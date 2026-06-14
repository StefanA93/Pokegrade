/**
 * Opdaterer image_url for PokemonJP kort der mangler phash.
 * Henter billeder fra pokemon-card.com (officiel japansk kortkatalog).
 *
 * Strategi: API returnerer kort i kortnummer-rækkefølge.
 *   position N i API = kort #N i sættet.
 *   image_url opdateres til det præcise URL fra API'en.
 *
 * Kør: node scripts/fix-pokemonjp-images.js
 */
import 'dotenv/config'
import { dbSelect, dbUpdate, dbCount } from '../server/middleware/db.js'

const API = 'https://www.pokemon-card.com/card-search/resultAPI.php'
const IMG_BASE = 'https://www.pokemon-card.com'
const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.pokemon-card.com/card-search/' }

// DB sætnavn prefix → pokemon-card.com API serie-kode
// Kun sæt med én-til-én mapping (ingen delade koder på tværs af sub-decks)
const SET_MAP = [
  // SV-æra (main sets)
  ['SV11B:',   'SV11B'],
  ['SV11W:',   'SV11W'],
  ['SV10:',    'SV10'],
  ['SV9a:',    'SV9a'],
  ['SV9:',     'SV9'],
  ['SV8a:',    'SV8a'],
  ['SV8:',     'SV8'],
  ['SV7a:',    'SV7a'],
  ['SV7:',     'SV7'],
  ['SV6a:',    'SV6a'],
  ['SV6:',     'SV6'],
  ['SV5a:',    'SV5a'],
  ['SV5M:',    'SV5M'],
  ['SV5K:',    'SV5K'],
  ['SV4a:',    'SV4a'],
  ['SV4M:',    'SV4M'],
  ['SV4K:',    'SV4K'],
  ['SV3a:',    'SV3a'],
  ['SV3:',     'SV3'],
  ['SV2a:',    'SV2a'],
  ['SV2P:',    'SV2P'],
  ['SV2D:',    'SV2D'],
  ['SV1V:',    'SV1V'],
  ['SV1S:',    'SV1S'],
  ['SVN:',     'SVN'],
  ['SV-P ',    'SV-P'],
  // SM-æra (main sets)
  ['SM12a:',   'SM12a'],
  ['SM12:',    'SM12'],
  ['SM11b:',   'SM11b'],
  ['SM11a:',   'SM11a'],
  ['SM11:',    'SM11'],
  ['SM10b:',   'SM10b'],
  ['SM10a:',   'SM10a'],
  ['SM10:',    'SM10'],
  ['SM9b:',    'SM9b'],
  ['SM9a:',    'SM9a'],
  ['SM9:',     'SM9'],
  ['SM8b:',    'SM8b'],
  ['SM8a:',    'SM8a'],
  ['SM8:',     'SM8'],
  ['SM7b:',    'SM7b'],
  ['SM7a:',    'SM7a'],
  ['SM7:',     'SM7'],
  ['SM6b:',    'SM6b'],
  ['SM6a:',    'SM6a'],
  ['SM6:',     'SM6'],
  ['SM5+:',    'SM5P'],
  ['SM5M:',    'SM5M'],
  ['SM5S:',    'SM5S'],
  ['SM4+:',    'SM4P'],
  ['SM4A:',    'SM4A'],
  ['SM4S:',    'SM4S'],
  ['SM3+:',    'SML'],
  ['SM3H:',    'SM3H'],
  ['SM2+:',    'SM2P'],
  ['SM2K:',    'SM2K'],
  ['SM2L:',    'SM2L'],
  ['SM1S:',    'SM1S'],
  ['SI:',      'SI'],
  ['SVM:',     'SVM'],
  ['M2a:',     'M2a'],
  // M-serie (SM-æra tema-decks)
  ['M2:',      'M2'],
  ['M4:',      'M4'],
  ['M5:',      'M5'],
  ['m1L:',     'm1L'],
  ['m1S:',     'm1S'],
  ['sm1+:',    'sm1+'],
  // S-æra (SWSH main sets) — mere specifik prefix FØR kortere
  ['S-P:',     'S-P'],
  ['S12a:',    'S12a'],
  ['S12:',     'S12'],
  ['S11a:',    'S11a'],
  ['S11:',     'S11'],
  ['S10b:',    'S10b'],
  ['S10a:',    'S10a'],
  ['S10P:',    'S10P'],
  ['S10D:',    'S10D'],
  ['S10:',     'S10'],
  ['S9a:',     'S9a'],
  ['S9:',      'S9'],
  ['S8b:',     'S8b'],
  ['S8a:',     'S8a'],
  ['S8:',      'S8'],
  ['S7R:',     'S7R'],
  ['S7D:',     'S7D'],
  ['S6H:',     'S6H'],
  ['S6K:',     'S6K'],
  ['S6a:',     'S6a'],
  ['S5R:',     'S5R'],
  ['S5I:',     'S5I'],
  ['S5a:',     'S5a'],
  ['S4a:',     'S4a'],
  ['S4:',      'S4'],
  ['S3a:',     'S3a'],
  ['S3:',      'S3'],
  ['S2a:',     'S2a'],
  ['S2:',      'S2'],
  ['S1W:',     'S1W'],
  ['S1H:',     'S1H'],
  ['S1a:',     'S1a'],
  // SWSH V Starter Sets
  ['sA:',      'sA'],
  ['sH:',      'sH'],
  ['sEK:',     'sEK'],
  ['sEF:',     'sEF'],
  ['sF:',      'sF'],
  ['sK:',      'sK'],
  ['sLD:',     'sLD'],
  ['sN:',      'sN'],
  ['sB:',      'sB'],
  ['sC:',      'sC'],
  ['s8a-P:',   's8a-P'],
  ['s0:',      's0'],
  // SWSH SP/SP special packs
  ['sp5:',     'sp5'],
  ['sp4:',     'sp4'],
  ['sp2:',     'sp2'],
  // SWSH SS / SS: Jumbo packs
  ['SS:',      'SS'],
  // SM small-set / starter-decks
  ['smG:',     'smG'],
  ['smI:',     'smI'],
  ['smB:',     'smB'],
  ['smA:',     'smA'],
  ['smC:',     'smC'],
  ['smD:',     'smD'],
  ['smE:',     'smE'],
  ['smH:',     'smH'],
  ['smL:',     'smL'],
  ['smM:',     'smM'],
  ['smN:',     'smN'],
  ['smP2:',    'smP2'],
  ['smP:',     'SMP'],
  // SM Promos
  ['SM-P ',    'SM-P'],
  // XY sub-sets / promos
  ['XY-P ',    'XY-P'],
  ['XY11-Br:', 'XY11-Br'],
  ['XY11-Bb:', 'XY11-Bb'],
  ['XY9:',     'XY9'],
  ['XY10:',    'XY10'],
  ['XY5-Bt:',  'XY5-Bt'],
  ['XY2:',     'XY2'],
  ['XY3:',     'XY3'],
  ['XY4:',     'XY4'],
  ['XY6:',     'XY6'],
  ['XY7:',     'XY7'],
  ['XYA:',     'XYA'],
  ['XYF:',     'XYF'],
  ['XYG:',     'XYG'],
  ['XYH:',     'XYH'],
  ['BREAK:',   'BREAK'],
  // CP-sets (XY-æra)
  ['CP3:',     'CP3'],
  ['CP4:',     'CP4'],
  ['CP5:',     'CP5'],
  ['CP6:',     'CP6'],
  // BW-æra
  ['LL:',      'LL'],
  ['BW:',      'BW'],
  // World Championships
  ['WCS23:',   'WCS23'],
  // M-P Promos
  ['M-P ',     'M-P'],
  // Promo
  ['MP1:',     'MP1'],
]

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchApiSet(code) {
  const pages = []
  let maxPage = 1
  for (let pg = 1; pg <= maxPage; pg++) {
    const url = API + '?' + new URLSearchParams({ 'sc_series_multi[]': code, s_flg: '1', page: String(pg) })
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: HEADERS })
    const d = await r.json()
    if (d.hitCnt === 0) return []
    maxPage = d.maxPage || 1
    pages.push(...(d.cardList || []))
    await sleep(200)
  }
  // Dedup — hold første forekomst (API kan returnere samme card i 2-3 varianter)
  const seen = new Set()
  const unique = []
  for (const c of pages) {
    if (!seen.has(c.cardID)) { seen.add(c.cardID); unique.push(c) }
  }
  return unique
}

