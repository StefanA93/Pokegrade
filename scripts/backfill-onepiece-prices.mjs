/**
 * Backfill card_prices for One Piece via Cardmarket EUR — PER VARIANT.
 *
 * The CM API returns each variant (Alternate Art / Manga / SP / Parallel) as a separate entry
 * distinguished only by `version` (V.1..V.n) + a distinct `tcgplayer_id`, with NO human label.
 * Our catalog ids are tcgapi ids (onepiece-{tcgapi_id}), and tcgapi exposes `tcgplayer_id` per card.
 * Bridge: catalog row → tcgapi (tcgplayer_id) → CM entry (same tcgplayer_id) → CM EUR price.
 * This is exact + deterministic (no price-rank guessing). Verified: OP09-004 Shanks Alt Art/Manga/
 * Wanted Poster each resolve to the correct row with the correct CM price.
 *
 * Kør: node scripts/backfill-onepiece-prices.mjs
 */
import 'dotenv/config'
import { dbSelect, dbUpsert } from '../server/middleware/db.js'

const TB = 'https://api.tcgapi.dev/v1'
const TH = { 'X-API-Key': process.env.TCGAPI_KEY }
const CB = 'https://cardmarket-api-tcg.p.rapidapi.com'
const CH = { 'x-rapidapi-key': process.env.CARDMARKET_API_KEY, 'x-rapidapi-host': 'cardmarket-api-tcg.p.rapidapi.com' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => (v == null ? null : parseFloat(v)) || null

async function jget(url, headers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(25000) })
      if (r.ok) return r.json()
    } catch {}
    await sleep(800)
  }
  return null
}

// 1. tcgapi One Piece (game 11): tcgplayer_id → catalog_id (onepiece-{tcgapi_id})
async function buildTcgMap() {
  const sets = []
  for (let p = 1; ; p++) {
    const d = await jget(`${TB}/games/11/sets?limit=50&page=${p}`, TH)
    sets.push(...((d && d.data) || []))
    if (!d || !d.meta?.has_more) break
    await sleep(150)
  }
  const map = new Map()
  for (const s of sets) {
    for (let p = 1; ; p++) {
      const d = await jget(`${TB}/sets/${s.id}/cards?limit=100&page=${p}`, TH)
      for (const c of (d && d.data) || []) if (c.tcgplayer_id) map.set(String(c.tcgplayer_id), `onepiece-${c.id}`)
      if (!d || !d.meta?.has_more) break
      await sleep(150)
    }
  }
  return map
}

async function run() {
  console.log('Bygger tcgapi tcgplayer_id → catalog_id map...')
  const tcgMap = await buildTcgMap()
  console.log(`  ${tcgMap.size} tcgapi-kort m. tcgplayer_id`)

  // hvilke catalog_ids findes faktisk?
  const catIds = new Set()
  for (let off = 0; ; off += 1000) {
    const rows = await dbSelect('card_catalog', `game=eq.onepiece&select=id&limit=1000&offset=${off}`)
    rows.forEach((r) => catIds.add(r.id))
    if (rows.length < 1000) break
  }
  console.log(`  ${catIds.size} onepiece-rækker i katalog`)

  // 2. CM One Piece episodes → cards, join på tcgplayer_id
  // NB: CM's episodes-endpoint returnerer ~20/side uanset per_page → loop til tom side (ikke <50)
  const eps = []
  for (let p = 1; p <= 30; p++) {
    const d = await jget(`${CB}/one-piece/episodes?page=${p}&per_page=50`, CH)
    const a = (d && (d.data || d)) || []
    if (a.length === 0) break
    eps.push(...a)
    await sleep(300)
  }
  console.log(`  ${eps.length} CM-episoder\n`)

  const matched = new Set()
  let upserted = 0, noMatch = 0, noPrice = 0
  for (let i = 0; i < eps.length; i++) {
    const ep = eps[i]
    for (let p = 1; ; p++) {
      const d = await jget(`${CB}/one-piece/episodes/${ep.id}/cards?page=${p}&per_page=50`, CH)
      const cards = (d && (Array.isArray(d) ? d : d.data)) || []
      const rows = []
      for (const c of cards) {
        const tid = c.tcgplayer_id != null ? String(c.tcgplayer_id) : null
        const catalogId = tid && tcgMap.get(tid)
        if (!catalogId || !catIds.has(catalogId)) { noMatch++; continue }
        const cm = c.prices?.cardmarket
        if (!cm || (cm.lowest_near_mint == null && cm['7d_average'] == null)) { noPrice++; continue }
        rows.push({
          catalog_id: catalogId,
          finish: 'Normal',
          source: 'cardmarket',
          price_sell: num(cm.lowest_near_mint),
          price_low: num(cm.lowest_near_mint_EU_only ?? cm.lowest_near_mint),
          price_avg7: num(cm['7d_average']),
          price_avg30: num(cm['30d_average']),
          fetched_at: new Date().toISOString(),
        })
        matched.add(catalogId)
      }
      if (rows.length) { await dbUpsert('card_prices', rows, 'catalog_id,finish'); upserted += rows.length }
      if (cards.length < 50) break
      await sleep(300)
    }
    process.stdout.write(`\r  [${i + 1}/${eps.length}] upserted ${upserted}, distinkte ${matched.size}   `)
  }

  console.log(`\n\nFÆRDIG: ${upserted} prisrækker upserted | ${matched.size}/${catIds.size} onepiece-rækker priset (${((100 * matched.size) / catIds.size).toFixed(0)}%)`)
  console.log(`  ingen tcgplayer-match: ${noMatch} | ingen pris: ${noPrice}`)
}

run().catch((e) => { console.error(e); process.exit(1) })
