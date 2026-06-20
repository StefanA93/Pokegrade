/**
 * Recall-probe: for udvalgte eBay-kort, sammenlign HNSW-pool vs EKSAKT KNN (index off)
 * over kun pokemon. Adskiller HNSW-recall-fejl (eksakt-rank god, HNSW-rank -1) fra
 * dårligt embedding (eksakt-rank også dårlig).
 *
 * Brug: node scripts/diag-recall.js 82 112
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import sharp from 'sharp'

const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const RWY = 'https://pokegrade-production-683f.up.railway.app', RSEC = 'gd_embed_2024'
const SET_ID = '5500048', GAME = 'pokemon'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36'
const h = { apikey: KEY, Authorization: 'Bearer ' + KEY }
const only = process.argv.slice(2)
const rows = readFileSync('_ebay/raw_pokemon.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .filter(r => only.includes(String(r.num)))
const numPart = s => { const m = String(s).match(/(\d{1,4})/); return m ? String(parseInt(m[1], 10)) : null }

async function railwayEmbed(buf) {
  const b64 = (await sharp(buf).resize(800, 800, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()).toString('base64')
  const r = await fetch(`${RWY}/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RSEC}` },
    body: JSON.stringify({ image: `data:image/jpeg;base64,${b64}`, game: GAME }), signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`Railway ${r.status}`)
  return r.json()
}

const { Client } = await import('pg')
const c = new Client({ host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: 'postgres.yezlcgooutpshqdhvufg',
  password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()

for (const row of rows) {
  console.log(`\n━━ eBay ${row.num}/203 ━━`)
  const buf = Buffer.from(await (await fetch(row.src, { headers: { 'User-Agent': UA } })).arrayBuffer())
  const { embedding } = await railwayEmbed(buf)
  const vec = `[${embedding.join(',')}]`

  const cor = await c.query(
    `select id,name,number from card_catalog where game=$1 and set_id=$2 and number like '%'||$3||'/203%' limit 5`,
    [GAME, SET_ID, numPart(row.num)])
  const correct = cor.rows.find(r => numPart(r.number) === numPart(row.num)) || cor.rows[0]
  console.log(`  Korrekt: ${correct?.name} [${correct?.number}] id=${correct?.id}`)

  // direkte cosine til det korrekte kort
  if (correct) {
    const dc = await c.query(`select (1-(embedding<=>$1::vector))::float sim from card_catalog where id=$2`, [vec, correct.id])
    console.log(`  Direkte cosine til korrekt kort: ${dc.rows[0]?.sim?.toFixed(4)}`)
  }

  // HNSW (index on) — top 40 pokemon
  const hnsw = await c.query(
    `select id,name,number,(1-(embedding<=>$1::vector))::float sim from card_catalog
     where game=$2 and embedding is not null order by embedding<=>$1::vector limit 40`, [vec, GAME])
  const hRank = correct ? hnsw.rows.findIndex(r => r.id === correct.id) : -2
  console.log(`  HNSW pool: ${hnsw.rows.length} | korrekt rank: ${hRank === -1 ? 'IKKE I POOL' : '#'+(hRank+1)}`)

  // EKSAKT KNN (index off) — sandt top 40 pokemon
  await c.query('SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off')
  const exact = await c.query(
    `select id,name,number,(1-(embedding<=>$1::vector))::float sim from card_catalog
     where game=$2 and embedding is not null order by embedding<=>$1::vector limit 40`, [vec, GAME])
  const eRank = correct ? exact.rows.findIndex(r => r.id === correct.id) : -2
  console.log(`  EKSAKT pool: ${exact.rows.length} | korrekt rank: ${eRank === -1 ? 'IKKE I TOP-40' : '#'+(eRank+1)+' (sim '+exact.rows[eRank]?.sim?.toFixed(4)+')'}`)
  console.log(`  EKSAKT top-5:`)
  exact.rows.slice(0, 5).forEach((r, i) => console.log(`    ${i+1}. ${r.sim.toFixed(4)} ${r.name} [${r.number}]`))
}
await c.end()
