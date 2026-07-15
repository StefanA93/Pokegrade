export const config = { runtime: 'edge' }

// Lag 2 — variant picker. Given an identified card (game + catalog id), return the unified list of
// variants the user picks from, each with its EU price. Two underlying models, one output shape:
//   • rows-model (yugioh/pokemonjp/onepiece/dragonball/riftbound): siblings share variant_group_key
//   • finishes-array model (pokemon/mtg/lorcana): unfold finish_types into one option per finish
// Prices come from card_prices via a label bridge (finish_types vocab → card_prices.finish vocab).

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
}

const VALID_GAMES = ['pokemon', 'mtg', 'yugioh', 'pokemonjp', 'onepiece', 'dragonball', 'lorcana', 'riftbound']

// Rows-games reprint the same card across many prints (YGO: Blue-Eyes = 50+ set-codes, identical art).
// Scan can only identify the CARD; the exact PRINT is a Lag-2 user pick (Collectr model). So for these
// games Lag 2 lists ALL prints of the card by name, not just variant_group_key (exact-print) siblings.
const PRINT_PICK_GAMES = new Set(['yugioh', 'onepiece', 'dragonball'])

// Base name = card name minus a trailing treatment suffix, e.g. "Blue-Eyes White Dragon (Alternate Art)".
function baseName(name) {
  return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim()
}

// Escape a value for a PostgREST ilike pattern embedded in a URL (commas/parens break the query).
function ilikeSafe(s) {
  return encodeURIComponent(String(s).replace(/[,()*]/g, ' ').trim())
}

// finish_types label (tcgplayer/Scryfall vocab) → the card_prices.finish label that holds its price.
// A holo-rare's price is stored as "Normal" (Cardmarket's single price), so Holofoil/1st Ed/etc → Normal.
function priceFinishFor(ft) {
  if (ft === 'Reverse Holo') return 'Reverse Holo'
  if (ft === 'Foil' || ft === 'Etched Foil') return 'Foil'
  return 'Normal'
}

// Human label for a rows-model variant: the treatment suffix(es) in the name, else rarity.
function rowsVariantLabel(row) {
  const parens = [...String(row.name || '').matchAll(/\(([^)]+)\)/g)]
    .map((m) => m[1].trim())
    .filter((p) => p && !/^\d+$/.test(p) && p !== row.number)
  if (parens.length) return parens.join(' · ')
  return row.rarity || 'Standard'
}

const PG_HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
}

async function pg(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: PG_HEADERS })
  if (!res.ok) return []
  return res.json()
}

