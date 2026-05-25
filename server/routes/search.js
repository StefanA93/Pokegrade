import { searchCards } from '../../packages/search/index.js'
import { cacheThrough, CacheKeys, TTL } from '../../packages/cache/index.js'

export async function searchRoutes(fastify) {
  fastify.get('/search', async (req, reply) => {
    const { q, game, limit = 10, offset = 0 } = req.query
    if (!q || q.trim().length < 1) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Query required' } })
    }

    const cacheKey = CacheKeys.search(q, game)
    return cacheThrough(cacheKey, TTL.SEARCH, () =>
      searchCards(q.trim(), { gameId: game || null, limit: parseInt(limit), offset: parseInt(offset) })
    )
  })
}
