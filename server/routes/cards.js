import { cacheThrough, CacheKeys, TTL } from '../../packages/cache/index.js'
import { dbSelect } from '../middleware/db.js'

export async function cardsRoutes(fastify) {
  fastify.get('/cards/:id', async (req, reply) => {
    const { id } = req.params
    const card = await cacheThrough(CacheKeys.card(id), TTL.CARD, async () => {
      const rows = await dbSelect(
        'card_catalog',
        `id=eq.${encodeURIComponent(id)}&select=*,card_prices(*),card_provider_ids(*)`
      )
      return rows[0] || null
    })
    if (!card) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Card not found' } })
    return card
  })

  fastify.get('/cards/:id/prices', async (req, reply) => {
    const { id } = req.params
    const prices = await cacheThrough(
      `${CacheKeys.card(id)}:prices`,
      TTL.PRICE,
      () => dbSelect('card_prices', `catalog_id=eq.${encodeURIComponent(id)}&order=finish`)
    )
    return prices
  })

  fastify.get('/cards/:id/prices/history', async (req, reply) => {
    const { id } = req.params
    const { period = '30d', finish = 'Normal' } = req.query

    const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[period] || 30
    const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

    const rows = await dbSelect(
      'price_history',
      `catalog_id=eq.${encodeURIComponent(id)}&finish=eq.${encodeURIComponent(finish)}&recorded_at=gte.${since}&order=recorded_at.asc`
    )
    return rows
  })
}
