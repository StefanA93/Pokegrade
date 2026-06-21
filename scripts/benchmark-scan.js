/**
 * Scan-præcisions-benchmark (Collectr-metrik) — alle spil.
 *
 * Sampler N rigtige kort (med embedding, ikke produkter) spredt på tværs af sæt,
 * kører hvert korts billede gennem produktions-scan-free, og måler:
 *   - eksakt-id  top-1 / top-3   (returnerer scan PRÆCIS dette kort?)
 *   - samme-navn top-1 / top-3   (rigtigt kort-navn = CLIP-loft)
 *
 * Modes:
 *   clean  — katalogbilledet uændret (loft / data+pipeline-sundhed)
 *   aug    — kamera-simulering: rotation/skew, glare, lysstyrke, blur, baggrund, JPEG
 *
 * Brug:
 *   node scripts/benchmark-scan.js all 150 clean
 *   node scripts/benchmark-scan.js pokemon 150 aug
 *
 * Skriver inkrementelt til _bench/<mode>_<game>.jsonl (partial-safe).
 */
import 'dotenv/config'
import sharp from 'sharp'
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync } from 'fs'

const GAME_ARG = process.argv[2] || 'pokemon'
const N        = parseInt(process.argv[3] || '50', 10)
const MODE     = process.argv[4] || 'clean'
const ALL_GAMES = ['pokemon', 'pokemonjp', 'yugioh', 'mtg', 'dragonball', 'lorcana', 'onepiece', 'riftbound']
const GAMES = GAME_ARG === 'all' ? ALL_GAMES : [GAME_ARG]

const SB     = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const KEY    = process.env.SUPABASE_SERVICE_KEY
const DEPLOY = process.env.SCAN_DEPLOY || 'https://pokegrade-rfml4mszc-stefana93.vercel.app'
const BYPASS = 'm8N3Uz2ILE3TvJPPbrApokT6OWvVAlOC'
const h = { apikey: KEY, Authorization: 'Bearer ' + KEY }
const OUTDIR = 'C:/Users/Ander/Documents/gradedex/_bench'

function norm(n) { return String(n || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/ - .*/, '').replace(/[^a-z0-9]/g, '').trim() }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function countEmbedded(game) {
  const r = await fetch(SB + `/rest/v1/card_catalog?game=eq.${game}&embedding=not.is.null&image_url=not.is.null&number=not.like.product-*&select=id`, { headers: { ...h, Prefer: 'count=exact', Range: '0-0' } })
  return parseInt(r.headers.get('content-range')?.split('/')[1] || '0')
}

// Stratificeret udvalg: loft pr. sæt tvinger bred dækning på tværs af sæt/æraer.
// (Kataloget er fysisk ordnet sæt-for-sæt, så et offset giver kort fra SAMME sæt —
//  derfor capper vi pr. sæt og tager mange tilfældige offsets.)
async function sample(game) {
  const total = await countEmbedded(game)
  const picks = []
  const seen = new Set()
  const perSet = new Map()
  const maxPerSet = Math.max(2, Math.ceil(N / 25))   // ~spred over mindst ~25 sæt
  const maxOff = Math.max(1, total - 6)
  for (let i = 0; i < N * 4 && picks.length < N; i++) {
    const offset = Math.floor(Math.random() * maxOff)
    const r = await fetch(SB + `/rest/v1/card_catalog?game=eq.${game}&embedding=not.is.null&image_url=not.is.null&number=not.like.product-*&select=id,name,number,set_name,image_url&limit=6&offset=${offset}`, { headers: h })
    const rows = await r.json()
    if (!Array.isArray(rows)) continue
    for (const c of rows) {
      if (seen.has(c.id)) continue
      const cnt = perSet.get(c.set_name) || 0
      if (cnt >= maxPerSet) continue
      seen.add(c.id); perSet.set(c.set_name, cnt + 1); picks.push(c)
    }
  }
  return { picks: picks.slice(0, N), total, sets: perSet.size }
}

