export const config = { runtime: 'edge' }

export default async function handler(req) {
  const { searchParams } = new URL(req.url)
  const game = searchParams.get('game')
  const name = searchParams.get('name')

  if (!name) return new Response(JSON.stringify({ url: null }), { headers: { 'Content-Type': 'application/json' } })

  let imageUrl = null

  try {
    if (game === 'pokemon') {
      const exact = await fetch(`https://api.pokemontcg.io/v2/cards?q=name:"${encodeURIComponent(name)}"&pageSize=1&select=images,name`)
      const exactData = await exact.json()
      imageUrl = exactData.data?.[0]?.images?.large || exactData.data?.[0]?.images?.small

      if (!imageUrl) {
        const fuzzy = await fetch(`https://api.pokemontcg.io/v2/cards?q=name:${encodeURIComponent(name)}*&pageSize=1&select=images,name`)
        const fuzzyData = await fuzzy.json()
        imageUrl = fuzzyData.data?.[0]?.images?.large || fuzzyData.data?.[0]?.images?.small
      }
    }

    if (game === 'mtg') {
      const res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`)
      const data = await res.json()
      if (data.object !== 'error') {
        imageUrl = data.image_uris?.large || data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.normal
      }
    }

    if (game === 'yugioh') {
      const res = await fetch(`https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(name)}`)
      const data = await res.json()
      imageUrl = data.data?.[0]?.card_images?.[0]?.image_url || null
    }
  } catch (e) {
    console.error('cardimage error:', e.message)
  }

  return new Response(JSON.stringify({ url: imageUrl, name }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  })
}
