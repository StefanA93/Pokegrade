import { Worker } from 'bullmq'
import { getBullRedis, cacheDel, CacheKeys } from '../packages/cache/index.js'
import { processAndUpload } from '../packages/storage/index.js'
import { computePhash } from '../packages/scanner/index.js'
import { dbUpdate, dbSelect } from '../server/middleware/db.js'
import { indexCards } from '../packages/search/index.js'
import sharp from 'sharp'

export function createImageWorker() {
  return new Worker('images', async job => {
    if (job.name === 'download-image') {
      await handleDownloadImage(job)
    }
  }, {
    connection: getBullRedis(),
    concurrency: 5,
    limiter: { max: 30, duration: 60000 },
  })
}

async function handleDownloadImage(job) {
  const { cardId, imageUrl, game, setCode, number, name } = job.data

  const existing = await dbSelect('card_catalog', `id=eq.${encodeURIComponent(cardId)}&select=image_key,phash`)
  if (existing[0]?.image_key && existing[0]?.phash) {
    job.log(`Image already processed for ${cardId}`)
    return
  }

  job.log(`Downloading image for ${cardId}: ${imageUrl}`)

  const res = await fetch(imageUrl)
  if (!res.ok) throw new Error(`Failed to fetch ${imageUrl}: ${res.status}`)
  const rawBuffer = Buffer.from(await res.arrayBuffer())

  const [{ fullKey, thumbKey }, phash] = await Promise.all([
    processAndUpload({ sourceBuffer: rawBuffer, game, setCode: setCode || 'unknown', number, name }),
    computePhash(rawBuffer),
  ])

  await dbUpdate('card_catalog', { id: cardId }, {
    image_key: fullKey,
    thumb_key: thumbKey,
    phash,
  })

  const updatedCard = await dbSelect(
    'card_catalog',
    `id=eq.${encodeURIComponent(cardId)}&select=id,game,name,number,set_id,set_name,rarity,finish_types,price_eur,price_avg7`
  )
  if (updatedCard[0]) {
    await indexCards([{ ...updatedCard[0], thumb_key: thumbKey, phash }])
  }

  await cacheDel(CacheKeys.card(cardId))

  job.log(`Processed image for ${cardId}: key=${fullKey}, phash=${phash}`)
}
