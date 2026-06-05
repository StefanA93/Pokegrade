import { TCGProvider } from './base.js'

// Pokemon EN via tcgapi.dev — bruges til kortdata (31.495 kort)
// PokemonProvider (pokemontcg.io) beholdes til Cardmarket-priser i backfill-pokemon-prices.js
const BASE = 'https://api.tcgapi.dev/v1'

export class PokemonTCGAPIProvider extends TCGProvider {
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
        `${BASE}/sets?game=pokemon&limit=50&page=${page}`,
        { headers: this.headers }
      )
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching Pokemon sets page ${page}`)
      const d     = await r.json()
      const batch = Array.isArray(d) ? d : (d.data || [])
      if (!batch.length) break
      all.push(...batch)
      if (!d.meta?.has_more && batch.length < 50) break
      page++
    }
    return all.map(s => ({
      name:        s.name         || null,
      code:        String(s.id    || s.code || ''),
      releaseDate: s.release_date || s.releaseDate || null,
      cardCount:   s.card_count   || s.cardCount   || null,
      imageUrl:    s.image_url    || s.imageUrl    || null,
      externalId:  s.id           || s.code,
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
      const batch = Array.isArray(d) ? d : (d.data || d.cards || [])
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
      `${BASE}/search?q=${encodeURIComponent(name)}&game=pokemon&limit=1`,
      { headers: this.headers }
    )
    if (!r.ok) return null
    const d     = await r.json()
    const cards = Array.isArray(d) ? d : (d.data || [])
    return cards[0] ? this.normalizeCard(cards[0]) : null
  }

  normalizeCard(c) {
    const priceUsd  = parseFloat(c.market_price || c.price || c.low_price) || null
    const priceEur  = priceUsd ? parseFloat((priceUsd * 0.92).toFixed(2)) : null
    const hasRH     = !!(c.printing === 'Reverse Holo' || c.reverse_holo)
    const isProduct = c.product_type === 'Sealed Products' || !c.number
    const number    = c.number || c.card_number || `product-${c.id}`

    return {
      name:        c.name,
      number,
      rarity:      isProduct ? null : (c.rarity || null),
      setCode:     String(c.set_id || c.setId || c.group_id || ''),
      setName:     c.set_name    || c.setName || null,
      finishTypes: hasRH ? ['Normal', 'Reverse Holo'] : ['Normal'],
      imageUrl:    c.image_url   || c.imageUrl || c.image || null,
      providerIds: { tcgapi: String(c.id || c.tcgplayer_id || '') },
      prices:      priceEur ? { Normal: { sell: priceEur, cmUrl: null } } : null,
      metadata: {
        isProduct,
        hp:        c.hp       || null,
        types:     c.types    || [],
        supertype: c.supertype || null,
      },
    }
  }
}