function priceObj(row) {
  if (!row) return null
  return {
    avg7: row.price_avg7 != null ? Number(row.price_avg7) : null,
    avg30: row.price_avg30 != null ? Number(row.price_avg30) : null,
    low: row.price_low != null ? Number(row.price_low) : null,
    sell: row.price_sell != null ? Number(row.price_sell) : null,
    trend: row.price_trend != null ? Number(row.price_trend) : null,
    cm_url: row.cm_url || null,
    // Most prices are Cardmarket EUR; pokemonjp/dragonball (tcgplayer) and lorcana foil (lorcast) are USD.
    currency: row.source === 'cardmarket' ? 'EUR' : 'USD',
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS_HEADERS })
  }

  const { searchParams } = new URL(req.url)
  const game = (searchParams.get('game') ?? '').trim()
  const id = (searchParams.get('id') ?? '').trim()

  if (!id || !VALID_GAMES.includes(game)) {
    return new Response(JSON.stringify({ error: 'game (valid) and id are required' }), { status: 400, headers: CORS_HEADERS })
  }

  const fields = 'id,game,name,number,set_name,rarity,image_url,image_url_small,finish_types,variant_group_key,cardmarket_url'

  try {
    const cardRows = await pg(`card_catalog?id=eq.${encodeURIComponent(id)}&game=eq.${encodeURIComponent(game)}&select=${fields}&limit=1`)
    const card = cardRows[0]
    if (!card) {
      return new Response(JSON.stringify({ error: 'Card not found' }), { status: 404, headers: CORS_HEADERS })
    }

    // --- determine model + build variant options ---
    let model = 'single'
    let options = [] // { id, label, finish?, rarity, number, image_url }

    // rows-games: Lag 2 = pick the exact PRINT among ALL prints of the card (name-search), since scan
    // identifies the card but not the print (same art across reprints).
    if (PRINT_PICK_GAMES.has(game)) {
      const base = baseName(card.name)
      // Prefix-search then filter to EXACT base name in JS: an ilike prefix would wrongly pull distinct
      // cards ("Dark Magician" must not match "Dark Magician Girl" / "...of Chaos").
      const fetched = await pg(
        `card_catalog?game=eq.${encodeURIComponent(game)}&name=ilike.${ilikeSafe(base)}*` +
          `&select=id,name,number,set_name,rarity,image_url,image_url_small&order=set_name.asc,number.asc&limit=600`
      )
      const prints = fetched.filter((p) => baseName(p.name).toLowerCase() === base.toLowerCase())
      if (prints.length > 1) {
        model = 'prints'
        options = prints.map((p) => ({
          id: p.id,
          label: p.number || p.set_name || baseName(p.name),
          treatment: rowsVariantLabel(p),
          set_name: p.set_name || null,
          rarity: p.rarity || null,
          number: p.number || null,
          image_url: p.image_url || p.image_url_small || null,
        }))
      }
    }

    let siblings = []
    if (!options.length && card.variant_group_key) {
      siblings = await pg(
        `card_catalog?game=eq.${encodeURIComponent(game)}&variant_group_key=eq.${encodeURIComponent(card.variant_group_key)}` +
          `&select=id,name,number,rarity,image_url,image_url_small&order=number.asc,name.asc`
      )
    }

    if (options.length) {
      // already built (prints model)
    } else if (siblings.length > 1) {
      model = 'rows'
      options = siblings.map((s) => ({
        id: s.id,
        label: rowsVariantLabel(s),
        rarity: s.rarity || null,
        number: s.number || null,
        image_url: s.image_url || s.image_url_small || null,
      }))
    } else if (Array.isArray(card.finish_types) && card.finish_types.length > 1) {
      model = 'finishes'
      options = card.finish_types.map((ft) => ({
        id: card.id,
        label: ft,
        finish: ft,
        rarity: card.rarity || null,
        number: card.number || null,
        image_url: card.image_url || card.image_url_small || null,
      }))
    } else {
      options = [
        {
          id: card.id,
          label: (Array.isArray(card.finish_types) && card.finish_types[0]) || card.rarity || 'Standard',
          finish: (Array.isArray(card.finish_types) && card.finish_types[0]) || null,
          rarity: card.rarity || null,
          number: card.number || null,
          image_url: card.image_url || card.image_url_small || null,
        },
      ]
    }

    // --- attach prices from card_prices ---
    const ids = [...new Set(options.map((o) => o.id))]
    const priceRows = await pg(
      `card_prices?catalog_id=in.(${ids.map((x) => encodeURIComponent(x)).join(',')})` +
        `&select=catalog_id,finish,price_avg7,price_avg30,price_low,price_sell,price_trend,cm_url,source`
    )
    const byKey = new Map() // `${catalog_id}|${finish}` → row
    const byId = new Map() // catalog_id → preferred row (Normal first)
    for (const r of priceRows) {
      byKey.set(`${r.catalog_id}|${r.finish}`, r)
      if (!byId.has(r.catalog_id) || r.finish === 'Normal') byId.set(r.catalog_id, r)
    }

    const variants = options.map((o) => {
      let priceRow
      if (model === 'finishes') priceRow = byKey.get(`${o.id}|${priceFinishFor(o.finish)}`)
      else priceRow = byId.get(o.id)
      return { ...o, price: priceObj(priceRow) }
    })

    return new Response(
      JSON.stringify({
        card: {
          id: card.id,
          game: card.game,
          name: card.name,
          number: card.number,
          set_name: card.set_name,
          rarity: card.rarity,
          image_url: card.image_url || card.image_url_small || null,
          cardmarket_url: card.cardmarket_url || null,
        },
        model,
        variants,
      }),
      { status: 200, headers: CORS_HEADERS }
    )
  } catch (err) {
    console.error('card-variants error:', err)
    return new Response(JSON.stringify({ error: 'Lookup failed' }), { status: 502, headers: CORS_HEADERS })
  }
}
