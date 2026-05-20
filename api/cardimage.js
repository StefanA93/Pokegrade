export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const { game, name } = req.query
  if (!name) return res.json({ url: null })

  let imageUrl = null

  try {
    if (game === 'pokemon') {
      const r1 = await fetch(`https://api.pokemontcg.io/v2/cards?q=name:"${encodeURIComponent(name)}"&pageSize=1&select=images`)
      const d1 = await r1.json()
      imageUrl = d1.data?.[0]?.images?.large || d1.data?.[0]?.images?.small

      if (!imageUrl) {
        const r2 = await fetch(`https://api.pokemontcg.io/v2/cards?q=name:${encodeURIComponent(name)}*&pageSize=1&select=images`)
        const d2 = await r2.json()
        imageUrl = d2.data?.[0]?.images?.large || d2.data?.[0]?.images?.small
      }
    }

    if (game === 'mtg') {
      const r = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`)
      const d = await r.json()
      if (d.object !== 'error') imageUrl = d.image_uris?.large || d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal
    }

    if (game === 'yugioh') {
      const r = await fetch(`https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(name)}`)
      const d = await r.json()
      imageUrl = d.data?.[0]?.card_images?.[0]?.image_url || null
    }
  } catch (e) {
    console.error('cardimage error:', e.message)
  }

  res.json({ url: imageUrl, name })
}
