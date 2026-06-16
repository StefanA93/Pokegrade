/**
 * Fix Pokemon kort med FORKERT image_url (kryds-kort-kollision).
 *
 * Find kort hvor 2+ kort med FORSKELLIGE navne deler image_url (fx Arcanine
 * Base Set 023 fik ecard1/23 = Pidgeot Expedition). Gen-udled hvert korts
 * KORREKTE billede fra dets eget set_id→ptcg-kode + nummer via pokemontcg.io.
 *
 * Default: DRY-RUN (skriver intet, rapporterer kun). Kør med --apply for at gemme.
 *
 * Brug:
 *   node scripts/fix-pokemon-collisions.js          # dry-run
 *   node scripts/fix-pokemon-collisions.js --apply   # skriv ændringer
 */
import 'dotenv/config'
import { dbSelect, dbUpdate } from '../server/middleware/db.js'

const APPLY = process.argv.includes('--apply')
const PTCG_KEY = process.env.PTCG_API_KEY
const PTCG_HEADERS = PTCG_KEY ? { 'X-Api-Key': PTCG_KEY } : {}
const BASE = 'https://api.pokemontcg.io/v2'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
// Normalisér kortnavn til sammenligning: fjern parenteser, katalog-promo-hale " - 022/167",
// men BEVAR suffikser som "-GX"/"-EX" (ptcg bruger bindestreg, vi bruger mellemrum → ens efter alfanum-strip).
function norm(n) { return String(n || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/ - .*/, '').replace(/[^a-z0-9]/g, '').trim() }

async function ptcgFetch(url, attempt = 0) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 60000)
  try {
    const r = await fetch(url, { headers: PTCG_HEADERS, signal: ctrl.signal })
    clearTimeout(t)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  } catch (err) {
    clearTimeout(t)
    if (attempt < 3) { await sleep(3000 * (attempt + 1)); return ptcgFetch(url, attempt + 1) }
    throw err
  }
}

async function fetchAllPtcgSets() {
  const all = []; let page = 1
  while (true) {
    const d = await ptcgFetch(`${BASE}/sets?pageSize=100&page=${page}&orderBy=-releaseDate`)
    all.push(...(d.data || []))
    if (all.length >= d.totalCount || !d.data?.length) break
    page++
  }
  return all
}

async function fetchPtcgCardsForSet(setId) {
  const all = []; let page = 1
  while (true) {
    const d = await ptcgFetch(`${BASE}/cards?q=set.id:${setId}&pageSize=250&page=${page}&select=id,name,number,images`)
    all.push(...(d.data || []))
    if (all.length >= d.totalCount || !d.data?.length) break
    page++
  }
  return all
}

const MANUAL_SET_OVERRIDES = {
  '5500149': 'swshp', '5500177': 'xyp', '5500083': 'hif', '5500125': 'hif',
  '5500025': 'swsh1', '5500032': 'sv1', '5500018': 'sm1', '5500120': 'xy1',
  '5500070': 'svp', '5500067': 'xy4', '5500027': 'xy3', '5500118': 'xy5',
  '5500095': 'xy6', '5500188': 'xy9', '5500004': 'xy11', '5500019': 'xy2',
  '5500147': 'xy12', '5500196': 'xy7', '5500169': 'xy10', '5500195': 'xy8',
  '5500115': 'bw1', '5500091': 'bwp', '5500037': 'hgss1', '5500034': 'dp1',
  '5500116': 'dpp', '5500052': 'ex1', '5500076': 'smp', '5500055': 'np',
  '5500065': 'hsp', '5500021': 'pgo', '5500133': 'g1',
  '5500097': 'mcd11', '5500164': 'mcd12', '5500200': 'mcd14', '5500172': 'mcd15',
  '5500002': 'mcd16', '5500145': 'mcd17', '5500193': 'mcd18', '5500203': 'mcd19',
  '5500198': 'mcd22', '5500033': 'mcd23', '5500136': 'mcd24', '5500117': 'mcd25',
}

// set_name (lowercase) → ptcg-kode. Bruges hvor auto-matcher rammer forkert pga.
// substring-fælde (fx "Base Set" matcher fejlagtigt "Expedition Base Set" = ecard1).
const NAME_OVERRIDES = {
  'base set': 'base1',
}

function buildSetMap(uniqueSets, nameToCode) {
  const setMapping = {}
  for (const [setId, setName] of uniqueSets) {
    if (!setName) continue
    const lowerName = String(setName).toLowerCase().trim()
    if (NAME_OVERRIDES[lowerName]) { setMapping[setId] = NAME_OVERRIDES[lowerName]; continue }
    if (MANUAL_SET_OVERRIDES[String(setId)]) { setMapping[setId] = MANUAL_SET_OVERRIDES[String(setId)]; continue }
    const stripped = setName.replace(/^[A-Z0-9]+(?:pt\d+)?:\s*/i, '').trim().toLowerCase()
    let code = nameToCode.get(stripped)
    if (!code && stripped.length >= 6) {
      for (const [ptcgName, ptcgCode] of nameToCode) {
        if (ptcgName.includes(stripped) || stripped.includes(ptcgName)) { code = ptcgCode; break }
      }
    }
    if (code) setMapping[setId] = code
  }
  return setMapping
}

