import { TCGProvider } from './base.js'

const RAPIDAPI_HOST = 'cardmarket-api-tcg.p.rapidapi.com'
const BASE          = `https://${RAPIDAPI_HOST}`

export class OnePieceProvider extends TCGProvider {
  get headers() {
    return {
      'x-rapidapi-key':  this.config.apiKey,
      'x-rapidapi-host': RAPIDAPI_HOST,
    }
  }

  async fetchAllSets() {
    if (!this.config.apiKey) return []
    const r = await this.timedFetch(`${BASE}/one-piece/episodes`, { headers: this.headers })
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching One Piece sets`)
    const d    = await r.json()
    const sets = Array.isArray(d) ? d : (d.data || d.episodes || d.sets || [])
    return sets.map(s => ({
      name:        s.name       || s.set_name    || null,
      code:        String(s.id  || s.code        || s.set_code || ''),
      releaseDate: s.releaseDate || s.release_date || null,
      cardCount:   s.cardCount  || s.card_count   || s.total   || null,
      imageUrl:    s.image      || s.imageUrl     || s.logo    || null,
      externalId:  s.id         || s.code         || s.set_code,
      provider:    'cardmarket-api-tcg',
    }))
  }

  async fetchCardsForSet(externalSetId) {
    if (!this.config.apiKey) return []
    const r = await this.timedFetch(
      `${BASE}/one-piece/episodes/${encodeURIComponent(externalSetId)}/cards`,
      { headers: this.headers }
    )
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching One Piece set ${externalSetId}`)
    const d     = await r.json()
    const cards = Array.isArray(d) ? d : (d.data || d.cards || [])
    return cards.map(c => this.normalizeCard(c))
  }

  async fetchCard(name) {
    if (!this.config.apiKey) return null
    const r = await this.timedFetch(
      `${BASE}/one-piece/cards?search=${encodeURIComponent(name)}`,
      { headers: this.headers }
    )
    if (!r.ok) return null
    const d     = await r.json()
    const cards = Array.isArray(d) ? d : (d.data || d.cards || [])
    return cards[0] ? this.normalizeCard(cards[0]) : null
  }

  normalizeCard(c) {
    // Håndterer multiple mulige felt-navne fra API'et
    const priceEur = parseFloat(
      c.price_eur ?? c.priceEur ?? c.price ?? c.cardmarket_price ?? c.market_price
    ) || null
    const cmUrl = c.cardmarket_url || c.cm_url || c.url || null

    return {
      name:        c.name,
      number:      c.number || c.cardNumber || c.card_number || null,
      rarity:      c.rarity || null,
      setCode:     String(c.episode_id || c.set_id || c.setId || c.episodeId || ''),
      setName:     c.episode_name || c.set_name || c.setName || null,
      finishTypes: ['Normal'],
      imageUrl:    c.image || c.imageUrl || c.image_url || null,
      providerIds: { 'cardmarket-api-tcg': String(c.id || '') },
      prices:      priceEur ? { Normal: { sell: priceEur, cmUrl } } : null,
      metadata: {
        color:       c.color       || null,
        power:       c.power       ?? null,
        cost:        c.cost        ?? null,
        counter:     c.counter     ?? null,
        attribute:   c.attribute   || null,
      },
    }
  }
}
