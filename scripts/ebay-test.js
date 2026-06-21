/**
 * eBay real-world test — collector + benchmark med KATALOG-FORANKREDE labels.
 *
 * Input:  _ebay/raw_<game>.jsonl  (linjer: {num, total, src, title}) — udtrukket fra eBay via browser.
 * Flow pr. kort:
 *   1. Parse num/total fra titlen.
 *   2. Slå op i VORES katalog (game + number-match + evt. total) → få eksakt {id, name, set_name}.
 *      = label-pålidelighed: vi scorer mod et kort der FAKTISK findes i kataloget.
 *   3. Download eBay-fotoet, scan via nyeste deployment (auto-crop live).
 *   4. Score: scan top-1 == katalog-id (eksakt) ELLER samme nummer (lempeligt).
 * Output: _ebay/results_<game>.jsonl + samlet accuracy.
 *
 * Brug: node scripts/ebay-test.js pokemon
 */
import 'dotenv/config'
import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

const GAME = process.argv[2] || 'pokemon'
const SB   = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const KEY  = process.env.SUPABASE_SERVICE_KEY
const BYPASS = 'm8N3Uz2ILE3TvJPPbrApokT6OWvVAlOC'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
const h = { apikey: KEY, Authorization: 'Bearer ' + KEY }
const norm = n => String(n || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/ - .*/, '').replace(/[^a-z0-9]/g, '')

function newestDeploy() {
  const o = execSync('npx vercel ls --yes 2>nul || npx vercel ls --yes', { encoding: 'utf8' })
  return o.match(/https:\/\/pokegrade-[a-z0-9]+-stefana93\.vercel\.app/)[0]
}

// Find det katalog-kort der bedst matcher et eBay-nummer (number-del + total hvis muligt)
// Brug match_cards_number_setsize-RPC'en: finder kort med nummer-del == num i et sæt af
// størrelse ~total. Korrekt normaliseret (regexp) → undgår "63/114 i stedet for 63/203"-fejlen.
async function catalogMatch(num, total) {
  if (!total) return null
  const r = await fetch(`${SB}/rest/v1/rpc/match_cards_number_setsize`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_game: GAME, p_number: String(num), p_set_total: total }),
  })
  const ids = r.ok ? await r.json() : []
  if (!ids.length) return null
  const det = await fetch(`${SB}/rest/v1/card_catalog?id=eq.${encodeURIComponent(ids[0].id)}&select=id,name,number,set_name`, { headers: h })
  const [card] = det.ok ? await det.json() : []
  return card ? { id: card.id, name: card.name, number: card.number, set_name: card.set_name, candidates: ids.length } : null
}

// Label = eBay-titlens (num, total). Score = scan top-1's nummer+total vs det.
// num+total er det robuste mål: "rigtigt kort i rigtigt sæt" uden skrøbeligt katalog-opslag.
async function run() {
  const inFile = `_ebay/raw_${GAME}.jsonl`
  if (!existsSync(inFile)) { console.log('Mangler ' + inFile + ' — udtræk eBay-par fra browser først'); return }
  const DEPLOY = newestDeploy()
  console.log(`\neBay real-world test — ${GAME} — deploy=${DEPLOY}\n`)
  const rows = readFileSync(inFile, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s))
  const outFile = `_ebay/results_${GAME}.jsonl`; writeFileSync(outFile, '')
  let numTotal = 0, numOnly = 0, scanned = 0
  for (const row of rows) {
    try {
      const buf = Buffer.from(await (await fetch(row.src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })).arrayBuffer())
      const r = await fetch(`${DEPLOY}/api/scan-free`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vercel-protection-bypass': BYPASS }, body: JSON.stringify({ image: 'data:image/webp;base64,' + buf.toString('base64'), game: GAME }), signal: AbortSignal.timeout(60000) })
      const b = await r.json(); const top = b.candidates?.[0]
      const m = top ? String(top.number).match(/(\d{1,4})(?:\/(\d{1,4}))?/) : null
      const tNum = m ? (m[1].replace(/^0+/, '') || '0') : '?'
      const tTot = m && m[2] ? +m[2] : null
      const numOk = tNum === String(row.num)
      const numTotalOk = numOk && tTot === row.total
      if (numTotalOk) numTotal++; if (numOk) numOnly++; scanned++
      appendFileSync(outFile, JSON.stringify({ ebay: { num: row.num, total: row.total }, top1: top ? { name: top.name, number: top.number } : null, numOk, numTotalOk }) + '\n')
      console.log(`${numTotalOk ? '✅' : numOk ? '🟡num' : '❌'}  eBay ${row.num}/${row.total}  →  ${top ? top.name + ' ' + top.number + ' (' + top._clip + ')' : 'ingen'}`)
    } catch (e) { console.log('fejl ' + row.num + ': ' + e.message); scanned++ }
    await new Promise(r => setTimeout(r, 2000))   // real-user spredt (ikke burst) → måler isolation-performance
  }
  console.log(`\n── ${GAME} real-world (n=${scanned}) ──`)
  console.log(`  num+total-match (rigtigt kort+sæt): ${((numTotal / (scanned || 1)) * 100).toFixed(0)}%`)
  console.log(`  num-only-match:                     ${((numOnly / (scanned || 1)) * 100).toFixed(0)}%`)
}
run().catch(e => { console.error(e); process.exit(1) })
