/**
 * Kunst-region CLIP-embeddings for HELE One Piece-kataloget (embedding_art) + embedding_combined.
 * OP-katalogbilleder (Bandai) har et "SAMPLE"-vandmærke → hele-kort-embedding er korrupt (scan↔katalog
 * cosine 0.655). Øvre karakter-region (0.06-0.40) UNDGÅR vandmærket → 0.754, og retrieval top-1 30%→49%,
 * top-5 49%→65% (kombineret). Crop: x 0.05-0.95, y 0.06-0.40 — SAMME vindue som scan-siden
 * (embedding-server.js ART_WINDOWS.onepiece), så scan- og katalog-kunst-embeddings flugter.
 * Resumérbart: springer billeder der allerede har embedding_art. Kør: node scripts/backfill-onepiece-art.mjs
 */
import 'dotenv/config'
import sharp from 'sharp'
import { pipeline, RawImage } from '@huggingface/transformers'
import { makeClient } from './pg-run.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
const WIN = { l: 0.05, t: 0.06, w: 0.90, h: 0.34 }   // = ART_WINDOWS.onepiece
const clip = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32')
async function embArt(buf) {
  const m = await sharp(buf).metadata()
  const w = m.width || 1, h = m.height || 1
  const png = await sharp(buf).extract({ left: Math.round(w * WIN.l), top: Math.round(h * WIN.t), width: Math.max(1, Math.round(w * WIN.w)), height: Math.max(1, Math.round(h * WIN.h)) }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const img = new RawImage(new Uint8ClampedArray(png.data), png.info.width, png.info.height, 3)
  const v = Array.from((await clip(img, { pooling: 'mean', normalize: true })).data)
  return `[${v.map(x => Math.round(x * 1e5) / 1e5).join(',')}]`
}

const c = makeClient(); await c.connect()
const imgs = (await c.query(`SELECT DISTINCT image_url FROM card_catalog WHERE game='onepiece' AND embedding_art IS NULL AND image_url IS NOT NULL AND number NOT LIKE 'product-%'`)).rows.map(r => r.image_url)
console.log(`resterende unikke billeder: ${imgs.length}`)
let ok = 0, fail = 0
const t0 = Date.now()
for (let i = 0; i < imgs.length; i++) {
  let art = null
  for (let a = 0; a < 2 && !art; a++) {
    try { const buf = Buffer.from(await (await fetch(imgs[i], { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })).arrayBuffer()); art = await embArt(buf) }
    catch { await new Promise(s => setTimeout(s, 300)) }
  }
  if (!art) { fail++; continue }
  try { await c.query(`UPDATE card_catalog SET embedding_art = $1::vector WHERE game='onepiece' AND image_url = $2 AND embedding_art IS NULL`, [art, imgs[i]]); ok++ } catch { fail++ }
  if (i % 200 === 0) { const rate = (Date.now() - t0) / 1000 / (i + 1); process.stdout.write(`\r  ${i}/${imgs.length} ok=${ok} fail=${fail} eta=${Math.round((imgs.length - i) * rate / 60)}min`) }
}
process.stdout.write('\n  populerer embedding_combined...')
const r = await c.query(`UPDATE card_catalog SET embedding_combined = l2_normalize(embedding) || l2_normalize(embedding_art) WHERE game='onepiece' AND embedding_art IS NOT NULL AND embedding IS NOT NULL AND embedding_combined IS NULL`)
console.log(` +${r.rowCount} rækker`)
const cov = (await c.query(`SELECT count(*) FILTER (WHERE embedding_combined IS NOT NULL) n FROM card_catalog WHERE game='onepiece'`)).rows[0].n
console.log(`✅ færdig: ${ok} billeder embeddet, ${fail} fejl. OP combined-coverage: ${cov}`)
await c.end()
