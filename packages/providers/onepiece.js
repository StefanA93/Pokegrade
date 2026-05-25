import { TCGProvider } from './base.js'

const RAPIDAPI_HOST = 'cardmarket-api1.p.rapidapi.com'
const BASE = `https://${RAPIDAPI_HOST}`

export class OnePieceProvider extends TCGProvider {
  get headers() {
    return {
      'x-rapidapi-key':  this.config.apiKey,
      'x-rapidapi-host': RAPIDAPI_HOST
    }
  }

  async fetchAllSets() {
    if (!this.config.apiKey) return []
    const r = await this.timedFetch(`${BASE}/sets?game=one-piece`, { headers: this.headers })
    const d = await r.json()
    const sets = Array.isArray(d) ? d : (d.data || d.sets || [])
    return sets.map(s => ({
      name:        s.name || s.set_name,
      code:        s.id   || s.set_code || s.code,
      releaseDate: s.releaseDate || s.release_date || null,
      cardCount:   s.cardCount   || s.card_count   || null,
      imageUrl:    s.image       || s.imageUrl      || null,
      externalId:  s.id          || s.set_code      || s.code,
      provider:    'cardmarket-api'
    }))
  }

  async fetchCardsForSet(externalSetId) {
    if (!this.config.apiKey) return []
    const r = await this.timedFetch(
      `${BASE}/cards?game=one-piece&set=${encodeURIComponent(externalSetId)}`,
      { headers: this.headers }
    )
    const d = await r.json()
    const cards = Array.isArray(d) ? d : (d.data || d.cards || [])
    return cards.map(c => this.normalizeCard(c))
  }

  async fetchCard(name) {
    if (!this.config.apiKey) return null
    const r = await this.timedFetch(
      `${BASE}/cards?game=one-piece&name=${encodeURIComponent(name)}`,
      { headers: this.headers }
    )
    const d = await r.json()
    const cards = Array.isArray(d) ? d : (d.data || d.cards || [])
    return cards[0] ? this.normalizeCard(cards[0]) : null
  }

  normalizeCard(c) {
    const price = parseFloat(c.price || c.priceEur || c.price_eur) || null
    return {
      name:        c.name,
      number:      c.number || c.cardNumber || c.card_number || null,
      rarity:      c.rarity || null,
      setCode:     c.setId  || c.set_id    || null,
      setName:     c.setName || c.set_name  || null,
      finishTypes: ['Normal'],
      imageUrl:    c.image  || c.imageUrl  || c.image_url || null,
      providerIds: { 'cardmarket-api': String(c.id || c.cardId || c.card_id || '') },
      prices:      price ? { Normal: { sell: price, cmUrl: c.url || c.cardmarketUrl || null } } : null,
      metadata:    { color: c.color || null, cost: c.cost ?? null, power: c.power ?? null }
    }
  }
}
