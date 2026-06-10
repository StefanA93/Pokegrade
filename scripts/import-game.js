/**
 * Direkte import af kortdata for ét spil — ingen Redis/BullMQ nødvendig.
 * Henter sæt → kort → upsert til card_catalog.
 * Kør derefter backfill-phash-only.js <game> for phash.
 *
 * Brug:
 *   node scripts/import-game.js yugioh
 *   node scripts/import-game.js onepiece
 *   node scripts/import-game.js lorcana
 *   node scripts/import-game.js dragonball
 */
import 'dotenv/config'
import { getProvider } from '../packages/providers/index.js'
import { dbUpsert, dbCount } from '../server/middleware/db.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

const GAME           = process.argv[2]
const DELAY_SET_MS   = 400
const DELAY_ERROR_MS = 5000
const MAX_SET_ERRORS = 3

if (!GAME) {
  console.error('Brug: node scripts/import-game.js <game>')
  console.error('Spil: yugioh | onepiece | lorcana | dragonball | mtg | pokemon | pokemonjp | riftbound')
  process.exit(1)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function buildCatalogId(gameId, setId, number) {
  const safeNum = String(number || 'x').replace(/[^a-zA-Z0-9]/g, '')
  return `${gameId}-${setId}-${safeNum}`.toLowerCase()
}

// ── Fremgangs-fil: gemmer sidste færdige sæt-index ────────────────────────────
const PROGRESS_FILE = join(__dir, `.progress-game-${GAME}.txt`)

function loadProgress() {
  if (!existsSync(PROGRESS_FILE)) return 0
  const n = parseInt(readFileSync(PROGRESS_FILE, 'utf8').trim())
  return isNaN(n) ? 0 : n + 1   // start EFTER det gemte index
}

function saveProgress(idx) {
  writeFileSync(PROGRESS_FILE, String(idx), 'utf8')
}

function clearProgress() {
  if (existsSync(PROGRESS_FILE)) writeFileSync(PROGRESS_FILE, '', 'utf8')
}

async function run() {
  const provider = getProvider(GAME)

  console.log(`\n📦 Henter sæt for ${GAME}…`)
  let sets
  try {
    sets = await provider.fetchAllSets()
  } catch (err) {
    console.error('Kunne ikke hente sæt:', err.message)
    process.exit(1)
  }

  const startIdx = loadProgress()
  if (startIdx > 0) {
    console.log(`   Fandt ${sets.length} sæt — genoptager fra sæt ${startIdx + 1} (${sets[startIdx]?.name || sets[startIdx]?.code})\n`)
  } else {
    console.log(`   Fandt ${sets.length} sæt\n`)
  }

  let totalCards  = 0
  let totalErrors = 0
  let skipped     = 0

  for (let i = startIdx; i < sets.length; i++) {
    const s    = sets[i]
    const pct  = (((i + 1) / sets.length) * 100).toFixed(0)
    process.stdout.write(`\r  [${i + 1}/${sets.length}] (${pct}%) ${String(s.name || s.code).slice(0, 30).padEnd(32)} kort: ${totalCards} | fejl: ${totalErrors}`)

    let cards = []
    let attempts = 0
    while (attempts < MAX_SET_ERRORS) {
      try {
        cards = await provider.fetchCardsForSet(s.externalId || s.code)
        break
      } catch (err) {
        attempts++
        if (attempts >= MAX_SET_ERRORS) { skipped++; break }
        await sleep(DELAY_ERROR_MS * attempts)
      }
    }

    if (!cards.length) {
      await sleep(DELAY_SET_MS)
      continue
    }

    const allRows = cards.map(c => ({
      // Brug TCGPlayer-ID (providerIds.tcgapi) som unik nøgle — undgår kollisioner
      // når samme kortnummer optræder i multiple printings (SP, alt art, promo osv.)
      // Falder tilbage til number-baseret ID for providers uden tcgapi nøgle (pokemontcg.io, Scryfall)
      id:           c.providerIds?.tcgapi
                      ? `${GAME}-${c.providerIds.tcgapi}`
                      : buildCatalogId(GAME, s.externalId || s.code, c.number),
      game:         GAME,
      name:         c.name,
      number:       c.number || null,
      set_id:       s.externalId || s.code,
      set_name:     c.setName || s.name || null,
      rarity:       c.rarity || null,
      finish_types: c.finishTypes || ['Normal'],
      image_url:    c.imageUrl || null,
      updated_at:   new Date().toISOString(),
    }))

    // Filtrer kort uden billede (image_url er NOT NULL i DB) + dedupliker på catalog ID
    const catalogRows = [...new Map(
      allRows.filter(r => r.image_url).map(r => [r.id, r])
    ).values()]

    if (!catalogRows.length) {
      await sleep(DELAY_SET_MS)
      continue
    }

    // Upsert i chunks af 50 for at undgå Supabase statement timeout
    const CHUNK = 50
    for (let ci = 0; ci < catalogRows.length; ci += CHUNK) {
      const chunk = catalogRows.slice(ci, ci + CHUNK)
      try {
        await dbUpsert('card_catalog', chunk, 'id')
        totalCards += chunk.length
      } catch (err) {
        console.error(`\n❌ Upsert fejl (sæt ${s.name}): ${err.message.slice(0, 120)}`)
        totalErrors += chunk.length
      }
    }

    saveProgress(i)   // gem fremgang efter hvert færdigt sæt
    await sleep(DELAY_SET_MS)
  }

  clearProgress()     // færdig — slet progress-filen
  console.log(`\n\n✅ Færdig!`)
  console.log(`   Kort importeret: ${totalCards}`)
  console.log(`   Fejl:            ${totalErrors}`)
  console.log(`   Sæt sprunget over: ${skipped}`)

  const dbTotal = await dbCount('card_catalog', `game=eq.${GAME}`)
  console.log(`   Total i database: ${dbTotal}`)
  console.log(`\n➡  Kør nu: node scripts/backfill-phash-only.js ${GAME}`)
}

run().catch(err => { console.error(err); process.exit(1) })
