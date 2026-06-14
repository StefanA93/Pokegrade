/**
 * Beregner phash_art for JP Pokemon-kort ved at finde EN-modparter på pokemontcg.io.
 *
 * Muligt fordi: EN og JP Pokemon kort bruger IDENTISKE artwork-crop koordinater
 * i phash.js (begge falder i 'default' case). Samme illustration → samme phash.
 *
 * Strategi per sæt-gruppe:
 *   L1/L2/L3 (HGSS-æra)   → søger i hgss1-hgss4 EN sæt
 *   SM: The Best of XY     → søger i xy1-xy12 EN sæt
 *   sA: Starter Sets       → søger i swsh1-swsh5 EN sæt
 *   SV11B: Black Bolt      → søger i sv1-sv8 EN sæt
 *   BK: Battle Strength    → søger i bw1-bw11 EN sæt
 *   Deck Kits / DP-æra     → søger i dp1-dp6, pl1-pl4 EN sæt
 *   World Champions Pack   → søger bredt (dp + hgss)
 *   Entry Pack '08         → søger i dp1-dp6 EN sæt
 *
 * Kør: node scripts/fix-pokemonjp-phash-via-ptcg.js
 */
import 'dotenv/config'
import { computeArtworkPhash } from '../packages/scanner/phash.js'
import { dbSelect, dbUpdate, dbCount } from '../server/middleware/db.js'

const PTCG_API    = 'https://api.pokemontcg.io/v2/cards'
const DL_TIMEOUT  = 18000
const CONCUR      = 3
const PTCG_DELAY  = 120  // ~8 req/s — under 10 req/s fri-tier grænse

// JP sæt-mønstre → pokemontcg.io sæt-IDs at søge i (rækkefølge = prioritet, første match vinder)
const SM_SETS  = ['sm1','sm2','sm3','sm4','sm5','sm6','sm7','sm8','sm9','sm10','sm11','sm12']
const SWSH_SETS = ['swsh1','swsh2','swsh3','swsh4','swsh5','swsh6','swsh7','swsh8','swsh9','swsh10','swsh11','swsh12','swsh12pt5']
const SV_SETS  = ['sv1','sv2','sv3','sv4','sv5','sv6','sv7','sv8','sv9']
const XY_SETS  = ['xy1','xy2','xy3','xy4','xy5','xy6','xy7','xy8','xy9','xy10','xy11','xy12']
const DP_SETS  = ['dp1','dp2','dp3','dp4','dp5','dp6']
const EX_SETS  = ['ex1','ex2','ex3','ex4','ex5','ex6','ex7','ex8','ex9','ex10','ex11','ex12','ex13','ex14','ex15','ex16']
const OLD_SETS = ['base1','base2','jungle','fossil','gym1','gym2','neo1','neo2','neo3','neo4','ecard1','ecard2','ecard3']
const PL_SETS  = ['pl1','pl2','pl3','pl4']

