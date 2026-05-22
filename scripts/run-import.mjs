/**
 * run-import.mjs — Trigger the card catalog import page by page.
 *
 * Usage:
 *   IMPORT_SECRET=your_secret node scripts/run-import.mjs pokemon
 *   IMPORT_SECRET=your_secret node scripts/run-import.mjs mtg
 *   IMPORT_SECRET=your_secret node scripts/run-import.mjs yugioh
 *
 * Or against production:
 *   BASE_URL=https://gradedex.eu IMPORT_SECRET=your_secret node scripts/run-import.mjs pokemon
 */

const game = process.argv[2]
if (!['pokemon', 'mtg', 'yugioh'].includes(game)) {
  console.error('Usage: node scripts/run-import.mjs <pokemon|mtg|yugioh>')
  process.exit(1)
}

const BASE_URL = process.env.BASE_URL || 'https://gradedex.eu'
const SECRET = process.env.IMPORT_SECRET
if (!SECRET) {
  console.error('Set IMPORT_SECRET env var first.')
  process.exit(1)
}

let page = 1
let totalImported = 0

console.log(`Starting ${game} import from ${BASE_URL}`)

while (true) {
  const url = `${BASE_URL}/api/import-cards?game=${game}&page=${page}`
  console.log(`  → page ${page}...`)

  const res = await fetch(url, { headers: { 'x-import-secret': SECRET } })
  const data = await res.json()

  if (!res.ok) {
    console.error(`  ✗ Error on page ${page}:`, data)
    process.exit(1)
  }

  totalImported += data.imported || 0
  console.log(`  ✓ page ${page}: +${data.imported} cards (total so far: ${totalImported}/${data.total ?? '?'})`)

  if (!data.hasMore) {
    console.log(`\n✅ Import complete — ${totalImported} ${game} cards in catalog.`)
    break
  }

  page++

  // Small delay between requests
  await new Promise(r => setTimeout(r, 500))
}
