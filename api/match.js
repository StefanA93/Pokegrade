export const config = { runtime: 'edge' }

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  const token = authHeader.replace('Bearer ', '')
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY }
    })
    if (!userRes.ok) throw new Error('Invalid token')
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401 })
  }

  let body
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 })
  }

  const { embedding, game = 'pokemon', ability, attacks, hp, cardName } = body

  if (!embedding || !Array.isArray(embedding) || embedding.length !== 512) {
    return new Response(JSON.stringify({
      error: 'Invalid embedding — must be float32 array[512]',
      fallback: true,
    }), { status: 400 })
  }

  const sbHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  }

  const debug = { embeddingDim: embedding.length, game }

  try {
    // pgvector cosine similarity: top-20 visually similar cards
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_cards`, {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        query_embedding: `[${embedding.join(',')}]`,
        game_filter: game,
        match_count: 20,
      }),
    })

    let candidates = []
    if (rpcRes.ok) {
      candidates = await rpcRes.json()
      debug.vectorHits = candidates.length
    } else {
      const errText = await rpcRes.text()
      debug.vectorError = errText
      // pgvector not yet set up — return fallback signal
      return new Response(JSON.stringify({
        match: null,
        confidence: 'none',
        candidates: [],
        fallback: true,
        debug,
      }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } })
    }

    // Rerank with OCR signals extracted by Claude
    // Weights: embedding(0.60) + cardName(0.15) + ability(0.15) + attacks(0.10)
    const reranked = candidates.map(c => {
      const embSim = typeof c.similarity === 'number' ? c.similarity : 0
      let score = embSim * 0.60

      // Name signal — Claude's extraction vs database name
      if (cardName && c.name) {
        const nameMatch = c.name.toLowerCase().includes(cardName.toLowerCase()) ||
          cardName.toLowerCase().includes(c.name.toLowerCase())
        if (nameMatch) score += 0.15
      }

      // Ability signal — provided by Claude extraction in analyze.js
      if (ability && c.name) {
        // We can't match ability directly (not in card_catalog schema yet)
        // Boost cards where the name matches — ability lookup from ptcg if needed
        // This is a placeholder for when abilities column is added
      }

      // attack/hp signals — placeholder, will improve when columns are added
      // For now, name match + visual similarity is the primary signal

      return { ...c, finalScore: Math.min(1, score) }
    })

    reranked.sort((a, b) => b.finalScore - a.finalScore)

    const best = reranked[0] ?? null
    debug.bestScore = best ? Math.round(best.finalScore * 100) : null
    debug.bestId = best?.id ?? null

    const confidence = !best ? 'none'
      : best.finalScore >= 0.70 ? 'high'
      : best.finalScore >= 0.50 ? 'medium'
      : 'low'

    return new Response(JSON.stringify({
      match: best ? {
        id: best.id,
        name: best.name,
        rarity: best.rarity,
        set_name: best.set_name,
        set_id: best.set_id,
        number: best.number,
        image_url: best.image_url,
        price_eur: best.price_eur,
        cardmarket_url: best.cardmarket_url,
        score: best.finalScore,
      } : null,
      confidence,
      candidates: reranked.slice(0, 5).map(c => ({
        id: c.id,
        name: c.name,
        rarity: c.rarity,
        set_name: c.set_name,
        number: c.number,
        score: c.finalScore,
      })),
      debug,
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Match failed', detail: e.message }), { status: 500 })
  }
}
