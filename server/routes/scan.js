import { scanCard, toWebp, generateThumbnail } from '../../packages/scanner/index.js'
import { searchCards } from '../../packages/search/index.js'
import { dbSelect, dbInsert } from '../middleware/db.js'
import { verifyJWT } from '../middleware/auth.js'

export async function scanRoutes(fastify) {
  fastify.post('/scan', { preHandler: verifyJWT }, async (req, reply) => {
    const data = await req.file()
    if (!data) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Image required' } })
    }

    const { game } = req.query
    const chunks = []
    for await (const chunk of data.file) chunks.push(chunk)
    const imageBuffer = Buffer.concat(chunks)

    const result = await scanCard(imageBuffer, {
      game: game || null,
      searchFn: (text, opts) => searchCards(text, opts)
    })

    const candidates = (result.candidates || [])
    const matchIds = candidates.map(c => c.id).filter(Boolean)

    let enriched = []
    if (matchIds.length) {
      enriched = await dbSelect(
        'card_catalog',
        `id=in.(${matchIds.map(id => `"${id}"`).join(',')})&select=*,card_prices(*)`
      )
    }

    const mergeCard = c => ({
      ...c,
      ...(enriched.find(e => e.id === c.id) || {}),
    })

    if (result.autoMatched && result.match) {
      await logScan(req.userId)
      return {
        autoMatched: true,
        confidence:  result.confidence,
        ocrText:     result.ocrText,
        match:       mergeCard(result.match),
        alternatives: candidates.slice(1, 3).map(mergeCard),
      }
    }

    return {
      autoMatched: false,
      confidence:  result.confidence,
      ocrText:     result.ocrText,
      candidates:  candidates.map(mergeCard),
    }
  })

  fastify.post('/scan/confirm', { preHandler: verifyJWT }, async (req, reply) => {
    const { cardId, finish = 'Normal', condition = null, purchasePrice = null } = req.body || {}
    if (!cardId) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'cardId required' } })
    }

    const cards = await dbSelect('card_catalog', `id=eq.${encodeURIComponent(cardId)}&select=*,card_prices(*)`)
    const card = cards[0]
    if (!card) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Card not found' } })
    }

    const priceRow = (card.card_prices || []).find(p => p.finish === finish) || {}

    const userCard = {
      user_id:       req.userId,
      catalog_id:    cardId,
      game:          card.game,
      name:          card.name,
      set_name:      card.set_name,
      card_number:   card.number,
      finish,
      condition,
      purchase_price: purchasePrice,
      value:          priceRow.price_avg7  || card.price_eur || null,
      price_avg7:     priceRow.price_avg7  || null,
      price_avg30:    priceRow.price_avg30 || null,
      price_low:      priceRow.price_low   || null,
      price_sell:     priceRow.price_sell  || null,
      cardmarket_url: priceRow.cm_url      || card.cardmarket_url || null,
      image_url:      card.image_url       || null,
    }

    const [created] = await dbInsert('cards', userCard)
    await logScan(req.userId)

    return { saved: true, card: created }
  })
}

async function logScan(userId) {
  const today = new Date().toISOString().split('T')[0]
  await dbInsert('scan_logs', { user_id: userId, scan_date: today }).catch(() => null)
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/increment_total_scans`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      apikey:         process.env.SUPABASE_SERVICE_KEY,
    },
    body: JSON.stringify({ p_user_id: userId })
  }).catch(() => null)
}
