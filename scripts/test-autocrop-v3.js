/**
 * Test-harness for auto-crop v3 (rigtig kort-rektangel-detektion via gradient-projektion).
 * Kører detektoren på alle eBay-fotos (skal croppe tæt) + clean katalog-renders (skal no-op).
 * Skriver croppede billeder til _ocrdebug/v3/ så de kan inspiceres visuelt.
 *
 * Brug: node scripts/test-autocrop-v3.js
 */
import 'dotenv/config'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import sharp from 'sharp'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36'
mkdirSync('_ocrdebug/v3', { recursive: true })

// ─── AUTO-CROP V3 ──────────────────────────────────────────────────────────
// Find kortets bbox via gradient-projektion. Kortets 4 kanter er lange lige
// højkontrast-linjer → skarpe toppe i række/kolonne-gradient-profilerne.
// Scanner udefra-ind, tager yderste kant hvor profilen krydser en relativ tærskel.
// Robust mod teksturerede/farvede baggrunde (modsat v2's farve-heuristik).
async function autoCropCardV3(buf, dbg = null) {
  try {
    const N = 256
    const { data, info } = await sharp(buf).resize(N, N, { fit: 'fill' }).grayscale().blur(0.6).raw().toBuffer({ resolveWithObject: true })
    const w = info.width, h = info.height
    const g = (x, y) => data[y * w + x]

    // Gradient-masse-profiler: kortets indre (tekst/art/border) er kant-tæt, baggrunds-
    // margener er kant-fattige. rowMass[y]/colMass[x] = samlet gradient pr. række/kolonne.
    const rowMass = new Array(h).fill(0), colMass = new Array(w).fill(0)
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const m = Math.abs(g(x + 1, y) - g(x - 1, y)) + Math.abs(g(x, y + 1) - g(x, y - 1))
        rowMass[y] += m; colMass[x] += m
      }
    }
    // Glat profilerne (glidende gennemsnit, vindue 5) → robust mod enkelt-pixel-støj
    const smooth = (p) => p.map((_, i) => {
      let s = 0, n = 0
      for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < p.length) { s += p[j]; n++ } }
      return s / n
    })
    const rM = smooth(rowMass), cM = smooth(colMass)

    // Kort-udstrækning = første/sidste indeks hvor masse ≥ tærskel (vedvarende kort-indhold,
    // ikke en enkelt top). Tærskel relativ til profilens median (= typisk kort-række-masse).
    const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
    const extent = (p, th) => {
      let a = 0, b = p.length - 1
      while (a < p.length && p[a] < th) a++
      while (b > a && p[b] < th) b--
      return [a, b]
    }
    const rThr = median(rM) * 0.40, cThr = median(cM) * 0.40
    const [top, bot] = extent(rM, rThr), [lft, rgt] = extent(cM, cThr)

    const bw = rgt - lft, bh = bot - top, frac = (bw * bh) / (w * h)
    // Konfidens: er margenen vi trimmer faktisk kant-fattig ift. kort-kernen? Ellers er
    // billedet sandsynligvis kant-tæt overalt (clean render el. busy bg) → no-op (sikkert).
    const coreMean = rM.slice(top, bot + 1).reduce((s, v) => s + v, 0) / Math.max(1, bh)
    const marginRows = [...rM.slice(0, top), ...rM.slice(bot + 1)]
    const marginMean = marginRows.length ? marginRows.reduce((s, v) => s + v, 0) / marginRows.length : coreMean
    const lowMargin = marginMean < coreMean * 0.55
    if (dbg) Object.assign(dbg, { top: top/h, bot: bot/h, lft: lft/w, rgt: rgt/w, frac, lowMargin })

    // Guards: kort fylder rammen (clean) ELLER detektion fejlede ELLER ingen klar margen → no-op
    if (frac > 0.86 || bw < w * 0.35 || bh < h * 0.35 || !lowMargin) { if (dbg) dbg.action = 'no-op'; return buf }
    if (dbg) dbg.action = 'CROP'

    // Generøs bund-padding (+4%) så nummer-båndet ALDRIG skæres; mindre på øvrige sider.
    const meta = await sharp(buf).metadata()
    const L = Math.max(0, Math.floor((lft / w - 0.015) * meta.width))
    const T = Math.max(0, Math.floor((top / h - 0.02) * meta.height))
    const R = Math.min(meta.width, Math.ceil((rgt / w + 0.015) * meta.width))
    const B = Math.min(meta.height, Math.ceil((bot / h + 0.04) * meta.height))
    return await sharp(buf).extract({ left: L, top: T, width: R - L, height: B - T }).toBuffer()
  } catch (e) { if (dbg) dbg.action = 'err:' + e.message; return buf }
}

// ─── Kør på eBay-fotos + clean renders ─────────────────────────────────────
async function dl(url, headers = {}) {
  const r = await fetch(url, { headers })
  return Buffer.from(await r.arrayBuffer())
}

const ebayRows = readFileSync('_ebay/raw_pokemon.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l))

console.log('=== eBay fotos (skal CROPpe) ===')
for (const row of ebayRows) {
  try {
    const buf = await dl(row.src, { 'User-Agent': UA })
    const norm = await sharp(buf).resize(900).jpeg({ quality: 90 }).toBuffer()
    const dbg = {}
    const out = await autoCropCardV3(norm, dbg)
    await sharp(out).resize(500).png().toFile(`_ocrdebug/v3/ebay_${row.num}.png`)
    console.log(`  ${String(row.num).padStart(3)}/203  ${dbg.action.padEnd(6)}  frac=${dbg.frac?.toFixed(3)}  box[T${dbg.top?.toFixed(2)} B${dbg.bot?.toFixed(2)} L${dbg.lft?.toFixed(2)} R${dbg.rgt?.toFixed(2)}]`)
  } catch (e) { console.log(`  ${row.num}: ERR ${e.message}`) }
}

console.log('\n=== Clean katalog-renders (skal NO-OP) ===')
const clean = [
  ['Sylveon V 074', 'https://images.pokemontcg.io/swsh7/74_hires.png'],
  ['Galarian Zapdos 082', 'https://images.pokemontcg.io/swsh7/82_hires.png'],
  ['Dialga 112', 'https://images.pokemontcg.io/swsh7/112_hires.png'],
]
for (const [name, url] of clean) {
  const buf = await dl(url)
  const norm = await sharp(buf).resize(900).jpeg({ quality: 90 }).toBuffer()
  const dbg = {}
  await autoCropCardV3(norm, dbg)
  console.log(`  ${name.padEnd(22)} ${dbg.action.padEnd(6)} frac=${dbg.frac?.toFixed(3)}`)
}
