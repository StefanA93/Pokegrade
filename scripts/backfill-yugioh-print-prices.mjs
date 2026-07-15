/**
 * Per-PRINT YuGiOh priser. YGOProDeck's card_prices.cardmarket_price er ÉN pris pr. KORT (laveste
 * printing) → alle tryk kollapser til samme EUR. Men card_sets[].set_price er per-tryk (TCGplayer USD)
 * og varierer ægte (CT13 $74 vs common reprint). Policy (samme som JP/DBS/Lorcana-foil): hvor der INGEN
 * EU per-tryk-dækning findes, brug per-tryk USD som dokumenteret undtagelse, markeret via source.
 *
 * Regel pr. tryk (number = set_code):
 *   set_price > 0  → per-tryk USD  (source='tcgplayer')     ← ægte per-tryk-værdi
 *   ellers         → CM EUR card-niveau (source='cardmarket') ← det vi allerede har
 *
 * Kør: node scripts/backfill-yugioh-print-prices.mjs
 */
import 'dotenv/config'
import { dbSelect, dbUpsert } from '../server/middleware/db.js'

const YGOPRO = 'https://db.ygoprodeck.com/api/v7/cardinfo.php'
const HEADERS = { 'User-Agent': 'GradeDex/1.0 (gradedex.app)' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function buildMap() {
  process.stdout.write('  Henter YGOProDeck...')
  const r = await fetch(YGOPRO, { headers: HEADERS })
  if (!r.ok) throw new Error(`YGOProDeck ${r.status}`)
  const { data } = await r.json()
  // setCode → { cm: kort-niveau CM EUR, tcg: per-tryk TCGplayer USD }
  const map = new Map()
  for (const card of data) {
    const cm = parseFloat(card.card_prices?.[0]?.cardmarket_price) || null
    for (const s of card.card_sets || []) {
      if (!s.set_code) continue
      const tcg = parseFloat(s.set_price) || null
      map.set(s.set_code.toUpperCase(), { cm, tcg })
    }
  }
  console.log(` ${data.length} kort → ${map.size} set-koder`)
  return map
}

async function run() {
  console.log('\n💰 YuGiOh PER-TRYK pris-backfill (CM EUR + TCGplayer USD-undtagelse)\n')
  const map = await buildMap()

  let offset = 0, usd = 0, eur = 0, none = 0, upserted = 0
  while (true) {
    const rows = await dbSelect('card_catalog', `game=eq.yugioh&number=not.is.null&select=id,number&limit=1000&offset=${offset}`)
    if (!rows.length) break
    const out = []
    for (const row of rows) {
      const m = map.get(String(row.number).toUpperCase())
      if (!m) { none++; continue }
      const base = { catalog_id: row.id, finish: 'Normal', fetched_at: new Date().toISOString() }
      if (m.tcg && m.tcg > 0) {
        out.push({ ...base, price_sell: m.tcg, source: 'tcgplayer' })   // per-tryk USD
        usd++
      } else if (m.cm && m.cm > 0) {
        out.push({ ...base, price_sell: m.cm, source: 'cardmarket' })   // CM EUR card-niveau
        eur++
      } else {
        none++
      }
    }
    if (out.length) { await dbUpsert('card_prices', out, 'catalog_id,finish'); upserted += out.length }
    offset += rows.length
    process.stdout.write(`\r  ${offset} behandlet | USD(per-tryk) ${usd} | EUR(card) ${eur} | ingen ${none} | upserted ${upserted}`)
    await sleep(40)
    if (rows.length < 1000) break
  }
  console.log(`\n\n✅ Færdig! per-tryk USD: ${usd} | CM EUR fallback: ${eur} | ingen pris: ${none}`)
}

run().catch((e) => { console.error(e); process.exit(1) })
