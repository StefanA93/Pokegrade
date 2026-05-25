import { cacheThrough, CacheKeys, TTL } from '../../packages/cache/index.js'
import { dbSelect } from '../middleware/db.js'

export async function setsRoutes(fastify) {
  fastify.get('/sets', async (req) => {
    const { game } = req.query
    const key = game ? `sets:${game}` : 'sets:all'
    return cacheThrough(key, TTL.SET, async () => {
      const qs = game
        ? `game_id=eq.${encodeURIComponent(game)}&order=release_date.desc`
        : 'order=release_date.desc'
      return dbSelect('sets', qs)
    })
  })

  fastify.get('/sets/:id', async (req, reply) => {
    const { id } = req.params
    const set = await cacheThrough(CacheKeys.set(id), TTL.SET, async () => {
      const rows = await dbSelect('sets', `id=eq.${encodeURIComponent(id)}`)
      return rows[0] || null
    })
    if (!set) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Set not found' } })
    return set
  })

  fastify.get('/sets/:id/cards', async (req, reply) => {
    const { id } = req.params
    const { page = 1, limit = 50 } = req.query
    const offset = (page - 1) * limit

    const key = `${CacheKeys.setCards(id)}:${page}:${limit}`
    return cacheThrough(key, TTL.SET_CARDS, async () => {
      return dbSelect(
        'card_catalog',
        `set_db_id=eq.${encodeURIComponent(id)}&order=number&limit=${limit}&offset=${offset}&select=id,name,number,rarity,finish_types,thumb_key,price_eur,price_avg7`
      )
    })
  })
}
