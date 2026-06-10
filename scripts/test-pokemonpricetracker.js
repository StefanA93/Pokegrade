/**
 * Test PokemonPriceTracker API — JP Pokemon kortpriser
 * Kræver: POKEMONPRICETRACKER_KEY i .env
 *
 * Opret gratis konto: https://www.pokemonpricetracker.com/pokemon-card-price-api
 *
 * Brug:
 *   node scripts/test-pokemonpricetracker.js
 */
import 'dotenv/config'

const KEY  = process.env.POKEMONPRICETRACKER_KEY
const BASE = 'https://www.pokemonpricetracker.com/api/v2'
const HEADERS = {
  'Authorization': `Bearer ${KEY}`,
  'Content-Type': 'application/json',
}

if (!KEY) {
  console.error('❌  POKEMONPRICETRACKER_KEY mangler i .env')
  process.exit(1)
}

async function apiFetch(path) {
  const r = await fetch(`${BASE}${path}`, { headers: HEADERS })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`)
  }
  return r.json()
}

// JP sæt vi har i vores DB (sample)
const JP_SETS_TO_TEST = [
  'S1H: Shield',
  'SV3: Ruler of the Black Flame',
  'S1W: Sword',
  'SV1S: Scarlet ex',
  'S9a: Battle Region',
]

async function main() {
  console.log('🔑  Tester PokemonPriceTracker API...\n')

  // 1. Hent JP sæt
  console.log('📦  Henter JP sæt-liste...')
  let sets
  try {
    const d = await apiFetch('/sets?language=japanese&limit=100')
    sets = d.data || d
    console.log(`  Fundet ${Array.isArray(sets) ? sets.length : '?'} JP sæt`)
    if (Array.isArray(sets)) {
      sets.slice(0, 10).forEach(s => console.log(`  - "${s.name}" | id: ${s.id} | cards: ${s.total_cards ?? '?'}`))
    } else {
      console.log('  Uventet format:', JSON.stringify(sets).slice(0, 300))
    }
  } catch (e) {
    console.error('  Fejl ved sæt-hentning:', e.message)
    // Prøv uden language parameter
    console.log('\n  Prøver uden language parameter...')
    try {
      const d = await apiFetch('/sets?limit=10')
      console.log('  Sample sæt:', JSON.stringify((d.data || d).slice(0, 3), null, 2).slice(0, 400))
    } catch (e2) {
      console.error('  Også fejl:', e2.message)
    }
    process.exit(1)
  }

  if (!Array.isArray(sets) || sets.length === 0) {
    console.log('\n❌  Ingen JP sæt returneret — tjek om planen inkluderer JP data')
    process.exit(1)
  }

  // 2. Match mod vores DB-sæt
  console.log('\n🔍  Matcher mod vores DB sæt:')
  const setNames = sets.map(s => s.name?.toLowerCase())
  for (const dbSet of JP_SETS_TO_TEST) {
    const match = sets.find(s =>
      s.name?.toLowerCase().includes(dbSet.toLowerCase()) ||
      dbSet.toLowerCase().includes(s.name?.toLowerCase())
    )
    console.log(`  ${match ? '✅' : '❌'} "${dbSet}" → ${match ? `"${match.name}" (id: ${match.id})` : 'ikke fundet'}`)
  }

  // 3. Hent sample kort fra første sæt med priser
  const testSet = sets.find(s => s.total_cards > 0) || sets[0]
  if (!testSet) return

  console.log(`\n🃏  Henter sample kort fra "${testSet.name}" (id: ${testSet.id})...`)
  try {
    const d = await apiFetch(`/cards?language=japanese&setId=${testSet.id}&limit=5`)
    const cards = d.data || d
    if (Array.isArray(cards) && cards.length > 0) {
      console.log(`  ${cards.length} kort returneret`)
      console.log('\n  Første kort — alle felter:')
      console.log(JSON.stringify(cards[0], null, 2))

      // Identificér prisfelter
      const priceFields = Object.entries(cards[0])
        .filter(([k, v]) => typeof v === 'number' || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).some(x => typeof x === 'number')))
        .map(([k]) => k)
      console.log('\n  Prisfelter:', priceFields)
    } else {
      console.log('  Ingen kort:', JSON.stringify(cards).slice(0, 300))
    }
  } catch (e) {
    console.error('  Fejl:', e.message)
  }

  // 4. Prøv direkte søgning på JP kort
  console.log('\n🔎  Søger efter "Charizard" på japansk...')
  try {
    const d = await apiFetch('/cards?language=japanese&search=Charizard&limit=3')
    const cards = d.data || d
    if (Array.isArray(cards)) {
      cards.forEach(c => {
        const price = c.price?.market || c.prices?.market || c.market_price || c.price || '?'
        console.log(`  - ${c.name} | set: ${c.set_name || c.set?.name} | pris: ${price}`)
      })
    }
  } catch (e) {
    console.error('  Fejl:', e.message)
  }

  console.log('\n✅  Test færdig')
}

main().catch(e => { console.error(e); process.exit(1) })
