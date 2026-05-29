/**
 * Re-indeksér alle kort i Meilisearch med opdaterede phash-værdier.
 * Kør efter backfill-phash-only.js er færdig.
 * Kør: node scripts/reindex-with-phash.js
 */
import 'dotenv/config'
import { indexCards } from '../packages/search/index.js'
import { dbSelect } from '../server/middleware/db.js'

const BATCH = 500
const GAME  = 'pokemon'

async function run() {
  let offset = 0, total = 0
  process.stdout.write(`\nRe-indekserer ${GAME} med phash...\n`)

  while (true) {
    const rows = await dbSelect(
      'card_catalog',
      `game=eq.${GAME}&select=id,name,number,set_id,set_name,rarity,finish_types,thumb_key,phash&limit=${BATCH}&offset=${offset}`
    )
    if (!rows.length) break

    await indexCards(rows.map(r => ({
      id:           r.id,
      game_id:      GAME,
      name:         r.name,
      number:       r.number      || '',
      set_id:       r.set_id      || '',
      set_name:     r.set_name    || '',
      rarity:       r.rarity      || '',
      finish_types: r.finish_types || ['Normal'],
      thumb_key:    r.thumb_key   || '',
      phash:        r.phash       || null,
      hasPrice:     false,
    })))

    offset += rows.length
    total  += rows.length
    process.stdout.write(`\r  ${total} kort re-indekseret...`)
  }

  console.log(`\n  Færdig — ${total} kort i Meilisearch med phash\n`)
}

run().catch(err => { console.error(err); process.exit(1) })