function extractCardNumber(numberStr) {
  if (!numberStr) return null
  const m = numberStr.match(/^0*(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

async function processSet(setName, apiCode) {
  const apiCards = await fetchApiSet(apiCode)
  if (!apiCards.length) return 0

  // Hent DB-kort der mangler phash for dette sæt
  const missing = await dbSelect('card_catalog',
    `game=eq.pokemonjp&set_name=eq.${encodeURIComponent(setName)}&phash_art=is.null&select=id,number,image_url`)

  if (!missing.length) return 0

  let fixed = 0
  for (const card of missing) {
    const num = extractCardNumber(card.number)
    if (!num || num > apiCards.length) continue

    const apiCard = apiCards[num - 1]
    if (!apiCard?.cardThumbFile) continue

    const newUrl = IMG_BASE + apiCard.cardThumbFile
    if (newUrl === card.image_url) continue

    await dbUpdate('card_catalog', { id: card.id }, { image_url: newUrl })
    fixed++
  }
  return fixed
}

async function getAllMissingSets() {
  // Paginér for at omgå PostgREST 1000-rækker grænse
  const setCounts = {}
  let offset = 0
  while (true) {
    const rows = await dbSelect('card_catalog',
      `game=eq.pokemonjp&phash_art=is.null&select=set_name&limit=1000&offset=${offset}`)
    if (!rows.length) break
    for (const r of rows) if (r.set_name) setCounts[r.set_name] = (setCounts[r.set_name] || 0) + 1
    offset += rows.length
    if (rows.length < 1000) break
    await sleep(100)
  }
  return setCounts
}

async function run() {
  console.log('\n🎌 PokemonJP image fix — pokemon-card.com API\n')

  // Iterér direkte over SET_MAP — ingen afhængighed af pagineret allMissing-forespørgsel
  const setCounts = await getAllMissingSets()
  let totalFixed = 0

  for (const [setName, missingCount] of Object.entries(setCounts).sort((a, b) => b[1] - a[1])) {
    const entry = SET_MAP.find(([prefix]) => setName.startsWith(prefix) || setName === prefix.slice(0, -1))
    if (!entry) continue

    const apiCode = entry[1]
    process.stdout.write(`  ${setName.slice(0, 45).padEnd(45)} (${String(missingCount).padStart(3)} mangler) → API:${apiCode} ... `)

    try {
      const fixed = await processSet(setName, apiCode)
      totalFixed += fixed
      console.log(`${fixed} opdateret`)
    } catch (err) {
      console.log(`FEJL: ${err.message.slice(0, 60)}`)
    }
    await sleep(300)
  }

  const stillMissing = await dbCount('card_catalog', 'game=eq.pokemonjp&phash_art=is.null')
  console.log(`\nTotal image URLs opdateret: ${totalFixed}`)
  console.log(`PokemonJP stadig uden phash: ${stillMissing}`)
  console.log('\n➡  Kør nu: node scripts/backfill-artwork-phash.js pokemonjp')
}

run().catch(err => { console.error(err); process.exit(1) })
