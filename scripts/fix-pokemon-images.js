/**
 * Erstatter brudte TCGPlayer image-URLs for Pokemon-kort med
 * pokemontcg.io billeder (høj kvalitet, stabil CDN).
 *
 * Matcher sæt via set_name → pokemontcg.io set-navn.
 * Bruger PTCG_API_KEY — ingen daglig rate-limit.
 *
 * Brug: node scripts/fix-pokemon-images.js
 */
import 'dotenv/config'
import { dbSelect, dbUpdate, dbCount } from '../server/middleware/db.js'

const PTCG_KEY = process.env.PTCG_API_KEY
const PTCG_HEADERS = PTCG_KEY ? { 'X-Api-Key': PTCG_KEY } : {}
const BASE = 'https://api.pokemontcg.io/v2'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function ptcgFetch(url, attempt = 0) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 60000)   // 60s timeout
  try {
    const r = await fetch(url, { headers: PTCG_HEADERS, signal: ctrl.signal })
    clearTimeout(t)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  } catch (err) {
    clearTimeout(t)
    if (attempt < 3) {
      await sleep(3000 * (attempt + 1))
      return ptcgFetch(url, attempt + 1)
    }
    throw err
  }
}

async function fetchAllPtcgSets() {
  const all = []
  let page = 1
  while (true) {
    const d = await ptcgFetch(`${BASE}/sets?pageSize=100&page=${page}&orderBy=-releaseDate`)
    all.push(...(d.data || []))
    if (all.length >= d.totalCount || !d.data?.length) break
    page++
  }
  return all
}

async function fetchPtcgCardsForSet(setId) {
  const all = []
  let page = 1
  while (true) {
    const d = await ptcgFetch(`${BASE}/cards?q=set.id:${setId}&pageSize=250&page=${page}&select=id,name,number,images`)
    all.push(...(d.data || []))
    if (all.length >= d.totalCount || !d.data?.length) break
    page++
  }
  return all
}

// Manuelle overrides for sæt hvor auto-matching fejler.
// Bruges som FØRSTE prioritet før auto-matching.
// set_id (som string) → pokemontcg.io set kode
const MANUAL_SET_OVERRIDES = {
  // Forkert matchet af auto-matcher (via substring-fejl)
  '5500149': 'swshp',   // SWSH Promo Cards → auto-mapper fejlagtigt til swsh1
  '5500177': 'xyp',     // XY Promos → auto-mapper fejlagtigt til xy1
  '5500083': 'hif',     // Hidden Fates: Shiny Vault → fejl: sm115
  '5500125': 'hif',     // Hidden Fates → fejl: sm115
  '5500025': 'swsh1',   // SWSH01: Sword & Shield Base Set → fejl: base1
  '5500032': 'sv1',     // SV01: Scarlet & Violet Base Set → fejl: base1
  '5500018': 'sm1',     // SM Base Set → fejl: base1
  '5500120': 'xy1',     // XY Base Set → fejl: base1
  '5500070': 'svp',     // SV: Scarlet & Violet Promo Cards → fejl: sv1
  // XY sæt der alle fejlagtigt mapper til xy1 via "xy" substring
  '5500067': 'xy4',     // XY - Phantom Forces
  '5500027': 'xy3',     // XY - Furious Fists
  '5500118': 'xy5',     // XY - Primal Clash
  '5500095': 'xy6',     // XY - Roaring Skies
  '5500188': 'xy9',     // XY - BREAKpoint
  '5500004': 'xy11',    // XY - Steam Siege
  '5500019': 'xy2',     // XY - Flashfire
  '5500147': 'xy12',    // XY - Evolutions
  '5500196': 'xy7',     // XY - Ancient Origins
  '5500169': 'xy10',    // XY - Fates Collide
  '5500195': 'xy8',     // XY - BREAKthrough

  // Umatched: "and" vs "&" mismatch
  '5500115': 'bw1',     // Black and White (ptcg: "Black & White")
  '5500091': 'bwp',     // Black and White Promos (ptcg: "BW Black Star Promos")
  '5500037': 'hgss1',   // HeartGold SoulSilver
  '5500034': 'dp1',     // Diamond and Pearl (ptcg: "Diamond & Pearl")
  '5500116': 'dpp',     // Diamond and Pearl Promos (ptcg: "DP Black Star Promos")
  '5500052': 'ex1',     // Ruby and Sapphire (ptcg: "EX Ruby & Sapphire")

  // Umatched: promo-sæt
  '5500076': 'smp',     // SM Promos (ptcg: "SM Black Star Promos")
  '5500055': 'np',      // Nintendo Promos (ptcg: "Nintendo Black Star Promos")
  '5500065': 'hsp',     // HGSS Promos (ptcg: "HGSS Black Star Promos")

  // Umatched: øvrige sæt
  '5500021': 'pgo',     // Pokemon GO
  '5500133': 'g1',      // Generations: Radiant Collection

  // McDonald's promo-sæt (år-specifik kode)
  '5500097': 'mcd11',
  '5500164': 'mcd12',
  '5500200': 'mcd14',
  '5500172': 'mcd15',
  '5500002': 'mcd16',
  '5500145': 'mcd17',
  '5500193': 'mcd18',
  '5500203': 'mcd19',
  '5500198': 'mcd22',
  '5500033': 'mcd23',
  '5500136': 'mcd24',
  '5500117': 'mcd25',
}

