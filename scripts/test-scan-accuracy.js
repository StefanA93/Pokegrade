/**
 * Scan Accuracy Benchmark
 *
 * Test 1 — Søgepræcision (hvad søgning faktisk kan):
 *   a) Eksakt navn → returneres et kort med det korrekte navn i top-1/3/5?
 *   b) OCR-støjede navne → overlever fejl i søgning?
 *
 * Test 2 — OCR-præcision:
 *   Officielle kortbilleder → hvad læser Tesseract?
 *   (Bemærk: officielle renders ≠ rigtige fotos; tester grænsetilfælde)
 *
 * Test 3 — Fuld pipeline:
 *   Officielt kortbillede → scanCard() → korrekt ID i resultatliste?
 *
 * Kør: node scripts/test-scan-accuracy.js
 */

import 'dotenv/config'
import { searchCards } from '../packages/search/index.js'
import { extractCardName, cleanup as cleanupOCR } from '../packages/scanner/ocr.js'
import { scanCard } from '../packages/scanner/index.js'
import { dbSelect } from '../server/middleware/db.js'

// ─── Testkorpus: [katalogId, eksakt-navn, sæt, beskrivelse] ─────────────────
const TEST_CARDS = [
  ['pokemon-sv4pt5-54',     'Charizard ex',              'Paldean Fates',          'populær ex'],
  ['pokemon-sv4pt5-234',    'Charizard ex',              'Paldean Fates',          'SIR variant'],
  ['pokemon-sv3pt5-36',     'Pikachu ex',                '151',                    'ikonisk ex'],
  ['pokemon-sv1-198',       'Miraidon ex',               'Scarlet & Violet',       'launch-kort'],
  ['pokemon-sv1-182',       'Koraidon ex',               'Scarlet & Violet',       'launch-kort'],
  ['pokemon-sv2-182',       'Gardevoir ex',              'Paldea Evolved',         'tier-1'],
  ['pokemon-sv3-185',       'Iono',                      'Obsidian Flames',        'Trainer'],
  ['pokemon-base1-4',       'Charizard',                 'Base Set',               'klassiker holo'],
  ['pokemon-base1-15',      'Venusaur',                  'Base Set',               'klassiker holo'],
  ['pokemon-base1-6',       'Gyarados',                  'Base Set',               'holo rare'],
  ['pokemon-base1-16',      'Zapdos',                    'Base Set',               'holo rare'],
  ['pokemon-sv4-199',       'Iron Thorns ex',            'Paradox Rift',           'dobbeltord ex'],
  ['pokemon-sv4-245',       'Sandy Shocks ex',           'Paradox Rift',           'dobbeltord ex'],
  ['pokemon-sv3-198',       'Tyranitar ex',              'Obsidian Flames',        'ex'],
  ['pokemon-swsh12pt5-160', 'Lugia V',                   'Crown Zenith',           'V-kort'],
  ['pokemon-swsh12-183',    'Arceus VSTAR',              'Brilliant Stars',        'VSTAR'],
  ['pokemon-swsh12-186',    'Charizard VSTAR',           'Brilliant Stars',        'VSTAR'],
  ['pokemon-swsh10-154',    'Giratina VSTAR',            'Lost Origin',            'VSTAR'],
  ['pokemon-swsh4-186',     'Rayquaza VMAX',             'Evolving Skies',         'VMAX'],
  ['pokemon-sv5-180',       'Ogerpon ex',                'Twilight Masquerade',    'ny ex'],
  ['pokemon-sv1-186',       'Arven',                     'Scarlet & Violet',       'Trainer'],
]

// Fuzzy-navne der simulerer typiske OCR-fejl
const FUZZY_TESTS = [
  { query: 'charizard ex',         expectName: 'Charizard ex'  },
  { query: 'Chariizard ex',        expectName: 'Charizard ex'  },  // dobbelttegn
  { query: 'pikach ex',            expectName: 'Pikachu ex'    },  // afkortet
  { query: 'Venusaur 100 HP',      expectName: 'Venusaur'      },  // HP-støj
  { query: 'Zapdos 90 HP',         expectName: 'Zapdos'        },  // HP-støj
  { query: 'Girateen VSTAR',       expectName: 'Giratina VSTAR' }, // udtale-fejl
  { query: 'Iron Thorns',          expectName: 'Iron Thorns ex' }, // mangler ex
  { query: 'iono',                 expectName: 'Iono'           }, // lowercase
  { query: 'arven trainer',        expectName: 'Arven'          }, // ekstra ord
]