// Kamera-simulering: skew (vinkel), rotation, lysstyrke/glare via brightness, blur, baggrund, JPEG.
// Glare-gradient via SVG-composite droppet — crasher pga. dimensions-tjek efter affine/rotate.
async function augment(buf) {
  const angle = Math.random() * 8 - 4
  const shear = Math.random() * 0.18 - 0.09
  const bright = 0.78 + Math.random() * 0.5   // bredt lysspænd simulerer over/undereksponering + glare
  const bg = { r: 30 + Math.floor(Math.random() * 40), g: 32, b: 38 }
  return sharp(buf)
    .affine([[1, shear], [0, 1]], { background: bg })
    .rotate(angle, { background: bg })
    .modulate({ brightness: bright, saturation: 0.85 + Math.random() * 0.3 })
    .blur(0.4 + Math.random() * 0.9)
    .resize(640, 880, { fit: 'inside' })
    .extend({ top: 35, bottom: 35, left: 35, right: 35, background: bg })
    .jpeg({ quality: 60 })
    .toBuffer()
}

async function scanOne(card, game) {
  let buf = Buffer.from(await (await fetch(card.image_url, { signal: AbortSignal.timeout(20000) })).arrayBuffer())
  if (MODE === 'aug') buf = await augment(buf)
  const r = await fetch(DEPLOY + '/api/scan-free', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vercel-protection-bypass': BYPASS },
    body: JSON.stringify({ image: 'data:image/jpeg;base64,' + buf.toString('base64'), game }),
    signal: AbortSignal.timeout(60000),
  })
  const body = await r.json()
  const cands = body.candidates || []
  const rank = cands.findIndex(c => c.id === card.id)   // -1 = slet ikke i kandidater
  return {
    idTop1:   cands[0]?.id === card.id,
    idTop3:   cands.slice(0, 3).some(c => c.id === card.id),
    nameTop1: !!(cands[0] && norm(cands[0].name) === norm(card.name)),
    nameTop3: cands.slice(0, 3).some(c => norm(c.name) === norm(card.name)),
    clip:     !!body.meta?.clip,
    top1:     cands[0] ? `${cands[0].name} ${cands[0].number}` : '(ingen)',
    // diagnostik
    rank,                                               // hvor det rigtige kort ligger
    ocr:      body.ocr ? (body.ocr.number || null) : null,
    trueNum:  card.number,
    t3:       cands.slice(0, 3).map(c => `${c.number}@${c.similarity}`),
  }
}

function readDone(file) {
  if (!existsSync(file)) return null
  const L = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(s => { try { return JSON.parse(s) } catch { return null } }).filter(Boolean)
  return L
}

function statsRow(game, L) {
  const ok = L.filter(l => !l.error)
  const n = ok.length || 1
  const pct = x => ((x / n) * 100).toFixed(1)
  return { game, n: ok.length, errors: L.length - ok.length,
    idTop1: pct(ok.filter(l => l.idTop1).length), idTop3: pct(ok.filter(l => l.idTop3).length),
    nameTop1: pct(ok.filter(l => l.nameTop1).length), nameTop3: pct(ok.filter(l => l.nameTop3).length),
    clip: pct(ok.filter(l => l.clip).length) }
}

