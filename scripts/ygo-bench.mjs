import 'dotenv/config'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

// YGO is a CODE_GAME: ground-truth = base name + set-code (region-agnostic). Scores name, code, and
// code+name (the strong metric, analogous to num+total for slash games). Run after warming Railway
// (OCR + CLIP services) and deploying the code-regex fix.

const INFILE = '_ebay/raw_yugioh.jsonl'
const BYPASS = 'm8N3Uz2ILE3TvJPPbrApokT6OWvVAlOC'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
const DEPLOY = execSync('npx vercel ls --yes 2>nul || npx vercel ls --yes', { encoding: 'utf8' }).match(/https:\/\/pokegrade-[a-z0-9]+-stefana93\.vercel\.app/)[0]

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '')
const baseName = s => String(s || '').replace(/\s*\([^)]*\)\s*$/, '')
const nameMatch = (a, b) => { const x = norm(baseName(a)), y = norm(baseName(b)); return x && y && (x === y || x.includes(y) || y.includes(x)) }
// region-agnostic: PREFIX-<region?><digits> → "PREFIX|<int>"
const codeKey = s => { const m = String(s || '').toUpperCase().match(/^([A-Z0-9]+)-[A-Z]*?(\d+)$/); return m ? `${m[1]}|${parseInt(m[2], 10)}` : String(s || '').toUpperCase().replace(/\s/g, '') }

const rows = readFileSync(INFILE, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s))
console.log(`\nYGO benchmark — n=${rows.length} — deploy=${DEPLOY}\n`)
let nameOk = 0, codeOk = 0, bothOk = 0, ocrReadOk = 0
let failReadNotInjected = 0, failNotRead = 0
const byBucket = {}, fails = []
for (let i = 0; i < rows.length; i++) {
  const row = rows[i]
  let ok = { name: false, code: false }, top = 'ingen', ocrRead = false, ocrCode = null, codeHits = null
  try {
    const buf = Buffer.from(await (await fetch(row.src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })).arrayBuffer())
    const r = await fetch(`${DEPLOY}/api/scan-free`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vercel-protection-bypass': BYPASS }, body: JSON.stringify({ image: 'data:image/webp;base64,' + buf.toString('base64'), game: 'yugioh' }), signal: AbortSignal.timeout(90000) })
    const b = await r.json(); const t = b.candidates?.[0]
    ocrCode = b.ocr?.number ?? null                         // hvad OCR læste som kode
    codeHits = b.meta?.codeHits ?? null                     // fyrede kode-injektion? (antal)
    ocrRead = ocrCode ? codeKey(ocrCode) === codeKey(row.number) : false
    if (t) {
      ok.name = nameMatch(t.name, row.name)
      ok.code = codeKey(t.number) === codeKey(row.number)
      top = `${t.name} ${t.number} (clip ${t._clip})`
    }
  } catch (e) { top = 'FEJL ' + e.message }
  if (ok.name) nameOk++; if (ok.code) codeOk++; if (ok.name && ok.code) bothOk++; if (ocrRead) ocrReadOk++
  const bk = row.bucket || '?'
  byBucket[bk] = byBucket[bk] || { n: 0, name: 0, both: 0 }; byBucket[bk].n++; if (ok.name) byBucket[bk].name++; if (ok.name && ok.code) byBucket[bk].both++
  if (!(ok.name && ok.code)) {
    // diagnose: blev koden læst korrekt men vi tabte alligevel (injektion-problem) vs ikke-læst (OCR-problem)
    if (ocrRead) failReadNotInjected++; else failNotRead++
    fails.push({ bk, want: `${row.name} ${row.number}`, got: top, ocr: ocrCode, read: ocrRead, ch: codeHits })
  }
  console.log(`${String(i + 1).padStart(3)}/${rows.length} ${ok.name && ok.code ? '✅' : ok.name ? '🟡' : '❌'} [${bk}] ${row.name} ${row.number} → ${top}  {ocr:${ocrCode || '-'} read:${ocrRead ? 'Y' : 'n'} inj:${codeHits ?? '-'}}`)
  await new Promise(r => setTimeout(r, 2000))
}
const pct = (p, n) => `${((p / (n || 1)) * 100).toFixed(0)}%`
console.log(`\n══ SAMLET (n=${rows.length}) ══`)
console.log(`  NAVN: ${pct(nameOk, rows.length)} (${nameOk})  |  KODE: ${pct(codeOk, rows.length)} (${codeOk})  |  KODE+NAVN: ${pct(bothOk, rows.length)} (${bothOk})`)
console.log(`  OCR læste koden korrekt: ${pct(ocrReadOk, rows.length)} (${ocrReadOk})`)
console.log(`  FEJL-SPLIT: kode-læst-men-tabt (→ injektion-lever) ${failReadNotInjected}  |  ikke-læst (→ OCR-crop-lever) ${failNotRead}`)
console.log('\n── PER BUCKET (navn | kode+navn) ──')
for (const k of Object.keys(byBucket).sort()) console.log(`  ${k.padEnd(8)} navn ${pct(byBucket[k].name, byBucket[k].n).padStart(4)}  k+n ${pct(byBucket[k].both, byBucket[k].n).padStart(4)}  (n=${byBucket[k].n})`)
console.log(`\n── FEJL (${fails.length}) ──`)
for (const f of fails) console.log(`  ❌ [${f.bk}] ${f.want} → ${f.got}  {ocr:${f.ocr || '-'} ${f.read ? 'LÆST' : 'ej-læst'} inj:${f.ch ?? '-'}}`)
