/**
 * import-local.mjs — Runs the card catalog import directly from your machine.
 * Calls pokemontcg.io / Scryfall / ygoprodeck and writes straight to Supabase.
 *
 * Usage (PowerShell):
 *   $env:SUPABASE_URL = "https://yezlcgooutpshqdhvufg.supabase.co"
 *   $env:SUPABASE_SERVICE_KEY = "YOUR_SERVICE_ROLE_KEY"
 *   node scripts/import-local.mjs pokemon
 *   node scripts/import-local.mjs mtg
 *   node scripts/import-local.mjs yugioh
 */

const game = process.argv[2]
if (!['pokemon', 'mtg', 'yugioh'].includes(game)) {
  console.error('Usage: node scripts/import-local.mjs <pokemon|mtg|yugioh>')
  process.exit(1)
}

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yezlcgooutpshqdhvufg.supabase.co'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
if (!SUPABASE_SERVICE_KEY) {
  console.error('Set SUPABASE_SERVICE_KEY env var. Get it from:')
  console.error('  https://supabase.com/dashboard/project/yezlcgooutpshqdhvufg/settings/api')
  console.error('  → Service Role Key (secret)')
  process.exit(1)
}

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates,return=minimal',
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, opts)
    if (res.status === 429 || res.status >= 500) {
      if (i < retries - 1) await sleep(2000 * (i + 1))
      continue
    }
    return res
  }
  throw new Error(`Failed after ${retries} attempts: ${url}`)
}

async function upsertBatch(rows) {
  if (!rows.length) return
  const res = await fetch(`${SUPABASE_URL}/rest/v1/card_catalog`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(rows),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase upsert failed (${res.status}): ${text}`)
  }
}

// ── Pokémon ───────────────────────────────────────────────────────────────────
function mapPokemon(c) {
  return {
    id: c.id,
    game: 'pokemon',
    name: c.name ?? null,
    number: c.number ?? null,
    set_id: c.set?.id ?? null,
    set_name: c.set?.name ?? null,
    rarity: c.rarity ?? null,
    finish: null,
    image_url: c.images?.large ?? c.images?.small ?? '',
    image_url_small: c.images?.small ?? null,
    cardmarket_url: c.cardmarket?.url ?? null,
    price_eur: c.cardmarket?.prices?.averageSellPrice ?? null,
    price_eur_low: c.cardmarket?.prices?.lowPrice ?? null,
    price_eur_trend: c.cardmarket?.prices?.trendPrice ?? null,
    updated_at: new Date().toISOString(),
  }
}

async function importPokemon() {
  let page = 1, total = 0, grand = 0
  while (true) {
    const res = await fetchWithRetry(
      `https://api.pokemontcg.io/v2/cards?pageSize=250&page=${page}&select=id,name,number,set,rarity,images,cardmarket`
    )
    if (!res.ok) throw new Error(`pokemontcg.io ${res.status}`)
    const data = await res.json()
    if (!total) total = data.totalCount ?? 0
    const rows = (data.data ?? []).map(mapPokemon).filter(r => r.image_url)
    await upsertBatch(rows)
    grand += rows.length
    process.stdout.write(`\r  Page ${page} — ${grand}/${total} cards imported`)
    if ((data.data?.length ?? 0) < 250) break
    page++
    await sleep(300)
  }
  console.log(`\n✅ Pokémon done — ${grand} cards`)
}

// ── MTG ───────────────────────────────────────────────────────────────────────
function mapMtg(c) {
  const imgs = c.image_uris ?? c.card_faces?.[0]?.image_uris ?? {}
  return {
    id: `mtg-${c.id}`,
    game: 'mtg',
    name: c.name ?? null,
    number: c.collector_number ?? null,
    set_id: c.set ?? null,
    set_name: c.set_name ?? null,
    rarity: c.rarity ?? null,
    finish: c.prices?.eur_foil != null ? 'Foil' : null,
    image_url: imgs.large ?? imgs.normal ?? '',
    image_url_small: imgs.small ?? null,
    cardmarket_url: c.related_uris?.cardmarket ?? c.purchase_uris?.cardmarket ?? null,
    price_eur: c.prices?.eur != null ? parseFloat(c.prices.eur) : null,
    price_eur_low: null,
    price_eur_trend: null,
    updated_at: new Date().toISOString(),
  }
}

async function importMtg() {
  // Paginate through Scryfall search — all English non-digital cards
  let url = 'https://api.scryfall.com/cards/search?q=lang%3Aen+-is%3Adigital&order=set&page=1'
  let grand = 0, page = 1

  while (url) {
    const res = await fetchWithRetry(url)
    if (!res.ok) {
      const txt = await res.text()
      throw new Error(`Scryfall page ${page}: ${res.status} — ${txt.slice(0, 200)}`)
    }
    const data = await res.json()
    const rows = (data.data ?? []).map(mapMtg).filter(r => r.image_url)
    await upsertBatch(rows)
    grand += rows.length
    process.stdout.write(`\r  Page ${page} — ${grand} cards imported`)
    url = data.has_more ? data.next_page : null
    page++
    await sleep(120)
  }
  console.log(`\n✅ MTG done — ${grand} cards`)
}

// ── Yu-Gi-Oh ──────────────────────────────────────────────────────────────────
function mapYgo(c) {
  const set = c.card_sets?.[0]
  const img = c.card_images?.[0]
  if (!img?.image_url) return null
  return {
    id: `yugioh-${c.id}`,
    game: 'yugioh',
    name: c.name ?? null,
    number: set?.set_code ?? null,
    set_id: set?.set_code ?? null,
    set_name: set?.set_name ?? null,
    rarity: c.type ?? null,
    finish: set?.set_rarity ?? null,
    image_url: img.image_url,
    image_url_small: img.image_url_small ?? null,
    cardmarket_url: null,
    price_eur: null,
    price_eur_low: null,
    price_eur_trend: null,
    updated_at: new Date().toISOString(),
  }
}

async function importYugioh() {
  let offset = 0, grand = 0, total = 0, page = 1
  while (true) {
    const res = await fetchWithRetry(`https://db.ygoprodeck.com/api/v7/cardinfo.php?num=500&offset=${offset}&misc=yes`)
    if (res.status === 400) break
    if (!res.ok) throw new Error(`ygoprodeck ${res.status}`)
    const data = await res.json()
    if (data.error) break
    if (!total) total = data.meta?.total_rows ?? 0
    const rows = (data.data ?? []).map(mapYgo).filter(Boolean)
    await upsertBatch(rows)
    grand += rows.length
    process.stdout.write(`\r  Page ${page} — ${grand}/${total} cards imported`)
    if ((data.data?.length ?? 0) < 500) break
    offset += 500
    page++
    await sleep(200)
  }
  console.log(`\n✅ Yu-Gi-Oh done — ${grand} cards`)
}

// ── Run ───────────────────────────────────────────────────────────────────────
console.log(`\nImporting ${game} cards into Supabase catalog...\n`)
if (game === 'pokemon') await importPokemon()
else if (game === 'mtg') await importMtg()
else if (game === 'yugioh') await importYugioh()
