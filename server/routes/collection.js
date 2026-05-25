import { verifyJWT } from '../middleware/auth.js'
import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../middleware/db.js'

export async function collectionRoutes(fastify) {
  fastify.get('/collection', { preHandler: verifyJWT }, async (req) => {
    const { game, limit = 100, offset = 0 } = req.query
    const gameFilter = game ? `&game=eq.${encodeURIComponent(game)}` : ''
    const rows = await dbSelect(
      'cards',
      `user_id=eq.${req.userId}${gameFilter}&order=created_at.desc&limit=${limit}&offset=${offset}&select=*`
    )
    return rows
  })

  fastify.get('/collection/stats', { preHandler: verifyJWT }, async (req) => {
    const cards = await dbSelect(
      'cards',
      `user_id=eq.${req.userId}&select=value,price_avg30,price_avg7,game,created_at`
    )

    const totalValue  = cards.reduce((s, c) => s + (c.value || 0), 0)
    const byGame      = {}
    for (const c of cards) {
      byGame[c.game] = (byGame[c.game] || 0) + (c.value || 0)
    }

    const now = Date.now()
    const cutoff30d = now - 30 * 86400000
    const recentCards = cards.filter(c => c.created_at && new Date(c.created_at).getTime() >= cutoff30d)
    const addedLast30d = recentCards.reduce((s, c) => s + (c.value || 0), 0)

    const movers = cards
      .filter(c => c.value && c.price_avg30)
      .map(c => ({
        ...c,
        trendPct: ((c.value - c.price_avg30) / c.price_avg30) * 100
      }))
      .sort((a, b) => Math.abs(b.trendPct) - Math.abs(a.trendPct))
      .slice(0, 5)

    return {
      totalValue,
      totalCards: cards.length,
      byGame,
      addedLast30d,
      topMovers: movers,
    }
  })

  fastify.post('/collection', { preHandler: verifyJWT }, async (req, reply) => {
    const body = req.body
    if (!body?.catalog_id && !body?.name) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'catalog_id or name required' } })
    }
    const [created] = await dbInsert('cards', { ...body, user_id: req.userId })
    return reply.code(201).send(created)
  })

  fastify.patch('/collection/:id', { preHandler: verifyJWT }, async (req, reply) => {
    const { id } = req.params
    const allowed = ['finish', 'condition', 'grade', 'grader', 'purchase_price', 'notes', 'value']
    const update  = Object.fromEntries(
      Object.entries(req.body || {}).filter(([k]) => allowed.includes(k))
    )
    if (!Object.keys(update).length) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'No valid fields to update' } })
    }
    const [existing] = await dbSelect('cards', `id=eq.${id}&user_id=eq.${req.userId}`)
    if (!existing) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Card not found' } })
    const [updated] = await dbUpdate('cards', { id, user_id: req.userId }, update)
    return updated
  })

  fastify.delete('/collection/:id', { preHandler: verifyJWT }, async (req, reply) => {
    const { id } = req.params
    const [existing] = await dbSelect('cards', `id=eq.${id}&user_id=eq.${req.userId}`)
    if (!existing) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Card not found' } })
    await dbDelete('cards', { id, user_id: req.userId })
    return reply.code(204).send()
  })
}