const CONCURRENCY   = 3
const DOWNLOAD_MS   = 15000

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function pct(n, d)  { return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%` }
function pad(s, n)  { return String(s).padEnd(n) }

async function downloadImage(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), DOWNLOAD_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  } finally { clearTimeout(t) }
}

// ─── Test 1a: Navnesøgning (eksakt) ─────────────────────────────────────────

async function testExactSearch() {
  console.log('\n━━━ TEST 1a: Eksakt navnesøgning (navn → Meilisearch) ━━━')
  console.log('  Spørgsmål: returneres ET KORREKT NAVNGIVET kort i top-N?\n')
  console.log(pad('Søgeord', 26), pad('Sæt', 20), pad('Top-1', 7), pad('Top-3', 7), 'Meilisearch-score')
  console.log('─'.repeat(75))

  let top1 = 0, top3 = 0, top5 = 0, total = 0

  for (const [catalogId, name, set] of TEST_CARDS) {
    const nameNorm = name.toLowerCase()
    const results  = await searchCards(name, { gameId: 'pokemon', limit: 5 }).catch(() => [])

    // Hit = et resultat hvis navn matcher (case-insensitive)
    const hits  = results.filter(r => r.name?.toLowerCase() === nameNorm)
    const rank  = hits.length ? results.findIndex(r => r.name?.toLowerCase() === nameNorm) + 1 : 0

    const inTop1 = rank === 1
    const inTop3 = rank >= 1 && rank <= 3
    const inTop5 = rank >= 1 && rank <= 5

    if (inTop1) top1++
    if (inTop3) top3++
    if (inTop5) top5++
    total++

    const scoreStr = results[0]?._searchScore?.toFixed(3) ?? '—'
    const rankStr  = rank === 0 ? '✗ ' : rank === 1 ? '✅' : `#${rank}`
    console.log(pad(name, 26), pad(set.slice(0, 19), 20), pad(rankStr, 7), pad(inTop3 ? '✓' : '✗', 7), scoreStr)
    await sleep(30)
  }

  console.log('─'.repeat(75))
  console.log(`\nTop-1: ${pct(top1, total)}  |  Top-3: ${pct(top3, total)}  |  Top-5: ${pct(top5, total)}  (${total} kort)`)
  return { top1, top3, top5, total }
}

// ─── Test 1b: Fuzzy/OCR-støjede søgninger ───────────────────────────────────

async function testFuzzySearch() {
  console.log('\n━━━ TEST 1b: Fuzzy søgning (OCR-støjede navne) ━━━\n')
  console.log(pad('OCR-forvrengt tekst', 28), pad('Forventet navn', 22), pad('Top-1', 7), 'Hvad returneres')
  console.log('─'.repeat(80))

  let hits = 0, total = 0

  for (const { query, expectName } of FUZZY_TESTS) {
    const results   = await searchCards(query, { gameId: 'pokemon', limit: 5 }).catch(() => [])
    const top1name  = results[0]?.name ?? '—'
    const found     = top1name.toLowerCase().includes(expectName.split(' ')[0].toLowerCase())

    if (found) hits++
    total++

    console.log(pad(`"${query}"`, 28), pad(expectName, 22), pad(found ? '✅' : '✗ ', 7), `"${top1name}"`)
    await sleep(30)
  }

  console.log('─'.repeat(80))
  console.log(`\nFuzzy top-1: ${pct(hits, total)}  (${hits}/${total})`)
  return { hits, total }
}

// ─── Test 2+3: OCR + fuld pipeline ─────────────────────────────────────────

