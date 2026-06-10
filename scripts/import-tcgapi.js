/**
 * Importer kortdata via tcgapi.dev — One Piece, Lorcana, Dragon Ball.
 * Henter alle sæt, søger pr. sæt (filtrerer client-side), upsert til card_catalog.
 * Respekterer 100 req/dag limit — stopper og genoptager automatisk næste dag.
 *
 * Brug:
 *   node scripts/import-tcgapi.js lorcana-tcg
 *   node scripts/import-tcgapi.js one-piece-card-game
 *   node scripts/import-tcgapi.js dragon-ball-super-ccg
 *
 * Game slug → vores game ID:
 *   lorcana-tcg          → lorcana
 *   one-piece-card-game  → onepiece
 *   dragon-ball-super-ccg→ dragonball
 */
import 'dotenv/config'
import { dbUpsert, dbCount } from '../server/middleware/db.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

const TCGAPI_SLUG = process.argv[2]
const BASE        = 'https://api.tcgapi.dev/v1'
const KEY         = process.env.TCGAPI_KEY
const DELAY_MS    = 800   // pause mellem API-kald
const PER_PAGE    = 50

const SLUG_TO_GAME = {
  'lorcana-tcg':           'lorcana',
  'one-piece-card-game':   'onepiece',
  'dragon-ball-super-ccg': 'dragonball',
}

if (!TCGAPI_SLUG || !SLUG_TO_GAME[TCGAPI_SLUG]) {
  console.error('Brug: node scripts/import-tcgapi.js <slug>')
  console.error('Slugs:', Object.keys(SLUG_TO_GAME).join(' | '))
  process.exit(1)
}

if (!KEY) { console.error('TCGAPI_KEY mangler i .env'); process.exit(1) }

const GAME_ID = SLUG_TO_GAME[TCGAPI_SLUG]

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function buildCatalogId(gameId, setId, number) {
  const safeNum = String(number || 'x').replace(/[^a-zA-Z0-9]/g, '')
  const safeSet = String(setId || 'unknown').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 20)
  return `${gameId}-${safeSet}-${safeNum}`.toLowerCase()
}

function normalizeCard(c, gameId) {
  const setSlug = (c.set_name || 'unknown').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 20)
  return {
    id:           buildCatalogId(gameId, setSlug, c.number),
    game:         gameId,
    name:         c.name,
    number:       c.number || String(c.id),
    set_id:       setSlug,
    set_name:     c.set_name || null,
    rarity:       c.rarity || null,
    finish_types: [c.printing || 'Normal'],
    image_url:    c.image_url || null,
    updated_at:   new Date().toISOString(),
  }
}

async function tcgFetch(path) {
  await sleep(DELAY_MS)
  const r = await fetch(`${BASE}${path}`, { headers: { 'X-API-Key': KEY } })
  const remaining = parseInt(r.headers.get('x-ratelimit-remaining') || '99')
  if (remaining <= 5) {
    console.log(`\n  ⚠  Kun ${remaining} API-kald tilbage i dag — pauser til midnat`)
    const now    = new Date()
    const reset  = new Date(); reset.setUTCHours(24, 5, 0, 0)
    const waitMs = reset - now
    console.log(`  Genoptager om ${Math.round(waitMs / 3600000)} timer`)
    await sleep(waitMs)
  }
  return r.json()
}

async function fetchAllSets() {
  const sets = []
  let page   = 1
  while (true) {
    const d  = await tcgFetch(`/sets?game=${TCGAPI_SLUG}&limit=50&page=${page}`)
    const batch = Array.isArray(d) ? d : (d.data || d.sets || d.results || [])
    if (!batch.length) break
    sets.push(...batch)
    const meta = d.meta || {}
    if (!meta.has_more && !Array.isArray(d)) break
    if (Array.isArray(d) && d.length < 50) break
    page++
  }
  return sets
}

// tcgapi søger på kortnavn — sweep alle kort via 2-bogstavs præfikser
const SWEEP_PREFIXES = [
  'a ','ab','ac','ad','ae','af','ag','ah','ai','aj','ak','al','am','an','ao','ap','aq','ar','as','at','au','av','aw','ax','ay','az',
  'ba','be','bi','bl','bo','br','bu','by',
  'ca','ce','ch','ci','cl','co','cr','cu','cy',
  'da','de','di','do','dr','du','dy',
  'ea','ec','ed','ef','el','em','en','er','es','et','eu','ev','ex','ey',
  'fa','fe','fi','fl','fo','fr','fu',
  'ga','ge','gh','gi','gl','gn','go','gr','gu','gy',
  'ha','he','hi','ho','hu','hy',
  'ic','id','ig','il','im','in','ir','is','it',
  'ja','je','ji','jo','ju',
  'ka','ke','ki','kn','ko',
  'la','le','li','lo','lu',
  'ma','me','mi','mo','mu','my',
  'na','ne','ni','no','nu',
  'ob','oc','of','oh','ok','ol','om','on','op','or','os','ou','ov','ow',
  'pa','pe','ph','pi','pl','po','pr','pu',
  'qu',
  'ra','re','rh','ri','ro','ru',
  'sa','sc','se','sh','si','sk','sl','sm','sn','so','sp','sq','st','su','sw','sy',
  'ta','te','th','ti','to','tr','tu','tw','ty',
  'ul','um','un','up','ur','us',
  'va','ve','vi','vo','vu',
  'wa','we','wh','wi','wo','wr',
  'ya','ye','yo',
  'za','ze','zo','zu',
]

