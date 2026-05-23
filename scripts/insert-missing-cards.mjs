/**
 * insert-missing-cards.mjs — Manually insert cards missing from pokemontcg.io
 * into the Supabase card_catalog table.
 *
 * Usage (PowerShell):
 *   $env:SUPABASE_SERVICE_KEY = "YOUR_SERVICE_ROLE_KEY"
 *   node scripts/insert-missing-cards.mjs
 *
 * Get service key from:
 *   https://supabase.com/dashboard/project/yezlcgooutpshqdhvufg/settings/api
 */

const SUPABASE_URL = 'https://yezlcgooutpshqdhvufg.supabase.co'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_SERVICE_KEY) {
  console.error('Set SUPABASE_SERVICE_KEY env var.')
  console.error('Get it from: https://supabase.com/dashboard/project/yezlcgooutpshqdhvufg/settings/api')
  process.exit(1)
}

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates,return=representation',
}

// Cards that exist in pokemontcg.io but only as Japanese versions,
// or are missing from the English database entirely.
// Image URLs use the pokemontcg.io CDN where available.
const MISSING_CARDS = [
  {
    id: 'rsv10pt5-43',
    game: 'pokemon',
    name: 'Gothitelle',
    set_id: 'rsv10pt5',
    set_name: 'White Flare',
    number: '43',
    rarity: 'Special Illustration Rare',
    image_url: 'https://images.pokemontcg.io/rsv10pt5/43_hires.png',
    price_eur: 35.00,
    cardmarket_url: 'https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=Gothitelle+White+Flare',
  },
]

async function run() {
  console.log(`Inserting ${MISSING_CARDS.length} missing card(s) into card_catalog...`)

  for (const card of MISSING_CARDS) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/card_catalog`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(card),
    })

    if (res.ok) {
      const data = await res.json()
      console.log(`✓ Inserted: ${card.id} — ${card.name} (${card.set_name} ${card.number}) rarity=${card.rarity}`)
    } else {
      const err = await res.text()
      console.error(`✗ Failed ${card.id}: ${res.status} ${err}`)
    }
  }

  console.log('Done.')
}

run()
