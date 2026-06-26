import 'dotenv/config'
import pg from 'pg'
import { createReadStream } from 'fs'

const F = { nonfoil: 'Normal', foil: 'Foil', etched: 'Etched Foil', glossy: 'Glossy' }
console.log('stream-parser Scryfall default_cards.json (526M)...')
const finById = new Map()
{
  let pending = '', depth = 0, inStr = false, esc = false
  const stream = createReadStream('_scryfall/default_cards.json', { encoding: 'utf8', highWaterMark: 1 << 20 })
  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]
      if (depth === 0) { if (ch === '{') { depth = 1; pending = '{' } continue }
      pending += ch
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { try { const o = JSON.parse(pending); if (o.id && Array.isArray(o.finishes)) finById.set(o.id, o.finishes) } catch {} pending = '' } }
    }
  }
}
console.log('scryfall-kort i map:', finById.size)

const c = new pg.Client({ host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: 'postgres.yezlcgooutpshqdhvufg', password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
const ours = (await c.query("SELECT id FROM card_catalog WHERE game='mtg' AND number NOT LIKE 'product-%'")).rows
console.log('vores MTG-kort:', ours.length)

const updates = []
let noMatch = 0
for (const o of ours) {
  const sid = o.id.replace(/^mtg-/, '')
  const fins = finById.get(sid)
  if (!fins) { noMatch++; continue }
  let ft = [...new Set(fins.map(x => F[x] || x))]
  if (!ft.length) ft = ['Normal']
  updates.push({ id: o.id, ft })
}
console.log('matchede:', updates.length, '| ingen match:', noMatch)

let upd = 0
for (let i = 0; i < updates.length; i += 400) {
  const batch = updates.slice(i, i + 400)
  const ph = batch.map((_, k) => `($${k * 2 + 1},$${k * 2 + 2}::text[])`).join(',')
  const vals = batch.flatMap(u => [u.id, u.ft])
  const r = await c.query(`UPDATE card_catalog AS t SET finish_types=v.f FROM (VALUES ${ph}) AS v(id,f) WHERE t.id=v.id AND t.finish_types IS DISTINCT FROM v.f`, vals)
  upd += r.rowCount
}
const dist = await c.query("SELECT finish_types::text, count(*) n FROM card_catalog WHERE game='mtg' GROUP BY finish_types::text ORDER BY n DESC LIMIT 8")
await c.end()
console.log('\nopdateret:', upd)
console.log('ny MTG finish_types-fordeling:')
dist.rows.forEach(x => console.log('  ' + String(x.n).padStart(7) + '  ' + x.finish_types))
