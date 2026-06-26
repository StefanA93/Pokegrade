/**
 * Lorcana foil — refine finish_types + add foil price (Option A: USD foil exception).
 *
 * CM (the EU price source) does not expose Lorcana foil prices, so per the JP/DBS precedent the
 * foil price is taken from lorcast (USD) as a documented exception; the non-foil price stays CM EUR.
 * lorcast's usd / usd_foil presence is also the cleanest foil-availability signal — better than our
 * rarity rule — so we refine finish_types from it too.
 *
 * Bridge: our catalog id = tcgapi id (lorcana-{tcgapi_id}); tcgapi + lorcast both carry tcgplayer_id.
 *   catalog row → tcgapi (tcgplayer_id) → lorcast (same tcgplayer_id) → usd / usd_foil.
 *
 * Kør: node scripts/backfill-lorcana-foil.mjs
 */
import 'dotenv/config'
import pg from 'pg'
import { dbUpsert } from '../server/middleware/db.js'

const TB = 'https://api.tcgapi.dev/v1'
const TH = { 'X-API-Key': process.env.TCGAPI_KEY }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => (v == null ? null : parseFloat(v)) || null

async function jget(url, headers) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(25000) }); if (r.ok) return r.json() } catch {}
    await sleep(700)
  }
  return null
}

async function run() {
  // 1. tcgapi Lorcana (game 45): tcgplayer_id -> catalog_id
  console.log('Bygger tcgapi tcgplayer_id → catalog_id...')
  const tMap = new Map()
  const tsets = ((await jget(`${TB}/games/45/sets?limit=50`, TH)) || {}).data || []
  for (const s of tsets) {
    for (let p = 1; ; p++) {
      const d = await jget(`${TB}/sets/${s.id}/cards?limit=100&page=${p}`, TH)
      for (const c of (d && d.data) || []) if (c.tcgplayer_id) tMap.set(String(c.tcgplayer_id), `lorcana-${c.id}`)
      if (!d || !d.meta?.has_more) break
      await sleep(150)
    }
  }
  console.log(`  ${tMap.size} tcgapi-kort m. tcgplayer_id`)

  // 2. lorcast: tcgplayer_id -> {usd, usd_foil}
  console.log('Henter lorcast-priser...')
  const lsets = ((await jget('https://api.lorcast.com/v0/sets')) || {}).results || []
  const lMap = new Map()
  for (const s of lsets) {
    const cards = (await jget(`https://api.lorcast.com/v0/sets/${s.id}/cards`)) || []
    for (const c of Array.isArray(cards) ? cards : []) if (c.tcgplayer_id) lMap.set(String(c.tcgplayer_id), c.prices || {})
    await sleep(150)
  }
  console.log(`  ${lMap.size} lorcast-kort m. tcgplayer_id`)

  // 3. join på tcgplayer_id -> catalog_id, beregn finish-signal + foil-pris
  const pc = new pg.Client({ host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: 'postgres.yezlcgooutpshqdhvufg', password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
  await pc.connect()
  await pc.query('SET statement_timeout=0')
  const cur = new Map(), rar = new Map()
  for (const r of (await pc.query("SELECT id, rarity, array_to_string(finish_types,'+') ft FROM card_catalog WHERE game='lorcana'")).rows) { cur.set(r.id, r.ft); rar.set(r.id, r.rarity) }

  const foilRows = []
  const setNormalFoil = [], setFoil = [], setNormal = []
  let matched = 0
  for (const [tid, prices] of lMap) {
    const catalogId = tMap.get(tid)
    if (!catalogId || !cur.has(catalogId)) continue
    matched++
    const usd = num(prices.usd), foil = num(prices.usd_foil)
    const target = usd && foil ? 'Normal+Foil' : foil ? 'Foil' : 'Normal'
    if (cur.get(catalogId) !== target) {
      if (target === 'Normal+Foil') setNormalFoil.push(catalogId)
      else if (target === 'Foil') setFoil.push(catalogId)
      else setNormal.push(catalogId)
    }
    // foil price with anomaly guard: lorcast/TCGplayer single-listing outliers inflate promo foils
    // (e.g. $10000 on a €1 promo). Skip foil >> non-foil (>50x), or absurd foil-only promos.
    const anomaly = (usd != null && foil > 50 * usd) || (usd == null && foil != null && foil > 50 && rar.get(catalogId) === 'Promo')
    if (foil != null && !anomaly) foilRows.push({ catalog_id: catalogId, finish: 'Foil', source: 'lorcast', price_sell: foil, price_avg7: foil, price_low: foil, fetched_at: new Date().toISOString() })
  }
  console.log(`\nmatchede Lorcana-kort: ${matched}`)

  // 4. foil-priser (USD, source=lorcast)
  for (let i = 0; i < foilRows.length; i += 200) await dbUpsert('card_prices', foilRows.slice(i, i + 200), 'catalog_id,finish')
  console.log(`foil-priser (USD) upserted: ${foilRows.length}`)

  // 5. finish_types-forfining (kun ændrede; batch)
  const upd = async (ids, val) => { if (ids.length) { for (let i = 0; i < ids.length; i += 500) await pc.query(`UPDATE card_catalog SET finish_types=$1 WHERE id = ANY($2)`, [val, ids.slice(i, i + 500)]) } }
  await upd(setNormalFoil, ['Normal', 'Foil'])
  await upd(setFoil, ['Foil'])
  await upd(setNormal, ['Normal'])
  console.log(`finish_types forfinet: +{Normal,Foil} ${setNormalFoil.length}, +{Foil} ${setFoil.length}, +{Normal} ${setNormal.length}`)
  await pc.end()
  console.log('\nFÆRDIG.')
}
run().catch((e) => { console.error(e); process.exit(1) })
