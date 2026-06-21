/**
 * Spredt eBay-benchmark for det store Pokemon-testsæt (_ebay/raw_pokemon_big.jsonl).
 * Måler num+total + num-only mod nyeste Vercel-deploy, med 2s-pause (real-user, ikke burst).
 * Bryder ned PER ÆRA (fra titel-sætnavn) og PER RARITY-TIER (fra titel-nøgleord),
 * og logger hver fejl (eBay-kort + hvad scan returnerede) → isoleret vs systematisk.
 *
 * Brug: node scripts/ebay-bench-big.mjs [infile] [game]
 */
import 'dotenv/config'
import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

const INFILE = process.argv[2] || '_ebay/raw_pokemon_big.jsonl'
const GAME   = process.argv[3] || 'pokemon'
const BYPASS = 'm8N3Uz2ILE3TvJPPbrApokT6OWvVAlOC'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'

function newestDeploy() {
  const o = execSync('npx vercel ls --yes 2>nul || npx vercel ls --yes', { encoding: 'utf8' })
  return o.match(/https:\/\/pokegrade-[a-z0-9]+-stefana93\.vercel\.app/)[0]
}

// src kan være en URL (eBay) ELLER en lokal sti (bruger-uploadede rene kort) → returnér data-URL.
async function loadDataUrl(src) {
  if (/^https?:/.test(src)) {
    const buf = Buffer.from(await (await fetch(src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })).arrayBuffer())
    return 'data:image/webp;base64,' + buf.toString('base64')
  }
  const buf = readFileSync(src)
  const ext = (src.split('.').pop() || '').toLowerCase()
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,` + buf.toString('base64')
}

function eraOf(title) {
  const t = title.toLowerCase()
  if (/base set 2/.test(t)) return '1b WotC Base2'
  if (/expedition/.test(t)) return '1c e-card'
  if (/base set/.test(t)) return '1a WotC Base'
  if (/ex emerald|emerald/.test(t)) return '2 EX-era'
  if (/great encounters/.test(t)) return '3 DP-era'
  if (/hgss|heartgold/.test(t)) return '4 HGSS'
  if (/plasma storm/.test(t)) return '5 BW'
  if (/evolutions/.test(t)) return '6 XY'
  if (/cosmic eclipse/.test(t)) return '7 SM'
  if (/\b151\b/.test(t)) return '8 SV151'
  return '? unknown'
}

// rarity-tier prioriteret (vigtigst først); num>total signalerer ofte special/secret
function rarityOf(title, num, total) {
  const t = title.toLowerCase()
  if (/rainbow|gold secret|secret rare|secret\b/.test(t)) return 'a secret/rainbow'
  if (/special illustration|\bsir\b/.test(t)) return 'b SIR'
  if (/illustration rare|\bar\b/.test(t)) return 'c illust(AR)'
  if (/full art/.test(t)) return 'd full-art'
  if (/ace spec/.test(t)) return 'e ACE SPEC'
  if (/\bprime\b|legend|lv\.?\s?x|lv x/.test(t)) return 'f Prime/LEGEND/LvX'
  if (/\bex\b|\bgx\b|double rare|ultra rare/.test(t)) return 'g ex/GX/ultra'
  if (/reverse/.test(t)) return 'j reverse-holo'
  if (/cosmos holo|holo rare|holo\b/.test(t)) return 'h holo-rare'
  if (/uncommon/.test(t)) return 'k uncommon'
  if (/common/.test(t)) return 'l common'
  if (/\brare\b/.test(t)) return 'i rare'
  return 'z other'
}

function bump(map, key, ok) {
  if (!map[key]) map[key] = { n: 0, pass: 0 }
  map[key].n++; if (ok) map[key].pass++
}

async function run() {
  if (!existsSync(INFILE)) { console.log('Mangler ' + INFILE); return }
  const DEPLOY = newestDeploy()
  const rows = readFileSync(INFILE, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s))
  const outFile = INFILE.replace(/raw_/, 'results_').replace(/\.jsonl$/, '.jsonl')
  writeFileSync(outFile, '')
  console.log(`\neBay spredt benchmark — ${GAME} — n=${rows.length} — deploy=${DEPLOY}\n`)

  let numTotal = 0, numOnly = 0, scanned = 0
  const byEra = {}, byRarity = {}, fails = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const era = eraOf(row.title || ''), rar = rarityOf(row.title || '', row.num, row.total)
    let numOk = false, numTotalOk = false, topStr = 'ingen'
    try {
      const dataUrl = await loadDataUrl(row.src)
      const r = await fetch(`${DEPLOY}/api/scan-free`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vercel-protection-bypass': BYPASS }, body: JSON.stringify({ image: dataUrl, game: GAME }), signal: AbortSignal.timeout(60000) })
      const b = await r.json(); const top = b.candidates?.[0]
      const m = top ? String(top.number).match(/(\d{1,4})[a-z]?\s*(?:\/\s*(\d{1,4}))?/i) : null
      const tNum = m ? (m[1].replace(/^0+/, '') || '0') : '?'
      const tTot = m && m[2] ? +m[2] : null
      numOk = tNum === String(row.num)
      numTotalOk = numOk && tTot === row.total
      topStr = top ? `${top.name} ${top.number} (clip ${top._clip ?? '?'})` : 'ingen'
    } catch (e) { topStr = 'FEJL ' + e.message }
    if (numTotalOk) numTotal++; if (numOk) numOnly++; scanned++
    bump(byEra, era, numTotalOk); bump(byRarity, rar, numTotalOk)
    if (!numTotalOk) fails.push({ era, rar, ebay: `${row.num}/${row.total}`, got: topStr, title: row.title, src: row.src })
    appendFileSync(outFile, JSON.stringify({ era, rar, ebay: { num: row.num, total: row.total }, numOk, numTotalOk, got: topStr, title: row.title }) + '\n')
    const mark = numTotalOk ? '✅' : numOk ? '🟡' : '❌'
    console.log(`${String(i + 1).padStart(3)}/${rows.length} ${mark} [${era}|${rar}] eBay ${row.num}/${row.total} → ${topStr}`)
    await new Promise(r => setTimeout(r, 2000))
  }

  const pct = (p, n) => `${((p / (n || 1)) * 100).toFixed(0)}%`
  console.log(`\n══ SAMLET (n=${scanned}) ══`)
  console.log(`  num+total: ${pct(numTotal, scanned)} (${numTotal}/${scanned})   num-only: ${pct(numOnly, scanned)}`)
  console.log(`\n── PER ÆRA (num+total) ──`)
  for (const k of Object.keys(byEra).sort()) console.log(`  ${k.padEnd(16)} ${pct(byEra[k].pass, byEra[k].n).padStart(4)}  (${byEra[k].pass}/${byEra[k].n})`)
  console.log(`\n── PER RARITY (num+total) ──`)
  for (const k of Object.keys(byRarity).sort()) console.log(`  ${k.padEnd(20)} ${pct(byRarity[k].pass, byRarity[k].n).padStart(4)}  (${byRarity[k].pass}/${byRarity[k].n})`)
  console.log(`\n── FEJL (${fails.length}) ──`)
  for (const f of fails) console.log(`  ❌ [${f.era}|${f.rar}] ${f.ebay}  fik: ${f.got}  — ${f.title}`)
  console.log(`\nResultater: ${outFile}`)
}
run().catch(e => { console.error(e); process.exit(1) })
