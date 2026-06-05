import { TCGProvider } from './base.js'

const BASE = 'https://api.tcgapi.dev/v1'

export class DragonBallProvider extends TCGProvider {
  get headers() {
    return this.config.apiKey
      ? { 'X-API-Key': this.config.apiKey }
      : {}
  }

  async fetchAllSets() {
    if (!this.config.apiKey) return []
    const all  = []
    let   page = 1
    while (true) {
      const r = await this.timedFetch(
        `${BASE}/sets?game=dragon-ball-super-ccg&limit=50&page=${page}`,
        { headers: this.headers }
      )
      if (!r.ok) break
      const d     = await r.json()
      const batch = Array.isArray(d) ? d : (d.data || d.sets || [])
      if (!batch.length) break
      all.push(...batch)
      if (!d.meta?.has_more && batch.length < 50) break
      page++
    }
    return all.map(s => ({
      name:        s.name        || s.set_name    || null,
      code:        String(s.id   || s.code        || ''),
      releaseDate: s.release_date || s.releaseDate || null,
      cardCount:   s.card_count  || s.cardCount   || null,
      imageUrl:    s.image_url   || s.imageUrl    || null,
      externalId:  s.id          || s.code,
      provider:    'tcgapi',
    }))
  }

  async fetchCardsForSet(externalSetId) {
    if (!this.config.apiKey) return []
    const all  = []
    let   page = 1
    while (true) {
      const r = await this.timedFetch(
        `${BASE}/sets/${encodeURIComponent(externalSetId)}/cards?limit=50&page=${page}`,
        { headers: this.headers }
      )
      if (!r.ok) break
      const d     = await r.json()
      const batch = Array.isArray(d) ? d : (d.data || d.results || d.cards || [])
      if (!batch.length) break
      const items = batch.filter(c => c.id)
      all.push(...items.map(c => this.normalizeCard(c)))
      if (!d.meta?.has_more && batch.length < 50) break
      page++
    }
    return all
  }

  async fetchCard(name) {
    if (!this.config.apiKey) return null
    const r = await this.timedFetch(
      `${BASE}/search?q=${encodeURIComponent(name)}&game=dragon-ball-super-ccg&limit=1`,
      { headers: this.headers }
    )
    if (!r.ok) return null
    const d     = await r.json()
    const cards = Array.isArray(d) ? d : (d.data || d.results || [])
    return cards[0] ? this.normalizeCard(cards[0]) : null
  }

  normalizeCard(c) {
    const priceUsd  = parseFloat(c.market_price || c.price || c.price_usd || c.low_price) || null
    const priceEur  = priceUsd ? parseFloat((priceUsd * 0.92).toFixed(2)) : null
    const isProduct = c.product_type === 'Sealed Products' || !c.number
    const number    = c.number || c.card_number || `product-${c.id}`

    return {
      name:        c.name,
      number,
      rarity:      isProduct ? null : (c.rarity || null),
      setCode:     String(c.set_id || c.setId || c.group_id || ''),
      setName:     c.set_name    || c.setName    || null,
      finishTypes: ['Normal'],
      imageUrl:    c.image_url   || c.imageUrl   || c.image  || null,
      providerIds: { tcgapi: String(c.id || '') },
      prices:      priceEur ? { Normal: { sell: priceEur, cmUrl: null } } : null,
      metadata:    { isProduct, color: c.color || null, power: c.power ?? null, energy: c.energy ?? null },
    }
  }
}