async function runGame(game) {
  const file = `${OUTDIR}/${MODE}_${game}.jsonl`
  // Genoptag: hvis spillet allerede er kørt færdigt (≥95% af N), spring over.
  const existing = readDone(file)
  // Færdig = sentinel-linje (robust for små spil der ikke kan nå N pga. sæt-loft) ELLER ≥95% af N.
  const isComplete = existing && (existing.some(l => l._complete) || existing.length >= Math.floor(N * 0.95))
  if (isComplete) {
    const row = statsRow(game, existing)
    console.log(`\n=== ${game}: ALLEREDE FÆRDIG (${existing.length} kort) — springer over ===`)
    console.log(`  → ${game}: eksakt-id top1=${row.idTop1}% top3=${row.idTop3}% | navn top1=${row.nameTop1}% | clip=${row.clip}%`)
    return row
  }
  const { picks, total, sets } = await sample(game)
  writeFileSync(file, '')
  const agg = { idTop1: 0, idTop3: 0, nameTop1: 0, nameTop3: 0, clipUsed: 0, errors: 0, n: 0 }
  console.log(`\n=== ${game} (katalog: ${total}, sampler ${picks.length} fra ${sets} sæt, mode ${MODE}) ===`)
  // 3 samtidige scans → ~3x hurtigere → større chance for at nå færdig i ét aktivt vindue.
  const CONC = 3
  let done = 0
  for (let b = 0; b < picks.length; b += CONC) {
    const chunk = picks.slice(b, b + CONC)
    await Promise.all(chunk.map(async card => {
      try {
        const res = await scanOne(card, game)
        agg.n++
        if (res.idTop1) agg.idTop1++
        if (res.idTop3) agg.idTop3++
        if (res.nameTop1) agg.nameTop1++
        if (res.nameTop3) agg.nameTop3++
        if (res.clip) agg.clipUsed++
        appendFileSync(file, JSON.stringify({ id: card.id, set: card.set_name, ...res }) + '\n')
      } catch (e) {
        agg.errors++
        appendFileSync(file, JSON.stringify({ id: card.id, error: e.message }) + '\n')
      }
    }))
    done += chunk.length
    if (done % 30 < CONC) console.log(`  ${game}: ${done}/${picks.length}  (id-top1 så langt: ${agg.n ? ((agg.idTop1 / agg.n) * 100).toFixed(0) : 0}%)`)
    await sleep(80)
  }
  const n = agg.n || 1
  const pct = x => ((x / n) * 100).toFixed(1)
  const row = { game, n: agg.n, errors: agg.errors,
    idTop1: pct(agg.idTop1), idTop3: pct(agg.idTop3),
    nameTop1: pct(agg.nameTop1), nameTop3: pct(agg.nameTop3), clip: pct(agg.clipUsed) }
  console.log(`  → ${game}: eksakt-id top1=${row.idTop1}% top3=${row.idTop3}% | navn top1=${row.nameTop1}% | clip=${row.clip}% | fejl=${agg.errors}`)
  appendFileSync(file, JSON.stringify({ _complete: true, n: agg.n }) + '\n')  // sentinel → genoptag springer over
  return row
}

async function run() {
  mkdirSync(OUTDIR, { recursive: true })
  console.log(`\n📊 OMFATTENDE benchmark — spil=${GAME_ARG} N=${N} mode=${MODE}\n   deploy=${DEPLOY}`)
  const rows = []
  for (const game of GAMES) {
    let ok = false
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {   // retry transiente netværksfejl (fx yugioh "fetch failed")
      try { rows.push(await runGame(game)); ok = true }
      catch (e) { console.log(`  ${game}: forsøg ${attempt} fejlede — ${e.message}`); await sleep(3000) }
    }
    if (!ok) console.log(`  ${game}: OPGIVET efter 3 forsøg`)
  }
  console.log(`\n\n════ SAMLET RESULTAT (${MODE}) ════`)
  console.log('spil'.padEnd(12) + 'n'.padStart(5) + 'id-top1'.padStart(9) + 'id-top3'.padStart(9) + 'navn-top1'.padStart(11) + 'clip'.padStart(8) + 'fejl'.padStart(6))
  for (const r of rows) {
    console.log(r.game.padEnd(12) + String(r.n).padStart(5) + (r.idTop1+'%').padStart(9) + (r.idTop3+'%').padStart(9) + (r.nameTop1+'%').padStart(11) + (r.clip+'%').padStart(8) + String(r.errors).padStart(6))
  }
  writeFileSync(`${OUTDIR}/summary_${MODE}.json`, JSON.stringify(rows, null, 2))
}

run().catch(e => { console.error(e); process.exit(1) })
