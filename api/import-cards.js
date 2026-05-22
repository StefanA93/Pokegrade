export const config = { runtime: 'edge' }

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const IMPORT_SECRET = process.env.IMPORT_SECRET

const SUPABASE_HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates,return=minimal',
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchWithRetry(url, opts = {}, retries = 3, backoffMs = 1500) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, opts)
    if (res.status === 429 || res.status >= 500) {
      if (attempt < retries - 1) await sleep(backoffMs * (attempt + 1))
      continue
    }
    return res
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts`)
}

async function upsertBatch(rows) {
  if (rows.length === 0) return

  const res = await fetch(`${SUPABASE_URL}/rest/v1/card_catalog`, {
    method: 'POST',
    headers: SUPABASE_HEADERS,
    body: JSON.stringify(rows),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase upsert failed (${res.status}): ${text}`)
  }
}

// ── Pokémon ───────────────────────────────────────────────────────────────────

function mapPokemonCard(card) {
  return {
    id: card.id,
    game: 'pokemon',
    name: card.name ?? null,
    number: card.number ?? null,
    set_id: card.set?.id ?? null,
    set_name: card.set?.name ?? null,
    rarity: card.rarity ?? null,
    finish: null,
    image_url: card.images?.large ?? card.images?.small ?? '',
    image_url_small: card.images?.small ?? null,
    cardmarket_url: card.cardmarket?.url ?? null,
    price_eur: card.cardmarket?.prices?.averageSellPrice ?? null,
    price_eur_low: card.cardmarket?.prices?.lowPrice ?? null,
    price_eur_trend: card.cardmarket?.prices?.trendPrice ?? null,
    updated_at: new Date().toISOString(),
  }
}

// Single-page import — call repeatedly with page=1,2,3... until hasMore=false
async function importPokemonPage(page) {
  const pageSize = 250
  const url =
    `https://api.pokemontcg.io/v2/cards` +
    `?pageSize=${pageSize}&page=${page}` +
    `&select=id,name,number,set,rarity,images,cardmarket`

  const res = await fetchWithRetry(url)
  if (!res.ok) throw new Error(`pokemontcg.io error: ${res.status}`)

  const data = await res.json()
  const total = data.totalCount ?? null
  const rows = (data.data ?? []).map(mapPokemonCard).filter((r) => r.image_url)
  await upsertBatch(rows)

  const fetched = data.data?.length ?? 0
  return { imported: rows.length, total, hasMore: fetched >= pageSize, page }
}

// ── MTG (Scryfall) ────────────────────────────────────────────────────────────

function mapMtgCard(card) {
  const imageUris = card.image_uris ?? card.card_faces?.[0]?.image_uris ?? {}
  const imageSmall = card.image_uris?.small ?? card.card_faces?.[0]?.image_uris?.small ?? null

  const foilPrice = card.prices?.eur_foil ?? null
  const finish = foilPrice !== null ? 'Foil' : null

  return {
    id: `mtg-${card.id}`,
    game: 'mtg',
    name: card.name ?? null,
    number: card.collector_number ?? null,
    set_id: card.set ?? null,
    set_name: card.set_name ?? null,
    rarity: card.rarity ?? null,
    finish,
    image_url: imageUris.large ?? imageUris.normal ?? '',
    image_url_small: imageSmall,
    cardmarket_url: card.related_uris?.cardmarket ?? card.purchase_uris?.cardmarket ?? null,
    price_eur: card.prices?.eur != null ? parseFloat(card.prices.eur) : null,
    price_eur_low: null,
    price_eur_trend: null,
    updated_at: new Date().toISOString(),
  }
}

async function importMtgPage(page) {
  const url = `https://api.scryfall.com/cards?page=${page}`
  const res = await fetchWithRetry(url)
  if (!res.ok) throw new Error(`Scryfall error: ${res.status}`)

  const data = await res.json()
  const total = data.total_cards ?? null

  const rows = (data.data ?? [])
    .filter((c) => c.lang === 'en' && !c.digital)
    .map(mapMtgCard)
    .filter((r) => r.image_url)

  await upsertBatch(rows)

  return { imported: rows.length, total, hasMore: data.has_more ?? false, page }
}

// ── Yu-Gi-Oh (ygoprodeck) ─────────────────────────────────────────────────────

function mapYgoCard(card) {
  const firstSet = card.card_sets?.[0] ?? null
  const firstImage = card.card_images?.[0] ?? {}

  const imageUrl = firstImage.image_url ?? ''
  if (!imageUrl) return null

  return {
    id: `yugioh-${card.id}`,
    game: 'yugioh',
    name: card.name ?? null,
    number: firstSet?.set_code ?? null,
    set_id: firstSet?.set_code ?? null,
    set_name: firstSet?.set_name ?? null,
    rarity: card.type ?? null,
    finish: firstSet?.set_rarity ?? null,
    image_url: imageUrl,
    image_url_small: firstImage.image_url_small ?? null,
    cardmarket_url: null,
    price_eur: null,
    price_eur_low: null,
    price_eur_trend: null,
    updated_at: new Date().toISOString(),
  }
}

async function importYugiohPage(page) {
  const pageSize = 500
  const offset = (page - 1) * pageSize
  const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?num=${pageSize}&offset=${offset}&misc=yes`

  const res = await fetchWithRetry(url)
  if (res.status === 400) return { imported: 0, total: null, hasMore: false, page }
  if (!res.ok) throw new Error(`ygoprodeck error: ${res.status}`)

  const data = await res.json()
  if (data.error) return { imported: 0, total: null, hasMore: false, page }

  const total = data.meta?.total_rows ?? null
  const rows = (data.data ?? []).map(mapYgoCard).filter(Boolean)
  await upsertBatch(rows)

  const fetched = data.data?.length ?? 0
  return { imported: rows.length, total, hasMore: fetched >= pageSize, page }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-import-secret',
      },
    })
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: CORS_HEADERS,
    })
  }

  const secret = req.headers.get('x-import-secret')
  if (!IMPORT_SECRET || secret !== IMPORT_SECRET) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: CORS_HEADERS,
    })
  }

  const { searchParams } = new URL(req.url)
  const game = searchParams.get('game')
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))

  const VALID_GAMES = ['pokemon', 'mtg', 'yugioh']
  if (!VALID_GAMES.includes(game)) {
    return new Response(
      JSON.stringify({ error: `Invalid game. Use one of: ${VALID_GAMES.join(', ')}` }),
      { status: 400, headers: CORS_HEADERS }
    )
  }

  try {
    let result

    if (game === 'pokemon') result = await importPokemonPage(page)
    else if (game === 'mtg') result = await importMtgPage(page)
    else if (game === 'yugioh') result = await importYugiohPage(page)

    // hasMore=true means there are more pages — caller should request ?page={page+1}
    return new Response(
      JSON.stringify({ game, page: result.page, imported: result.imported, total: result.total, hasMore: result.hasMore, done: !result.hasMore }),
      { status: 200, headers: CORS_HEADERS }
    )
  } catch (err) {
    console.error(`import-cards [${game}] page ${page} error:`, err)
    return new Response(JSON.stringify({ error: err.message ?? 'Import failed', game, page }), {
      status: 502,
      headers: CORS_HEADERS,
    })
  }
}
