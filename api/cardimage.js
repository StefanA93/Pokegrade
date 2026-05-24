export const config = { maxDuration: 60 }

export default async function handler(req) {
  const { searchParams } = new URL(req.url)
  const game = searchParams.get('game') || ''
  const name = searchParams.get('name') || ''

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  }

  if (!name) return new Response(JSON.stringify({ url: null }), { headers })

  function timedFetch(url, timeoutMs = 6000) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer))
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
  } catch {
    // timeout or network error — return null
  }

  return new Response(JSON.stringify({ url: imageUrl, name }), { headers })
}
