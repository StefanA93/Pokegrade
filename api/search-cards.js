export const config = { runtime: 'edge' }

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: CORS_HEADERS,
    })
  }

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') ?? '').trim()
  const game = (searchParams.get('game') ?? '').trim()
  const number = (searchParams.get('number') ?? '').trim()
  const set = (searchParams.get('set') ?? '').trim()
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 50)

  if (!q && !number) {
    return new Response(JSON.stringify({ cards: [] }), { headers: CORS_HEADERS })
  }

  // Build PostgREST filter string
  const filters = []

  if (game) {
    const VALID_GAMES = ['pokemon', 'mtg', 'yugioh', 'pokemonjp', 'onepiece', 'dragonball', 'lorcana', 'riftbound']
    if (VALID_GAMES.includes(game)) filters.push(`game=eq.${encodeURIComponent(game)}`)
  }

  if (number) {
    // Exact number match takes priority — used when AI returns a card number
    filters.push(`number=eq.${encodeURIComponent(number)}`)
  }

  if (set) {
    filters.push(`set_name=ilike.${encodeURIComponent(`*${set}*`)}`)
  }

  // Name search — ilike for substring match
  // If there's an exact-name match we want it first; PostgREST can't rank, so we
  // run two queries: one exact, then a broader ilike, then deduplicate.
  const baseFields =
    'id,game,name,number,set_id,set_name,rarity,finish,image_url,image_url_small,cardmarket_url,price_eur,price_eur_low,price_eur_trend'

  const commonHeaders = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  }

  try {
    let exactRows = []
    let ilikeRows = []

    if (q) {
      // 1. Exact name match (case-insensitive via ilike with no wildcards)
      const exactFilters = [...filters, `name=ilike.${encodeURIComponent(q)}`]
      const exactUrl =
        `${SUPABASE_URL}/rest/v1/card_catalog` +
        `?select=${baseFields}` +
        `&${exactFilters.join('&')}` +
        `&limit=${limit}` +
        `&order=name.asc`

      const exactRes = await fetch(exactUrl, { headers: commonHeaders })
      if (exactRes.ok) exactRows = await exactRes.json()

      // 2. Broader ilike with leading+trailing wildcard
      const ilikeFilters = [...filters, `name=ilike.${encodeURIComponent(`*${q}*`)}`]
      const ilikeUrl =
        `${SUPABASE_URL}/rest/v1/card_catalog` +
        `?select=${baseFields}` +
        `&${ilikeFilters.join('&')}` +
        `&limit=${limit}` +
        `&order=name.asc`

      const ilikeRes = await fetch(ilikeUrl, { headers: commonHeaders })
      if (ilikeRes.ok) ilikeRows = await ilikeRes.json()
    } else {
      // number-only search (no q) — just run the filters
      const filterUrl =
        `${SUPABASE_URL}/rest/v1/card_catalog` +
        `?select=${baseFields}` +
        `&${filters.join('&')}` +
        `&limit=${limit}` +
        `&order=name.asc`

      const filterRes = await fetch(filterUrl, { headers: commonHeaders })
      if (filterRes.ok) ilikeRows = await filterRes.json()
    }

    // Merge: exact matches first, then ilike-only, deduplicated by id
    const seen = new Set()
    const cards = []

    for (const row of [...exactRows, ...ilikeRows]) {
      if (!seen.has(row.id)) {
        seen.add(row.id)
        cards.push(row)
        if (cards.length >= limit) break
      }
    }

    return new Response(JSON.stringify({ cards, total: cards.length }), {
      status: 200,
      headers: CORS_HEADERS,
    })
  } catch (err) {
    console.error('search-cards error:', err)
    return new Response(JSON.stringify({ error: 'Search failed' }), {
      status: 502,
      headers: CORS_HEADERS,
    })
  }
}
