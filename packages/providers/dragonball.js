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
    const r = await this.timedFetch(`${BASE}/sets?game=dragon-ball`, { headers: this.headers })
    const d = await r.json()
    const sets = Array.isArray(d) ? d : (d.data || d.sets || [])
    return sets.map(s => ({
      name:        s.name || s.set_name,
      code:        s.id   || s.code,
      releaseDate: s.releaseDate || s.release_date || null,
      cardCount:   s.cardCount   || s.card_count   || null,
      imageUrl:    s.image       || s.imageUrl      || null,
      externalId:  s.id          || s.code,
      provider:    'tcgapi'
    }))
  }

  async fetchCardsForSet(externalSetId) {
    if (!this.config.apiKey) return []
    const r = await this.timedFetch(
      `${BASE}/cards?game=dragon-ball&set=${encodeURIComponent(externalSetId)}`,
      { headers: this.headers }
    )
    const d = await r.json()
    const cards = Array.isArray(d) ? d : (d.data || d.results || [])
    return cards.map(c => this.normalizeCard(c))
  }

  async fetchCard(name) {
    if (!this.config.apiKey) return null
    const r = await this.timedFetch(
      `${BASE}/search?q=${encodeURIComponent(name)}&game=dragon-ball`,
      { headers: this.headers }
    )
    const d = await r.json()
    const cards = Array.isArray(d) ? d : (d.data || d.results || [])
    return cards[0] ? this.normalizeCard(cards[0]) : null
  }

  normalizeCard(c) {
    const price = parseFloat(c.price || c.price_usd || c.market_price) || null
    return {
      name:        c.name,
      number:      c.number || c.card_number || null,
      rarity:      c.rarity || null,
      setCode:     c.set_id || c.setId || null,
      setName:     c.set_name || c.setName || null,
      finishTypes: ['Normal'],
      imageUrl:    c.image_url || c.imageUrl || c.image || null,
      providerIds: { tcgapi: String(c.id || '') },
      prices:      price ? { Normal: { sell: price, cmUrl: null } } : null,
      metadata:    { color: c.color || null, power: c.power ?? null, energy: c.energy ?? null }
    }
  }
}
