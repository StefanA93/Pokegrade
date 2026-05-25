import { verifyServiceKey } from '../middleware/auth.js'
import { indexStatus, configureIndex } from '../../packages/search/index.js'
import { syncQueue, priceQueue, imageQueue } from '../../worker/queues.js'
import { getAllGameIds } from '../../packages/providers/index.js'

export async function adminRoutes(fastify) {
  fastify.post('/admin/sync/:gameId', { preHandler: verifyServiceKey }, async (req, reply) => {
    const { gameId } = req.params
    const validGames = getAllGameIds()

    if (gameId !== 'all' && !validGames.includes(gameId)) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: `Unknown game: ${gameId}` } })
    }

    const games = gameId === 'all' ? validGames : [gameId]
    const jobs  = await Promise.all(games.map(g => syncQueue.add('sync-game', { gameId: g })))

    return { queued: jobs.length, games }
  })

  fastify.post('/admin/sync-prices/:gameId', { preHandler: verifyServiceKey }, async (req, reply) => {
    const { gameId } = req.params
    await priceQueue.add('sync-prices', { gameId })
    return { queued: true, gameId }
  })

  fastify.post('/admin/reindex', { preHandler: verifyServiceKey }, async (req, reply) => {
    await configureIndex()
    const games = getAllGameIds()
    const jobs  = await Promise.all(games.map(g => syncQueue.add('reindex-game', { gameId: g })))
    return { queued: jobs.length }
  })

  fastify.get('/admin/queue/status', { preHandler: verifyServiceKey }, async () => {
    const [syncCounts, priceCounts, imageCounts] = await Promise.all([
      syncQueue.getJobCounts(),
      priceQueue.getJobCounts(),
      imageQueue.getJobCounts(),
    ])
    const search = await indexStatus()
    return { queues: { sync: syncCounts, price: priceCounts, image: imageCounts }, search }
  })

  fastify.get('/admin/games', { preHandler: verifyServiceKey }, async () => {
    return getAllGameIds().map(id => ({ id }))
  })
}
