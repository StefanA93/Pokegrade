import 'dotenv/config'
import { processAndUpload } from '../packages/storage/index.js'
import { computePhash } from '../packages/scanner/index.js'
import { dbSelect, dbUpdate } from '../server/middleware/db.js'
import { indexCards } from '../packages/search/index.js'

const BATCH = 20
const DELAY = 200

async function run() {
  console.log('Starting direct image processing (no Redis)...')
  let total = 0
  let failed = 0

  while (true) {
    const cards = await dbSelect(
      'card_catalog',
      `image_key=is.null&image_url=not.is.null&select=id,game,name,number,set_id,set_name,rarity,finish_types,image_url,price_eur,price_avg7&limit=${BATCH}`
    )

    if (!cards.length) {
      console.log(`\nDone! Processed ${total} images, ${failed} failed.`)
      break
    }

    for (const card of cards) {
      try {
        const res = await fetch(card.image_url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())

        const [{ fullKey, thumbKey }, phash] = await Promise.all([
          processAndUpload({
            sourceBuffer: buf,
            game: card.game,
            setCode: card.set_id || 'unknown',
            number: card.number,
            name: card.name,
          }),
          computePhash(buf),
        ])

        await dbUpdate('card_catalog', { id: card.id }, { image_key: fullKey, thumb_key: thumbKey, phash })
        await indexCards([{ ...card, thumb_key: thumbKey, phash }])

        total++
        process.stdout.write(`\r${total} done, ${failed} failed`)
      } catch (err) {
        failed++
        await dbUpdate('card_catalog', { id: card.id }, { image_key: 'error' }).catch(() => null)
      }

      await sleep(DELAY)
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

run().catch(err => { console.error(err); process.exit(1) })
