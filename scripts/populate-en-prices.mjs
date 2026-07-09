import 'dotenv/config'
import pg from 'pg'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dbUpsert } from '../server/middleware/db.js'

// EN Pokemon Cardmarket EUR prices via pokemontcg.io (reuses the proven set+number matching from
// populate-en-finishes.mjs). Fills the ~52% unpriced Full Art EX etc. — the price EXISTS in
// pokemontcg.io's cardmarket data, our earlier price backfill (CM /pokemon) just had coverage gaps.
// Writes finish='Normal' (card market price; the endpoint's Holofoil→Normal label bridge surfaces it
// for holo cards) + finish='Reverse Holo' where the card has a reverse-holo. All Cardmarket EUR.

const PROG = '_ebay/en_price_progress.json'
const norm = s => String(s || '').toLowerCase().replace(/^[a-z]{1,5}\d{0,2}:\s*/, '').replace(/\bbase set\b/, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '')
const numKey = s => { const m = String(s || '').match(/^([A-Za-z]*)0*(\d+)/); return m ? (m[1].toUpperCase() + parseInt(m[2], 10)) : String(s || '').toUpperCase() }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const n = v => (v == null ? null : Number(v)) || null

const c = new pg.Client({ host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: 'postgres.yezlcgooutpshqdhvufg', password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()

const ptc = (await (await fetch('https://api.pokemontcg.io/v2/sets?pageSize=250', { signal: AbortSignal.timeout(25000) })).json()).data || []
const ptcN = ptc.map(s => ({ s, n: norm(s.name) }))
const ourSets = (await c.query("SELECT DISTINCT set_name FROM card_catalog WHERE game='pokemon' AND number NOT LIKE 'product-%'")).rows.map(r => r.set_name)
const mapping = []
for (const sn of ourSets) {
  const on = norm(sn)
  const m = ptcN.find(p => p.n === on) || ptcN.find(p => p.n && on && (p.n.includes(on) || on.includes(p.n)) && Math.min(p.n.length, on.length) >= 4)
  if (m) mapping.push({ ourSet: sn, ptcId: m.s.id })
}
console.log(`mappede sæt: ${mapping.length}/${ourSets.length}`)

const done = existsSync(PROG) ? JSON.parse(readFileSync(PROG, 'utf8')) : []
const doneSet = new Set(done)
let totalRows = 0, totalCards = 0
for (const { ourSet, ptcId } of mapping) {
  if (doneSet.has(ourSet)) continue
  const ptcCards = []
  for (let page = 1; page <= 6; page++) {
    let j
    try { j = await (await fetch(`https://api.pokemontcg.io/v2/cards?q=set.id:${ptcId}&pageSize=250&page=${page}&select=number,cardmarket`, { signal: AbortSignal.timeout(25000) })).json() }
    catch (e) { console.log(`  ${ourSet}: fetch-fejl ${e.message}`); break }
    const d = j.data || []; ptcCards.push(...d)
    await sleep(2200)
    if (d.length < 250) break
  }
  const byNum = {}
  for (const pc of ptcCards) { const p = pc.cardmarket?.prices; if (p) byNum[numKey(pc.number)] = p }

  const ours = (await c.query("SELECT id, number FROM card_catalog WHERE game='pokemon' AND set_name=$1 AND number NOT LIKE 'product-%'", [ourSet])).rows
  const rows = []
  const now = new Date().toISOString()
  for (const o of ours) {
    const p = byNum[numKey(o.number)]
    if (!p) continue
    if (n(p.averageSellPrice) || n(p.avg7) || n(p.trendPrice)) {
      rows.push({ catalog_id: o.id, finish: 'Normal', source: 'cardmarket', price_sell: n(p.averageSellPrice), price_low: n(p.lowPrice), price_avg7: n(p.avg7), price_avg30: n(p.avg30), price_trend: n(p.trendPrice), fetched_at: now })
      totalCards++
    }
    if (n(p.reverseHoloSell) || n(p.reverseHoloAvg7) || n(p.reverseHoloTrend)) {
      rows.push({ catalog_id: o.id, finish: 'Reverse Holo', source: 'cardmarket', price_sell: n(p.reverseHoloSell), price_low: n(p.reverseHoloLow), price_avg7: n(p.reverseHoloAvg7), price_avg30: n(p.reverseHoloAvg30), price_trend: n(p.reverseHoloTrend), fetched_at: now })
    }
  }
  for (let i = 0; i < rows.length; i += 200) await dbUpsert('card_prices', rows.slice(i, i + 200), 'catalog_id,finish')
  totalRows += rows.length
  console.log(`  ${ourSet.slice(0, 34).padEnd(34)} → ptc ${ptcCards.length}, prisrækker ${rows.length}`)
  doneSet.add(ourSet); done.push(ourSet); writeFileSync(PROG, JSON.stringify(done))
}
await c.end()
console.log(`\nFÆRDIG. prisrækker: ${totalRows} | kort m. Normal-pris: ${totalCards}`)
