/**
 * Sletter eksisterende kortdata for spil der re-importeres fra tcgapi.dev.
 * Kør EN GANG inden import-game.js køres for disse spil.
 *
 * Sletter: pokemon (gamle pokemontcg.io IDs), yugioh (gamle ygoprodeck IDs),
 *          lorcana (partial import), dragonball (kun 5 sæt fra manglende pagination)
 *
 * Bevarer: mtg (Scryfall EN — beholdes som-er)
 *
 * Brug: node scripts/clear-for-reimport.js
 *       node scripts/clear-for-reimport.js pokemon    (kun ét spil)
 */
import 'dotenv/config'

const SUPABASE_URL         = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

const GAMES_TO_CLEAR = process.argv[2]
  ? [process.argv[2]]
  : ['pokemon', 'yugioh', 'lorcana', 'dragonball']

const headers = {
  'Content-Type': 'application/json',
  Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
  apikey:          SUPABASE_SERVICE_KEY,
}

async function countGame(game) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}`,
    { headers: { ...headers, Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } }
  )
  return parseInt(r.headers.get('content-range')?.split('/')[1] || '0')
}

async function clearGame(game) {
  const count = await countGame(game)
  if (count === 0) {
    console.log(`  ${game}: 0 kort — springer over`)
    return
  }

  process.stdout.write(`  ${game}: sletter ${count} kort...`)
  let deleted = 0

  while (true) {
    const idsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&select=id&limit=1000`,
      { headers }
    )
    const ids = await idsRes.json()
    if (!ids.length) break

    const idList = ids.map(r => `"${r.id}"`).join(',')
    await fetch(
      `${SUPABASE_URL}/rest/v1/card_catalog?id=in.(${idList})`,
      { method: 'DELETE', headers }
    )
    deleted += ids.length
    process.stdout.write(`\r  ${game}: slettet ${deleted}/${count}...`)
  }

  console.log(`\r  ${game}: ✅ ${deleted} kort slettet (cascade: priser, provider_ids, sets)`)
}

console.log('\n🗑  Clear-for-reimport')
console.log(`   Spil: ${GAMES_TO_CLEAR.join(', ')}`)
console.log(`   MTG bevares (Scryfall EN)\n`)

for (const game of GAMES_TO_CLEAR) {
  await clearGame(game)
}

console.log('\n✅ Klar til re-import. Kør nu:')
GAMES_TO_CLEAR.forEach(g => console.log(`   node scripts/import-game.js ${g}`))
