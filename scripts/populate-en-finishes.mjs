import 'dotenv/config'
import pg from 'pg'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const PROG = '_ebay/en_finish_progress.json'
const FINISH_MAP = { normal: 'Normal', reverseHolofoil: 'Reverse Holo', holofoil: 'Holofoil', '1stEditionHolofoil': '1st Edition Holofoil', '1stEditionNormal': '1st Edition Normal', unlimitedHolofoil: 'Holofoil', unlimited: 'Normal' }
const norm = s => String(s || '').toLowerCase().replace(/^[a-z]{1,5}\d{0,2}:\s*/, '').replace(/\bbase set\b/, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '')
const numKey = s => { const m = String(s || '').match(/^([A-Za-z]*)0*(\d+)/); return m ? (m[1].toUpperCase() + parseInt(m[2], 10)) : String(s || '').toUpperCase() }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const c = new pg.Client({ host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: 'postgres.yezlcgooutpshqdhvufg', password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()

// 1) pokemontcg.io sæt + match til vores
const ptc = (await (await fetch('https://api.pokemontcg.io/v2/sets?pageSize=250', { signal: AbortSignal.timeout(25000) })).json()).data || []
const ptcN = ptc.map(s => ({ s, n: norm(s.name) }))
const ourSets = (await c.query("SELECT DISTINCT set_name FROM card_catalog WHERE game='pokemon' AND number NOT LIKE 'product-%'")).rows.map(r => r.set_name)
const mapping = []
for (const sn of ourSets) {
  const on = norm(sn)
  let m = ptcN.find(p => p.n === on) || ptcN.find(p => p.n && on && (p.n.includes(on) || on.includes(p.n)) && Math.min(p.n.length, on.length) >= 4)
  if (m) mapping.push({ ourSet: sn, ptcId: m.s.id, ptcName: m.s.name })
}
console.log(`mappede sæt: ${mapping.length}`)

const done = existsSync(PROG) ? JSON.parse(readFileSync(PROG, 'utf8')) : []
const doneSet = new Set(done)
let totalUpd = 0
for (const { ourSet, ptcId, ptcName } of mapping) {
  if (doneSet.has(ourSet)) continue
  // hent alle ptc-kort for sættet (pagineret)
  const ptcCards = []
  for (let page = 1; page <= 6; page++) {
    let j
    try { j = await (await fetch(`https://api.pokemontcg.io/v2/cards?q=set.id:${ptcId}&pageSize=250&page=${page}&select=number,rarity,supertype,tcgplayer`, { signal: AbortSignal.timeout(25000) })).json() }
    catch (e) { console.log(`  ${ourSet}: fetch-fejl ${e.message}`); break }
    const d = j.data || []; ptcCards.push(...d)
    await sleep(2200)
    if (d.length < 250) break
  }
  if (!ptcCards.length) { console.log(`  ${ourSet} → 0 ptc-kort (skip)`); doneSet.add(ourSet); done.push(ourSet); writeFileSync(PROG, JSON.stringify(done)); continue }
  const isPrismatic = /prismatic evolutions/i.test(ptcName)
  // numKey → finishes
  const byNum = {}
  for (const pc of ptcCards) {
    const prices = pc.tcgplayer?.prices || {}
    let fin = [...new Set(Object.keys(prices).map(k => FINISH_MAP[k] || null).filter(Boolean))]
    if (!fin.length) fin = ['Normal']
    if (isPrismatic && fin.includes('Reverse Holo')) { fin.push('Poké Ball'); if (pc.supertype === 'Pokémon') fin.push('Master Ball') }
    byNum[numKey(pc.number)] = [...new Set(fin)]
  }
  // vores kort i sættet → match + opdater
  const ours = (await c.query("SELECT id, number FROM card_catalog WHERE game='pokemon' AND set_name=$1 AND number NOT LIKE 'product-%'", [ourSet])).rows
  const updates = []
  for (const o of ours) { const f = byNum[numKey(o.number)]; if (f) updates.push({ id: o.id, f }) }
  for (let i = 0; i < updates.length; i += 400) {
    const batch = updates.slice(i, i + 400)
    const ph = batch.map((_, k) => `($${k * 2 + 1},$${k * 2 + 2}::text[])`).join(',')
    const vals = batch.flatMap(u => [u.id, u.f])
    const r = await c.query(`UPDATE card_catalog AS t SET finish_types=v.f FROM (VALUES ${ph}) AS v(id,f) WHERE t.id=v.id`, vals)
    totalUpd += r.rowCount
  }
  console.log(`  ${ourSet.slice(0, 34).padEnd(34)} → ptc ${ptcCards.length}, matched/opdateret ${updates.length}/${ours.length}${isPrismatic ? ' [PRISMATIC: +Poké/Master Ball]' : ''}`)
  doneSet.add(ourSet); done.push(ourSet); writeFileSync(PROG, JSON.stringify(done))
}
await c.end()
console.log(`\nFÆRDIG. Kort opdateret med finishes: ${totalUpd}`)
