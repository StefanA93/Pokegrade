export const config = { runtime: 'edge' }

const CARDMARKET_API_KEY = process.env.CARDMARKET_API_KEY
const TCGAPI_KEY = process.env.TCGAPI_KEY

export default async function handler(req) {
  const { searchParams } = new URL(req.url)
  const game = searchParams.get('game') || ''
  const name = searchParams.get('name') || ''

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  }

  if (!name) return new Response(JSON.stringify({ url: null }), { headers })

  function timedFetch(url, opts = {}, timeoutMs = 6000) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer))
  }

  let imageUrl = null

  try {
    if (game === 'pokemon') {
      const r1 = await timedFetch(`https://api.pokemontcg.io/v2/cards?q=name:"${encodeURIComponent(name)}"&pageSize=1&select=images`)
      const d1 = await r1.json()
      imageUrl = d1.data?.[0]?.images?.large || d1.data?.[0]?.images?.small
      if (!imageUrl) {
        const r2 = await timedFetch(`https://api.pokemontcg.io/v2/cards?q=name:${encodeURIComponent(name)}*&pageSize=1&select=images`)
        const d2 = await r2.json()
        imageUrl = d2.data?.[0]?.images?.large || d2.data?.[0]?.images?.small
      }
    }

    if (game === 'mtg') {
      const r = await timedFetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`)
      const d = await r.json()
      if (d.object !== 'error') imageUrl = d.image_uris?.large || d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal
    }

    if (game === 'yugioh') {
      const r = await timedFetch(`https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(name)}`)
      const d = await r.json()
      imageUrl = d.data?.[0]?.card_images?.[0]?.image_url || null
    }

    // One Piece: cardmarket-api.com (when key available)
    if (game === 'onepiece' && CARDMARKET_API_KEY) {
      const r = await timedFetch(
        `https://cardmarket-api1.p.rapidapi.com/cards?game=one-piece&name=${encodeURIComponent(name)}`,
        { headers: { 'x-rapidapi-key': CARDMARKET_API_KEY, 'x-rapidapi-host': 'cardmarket-api1.p.rapidapi.com' } }
      )
      const d = await r.json()
      const card = Array.isArray(d) ? d[0] : (d.data?.[0] || d.cards?.[0] || null)
      imageUrl = card?.image || card?.imageUrl || card?.image_url || null
    }

    // Lorcana: cardmarket-api.com (when key available)
    if (game === 'lorcana' && CARDMARKET_API_KEY) {
      const r = await timedFetch(
        `https://cardmarket-api1.p.rapidapi.com/cards?game=lorcana&name=${encodeURIComponent(name)}`,
        { headers: { 'x-rapidapi-key': CARDMARKET_API_KEY, 'x-rapidapi-host': 'cardmarket-api1.p.rapidapi.com' } }
      )
      const d = await r.json()
      const card = Array.isArray(d) ? d[0] : (d.data?.[0] || d.cards?.[0] || null)
      imageUrl = card?.image || card?.imageUrl || card?.image_url || null
    }

    // Dragon Ball: TCGAPI.dev (when key available)
    if (game === 'dragonball' && TCGAPI_KEY) {
      const r = await timedFetch(
        `https://api.tcgapi.dev/v1/search?q=${encodeURIComponent(name)}&game=dragon-ball`,
        { headers: { 'X-API-Key': TCGAPI_KEY } }
      )
      const d = await r.json()
      const card = Array.isArray(d) ? d[0] : (d.data?.[0] || d.results?.[0] || null)
      imageUrl = card?.image_url || card?.imageUrl || null
    }
  } catch {
    // timeout or network error — return null
  }

  return new Response(JSON.stringify({ url: imageUrl, name }), { headers })
}