async function run() {
  // ── 1. Hent alle pokemontcg.io sæt ────────────────────────────────────────
  console.log('\n🔍 Henter pokemontcg.io sæt-liste…')
  const ptcgSets = await fetchAllPtcgSets()
  // Map: lowercase set-navn → ptcg set-kode
  const nameToCode = new Map(ptcgSets.map(s => [s.name.toLowerCase().trim(), s.id]))
  console.log(`   ${ptcgSets.length} sæt fundet`)

  // ── 2. Hent ALLE unikke set_id + set_name fra vores catalog ─────────────
  const allRows = []
  for (let offset = 0; ; offset += 1000) {
    const batch = await dbSelect('card_catalog',
      `game=eq.pokemon&select=set_id,set_name&limit=1000&offset=${offset}&order=set_id.asc`)
    allRows.push(...batch)
    if (batch.length < 1000) break
  }
  const uniqueSets = [...new Map(allRows.map(r => [r.set_id, r.set_name])).entries()]
  console.log(`   ${uniqueSets.length} unikke sæt i catalog\n`)

  // ── 3. Match catalog-sæt → pokemontcg.io set-kode ────────────────────────
  const setMapping = {}   // catalog set_id → ptcg set-kode
  let matched = 0, manualMatched = 0

  for (const [setId, setName] of uniqueSets) {
    if (!setName) continue

    // Manuel override har højeste prioritet
    if (MANUAL_SET_OVERRIDES[String(setId)]) {
      setMapping[setId] = MANUAL_SET_OVERRIDES[String(setId)]
      matched++
      manualMatched++
      continue
    }

    // Strip prefix som "SV10: ", "SWSH: ", "SV: " osv.
    const stripped = setName.replace(/^[A-Z0-9]+(?:pt\d+)?:\s*/i, '').trim().toLowerCase()

    // Direkte match
    let code = nameToCode.get(stripped)

    // Fuzzy: find ptcg-sæt der indeholder vores strippede navn
    // Guard: kun hvis stripped er mindst 6 tegn for at undgå "xy" / "sm" falsk-positiver
    if (!code && stripped.length >= 6) {
      for (const [ptcgName, ptcgCode] of nameToCode) {
        if (ptcgName.includes(stripped) || stripped.includes(ptcgName)) {
          code = ptcgCode
          break
        }
      }
    }

    if (code) {
      setMapping[setId] = code
      matched++
    }
  }

  console.log(`✅ ${matched}/${uniqueSets.length} sæt matchet (${manualMatched} manuelt, ${matched - manualMatched} auto)\n`)

  // ── 4. For hvert matchet sæt: hent ptcg-kort + opdater image_url ──────────
  let totalUpdated = 0
  let totalSkipped = 0
  let setsProcessed = 0
  const total = Object.keys(setMapping).length

  for (const [catalogSetId, ptcgSetCode] of Object.entries(setMapping)) {
    // Hent kort fra pokemontcg.io
    let ptcgCards
    try {
      ptcgCards = await fetchPtcgCardsForSet(ptcgSetCode)
    } catch (err) {
      console.error(`  Fejl ved ${ptcgSetCode}: ${err.message}`)
      setsProcessed++
      continue
    }

    if (!ptcgCards.length) { setsProcessed++; continue }

    // Byg kort-map: number → ptcg image URL
    const numToImage = new Map()
    for (const c of ptcgCards) {
      const img = c.images?.large || c.images?.small
      if (img && c.number) {
        numToImage.set(c.number.toLowerCase(), img)
        numToImage.set(String(parseInt(c.number, 10)), img)
      }
    }

    // Hent vores catalog-kort for dette sæt med TCGPlayer-billeder
    const catalogCards = await dbSelect('card_catalog',
      `game=eq.pokemon&set_id=eq.${encodeURIComponent(catalogSetId)}&select=id,number,image_url`)

    let setUpdated = 0
    for (const card of catalogCards) {
      if (!card.image_url?.includes('tcgplayer.com')) {
        totalSkipped++
        continue
      }
      if (!card.number) continue

      // Normaliser vores nummer: "001/086" → "001", "1" → "1"
      const rawNum = card.number.split('/')[0].trim()
      const ptcgUrl = numToImage.get(rawNum.toLowerCase())
                   || numToImage.get(String(parseInt(rawNum, 10)))

      if (!ptcgUrl) continue

      await dbUpdate('card_catalog', { id: card.id }, { image_url: ptcgUrl })
      setUpdated++
      totalUpdated++
    }

    setsProcessed++
    process.stdout.write(
      `\r  [${setsProcessed}/${total}] ${ptcgSetCode.padEnd(12)} opdateret: ${totalUpdated}`
    )

    await sleep(350)  // respekter pokemontcg.io rate limit
  }

  // ── 5. Afsluttende status ──────────────────────────────────────────────────
  const broken = await dbCount('card_catalog',
    `game=eq.pokemon&image_url=like.*tcgplayer.com*`)

  console.log(`\n\n✅ Færdig!`)
  console.log(`   Image URLs opdateret: ${totalUpdated}`)
  console.log(`   Allerede OK (ikke tcgplayer): ${totalSkipped}`)
  console.log(`   Stadig TCGPlayer (ingen ptcg-match): ${broken}`)
  console.log(`\n➡  Kør nu: node scripts/backfill-phash-only.js pokemon`)
}

run().catch(err => { console.error(err); process.exit(1) })
