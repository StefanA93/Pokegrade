/**
 * EN Pokemon — Prismatic Evolutions Poké/Master Ball variants (JP-style treatment).
 *
 * The catalog stores each Prismatic card as 3 rows (base + Poke Ball Pattern + Master Ball Pattern)
 * but the finishes-populate blanket-wrote the SAME wrong finish_types (…+Poké Ball+Master Ball) on
 * all three. The patterns are separate ROWS (like JP 151), not finishes. So:
 *   1) variant_group_key = set_id|number → groups the 3 rows (Lag 2 pick-list)
 *   2) remove Poké Ball / Master Ball from finish_types (they are rows, not finishes)
 *   3) price the pattern rows from tcgapi (USD — no EUR source exists; CM/pokemontcg.io lack these
 *      variants entirely; documented USD exception like Lorcana foil / JP / DBS). Base rows keep EUR.
 *
 * Kør: node scripts/backfill-pokemon-prismatic.mjs
 */
import 'dotenv/config'
import pg from 'pg'
import { dbUpsert } from '../server/middleware/db.js'

const TB = 'https://api.tcgapi.dev/v1'
const TH = { 'X-API-Key': process.env.TCGAPI_KEY }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => (v == null ? null : parseFloat(v)) || null

async function jget(url) {
  for (let i = 0; i < 3; i++) { try { const r = await fetch(url, { headers: TH, signal: AbortSignal.timeout(25000) }); if (r.ok) return r.json() } catch {} await sleep(600) }
  return null
}

async function run() {
  // 1. tcgapi Prismatic Evolutions (set 5500017): catalog_id -> USD market_price
  const price = new Map()
  for (let p = 1; ; p++) {
    const d = await jget(`${TB}/sets/5500017/cards?limit=100&page=${p}`)
    for (const c of (d && d.data) || []) price.set(`pokemon-${c.id}`, num(c.market_price))
    if (!d || !d.meta?.has_more) break
    await sleep(150)
  }
  console.log(`tcgapi Prismatic-priser: ${price.size}`)

  const c = new pg.Client({ host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: 'postgres.yezlcgooutpshqdhvufg', password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
  await c.connect()
  await c.query('SET statement_timeout=0')
  const WHERE = "game='pokemon' AND set_name ILIKE '%Prismatic Evolutions%'"

  // 2. variant_group_key = set_id|number (group base + patterns)
  await c.query(`UPDATE card_catalog SET variant_group_key = lower(set_id || '|' || coalesce(nullif(number,''), id)) WHERE ${WHERE}`)
  // 3. remove bogus ball-finishes (patterns are rows, not finishes)
  const rm = await c.query(`UPDATE card_catalog SET finish_types = array_remove(array_remove(finish_types, 'Poké Ball'), 'Master Ball') WHERE ${WHERE} AND ('Poké Ball' = ANY(finish_types) OR 'Master Ball' = ANY(finish_types))`)
  console.log(`variant_group_key sat + ${rm.rowCount} rækker renset for ball-finishes`)

  // 4. price the pattern rows (USD, tcgapi)
  const rows = (await c.query(`SELECT id, name FROM card_catalog WHERE ${WHERE} AND (name ILIKE '%Master Ball Pattern%' OR name ILIKE '%Poke Ball Pattern%')`)).rows
  const priceRows = []
  for (const r of rows) {
    const p = price.get(r.id)
    if (p != null) priceRows.push({ catalog_id: r.id, finish: 'Normal', source: 'tcgplayer', price_sell: p, price_avg7: p, price_low: p, fetched_at: new Date().toISOString() })
  }
  for (let i = 0; i < priceRows.length; i += 200) await dbUpsert('card_prices', priceRows.slice(i, i + 200), 'catalog_id,finish')
  console.log(`pattern-rækker priset (USD): ${priceRows.length}/${rows.length}`)

  // verifikation
  const g = await c.query(`SELECT name, array_to_string(finish_types,'+') ft, variant_group_key, (SELECT price_avg7 FROM card_prices p WHERE p.catalog_id=cc.id LIMIT 1) pr FROM card_catalog cc WHERE ${WHERE} AND number='025/131' ORDER BY name`)
  console.log('\nGlaceon 025/131 efter fix:')
  for (const r of g.rows) console.log(`   ${(r.pr==null?'—':(r.name.includes('Pattern')?'$':'€')+r.pr).padEnd(10)} key=${r.variant_group_key} ft=[${r.ft}]  ${r.name}`)
  await c.end()
  console.log('\nFÆRDIG.')
}
run().catch((e) => { console.error(e); process.exit(1) })
