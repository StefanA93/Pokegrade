import { Queue } from 'bullmq'
import { getRedis } from '../packages/cache/index.js'

const connection = getRedis()

export const syncQueue  = new Queue('sync',   { connection })
export const priceQueue = new Queue('prices', { connection })
export const imageQueue = new Queue('images', { connection })

const JOB_DEFAULTS = {
  attempts:  3,
  backoff:   { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 200 },
  removeOnFail:     { count: 500 },
}

export async function enqueueSyncGame(gameId) {
  return syncQueue.add('sync-game', { gameId }, JOB_DEFAULTS)
}

export async function enqueueSyncSet(gameId, externalSetId, setDbId) {
  return syncQueue.add('sync-set', { gameId, externalSetId, setDbId }, JOB_DEFAULTS)
}

export async function enqueuePriceSync(gameId) {
  return priceQueue.add('sync-prices', { gameId }, JOB_DEFAULTS)
}

export async function enqueueImageDownload(cardId, imageUrl, game, setCode, number, name) {
  return imageQueue.add('download-image', { cardId, imageUrl, game, setCode, number, name }, {
    ...JOB_DEFAULTS,
    attempts: 5,
  })
}

export async function setupCronJobs() {
  const games = ['pokemon', 'mtg', 'yugioh', 'onepiece', 'lorcana', 'dragonball']

  for (const gameId of games) {
    await priceQueue.add('sync-prices', { gameId }, {
      ...JOB_DEFAULTS,
      repeat: { cron: '0 3 * * *', tz: 'UTC' },
    })
  }

  await syncQueue.add('sync-game', { gameId: 'pokemon' }, {
    ...JOB_DEFAULTS,
    repeat: { cron: '0 1 * * 0', tz: 'UTC' },
  })
}