async function testOCRAndPipeline(catalogCards) {
  console.log('\n━━━ TEST 2+3: OCR-præcision + Fuld pipeline (officielle billeder) ━━━')
  console.log('  Officielle renders bruges som bedste-tilfælde proxy for rigtige fotos.\n')
  console.log(
    pad('Kort', 24), pad('OCR læste', 26), pad('Conf', 6),
    pad('OCR✓', 5), pad('Top1', 5), 'Auto'
  )
  console.log('─'.repeat(80))

  let ocrCorrect = 0, pipeTop1 = 0, pipeTop3 = 0, autoMatch = 0
  let ocrTotal   = 0, pipeTotal = 0, totalMs = 0

  const queue = [...catalogCards]
  while (queue.length) {
    const batch   = queue.splice(0, CONCURRENCY)
    const results = await Promise.all(batch.map(async ({ catalogId, name, imageUrl }) => {
      if (!imageUrl) return { catalogId, name, skip: 'no image' }
      try {
        const t0  = Date.now()
        const buf = await downloadImage(imageUrl)

        const { text: ocrText, confidence: ocrConf } = await extractCardName(buf, 'pokemon')

        const scan = await scanCard(buf, {
          game: 'pokemon',
          searchFn: (q, opts) => searchCards(q, opts),
        })

        const ms        = Date.now() - t0
        const firstName = name.split(' ')[0].toLowerCase()
        const ocrOk     = ocrText.toLowerCase().includes(firstName)
        const allCands  = scan.match ? [scan.match, ...(scan.candidates || [])] : (scan.candidates || [])
        const rank      = allCands.findIndex(c => c.id === catalogId) + 1

        return {
          catalogId, name, ocrText, ocrConf, ocrOk,
          top1: allCands[0]?.id === catalogId,
          top3: rank >= 1 && rank <= 3,
          autoOk: scan.autoMatched && scan.match?.id === catalogId,
          ms,
        }
      } catch (e) {
        return { catalogId, name, skip: e.message.slice(0, 40) }
      }
    }))

    for (const r of results) {
      if (r.skip) {
        console.log(pad(r.name, 24), `(spring over: ${r.skip})`)
        continue
      }
      ocrTotal++;  pipeTotal++;  totalMs += r.ms
      if (r.ocrOk)  ocrCorrect++
      if (r.top1)   pipeTop1++
      if (r.top3)   pipeTop3++
      if (r.autoOk) autoMatch++

      const confStr = `${(r.ocrConf * 100).toFixed(0)}%`
      console.log(
        pad(r.name.slice(0, 23), 24),
        pad((r.ocrText || '—').slice(0, 25), 26),
        pad(confStr, 6),
        pad(r.ocrOk ? '✅' : '✗', 5),
        pad(r.top1 ? '✅' : r.top3 ? '#≤3' : '✗', 5),
        r.autoOk ? '🎯' : ''
      )
    }
  }

  const avgMs = pipeTotal > 0 ? Math.round(totalMs / pipeTotal) : 0
  console.log('─'.repeat(80))
  console.log(`\nOCR-præcision (første ord korrekt):  ${pct(ocrCorrect, ocrTotal)}`)
  console.log(`Pipeline top-1:                       ${pct(pipeTop1, pipeTotal)}`)
  console.log(`Pipeline top-3:                       ${pct(pipeTop3, pipeTotal)}`)
  console.log(`Auto-match (korrekt + confidence>0.75): ${pct(autoMatch, pipeTotal)}`)
  console.log(`Gns. tid pr. kort:                    ${avgMs}ms`)
  return { ocrCorrect, ocrTotal, pipeTop1, pipeTop3, autoMatch, pipeTotal, avgMs }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.log('GradeDex — Scan Accuracy Benchmark v2')
  console.log(`Testkorpus: ${TEST_CARDS.length} kort + ${FUZZY_TESTS.length} fuzzy-tests`)

  const searchRes = await testExactSearch()
  const fuzzyRes  = await testFuzzySearch()

  // Hent image_url fra DB
  const ids      = TEST_CARDS.map(t => t[0])
  const dbCards  = await dbSelect('card_catalog', `id=in.(${ids.map(id => `"${id}"`).join(',')})&select=id,image_url`)
  const dbMap    = Object.fromEntries(dbCards.map(c => [c.id, c]))
  const catCards = TEST_CARDS.map(([catalogId, name]) => ({
    catalogId, name, imageUrl: dbMap[catalogId]?.image_url || null,
  }))

  const pipeRes = await testOCRAndPipeline(catCards)

  console.log('\n━━━ SAMLET RESUMÉ ━━━\n')
  console.log(`Søgning (eksakt navn → top-1):     ${pct(searchRes.top1, searchRes.total)}`)
  console.log(`Søgning (eksakt navn → top-3):     ${pct(searchRes.top3, searchRes.total)}`)
  console.log(`Fuzzy søgning (OCR-støj → top-1):  ${pct(fuzzyRes.hits, fuzzyRes.total)}`)
  console.log(`OCR på officielle renders:          ${pct(pipeRes.ocrCorrect, pipeRes.ocrTotal)}`)
  console.log(`Fuld pipeline top-1:               ${pct(pipeRes.pipeTop1, pipeRes.pipeTotal)}`)
  console.log(`Auto-match rate:                   ${pct(pipeRes.autoMatch, pipeRes.pipeTotal)}`)
  console.log(`Gns. scantid:                      ${pipeRes.avgMs}ms`)
  console.log()
  console.log('ℹ️  Søg-tests = hvad systemet KAN når OCR giver korrekt tekst')
  console.log('ℹ️  OCR-tests = digital renders, ikke rigtige kortfotos (forventet lavere)')

  await cleanupOCR()
}

run().catch(err => { console.error(err); process.exit(1) })