const SET_ERA_MAP = [
  // ── HGSS-æra ─────────────────────────────────────────────────────────────
  { test: s => /^L[123]:/.test(s),                    sets: ['hgss1','hgss2','hgss3','hgss4','cl'] },
  // ── SM compilations ──────────────────────────────────────────────────────
  { test: s => s.startsWith('SM: The Best of XY'),    sets: XY_SETS },
  // SM8b: GX Ultra Shiny = EN Hidden Fates (hif)
  { test: s => s.startsWith('SM8b:'),                 sets: ['hif',...SM_SETS] },
  // SM12a: TAG TEAM = broad SM coverage
  { test: s => s.startsWith('SM12a:'),                sets: SM_SETS },
  // SM Promos
  { test: s => /^SM-P[: ]|^SM-P$/.test(s),           sets: ['smp',...SM_SETS] },
  // SM sub-sets (SM1S – SM12 + numbered sub-expansions)
  { test: s => /^SM[0-9]/.test(s),                    sets: SM_SETS },
  // ── SWSH/S-æra ───────────────────────────────────────────────────────────
  // S12a: VSTAR Universe = compilation → Crown Zenith + SWSH
  { test: s => s.startsWith('S12a:'),                 sets: ['swsh12pt5','swsh12','swsh11','swsh10','swsh9','swsh8'] },
  // S-series SWSH (S1W, S2, S3a, S5a, S6H … S12)
  { test: s => /^S[0-9]|^S-P:/.test(s),              sets: SWSH_SETS },
  // sD: V Starter Decks
  { test: s => s.startsWith('sD:'),                   sets: SWSH_SETS },
  // sA: SWSH V Starter Sets
  { test: s => /^sA:/.test(s),                        sets: SWSH_SETS },
  // Other SWSH sm-lowercase special sets
  { test: s => /^s[A-Z]:|^s[0-9]/.test(s),           sets: SWSH_SETS },
  // ── SV-æra ───────────────────────────────────────────────────────────────
  { test: s => /^SV11B:/.test(s),                     sets: SV_SETS },
  // Other SV sub-sets (SV2P, SV3a, SV4M, SV7a …)
  { test: s => /^SV[0-9]/.test(s),                    sets: SV_SETS },
  // SV promos og special sets (SV-P, SV: Premium Trainer Box, SV: Stellar Miracle…)
  { test: s => /^SV-P|^SV:\s/.test(s),                sets: SV_SETS },
  // Start Deck 100 Battle Collection = SV-æra reprints af kort fra mange eras
  { test: s => /Start Deck 100|^MP1:|^sN:/.test(s),  sets: [...SV_SETS, ...SWSH_SETS, ...SM_SETS, 'hgss1','hgss2','hgss3','hgss4','dp1','dp2','dp3','dp4','dp5','dp6','gym1','gym2'] },
  // Battle Academy = SWSH era
  { test: s => /Battle Academy/.test(s),              sets: SWSH_SETS },
  // ── BW-æra ───────────────────────────────────────────────────────────────
  { test: s => /^BK:/.test(s),                        sets: ['bw1','bw2','bw3','bw4','bw5','bw6','bw7','bw8','bw9','bw10','bw11'] },
  // BW SM lowercase sets (smG, smI, smB, smA etc.) — søg XY+SM da trainer-kort kan være fra XY-æra
  { test: s => /^smG:|^smI:|^smB:|^smA:|^smC:|^smD:|^smE:|^smH:|^smL:|^smM:|^smN:|^smP/.test(s),
                                                       sets: [...XY_SETS, ...SM_SETS] },
  // m1L / m1S / M2 / M4 / M5: SM-æra tema-decks
  { test: s => /^m1|^M2:|^M4:|^M5:/.test(s),         sets: SM_SETS },
  // ── XY-æra ───────────────────────────────────────────────────────────────
  // CP4/CP: Premium Champion Pack + CP sub-sets = XY compilation
  { test: s => /^CP[0-9]?:/.test(s),                  sets: XY_SETS },
  // XY special sets: promos (XY-P), sub-sets (XY5-Bt, XYA, XYF…), MEGA decks, starter sets
  { test: s => /^XY[^0-9]|^XY[0-9]-|XY Beginning Set|M Master Deck Build Box/.test(s),
                                                       sets: XY_SETS },
  // World Champions Pack = EX-æra
  { test: s => /World Champions Pack/.test(s),        sets: [...EX_SETS, ...DP_SETS] },
  // ── DP / Platinum-æra ────────────────────────────────────────────────────
  { test: s => /Entry Pack/.test(s),                  sets: [...DP_SETS, ...PL_SETS] },
  // Deck Kits + Constructed / Half Deck / Quarter Deck (DP+Platinum+EX era)
  { test: s => /Deck Kit|Constructed|Half Deck|Quarter Deck|Attacker|Defender|Starter Deck/.test(s),
                                                       sets: [...EX_SETS, ...DP_SETS, ...PL_SETS] },
  { test: s => /^DP[0-9]:|^DP2:|^DP3:/.test(s),      sets: DP_SETS },
  // Offense and Defense of the Furthest Ends = Platinum/HGSS era
  { test: s => /Offense and Defense|Furthest Ends/.test(s),
                                                       sets: [...PL_SETS,'hgss1','hgss2','hgss3','hgss4'] },
  // Battle Road = DP/Platinum era event cards
  { test: s => /Battle Road/.test(s),                 sets: [...EX_SETS, ...DP_SETS, ...PL_SETS] },
  // ── Old era (Base Set → e-Card) ───────────────────────────────────────────
  { test: s => /Random Constructed|Pokemon VS|Rocket Gang|Master Kit|Gift Box|Quick Construction|Quick Starter|Gift Set/.test(s),
                                                       sets: OLD_SETS },
  // Ancient/neo-era misc sets
  { test: s => /Base Expansion Pack|Crossing the Ruins|Challenge from the Darkness|Trainer Prize/.test(s),
                                                       sets: [...OLD_SETS, ...EX_SETS] },
  // Gym Challenge era
  { test: s => /Gym Challenge|Gym Hero/.test(s),      sets: ['gym1','gym2','base1','base2','jungle','fossil'] },
  // ── Catch-all: any remaining SM or SWSH era ──────────────────────────────
  { test: s => /^sm[0-9]?[+a-z]/i.test(s),           sets: SM_SETS },
]

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function normalizeName(raw) {
  return (raw || '')
    .replace(/\s*\(Mirror Holofoil\)\s*/gi, '')
    .replace(/\s*\(Mirror Holo\)\s*/gi, '')
    .replace(/\s*\(Reverse Holofoil\)\s*/gi, '')
    .replace(/\s*\(Holo\)\s*/gi, '')
    .replace(/\s*-\s*\d+\/.*$/, '')
    .replace(/-GX\b/gi, ' GX')
    .replace(/-EX\b/gi, ' EX')
    .replace(/\s+/g, ' ')
    .trim()
}

