/**
 * Kunst-region CLIP-embeddings for HELE YGO-kataloget (embedding_art) + embedding_combined.
 * YGO-kort er tekst-dominerede → hele-kort-embedding svag; kunst-region tredobler kort-ID (valideret).
 * Crop: monster-kunst-vindue x 0.08-0.92, y 0.155-0.505 (samme som scan-siden i embedding-server.js).
 * Resumérbart: springer billeder der allerede har embedding_art. Kør: node scripts/backfill-yugioh-art.mjs
 */
import 'dotenv/config'
import sharp from 'sharp'
import { pipeline, RawImage } from '@huggingface/transformers'
import { makeClient } from './pg-run.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
const clip = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32')
async function embArt(buf) {
  const m = await sharp(buf).metadata()
  const w = m.width || 1, h = m.height || 1
  const png = await sharp(buf).extract({ left: Math.round(w * 0.08), top: Math.round(h * 0.155), width: Math.max(1, Math.round(w * 0.84)), height: Math.max(1, Math.round(h * 0.35)) }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const img = new RawImage(new Uint8ClampedArray(png.data), png.info.width, png.info.height, 3)
  const v = Array.from((await clip(img, { pooling: 'mean', normalize: true })).data)
  return `[${v.map(x => Math.round(x * 1e5) / 1e5).join(',')}]`
}

const c = makeClient(); await c.connect()
const imgs = (await c.query(`SELECT DISTINCT image_url FROM card_catalog WHERE game='yugioh' AND embedding_art IS NULL AND image_url IS NOT NULL`)).rows.map(r => r.image_url)
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
  try { await c.query(`UPDATE card_catalog SET embedding_art = $1::vector WHERE game='yugioh' AND image_url = $2 AND embedding_art IS NULL`, [art, imgs[i]]); ok++ } catch { fail++ }
  if (i % 200 === 0) { const rate = (Date.now() - t0) / 1000 / (i + 1); process.stdout.write(`\r  ${i}/${imgs.length} ok=${ok} fail=${fail} eta=${Math.round((imgs.length - i) * rate / 60)}min`) }
}
// populér embedding_combined for alle ny-artede rækker
process.stdout.write('\n  populerer embedding_combined...')
const r = await c.query(`UPDATE card_catalog SET embedding_combined = l2_normalize(embedding) || l2_normalize(embedding_art) WHERE game='yugioh' AND embedding_art IS NOT NULL AND embedding IS NOT NULL AND embedding_combined IS NULL`)
console.log(` +${r.rowCount} rækker`)
const cov = (await c.query(`SELECT count(*) FILTER (WHERE embedding_combined IS NOT NULL) n FROM card_catalog WHERE game='yugioh'`)).rows[0].n
console.log(`✅ færdig: ${ok} billeder embeddet, ${fail} fejl. YGO combined-coverage: ${cov}`)
await c.end()
