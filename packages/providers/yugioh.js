import { TCGProvider } from './base.js'

const BASE = 'https://db.ygoprodeck.com/api/v7'

export class YGOProvider extends TCGProvider {
  async fetchAllSets() {
    const r = await this.timedFetch(`${BASE}/cardsets.php`)
    const data = await r.json()
    return (Array.isArray(data) ? data : []).map(s => ({
      name:        s.set_name,
      code:        s.set_code,
      releaseDate: s.tcg_date || null,
      cardCount:   s.num_of_cards || null,
      imageUrl:    null,
      externalId:  s.set_code,
      provider:    'ygoprodeck'
    }))
  }

  async fetchCardsForSet(setCode) {
    const r = await this.timedFetch(`${BASE}/cardinfo.php?cardset=${encodeURIComponent(setCode)}&num=500&offset=0`)
    const d = await r.json()
    return (d.data || []).map(c => this.normalizeCard(c))
  }

  async fetchCard(name) {
    const r = await this.timedFetch(`${BASE}/cardinfo.php?fname=${encodeURIComponent(name)}`)
    const d = await r.json()
    const c = d.data?.[0]
    return c ? this.normalizeCard(c) : null
  }

  normalizeCard(c) {
    const cmPrice = parseFloat(c.card_prices?.[0]?.cardmarket_price) || null
    const imageUrl = c.card_images?.[0]?.image_url || null

    return {
      name:        c.name,
      number:      String(c.id),
      rarity:      c.card_sets?.[0]?.set_rarity || null,
      setCode:     c.card_sets?.[0]?.set_code || null,
      setName:     c.card_sets?.[0]?.set_name || null,
      finishTypes: ['Normal'],
      imageUrl,
      providerIds: { ygoprodeck: String(c.id) },
      prices: cmPrice ? {
        Normal: { sell: cmPrice, cmUrl: null }
      } : null,
      metadata: {
        type:      c.type || null,
        attribute: c.attribute || null,
        atk:       c.atk ?? null,
        def:       c.def ?? null,
        level:     c.level ?? null,
        desc:      c.desc || null
      }
    }
  }
}
