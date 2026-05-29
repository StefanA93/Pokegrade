/**
 * Test phash-baseret kortidentifikation (free scan pipeline).
 * Downloader officielle kortbilleder → beregner phash → finder nærmeste i DB.
 *
 * Kør: node scripts/test-phash-accuracy.js
 */
import 'dotenv/config'
import { computePhash, hammingDistance } from '../packages/scanner/phash.js'
import { dbSelect } from '../server/middleware/db.js'

const TIMEOUT_MS  = 15000
const CONCURRENCY = 4

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
  ['pokemon-swsh12-186',    'Charizard VSTAR',    'Brilliant Stars'],
  ['pokemon-base1-6',       'Gyarados',           'Base Set'],
  ['pokemon-sv4pt5-234',    'Charizard ex',       'Paldean Fates (SIR)'],
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
  } finally {
    clearTimeout(t)
  }
}

async function run() {
  console.log('GradeDex — Phash Free Scan Test')
  console.log(`Testkorpus: ${TEST_CARDS.length} Pokémon-kort\n`)

  // Hent alle image_url fra DB for testkorpuset
  const ids    = [...new Set(TEST_CARDS.map(t => t[0]))]
  const dbRows = await dbSelect(
    'card_catalog',
    `id=in.(${ids.map(id => `"${id}"`).join(',')})&select=id,name,image_url,phash`
  )
  const dbMap = Object.fromEntries(dbRows.map(c => [c.id, c]))

  // Hent alle Pokémon phashes fra DB med pagination (Supabase max 1000/kald)
  console.log('Henter alle Pokémon phashes fra database...')
  const allPhashes = []
  const PAGE = 1000
  let offset  = 0
  while (true) {
    const batch = await dbSelect(
      'card_catalog',
      `game=eq.pokemon&phash=not.is.null&select=id,phash&limit=${PAGE}&offset=${offset}`
    )
    allPhashes.push(...batch)
    if (batch.length < PAGE) break
    offset += PAGE
  }
  console.log(`  ${allPhashes.length} kort med phash\n`)

  console.log(
    pad('Kort', 22),
    pad('Sæt', 20),
    pad('DB phash', 9),
    pad('Top-1', 6),
    pad('Top-3', 6),
    pad('Top-5', 6),
    'Dist  Similarity'
  )
  console.log('─'.repeat(85))

  let top1 = 0, top3 = 0, top5 = 0, noPhash = 0, noImage = 0
  let totalTests = 0

  const queue = [...TEST_CARDS]
  while (queue.length) {
    const batch = queue.splice(0, CONCURRENCY)
    const results = await Promise.all(batch.map(async ([catalogId, name, set]) => {
      const dbCard = dbMap[catalogId]

      if (!dbCard?.image_url) return { catalogId, name, set, skip: 'ingen image_url i DB' }
      if (!dbCard?.phash)     return { catalogId, name, set, skip: 'ingen phash i DB' }

      try {
        // Download officielt kortbillede og beregn phash
        const buf      = await downloadImage(dbCard.image_url)
        const computed = await computePhash(buf)

        // Find nærmeste matches via Hamming distance
        const scored = allPhashes
          .map(c => ({ id: c.id, dist: hammingDistance(computed, c.phash) }))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 5)

        const rank      = scored.findIndex(c => c.id === catalogId) + 1
        const bestMatch = scored[0]
        const similarity = (1 - bestMatch.dist / 64)

        return {
          catalogId, name, set,
          rank,
          dist:       bestMatch.dist,
          similarity: similarity.toFixed(3),
          inTop1:     rank === 1,
          inTop3:     rank >= 1 && rank <= 3,
          inTop5:     rank >= 1 && rank <= 5,
          hasPhash:   true,
        }
      } catch (e) {
        return { catalogId, name, set, skip: e.message.slice(0, 40) }
      }
    }))

    for (const r of results) {
      if (r.skip) {
        if (r.skip.includes('phash'))   noPhash++
        if (r.skip.includes('image'))   noImage++
        console.log(pad(r.name, 22), pad(r.set, 20), `(spring over: ${r.skip})`)
        continue
      }

      totalTests++
      if (r.inTop1) top1++
      if (r.inTop3) top3++
      if (r.inTop5) top5++

      const rankStr  = r.rank === 0 ? '✗    ' : r.rank === 1 ? '✅   ' : `#${r.rank}   `
      const top3Str  = r.inTop3 ? '✓    ' : '✗    '
      const top5Str  = r.inTop5 ? '✓    ' : '✗    '

      console.log(
        pad(r.name, 22),
        pad(r.set, 20),
        pad('✓', 9),
        pad(rankStr, 6),
        pad(top3Str, 6),
        pad(top5Str, 6),
        `${String(r.dist).padStart(2)}    ${r.similarity}`
      )
    }
    await sleep(200)
  }

  console.log('─'.repeat(85))
  console.log(`
━━━ SAMLET RESUMÉ ━━━

Phash top-1:     ${pct(top1, totalTests)}  (${top1}/${totalTests})
Phash top-3:     ${pct(top3, totalTests)}  (${top3}/${totalTests})
Phash top-5:     ${pct(top5, totalTests)}  (${top5}/${totalTests})
Ingen phash i DB:  ${noPhash}
Ingen billede:     ${noImage}

Pool størrelse: ${allPhashes.length} Pokémon-kort med phash

ℹ️  Test bruger officielle renders — rigtige kortfotos giver typisk lidt lavere similarity
ℹ️  Similarity ≥ 0.90 = sikkert match, ≥ 0.75 = sandsynligt match
`)
}

run().catch(err => { console.error(err); process.exit(1) })