async function upsertCards(cards) {
  const allRows = cards.map(c => normalizeCard(c, GAME_ID))
  // Dedupliker på catalog ID + filtrer kort uden billede (image_url er NOT NULL i DB)
  const rows  = [...new Map(allRows.filter(r => r.image_url).map(r => [r.id, r])).values()]
  const CHUNK = 20   // små chunks undgår Supabase statement timeout
  let saved   = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    try {
      await dbUpsert('card_catalog', rows.slice(i, i + CHUNK), 'id')
      saved += Math.min(CHUNK, rows.length - i)
    } catch (e) {
      console.error('\n❌ Upsert fejl:', e.message.slice(0, 120))
    }
    await new Promise(r => setTimeout(r, 200))  // pause mellem chunks
  }
  return saved
}

// ── Fremgangs-fil: gemmer sidste færdige præfiks så vi kan genoptage ──────────
const PROGRESS_FILE = join(__dir, `.progress-${TCGAPI_SLUG}.txt`)

function loadProgress() {
  if (!existsSync(PROGRESS_FILE)) return null
  const saved = readFileSync(PROGRESS_FILE, 'utf8').trim()
  const idx   = SWEEP_PREFIXES.indexOf(saved)
  return idx >= 0 ? idx + 1 : null  // start EFTER det gemte præfiks
}

function saveProgress(prefix) {
  writeFileSync(PROGRESS_FILE, prefix, 'utf8')
}

function clearProgress() {
  if (existsSync(PROGRESS_FILE)) writeFileSync(PROGRESS_FILE, '', 'utf8')
}

async function sweepAllCards() {
  const seen  = new Map() // id → card
  let   calls = 0
  let   totalSaved = 0

  const startIdx = loadProgress() ?? 0
  if (startIdx > 0) {
    console.log(`  ↩  Genoptager fra præfiks '${SWEEP_PREFIXES[startIdx].trim()}' (springer ${startIdx} over)\n`)
  }

  for (let i = startIdx; i < SWEEP_PREFIXES.length; i++) {
    const prefix   = SWEEP_PREFIXES[i]
    const newCards = []
    let page = 1
    while (true) {
      const d     = await tcgFetch(`/search?game=${TCGAPI_SLUG}&q=${encodeURIComponent(prefix.trim() || prefix)}&limit=${PER_PAGE}&page=${page}`)
      calls++
      const batch = d.data || []
      for (const c of batch) {
        if (!seen.has(c.id)) { seen.set(c.id, c); newCards.push(c) }
      }
      const meta = d.meta || {}
      if (!meta.has_more || batch.length < PER_PAGE) break
      page++
    }

    if (newCards.length > 0) {
      totalSaved += await upsertCards(newCards)
    }

    saveProgress(prefix)  // gem fremgang efter hvert præfiks
    process.stdout.write(`\r  Præfiks '${prefix.trim().padEnd(2)}' | unikke kort: ${seen.size} | gemt: ${totalSaved} | API-kald: ${calls}  `)
  }

  clearProgress()  // færdig — slet fremgangs-filen
  return { total: seen.size, saved: totalSaved }
}

async function run() {
  console.log(`\n📦 tcgapi.dev import: ${TCGAPI_SLUG} → ${GAME_ID}`)
  console.log(`   Sweep alle kort via præfiks-søgning (gemmer løbende)...\n`)

  let result = { total: 0, saved: 0 }
  try {
    result = await sweepAllCards()
  } catch (err) {
    console.error('\nFejl under sweep:', err.message)
    process.exit(1)
  }

  const dbTotal = await dbCount('card_catalog', `game=eq.${GAME_ID}`)
  console.log(`\n\n✅ Færdig!`)
  console.log(`   Kort fundet:      ${result.total}`)
  console.log(`   Gemt i database:  ${result.saved}`)
  console.log(`   Total i database: ${dbTotal}`)
  console.log(`\n➡  Kør nu: node scripts/backfill-phash-only.js ${GAME_ID}`)
}

run().catch(err => { console.error(err); process.exit(1) })
