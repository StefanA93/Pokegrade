/**
 * Diagnose pr. fejlende eBay-kort: replikér scan-pipelinen lokalt mod Railway + DB,
 * men vis HELE den rangerede CLIP-pool (prod returnerer kun top-5) + det korrekte
 * korts rank/embedding-status. Svarer på: recall-hul (rank -1) vs disambiguering
 * (rigtigt kort i pool men outscoret) vs Railway/embed-fejl (phash-fallback).
 *
 * Brug: node scripts/diag-ebay.js            (alle linjer i _ebay/raw_pokemon.jsonl)
 *       node scripts/diag-ebay.js 82 112     (kun udvalgte eBay-numre)
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import sharp from 'sharp'

const SB  = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const RWY = 'https://pokegrade-production-683f.up.railway.app'
const RSEC = 'gd_embed_2024'
const SET_ID = '5500048'              // SWSH07: Evolving Skies (total 203)
const GAME = 'pokemon'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36'
const h = { apikey: KEY, Authorization: 'Bearer ' + KEY }

const only = process.argv.slice(2)
const rows = readFileSync('_ebay/raw_pokemon.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .filter(r => only.length === 0 || only.includes(String(r.num)))

const numPart = s => { const m = String(s).match(/(\d{1,4})/); return m ? String(parseInt(m[1], 10)) : null }

async function dl(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } })
  return Buffer.from(await r.arrayBuffer())
}

async function railwayEmbed(buf) {
  const b64 = (await sharp(buf).resize(800, 800, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()).toString('base64')
  const r = await fetch(`${RWY}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RSEC}` },
    body: JSON.stringify({ image: `data:image/jpeg;base64,${b64}`, game: GAME }),
    signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error(`Railway ${r.status}`)
  return r.json()    // {embedding, ocr}
}

async function matchCards(embedding, count = 40) {
  const r = await fetch(`${SB}/rest/v1/rpc/match_cards`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_embedding: `[${embedding.join(',')}]`, game_filter: GAME, match_count: count }),
  })
  return r.ok ? r.json() : null
}

// Det korrekte Evolving Skies-kort for et eBay-nummer (filtreret på set_id)
async function correctCard(num) {
  const r = await fetch(
    `${SB}/rest/v1/card_catalog?game=eq.${GAME}&set_id=eq.${SET_ID}&number=like.*${num}/203*&select=id,name,number,embedding`,
    { headers: h })
  const d = r.ok ? await r.json() : []
  // foretræk eksakt num-del match
  return d.find(c => numPart(c.number) === numPart(num)) || d[0] || null
}

for (const row of rows) {
  const tag = `eBay ${row.num}/203`
  try {
    const buf = await dl(row.src)
    const { embedding, ocr } = await railwayEmbed(buf)
    const pool = await matchCards(embedding, 40)
    const correct = await correctCard(row.num)

    const correctId = correct?.id
    const rank = correctId ? pool.findIndex(c => c.id === correctId) : -2
    const correctSim = rank >= 0 ? pool[rank].similarity : null

    console.log(`\n━━ ${tag} ━━`)
    console.log(`  OCR:        ${ocr ? JSON.stringify(ocr) : 'null'}`)
    console.log(`  Embedding:  ${Array.isArray(embedding) ? 'OK ('+embedding.length+')' : 'FAIL'}`)
    console.log(`  Pool:       ${pool ? pool.length + ' kandidater' : 'NULL (match_cards fejl)'}`)
    if (correct) {
      console.log(`  Korrekt:    ${correct.name} [${correct.number}] id=${correctId}`)
      console.log(`  Has emb:    ${correct.embedding ? 'JA' : 'NEJ (kan ikke matches!)'}`)
      console.log(`  Rank i pool:${rank === -1 ? ' IKKE I POOL (rank -1 = recall-miss)' : rank === -2 ? ' n/a' : ` #${rank+1} (sim ${correctSim?.toFixed(4)})`}`)
    } else {
      console.log(`  Korrekt:    INTET katalog-kort for ${row.num}/203 i set ${SET_ID}`)
    }
    console.log(`  Top-5 CLIP:`)
    const ids = (pool || []).slice(0, 5).map(c => c.id)
    const det = ids.length ? await (await fetch(`${SB}/rest/v1/card_catalog?id=in.(${ids.map(i=>`"${i}"`).join(',')})&select=id,name,number,set_name`, { headers: h })).json() : []
    const dm = Object.fromEntries(det.map(c => [c.id, c]))
    ;(pool || []).slice(0, 5).forEach((c, i) => {
      const d = dm[c.id] || {}
      console.log(`    ${i+1}. ${c.similarity.toFixed(4)}  ${d.name||c.id} [${d.number||'?'}] {${d.set_name||'?'}}`)
    })
  } catch (e) {
    console.log(`\n━━ ${tag} ━━  ERROR: ${e.message}`)
  }
}
