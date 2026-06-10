export const config = { runtime: 'edge' }

const SUPABASE_URL      = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity
  let dist = 0
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (xor) { dist += xor & 1; xor >>= 1 }
  }
  return dist
}

const VALID_GAMES = ['pokemon', 'pokemonjp', 'mtg', 'yugioh', 'onepiece', 'lorcana', 'dragonball', 'riftbound']

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body
  try { body = await req.json() } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const { phash, game } = body

  // phash er 16 hex-tegn (64-bit dHash)
  if (typeof phash !== 'string' || !/^[0-9a-f]{16}$/i.test(phash)) {
    return json({ error: 'phash skal være 16 hex-tegn (beregnet client-side fra kortbilledet)' }, 400)
  }

  const safeGame = VALID_GAMES.includes(game) ? game : 'pokemon'

  // Fase 1: hent alle id + phash for spillet med pagination (Supabase max 1000/kald)
  const sbHeaders = {
    apikey:        SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  }

  const allCards = []
  const PAGE     = 1000
  let   offset   = 0
  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${safeGame}&phash=not.is.null&select=id,phash&limit=${PAGE}&offset=${offset}`,
      { headers: sbHeaders }
    )
    if (!r.ok) return json({ error: 'Database fejl ved phash-opslag' }, 502)
    const batch = await r.json()
    allCards.push(...batch)
    if (batch.length < PAGE) break
    offset += PAGE
  }

  if (!allCards.length) {
    return json({ candidates: [], message: 'Ingen kort med phash fundet for dette spil' })
  }

  // Beregn Hamming-distance for alle kort og tag top 5
  const top5 = allCards
    .map(c => ({ id: c.id, dist: hammingDistance(phash, c.phash) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5)

  // Fase 2: hent fuld kortdata for de 5 bedste matches
  const ids = top5.map(c => `"${c.id}"`).join(',')
  const detailRes = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?id=in.(${ids})&select=id,name,number,set_id,set_name,rarity,finish_types,image_url,game`,
    {
      headers: {
        apikey:        SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  )

  if (!detailRes.ok) {
    return json({ error: 'Database fejl ved kortdata-hentning' }, 502)
  }

  const details = await detailRes.json()
  const detailMap = Object.fromEntries(details.map(c => [c.id, c]))

  // Byg endelig kandidatliste med similarity-score
  const MAX_DIST  = 64 // 8×8 bits
  const candidates = top5.map(({ id, dist }) => {
    const card       = detailMap[id] || { id }
    const similarity = Math.max(0, 1 - dist / MAX_DIST)
    return {
      id:           card.id,
      name:         card.name         || null,
      number:       card.number       || null,
      set_id:       card.set_id       || null,
      set_name:     card.set_name     || null,
      rarity:       card.rarity       || null,
      finish_types: card.finish_types || ['Normal'],
      image_url:    card.image_url    || null,
      game:         card.game         || safeGame,
      similarity:   parseFloat(similarity.toFixed(4)),
      hamming_dist: dist,
    }
  })

  // Confidence baseret på bedste match
  const best       = candidates[0]
  const confidence = !best           ? 'none'
    : best.similarity >= 0.90        ? 'high'
    : best.similarity >= 0.75        ? 'medium'
    : best.similarity >= 0.60        ? 'low'
    : 'very_low'

  return json({
    candidates,
    confidence,
    best: confidence !== 'very_low' ? candidates[0] : null,
    meta: {
      game:        safeGame,
      pool_size:   allCards.length,
      query_phash: phash,
    },
  })
}
