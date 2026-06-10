/**
 * Sletter eksisterende kortdata for spil der re-importeres fra tcgapi.dev.
 * Kør EN GANG inden import-game.js køres for disse spil.
 *
 * Sletter: pokemon, yugioh, lorcana, dragonball (gamle ID-formater/kilder)
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

async function getAllSetIds(game) {
  const setIds = new Set()
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&select=set_id&limit=1000&offset=${offset}`,
      { headers }
    )
    const rows = await r.json()
    if (!rows.length) break
    rows.forEach(r => r.set_id && setIds.add(r.set_id))
    if (rows.length < 1000) break
  }
  return [...setIds]
}

async function clearGame(game) {
  const count = await countGame(game)
  if (count === 0) {
    console.log(`  ${game}: allerede tom ✅`)
    return
  }

  // Trin 1: Null catalog_id referencer i cards-tabellen (undgår FK-constraint)
  const ur = await fetch(
    `${SUPABASE_URL}/rest/v1/cards?game=eq.${game}&catalog_id=not.is.null`,
    { method: 'PATCH', headers, body: JSON.stringify({ catalog_id: null }) }
  )
  if (!ur.ok) {
    console.error(`  ${game}: PATCH fejl ${ur.status}:`, await ur.text())
  }

  let deleted = 0

  // Trin 2: Slet via set_id-filter (undgår IN-liste parsing-fejl for IDs med special chars)
  const setIds = await getAllSetIds(game)
  for (const setId of setIds) {
    const dr = await fetch(
      `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&set_id=eq.${encodeURIComponent(setId)}`,
      { method: 'DELETE', headers }
    )
    if (dr.ok) deleted++
    process.stdout.write(`\r  ${game}: ${deleted}/${setIds.length} sæt slettet`)
  }

  // Trin 3: Slet evt. kort uden set_id (én ad gangen)
  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&set_id=is.null&select=id&limit=100`,
      { headers }
    )
    const rows = await r.json()
    if (!rows.length) break
    for (const row of rows) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/card_catalog?id=eq.${encodeURIComponent(row.id)}`,
        { method: 'DELETE', headers }
      )
    }
  }

  const after = await countGame(game)
  console.log(`\r  ${game}: ${count} → ${after} ${after === 0 ? '✅' : '⚠️  ' + after + ' tilbage'}`)
}

console.log('\n🗑  Clear-for-reimport')
console.log(`   Spil: ${GAMES_TO_CLEAR.join(', ')}`)
console.log(`   MTG bevares (Scryfall EN)\n`)

for (const game of GAMES_TO_CLEAR) {
  await clearGame(game)
}

console.log('\n✅ Klar til re-import. Kør nu:')
GAMES_TO_CLEAR.forEach(g => console.log(`   node scripts/import-game.js ${g}`))
