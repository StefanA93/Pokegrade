/**
 * Valider auto-crop v3 ende-til-ende: for hvert eBay-kort, anvend v3-crop FØR Railway,
 * og mål OCR + korrekt korts rank i match_cards-poolen. Sammenlign mod baseline (rå ramme).
 *
 * Brug: node scripts/diag-v3-validate.js
 */
import 'dotenv/config'
import { readFileSync } from 'fs'
import sharp from 'sharp'

const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const RWY = 'https://pokegrade-production-683f.up.railway.app', RSEC = 'gd_embed_2024'
const SET_ID = '5500048', GAME = 'pokemon'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36'
const h = { apikey: KEY, Authorization: 'Bearer ' + KEY }
const numPart = s => { const m = String(s).match(/(\d{1,4})/); return m ? String(parseInt(m[1], 10)) : null }
const rows = readFileSync('_ebay/raw_pokemon.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l))

// ── auto-crop v3 (kopi af den testede funktion) ──
async function autoCropCardV3(buf) {
  try {
    const N = 256
    const { data, info } = await sharp(buf).resize(N, N, { fit: 'fill' }).grayscale().blur(0.6).raw().toBuffer({ resolveWithObject: true })
    const w = info.width, h = info.height, g = (x, y) => data[y * w + x]
    const rowMass = new Array(h).fill(0), colMass = new Array(w).fill(0)
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const m = Math.abs(g(x + 1, y) - g(x - 1, y)) + Math.abs(g(x, y + 1) - g(x, y - 1)); rowMass[y] += m; colMass[x] += m
    }
    const smooth = p => p.map((_, i) => { let s = 0, n = 0; for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < p.length) { s += p[j]; n++ } } return s / n })
    const rM = smooth(rowMass), cM = smooth(colMass)
    const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
    const extent = (p, th) => { let a = 0, b = p.length - 1; while (a < p.length && p[a] < th) a++; while (b > a && p[b] < th) b--; return [a, b] }
    const [top, bot] = extent(rM, median(rM) * 0.40), [lft, rgt] = extent(cM, median(cM) * 0.40)
    const bw = rgt - lft, bh = bot - top, frac = (bw * bh) / (w * h)
    const coreMean = rM.slice(top, bot + 1).reduce((s, v) => s + v, 0) / Math.max(1, bh)
    const marginRows = [...rM.slice(0, top), ...rM.slice(bot + 1)]
    const marginMean = marginRows.length ? marginRows.reduce((s, v) => s + v, 0) / marginRows.length : coreMean
    if (frac > 0.86 || bw < w * 0.35 || bh < h * 0.35 || marginMean >= coreMean * 0.55) return { buf, cropped: false }
    const meta = await sharp(buf).metadata()
    const L = Math.max(0, Math.floor((lft / w - 0.015) * meta.width)), T = Math.max(0, Math.floor((top / h - 0.02) * meta.height))
    const R = Math.min(meta.width, Math.ceil((rgt / w + 0.015) * meta.width)), B = Math.min(meta.height, Math.ceil((bot / h + 0.04) * meta.height))
    return { buf: await sharp(buf).extract({ left: L, top: T, width: R - L, height: B - T }).toBuffer(), cropped: true }
  } catch { return { buf, cropped: false } }
}

async function railwayEmbed(buf) {
  const b64 = (await sharp(buf).resize(800, 800, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()).toString('base64')
  const r = await fetch(`${RWY}/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RSEC}` },
    body: JSON.stringify({ image: `data:image/jpeg;base64,${b64}`, game: GAME }), signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`Railway ${r.status}`)
  return r.json()
}
async function matchRank(embedding, correctId) {
  const r = await fetch(`${SB}/rest/v1/rpc/match_cards`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_embedding: `[${embedding.join(',')}]`, game_filter: GAME, match_count: 30 }) })
  const pool = r.ok ? await r.json() : []
  const rank = correctId ? pool.findIndex(c => c.id === correctId) : -2
  return { rank, sim: rank >= 0 ? pool[rank].similarity : null, pool: pool.length }
}
async function correctCard(num) {
  const r = await fetch(`${SB}/rest/v1/card_catalog?game=eq.${GAME}&set_id=eq.${SET_ID}&number=like.*${num}/203*&select=id,name,number`, { headers: h })
  const d = r.ok ? await r.json() : []
  return d.find(c => numPart(c.number) === numPart(num)) || d[0] || null
}

console.log('num   | crop | OCR(v3)        | rank(v3)   | numOk')
console.log('------|------|----------------|------------|------')
let pass = 0
for (const row of rows) {
  try {
    const raw = Buffer.from(await (await fetch(row.src, { headers: { 'User-Agent': UA } })).arrayBuffer())
    const norm = await sharp(raw).resize(900).jpeg({ quality: 90 }).toBuffer()
    const { buf, cropped } = await autoCropCardV3(norm)
    const { embedding, ocr } = await railwayEmbed(buf)
    const correct = await correctCard(row.num)
    const { rank, sim } = await matchRank(embedding, correct?.id)
    const ocrStr = ocr?.number ? `${ocr.number}/${ocr.setTotal ?? '?'}` : 'null'
    const numOk = ocr?.number && numPart(ocr.number) === numPart(row.num)
    if (numOk) pass++
    const rankStr = rank === -1 ? 'IKKE-I-POOL' : rank === -2 ? 'n/a' : `#${rank + 1}(${sim?.toFixed(2)})`
    console.log(`${String(row.num).padStart(3)}/203| ${cropped ? 'JA ' : 'no '} | ${ocrStr.padEnd(14)} | ${rankStr.padEnd(10)} | ${numOk ? '✅' : '❌'}`)
  } catch (e) { console.log(`${row.num}: ERR ${e.message}`) }
}
console.log(`\nOCR-læst korrekt nummer: ${pass}/${rows.length} (baseline rå-ramme: 5/16)`)