// Cache: ptcg-sæt → Map<baseName, imageUrl>
const ptcgSetCache = new Map()

async function fetchPtcgSet(setId) {
  if (ptcgSetCache.has(setId)) return ptcgSetCache.get(setId)

  const map = new Map()
  let page = 1
  while (true) {
    const url = `${PTCG_API}?q=set.id:${setId}&pageSize=250&page=${page}&select=name,images`
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!r.ok) {
        // Returner tom map MEN cache ikke — så næste forsøg prøver igen
        return map
      }
      const d = await r.json()
      for (const card of (d.data || [])) {
        const key = normalizeName(card.name).toLowerCase()
        if (!map.has(key) && card.images?.large) {
          map.set(key, card.images.large)
        }
      }
      if (page >= Math.ceil((d.totalCount || 1) / 250)) break
      page++
      await sleep(PTCG_DELAY)
    } catch {
      return map  // Returner tom map MEN cache ikke
    }
  }

  // Cache kun hvis vi fik data
  if (map.size > 0) ptcgSetCache.set(setId, map)
  return map
}

async function findEnImage(baseName, setIds) {
  const key = baseName.toLowerCase()
  for (const setId of setIds) {
    const map = await fetchPtcgSet(setId)
    await sleep(PTCG_DELAY)
    if (map.has(key)) return map.get(key)
  }
  return null
}

async function downloadImage(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), DL_TIMEOUT)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  } finally {
    clearTimeout(t)
  }
}

async function run() {
  console.log('\n🎌 PokemonJP phash via pokemontcg.io EN-billeder\n')

  // Paginér for at omgå PostgREST 1000-rækker grænse
  const bySets = {}
  let offset = 0
  while (true) {
    const rows = await dbSelect('card_catalog',
      `game=eq.pokemonjp&phash_art=is.null&select=id,name,number,set_name&limit=1000&offset=${offset}`)
    if (!rows.length) break
    for (const c of rows) {
      if (!bySets[c.set_name]) bySets[c.set_name] = []
      bySets[c.set_name].push(c)
    }
    offset += rows.length
    if (rows.length < 1000) break
    await sleep(100)
  }

  let totalSaved = 0
  let totalErrors = 0

  for (const [setName, cards] of Object.entries(bySets).sort((a, b) => b[1].length - a[1].length)) {
    // Find era-mapping
    const era = SET_ERA_MAP.find(e => e.test(setName))
    if (!era) {
      process.stdout.write(`  ⚠  Ingen era-mapping: ${setName.slice(0, 50)}\n`)
      continue
    }

    // Grupér per base-navn (regular + foil → samme phash)
    const byBaseName = {}
    for (const c of cards) {
      const base = normalizeName(c.name)
      if (!byBaseName[base]) byBaseName[base] = []
      byBaseName[base].push(c)
    }

    const uniqueNames = Object.keys(byBaseName)
    process.stdout.write(`\n  ${setName.slice(0, 50).padEnd(50)} ${String(cards.length).padStart(4)} mangler | ${uniqueNames.length} unikke navne\n`)

    let setSaved = 0, setErrors = 0

    // Processér i batches af CONCUR
    const nameQueue = [...uniqueNames]
    while (nameQueue.length) {
      const batch = nameQueue.splice(0, CONCUR)
      const results = await Promise.all(batch.map(async baseName => {
        try {
          const imageUrl = await findEnImage(baseName, era.sets)
          if (!imageUrl) return { baseName, phash: null, reason: 'ikke fundet i EN sæt' }

          const buf = await downloadImage(imageUrl)
          const phash = await computeArtworkPhash(buf, 'pokemonjp')
          return { baseName, phash, cards: byBaseName[baseName] }
        } catch (err) {
          return { baseName, phash: null, reason: err.message.slice(0, 60) }
        }
      }))

      for (const res of results) {
        if (!res.phash) {
          setErrors += byBaseName[res.baseName]?.length || 1
          continue
        }
        // Gem phash på ALLE varianter (regular + foil)
        for (const card of res.cards) {
          try {
            await dbUpdate('card_catalog', { id: card.id }, { phash_art: res.phash })
            setSaved++
          } catch {
            setErrors++
          }
        }
      }

      process.stdout.write(`\r    ${setSaved} gemt | ${setErrors} fejl`)
    }

    totalSaved += setSaved
    totalErrors += setErrors
    process.stdout.write(`\r    ✓ ${setSaved} gemt | ${setErrors} fejl\n`)
    await sleep(300)
  }

  const remaining = await dbCount('card_catalog', 'game=eq.pokemonjp&phash_art=is.null')
  console.log(`\n📊 Total: ${totalSaved} phash gemt | ${totalErrors} fejl`)
  console.log(`PokemonJP stadig uden phash: ${remaining}`)
}

run().catch(err => { console.error(err); process.exit(1) })