async function run() {
  console.log(`\n🔧 Pokemon kollisions-fix  (${APPLY ? 'APPLY — skriver' : 'DRY-RUN — skriver intet'})\n`)

  console.log('🔍 Henter pokemontcg.io sæt…')
  const ptcgSets = await fetchAllPtcgSets()
  const nameToCode = new Map(ptcgSets.map(s => [s.name.toLowerCase().trim(), s.id]))
  console.log(`   ${ptcgSets.length} sæt`)

  console.log('📥 Henter alle pokemon-kort fra catalog…')
  const cards = []
  for (let offset = 0; ; offset += 1000) {
    const batch = await dbSelect('card_catalog',
      `game=eq.pokemon&image_url=not.is.null&select=id,set_id,set_name,number,name,image_url&limit=1000&offset=${offset}&order=set_id.asc`)
    cards.push(...batch)
    if (batch.length < 1000) break
  }
  console.log(`   ${cards.length} kort`)

  // Find kollisions-kort: image_url delt af 2+ forskellige-navn kort
  const byUrl = new Map()
  for (const c of cards) { if (!byUrl.has(c.image_url)) byUrl.set(c.image_url, []); byUrl.get(c.image_url).push(c) }
  const collisionCards = []
  for (const [url, v] of byUrl) {
    if (v.length > 1 && new Set(v.map(c => norm(c.name))).size > 1) collisionCards.push(...v)
  }
  console.log(`   ${collisionCards.length} kort i forskellige-navn kollisioner\n`)

  // Byg set_id→ptcg-kode kun for de berørte sæt
  const uniqueSets = [...new Map(cards.map(r => [r.set_id, r.set_name])).entries()]
  const setMap = buildSetMap(uniqueSets, nameToCode)

  // Grupper kollisions-kort pr. sæt
  const bySet = new Map()
  for (const c of collisionCards) { if (!bySet.has(c.set_id)) bySet.set(c.set_id, []); bySet.get(c.set_id).push(c) }

  let wouldFix = 0, alreadyOk = 0, noPtcgMatch = 0, nameMismatch = 0
  const unmappedSets = new Map()      // set_id → {name, count}
  const numCache = new Map()          // ptcgCode → Map(num→image)

  for (const [setId, group] of bySet) {
    const code = setMap[setId]
    if (!code) { unmappedSets.set(setId, { name: group[0].set_name, count: group.length }); continue }

    if (!numCache.has(code)) {
      let ptcgCards = []
      try { ptcgCards = await fetchPtcgCardsForSet(code) } catch { ptcgCards = [] }
      const m = new Map()   // num → { img, name }
      for (const pc of ptcgCards) {
        const img = pc.images?.large || pc.images?.small
        if (img && pc.number) { const v = { img, name: pc.name }; m.set(pc.number.toLowerCase(), v); m.set(String(parseInt(pc.number, 10)), v) }
      }
      numCache.set(code, m)
      await sleep(300)
    }
    const numToImage = numCache.get(code)

    for (const card of group) {
      if (!card.number) { noPtcgMatch++; continue }
      const rawNum = card.number.split('/')[0].trim()
      const hit = numToImage.get(rawNum.toLowerCase()) || numToImage.get(String(parseInt(rawNum, 10)))
      if (!hit) { noPtcgMatch++; continue }
      if (hit.img === card.image_url) { alreadyOk++; continue }
      // KRÆV navne-match: ptcg-kortet på (sæt,nummer) skal være SAMME kort som vores
      if (norm(hit.name) !== norm(card.name)) {
        nameMismatch++
        if (nameMismatch <= 15) console.log(`  ⚠ navne-mismatch: vores "${card.name}" ${card.number} (${card.set_name}) vs ptcg "${hit.name}" → springer over`)
        continue
      }
      wouldFix++
      if (wouldFix <= 8) console.log(`  FIX ${card.name} ${card.number} (${card.set_name})\n      ${card.image_url.replace('https://images.pokemontcg.io/','…/')}  →  ${hit.img.replace('https://images.pokemontcg.io/','…/')}`)
      // Nulstil embedding så backfill-clip-embeddings.js genberegner fra det nye billede
      if (APPLY) await dbUpdate('card_catalog', { id: card.id }, { image_url: hit.img, embedding: null })
    }
  }

  console.log(`\n── Resultat ──`)
  console.log(`  Ville rette image_url:     ${wouldFix}  (navne-verificeret)`)
  console.log(`  Allerede korrekt:          ${alreadyOk}`)
  console.log(`  Navne-mismatch (sprunget): ${nameMismatch}`)
  console.log(`  Intet ptcg-nummer-match:   ${noPtcgMatch}`)
  if (unmappedSets.size) {
    const totalUnmapped = [...unmappedSets.values()].reduce((s, x) => s + x.count, 0)
    console.log(`  UMAPPEDE sæt (mangler override): ${unmappedSets.size} sæt, ${totalUnmapped} kort`)
    ;[...unmappedSets.entries()].sort((a,b)=>b[1].count-a[1].count).slice(0,20).forEach(([id,x]) => console.log(`     ${id}  "${x.name}"  (${x.count} kort)`))
  }
  console.log(APPLY ? '\n✅ Ændringer gemt. Kør derefter re-embed for de rettede kort.' : '\n➡  Dry-run. Kør med --apply når du er tilfreds.')
}

run().catch(err => { console.error(err); process.exit(1) })
