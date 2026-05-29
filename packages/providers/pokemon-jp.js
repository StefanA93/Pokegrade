import { TCGProvider } from './base.js'

const BASE = 'https://api.tcgapi.dev/v1'

export class PokemonJPProvider extends TCGProvider {
  get headers() {
    return this.config.apiKey ? { 'X-API-Key': this.config.apiKey } : {}
  }

  async fetchAllSets() {
    if (!this.config.apiKey) return []
    const sets = []
    let page = 1
    while (true) {
      const r = await this.timedFetch(`${BASE}/sets?game=pokemon-japan&limit=50&page=${page}`, { headers: this.headers })
      const d = await r.json()
      const batch = Array.isArray(d) ? d : (d.data || [])
      if (!batch.length) break
      sets.push(...batch)
      const meta = d.meta || {}
      if (!meta.has_more) break
      if (Array.isArray(d) && d.length < 50) break
      page++
    }
    return sets.map(s => ({
      name:        s.name,
      code:        String(s.id),
      releaseDate: s.release_date || null,
      cardCount:   s.card_count   || null,
      imageUrl:    s.image_url    || null,
      externalId:  s.id,
      provider:    'tcgapi-jp'
    }))
  }

  async fetchCardsForSet(setId) {
    if (!this.config.apiKey) return []
    const all  = []
    let   page = 1
    while (true) {
      const r = await this.timedFetch(`${BASE}/sets/${setId}/cards?limit=50&page=${page}`, { headers: this.headers })
      if (!r.ok) break
      const d     = await r.json()
      const batch = d.data || []
      const cards = batch.filter(c => c.product_type === 'Cards' || !c.product_type)
      all.push(...cards.map(c => this.normalizeCard(c)))
      if (!d.meta?.has_more) break
      page++
    }
    return all
  }

  async fetchCard(name) {
    if (!this.config.apiKey) return null
    const r = await this.timedFetch(`${BASE}/search?q=${encodeURIComponent(name)}&game=pokemon-japan&limit=1`, { headers: this.headers })
    const d = await r.json()
    const c = (d.data || [])[0]
    return c ? this.normalizeCard(c) : null
  }

  normalizeCard(c) {
    const priceUsd = parseFloat(c.market_price || c.low_price) || null
    const priceEur = priceUsd ? parseFloat((priceUsd / 1.08).toFixed(2)) : null
    return {
      name:        c.name,
      number:      c.number || null,
      rarity:      c.rarity || null,
      setCode:     String(c.set_id || c.group_id || ''),
      setName:     c.set_name || null,
      finishTypes: [c.printing || 'Normal'],
      imageUrl:    c.image_url || null,
      providerIds: { tcgapi: String(c.id || c.tcgplayer_id || '') },
      prices:      priceEur ? { Normal: { sell: priceEur, cmUrl: null } } : null,
      metadata:    {}
    }
  }
}
