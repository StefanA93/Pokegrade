/**
 * Scan-præcisions-benchmark (Collectr-metrik).
 *
 * Sampler N rigtige kort med embedding, kører hvert korts billede gennem
 * produktions-scan-free, og måler:
 *   - eksakt-id  top-1 / top-3   (returnerer scan PRÆCIS dette kort? kræver OCR ved samme-artwork)
 *   - samme-navn top-1 / top-3   (returnerer scan det rigtige Pokémon/kort-navn? = CLIP-loft)
 *
 * Modes:
 *   clean  — sender katalogbilledet uændret (ideelt input → loft)
 *   aug    — kamera-simulering: rotation, lysstyrke, blur, JPEG-recompress, baggrund
 *
 * Brug:
 *   node scripts/benchmark-scan.js pokemon 50 clean
 *   node scripts/benchmark-scan.js pokemon 50 aug
 */
import 'dotenv/config'
import sharp from 'sharp'

const GAME  = process.argv[2] || 'pokemon'
const N     = parseInt(process.argv[3] || '50', 10)
const MODE  = process.argv[4] || 'clean'

const SB     = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const KEY    = process.env.SUPABASE_SERVICE_KEY
const DEPLOY = process.env.SCAN_DEPLOY || 'https://pokegrade-lbbntahzq-stefana93.vercel.app'
const BYPASS = 'm8N3Uz2ILE3TvJPPbrApokT6OWvVAlOC'
const h = { apikey: KEY, Authorization: 'Bearer ' + KEY }

function norm(n) { return String(n || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/ - .*/, '').replace(/[^a-z0-9]/g, '').trim() }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Hent et tilfældigt-spredt udvalg af rigtige kort (ikke produkter) med embedding + pokemontcg-billede
async function sample() {
  const picks = []
  const seen = new Set()
  // 6 tilfældige offsets for spredning på tværs af sæt
  for (let i = 0; i < 8 && picks.length < N; i++) {
    const offset = Math.floor(Math.random() * 28000)
    const r = await fetch(SB + `/rest/v1/card_catalog?game=eq.${GAME}&embedding=not.is.null&image_url=like.*images.pokemontcg.io*&number=not.like.product-*&select=id,name,number,set_name,image_url&limit=40&offset=${offset}`, { headers: h })
    const rows = await r.json()
    for (const c of rows) { if (!seen.has(c.id)) { seen.add(c.id); picks.push(c) } }
  }
  return picks.slice(0, N)
}

async function augment(buf) {
  const angle = (Math.random() * 8 - 4)
  const bright = 0.85 + Math.random() * 0.3
  return sharp(buf)
    .rotate(angle, { background: { r: 40, g: 42, b: 48 } })
    .modulate({ brightness: bright, saturation: 0.9 + Math.random() * 0.2 })
    .blur(0.4 + Math.random() * 0.6)
    .resize(600, 800, { fit: 'inside' })
    .jpeg({ quality: 68 })
    .toBuffer()
}

async function scanOne(card) {
  let buf = Buffer.from(await (await fetch(card.image_url, { signal: AbortSignal.timeout(20000) })).arrayBuffer())
  if (MODE === 'aug') buf = await augment(buf)
  const r = await fetch(DEPLOY + '/api/scan-free', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vercel-protection-bypass': BYPASS },
    body: JSON.stringify({ image: 'data:image/jpeg;base64,' + buf.toString('base64'), game: GAME }),
    signal: AbortSignal.timeout(60000),
  })
  const body = await r.json()
  const cands = body.candidates || []
  return {
    idTop1:   cands[0]?.id === card.id,
    idTop3:   cands.slice(0, 3).some(c => c.id === card.id),
    nameTop1: cands[0] && norm(cands[0].name) === norm(card.name),
    nameTop3: cands.slice(0, 3).some(c => norm(c.name) === norm(card.name)),
    clip:     body.meta?.clip,
    top1:     cands[0] ? `${cands[0].name} ${cands[0].number}` : '(ingen)',
  }
}

async function run() {
  console.log(`\n📊 Scan-benchmark — spil=${GAME} N=${N} mode=${MODE}\n   deploy=${DEPLOY}\n`)
  const cards = await sample()
  console.log(`   ${cards.length} kort samplet\n`)
  const agg = { idTop1: 0, idTop3: 0, nameTop1: 0, nameTop3: 0, clipUsed: 0, errors: 0 }
  let i = 0
  for (const card of cards) {
    i++
    try {
      const res = await scanOne(card)
      if (res.idTop1) agg.idTop1++
      if (res.idTop3) agg.idTop3++
      if (res.nameTop1) agg.nameTop1++
      if (res.nameTop3) agg.nameTop3++
      if (res.clip) agg.clipUsed++
      const mark = res.idTop1 ? '✅id' : res.nameTop1 ? '🟡navn' : res.nameTop3 ? '🟠top3' : '❌'
      console.log(`  [${i}/${cards.length}] ${mark}  ${card.name} ${card.number} (${card.set_name})  →  ${res.top1}`)
    } catch (e) {
      agg.errors++
      console.log(`  [${i}/${cards.length}] FEJL ${card.name}: ${e.message}`)
    }
    await sleep(200)
  }
  const n = cards.length - agg.errors || 1
  const pct = x => ((x / n) * 100).toFixed(1) + '%'
  console.log(`\n── Resultat (${MODE}, n=${n}) ──`)
  console.log(`  Eksakt-id   top-1: ${pct(agg.idTop1)}   top-3: ${pct(agg.idTop3)}`)
  console.log(`  Samme-navn  top-1: ${pct(agg.nameTop1)}   top-3: ${pct(agg.nameTop3)}`)
  console.log(`  CLIP brugt: ${pct(agg.clipUsed)}   fejl: ${agg.errors}`)
}

run().catch(e => { console.error(e); process.exit(1) })
