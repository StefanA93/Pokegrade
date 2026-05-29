/**
 * Test free scan pipeline: phash + kortnummer OCR + Meilisearch.
 * Downloader officielle kortbilleder → kører alle 3 signaler → måler præcision.
 *
 * Kør: node scripts/test-phash-accuracy.js
 */
import 'dotenv/config'
import { computePhash, hammingDistance } from '../packages/scanner/phash.js'
import { extractCardNumber }             from '../packages/scanner/ocr.js'
import { dbSelect }                      from '../server/middleware/db.js'
import { searchCards }                   from '../packages/search/index.js'

const TIMEOUT_MS  = 15000
const CONCURRENCY = 3

const TEST_CARDS = [
  ['pokemon-sv4pt5-54',     'Charizard ex',      'Paldean Fates'],
  ['pokemon-sv3pt5-36',     'Pikachu ex',         '151'],
  ['pokemon-sv1-198',       'Miraidon ex',        'Scarlet & Violet'],
  ['pokemon-sv1-182',       'Koraidon ex',        'Scarlet & Violet'],
  ['pokemon-sv2-182',       'Gardevoir ex',       'Paldea Evolved'],
  ['pokemon-sv3-185',       'Iono',               'Obsidian Flames'],
  ['pokemon-base1-4',       'Charizard',          'Base Set'],
  ['pokemon-base1-15',      'Venusaur',           'Base Set'],
  ['pokemon-sv4-199',       'Iron Thorns ex',     'Paradox Rift'],
  ['pokemon-swsh12pt5-160', 'Lugia V',            'Crown Zenith'],
  ['pokemon-swsh12-183',    'Arceus VSTAR',       'Brilliant Stars'],
  ['pokemon-swsh12-186',    'Charizard VSTAR',    'Brilliant Stars'],
  ['pokemon-swsh10-154',    'Giratina VSTAR',     'Lost Origin'],
  ['pokemon-swsh4-186',     'Rayquaza VMAX',      'Evolving Skies'],
  ['pokemon-sv5-180',       'Ogerpon ex',         'Twilight Masquerade'],
  ['pokemon-sv1-186',       'Arven',              'Scarlet & Violet'],
  ['pokemon-sv3-198',       'Tyranitar ex',       'Obsidian Flames'],
  ['pokemon-base1-6',       'Gyarados',           'Base Set'],
  ['pokemon-sv4pt5-234',    'Charizard ex SIR',   'Paldean Fates'],
]

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function pad(s, n)  { return String(s).slice(0, n).padEnd(n) }
function pct(n, d)  { return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%` }

async function downloadImage(url) {
  const ctrl = new AbortController()
  const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  } finally { clearTimeout(t) }
}

async function run() {
  console.log('GradeDex — Free Scan Pipeline Test (phash + OCR + Meilisearch)\n')

  // Hent kortdata fra DB
  const ids    = [...new Set(TEST_CARDS.map(t => t[0]))]
  const dbRows = await dbSelect('card_catalog',
    `id=in.(${ids.map(id => `"${id}"`).join(',')})&select=id,name,number,image_url,phash`)
  const dbMap = Object.fromEntries(dbRows.map(c => [c.id, c]))

  // Hent alle Pokémon phashes (pagineret)
  console.log('Henter phashes fra DB...')
  const allPhashes = []
  let offset = 0
  while (true) {
    const batch = await dbSelect('card_catalog',
      `game=eq.pokemon&phash=not.is.null&select=id,phash&limit=1000&offset=${offset}`)
    allPhashes.push(...batch)
    if (batch.length < 1000) break
    offset += 1000
  }
  console.log(`  ${allPhashes.length} Pokémon-kort med phash\n`)

  console.log(
    pad('Kort', 22), pad('Sæt', 18),
    pad('Ph1', 4), pad('Ph3', 4), pad('Ph5', 4),
    pad('3sig-1', 7), pad('3sig-3', 7),
    'OCR-num'
  )
  console.log('─'.repeat(80))

  let ph1 = 0, ph3 = 0, ph5 = 0
  let s1  = 0, s3  = 0
  let ocrHits = 0, ocrTotal = 0
  let total = 0, noImg = 0

  const queue = [...TEST_CARDS]
  while (queue.length) {
    const chunk = queue.splice(0, CONCURRENCY)
    const results = await Promise.all(chunk.map(async ([catalogId, name, set]) => {
      const dbCard = dbMap[catalogId]
      if (!dbCard?.image_url) return { skip: 'no-image', name, set }
      if (!dbCard?.phash)     return { skip: 'no-phash', name, set }

      try {
        const buf      = await downloadImage(dbCard.image_url)
        const computed = await computePhash(buf)

        // Signal 1: phash → top 50
        const byPhash = allPhashes
          .map(c => ({ id: c.id, dist: hammingDistance(computed, c.phash) }))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 50)

        const phashRank = byPhash.findIndex(c => c.id === catalogId) + 1

        // Signal 2: kortnummer OCR (fejler stille)
        let ocrNum   = null
        let numberSet = new Set()
        try {
          const raw = await extractCardNumber(buf, 'pokemon')
          if (raw) {
            ocrNum = raw
            const rows = await dbSelect('card_catalog',
              `game=eq.pokemon&number=eq.${encodeURIComponent(raw)}&select=id&limit=30`)
            rows.forEach(r => numberSet.add(r.id))
          }
        } catch { /* tesseract fejlede — fortsæt */ }

        // Signal 3: Meilisearch (hvis OCR gav noget)
        const meiliSet = new Set()
        if (ocrNum) {
          const hits = await searchCards(ocrNum, { gameId: 'pokemon', limit: 10 }).catch(() => [])
          hits.forEach(h => meiliSet.add(h.id))
        }

        // 3-signal ranking: phash primær, resten additive bonus
        const combined = byPhash.map(c => ({
          id:    c.id,
          dist:  c.dist,
          score: (1 - c.dist / 64)
                 + (numberSet.has(c.id) ? 0.50 : 0)
                 + (meiliSet.has(c.id)  ? 0.10 : 0),
        })).sort((a, b) => b.score - a.score)

        const sigRank = combined.findIndex(c => c.id === catalogId) + 1

        const ocrCorrect = ocrNum !== null && numberSet.has(catalogId)

        return {
          catalogId, name, set,
          phashRank, sigRank,
          dist:       byPhash[0]?.dist ?? 64,
          similarity: byPhash[0] ? (1 - byPhash[0].dist / 64).toFixed(3) : '0',
          ocrNum,
          ocrCorrect,
        }
      } catch (e) {
        return { skip: e.message.slice(0, 50), name, set }
      }
    }))

    for (const r of results) {
      if (r.skip) {
        if (r.skip === 'no-image') noImg++
        console.log(pad(r.name, 22), pad(r.set, 18), `(spring over: ${r.skip})`)
        continue
      }

      total++
      if (r.phashRank === 1) ph1++
      if (r.phashRank >= 1 && r.phashRank <= 3) ph3++
      if (r.phashRank >= 1 && r.phashRank <= 5) ph5++
      if (r.sigRank  === 1) s1++
      if (r.sigRank  >= 1 && r.sigRank  <= 3) s3++
      if (r.ocrNum !== null) { ocrTotal++; if (r.ocrCorrect) ocrHits++ }

      const mk = (b) => b ? '✅' : '✗ '
      const ocrStr = r.ocrNum
        ? (r.ocrCorrect ? `✅${r.ocrNum}` : `🔢${r.ocrNum}`)
        : '—'

      console.log(
        pad(r.name, 22), pad(r.set, 18),
        pad(mk(r.phashRank === 1), 4),
        pad(mk(r.phashRank <= 3 && r.phashRank > 0), 4),
        pad(mk(r.phashRank <= 5 && r.phashRank > 0), 4),
        pad(mk(r.sigRank  === 1), 7),
        pad(mk(r.sigRank  <= 3 && r.sigRank > 0), 7),
        ocrStr
      )
    }
    await sleep(150)
  }

  console.log('─'.repeat(80))
  console.log(`
━━━ SAMLET RESUMÉ ━━━

             phash-only    3-signal (phash+OCR+meili)
Top-1:       ${pct(ph1,total).padEnd(12)} ${pct(s1,total)}
Top-3:       ${pct(ph3,total).padEnd(12)} ${pct(s3,total)}
Top-5:       ${pct(ph5,total).padEnd(12)} —

OCR kortnummer: ${ocrHits}/${ocrTotal} korrekt (${pct(ocrHits,ocrTotal)}) på renders
Ingen billede:  ${noImg}
Pool:           ${allPhashes.length} kort med phash

ℹ️  Renders er best-case for phash, worst-case for OCR (stiliseret font).
ℹ️  På rigtige kortfotos forventes: phash lidt lavere, OCR markant højere.
`)

  process.exit(0)
}

run().catch(err => { console.error(err); process.exit(1) })
