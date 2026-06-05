/**
 * Dry-run test af en provider — bruger MINIMALE API-kald (typisk 2-4 pr. spil).
 * Skriver INTET til databasen.
 *
 * Brug:
 *   node scripts/test-provider.js pokemon
 *   node scripts/test-provider.js yugioh
 *   node scripts/test-provider.js pokemonjp
 *   node scripts/test-provider.js onepiece
 *   node scripts/test-provider.js lorcana
 *   node scripts/test-provider.js dragonball
 */
import 'dotenv/config'
import { getProvider } from '../packages/providers/index.js'

const GAME = process.argv[2]
if (!GAME) {
  console.error('Brug: node scripts/test-provider.js <game>')
  process.exit(1)
}

function buildCatalogId(gameId, setId, number) {
  const safeNum = String(number || 'x').replace(/[^a-zA-Z0-9]/g, '')
  return `${gameId}-${setId}-${safeNum}`.toLowerCase()
}

function pad(s, n) { return String(s).padEnd(n) }

async function run() {
  console.log(`\n🧪 Provider test — ${GAME}`)
  console.log('   (dry run, ingen DB-writes)\n')

  const provider = getProvider(GAME)

  // ── 1. Hent sæt-liste ────────────────────────────────────────────────────
  console.log('▶ Henter sæt-liste...')
  let sets
  try {
    sets = await provider.fetchAllSets()
  } catch (err) {
    console.error(`❌ fetchAllSets fejlede: ${err.message}`)
    process.exit(1)
  }

  if (!sets.length) {
    console.error('❌ Ingen sæt returneret — tjek game-identifier og API-nøgle')
    process.exit(1)
  }

  console.log(`✅ ${sets.length} sæt hentet\n`)
  console.log('Første 5 sæt:')
  sets.slice(0, 5).forEach(s =>
    console.log(`  ${pad(s.code, 30)} ${pad(s.name || '—', 35)} cards: ${s.cardCount ?? '?'}`)
  )

  // ── 2. Hent kort for første sæt med kort ─────────────────────────────────
  // Find et sæt med mange kort — mere sandsynligt at have rigtige kort (ikke kun sealed)
  const testSet = sets.find(s => (s.cardCount || 0) > 50) || sets.find(s => s.cardCount > 0) || sets[0]
  console.log(`\n▶ Henter kort for sæt: "${testSet.name}" (${testSet.externalId || testSet.code})...`)

  let cards
  try {
    cards = await provider.fetchCardsForSet(testSet.externalId || testSet.code)
  } catch (err) {
    console.error(`❌ fetchCardsForSet fejlede: ${err.message}`)
    process.exit(1)
  }

  if (!cards.length) {
    console.warn('⚠️  0 kort i dette sæt — prøv et andet sæt manuelt')
  } else {
    console.log(`✅ ${cards.length} kort hentet\n`)

    // Vis de første 3 kort med det ID de ville få i DB
    console.log('Eksempel-kort (ID-format der gemmes i card_catalog):')
    cards.slice(0, 3).forEach(c => {
      const catalogId = buildCatalogId(GAME, testSet.externalId || testSet.code, c.number)
      console.log(`  ID:        ${catalogId}`)
      console.log(`  Navn:      ${c.name}`)
      console.log(`  Nummer:    ${c.number ?? '—'}`)
      console.log(`  Rarity:    ${c.rarity ?? '—'}`)
      console.log(`  Image URL: ${c.imageUrl ? '✅ ' + c.imageUrl.slice(0, 60) + '...' : '❌ mangler'}`)
      console.log(`  Pris:      ${c.prices ? JSON.stringify(c.prices).slice(0, 60) : '—'}`)
      console.log()
    })
  }

  // ── 3. Realistisk request-estimat baseret på faktiske data ───────────────
  const LIMIT         = 50
  const setCalls      = Math.ceil(sets.length / LIMIT)
  const avgCards      = sets.reduce((s, x) => s + (x.cardCount || 0), 0) / sets.length || cards.length
  const cardCallsEst  = Math.ceil(avgCards / LIMIT) * sets.length
  const totalEst      = setCalls + cardCallsEst

  console.log('── Request-estimat (baseret på faktiske sæt-data) ──────────')
  console.log(`  Sæt:               ${sets.length}`)
  console.log(`  Gns. kort/sæt:     ${avgCards.toFixed(0)}`)
  console.log(`  Sæt-kald:          ${setCalls}`)
  console.log(`  Kort-kald (est):   ${cardCallsEst}`)
  console.log(`  TOTAL est:         ${totalEst} requests`)
  console.log(`  Dage (1000/dag):   ${Math.ceil(totalEst / 1000)}`)

  // Advarsel hvis enkelt spil overstiger dagslimit
  if (totalEst > 1000) {
    console.log(`\n⚠️  Overstiger 1000/dag — import-game.js bruger progress-fil og kan genoptages`)
  }

  console.log('\n✅ Test OK — provider virker korrekt')
  console.log(`   Klar til: node scripts/import-game.js ${GAME}`)
}

run().catch(err => { console.error(err); process.exit(1) })
