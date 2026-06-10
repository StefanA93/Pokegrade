/**
 * Indeksér ALLE kort fra card_catalog i Meilisearch — ikke kun dem med billeder.
 * Kør én gang efter backfill. Idempotent.
 */
import 'dotenv/config'
import { indexCards } from '../packages/search/index.js'
import { dbSelect } from '../server/middleware/db.js'

const BATCH  = 1000
const GAMES  = ['pokemon', 'yugioh', 'mtg', 'lorcana', 'onepiece', 'dragonball', 'pokemonjp']

async function run() {
  for (const game of GAMES) {
    let offset = 0
    let total  = 0

    process.stdout.write(`\nIndekserer ${game}...\n`)

    while (true) {
      const rows = await dbSelect(
        'card_catalog',
        `game=eq.${game}&select=id,name,number,set_id,set_name,rarity,finish_types,image_url,thumb_key,phash,phash_art&limit=${BATCH}&offset=${offset}`
      )
      if (!rows.length) break

      const docs = rows.map(r => {
        const numInt = parseInt(r.number, 10)
        return {
          id:           r.id,
          game_id:      game,
          name:         r.name,
          number:       r.number   || '',
          numberInt:    Number.isFinite(numInt) && numInt > 0 ? numInt : null,
          set_id:       r.set_id   || '',
          set_name:     r.set_name || '',
          rarity:       r.rarity   || '',
          finish_types: r.finish_types || ['Normal'],
          thumb_key:    r.thumb_key || '',
          phash:        r.phash     || null,
          phash_art:    r.phash_art || null,
          hasPrice:     false,
        }
      })

      await indexCards(docs)
      offset += rows.length
      total  += rows.length
      process.stdout.write(`\r  ${total} kort indekseret...`)
    }

    console.log(`\n  ${game}: ${total} kort indekseret OK`)
  }
  console.log('\nFærdig!')
}

run().catch(err => { console.error(err); process.exit(1) })
