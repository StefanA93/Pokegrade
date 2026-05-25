import { TCGProvider } from './base.js'

const BASE = 'https://api.scryfall.com'

export class MTGProvider extends TCGProvider {
  async fetchAllSets() {
    const r = await this.timedFetch(`${BASE}/sets`)
    const { data } = await r.json()
    return data
      .filter(s => ['expansion', 'core', 'masters', 'draft_innovation', 'commander'].includes(s.set_type))
      .map(s => ({
        name:        s.name,
        code:        s.code,
        releaseDate: s.released_at || null,
        cardCount:   s.card_count || null,
        imageUrl:    s.icon_svg_uri || null,
        externalId:  s.code,
        provider:    'scryfall'
      }))
  }

  async fetchCardsForSet(setCode) {
    const cards = []
    let url = `${BASE}/cards/search?q=e:${setCode}&unique=prints&order=collector_number`
    while (url) {
      const r = await this.timedFetch(url)
      const d = await r.json()
      if (d.object === 'error') break
      cards.push(...(d.data || []).map(c => this.normalizeCard(c)))
      url = d.has_more ? d.next_page : null
      if (url) await new Promise(res => setTimeout(res, 100))
    }
    return cards
  }

  async fetchCard(nameOrId) {
    const r = await this.timedFetch(`${BASE}/cards/named?fuzzy=${encodeURIComponent(nameOrId)}`)
    const d = await r.json()
    return d.object === 'error' ? null : this.normalizeCard(d)
  }

  normalizeCard(d) {
    const isFoil   = d.finishes?.includes('foil') ?? false
    const isNormal = d.finishes?.includes('nonfoil') ?? true
    const finishTypes = []
    if (isNormal) finishTypes.push('Normal')
    if (isFoil)   finishTypes.push('Foil')

    const eurPrice     = parseFloat(d.prices?.eur)      || null
    const eurFoilPrice = parseFloat(d.prices?.eur_foil) || null
    const cmUrl = d.purchase_uris?.cardmarket || null

    const prices = {}
    if (eurPrice)     prices['Normal'] = { sell: eurPrice,     cmUrl }
    if (eurFoilPrice) prices['Foil']   = { sell: eurFoilPrice, cmUrl }

    const imageUri = d.image_uris?.large
      || d.image_uris?.normal
      || d.card_faces?.[0]?.image_uris?.large
      || d.card_faces?.[0]?.image_uris?.normal
      || null

    return {
      name:        d.name,
      number:      d.collector_number,
      rarity:      d.rarity || null,
      setCode:     d.set || null,
      setName:     d.set_name || null,
      finishTypes: finishTypes.length ? finishTypes : ['Normal'],
      imageUrl:    imageUri,
      providerIds: { scryfall: d.id },
      prices,
      metadata: {
        manaCost:      d.mana_cost || null,
        colorIdentity: d.color_identity || [],
        typeLine:      d.type_line || null,
        oracleText:    d.oracle_text || null
      }
    }
  }
}
