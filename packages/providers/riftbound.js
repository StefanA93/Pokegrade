import { TCGProvider } from './base.js'

const HOST = 'cardmarket-api-tcg.p.rapidapi.com'
const BASE = `https://${HOST}`

export class RiftboundProvider extends TCGProvider {
  get headers() {
    return {
      'x-rapidapi-key':  this.config.apiKey,
      'x-rapidapi-host': HOST,
    }
  }

  async fetchAllSets() {
    if (!this.config.apiKey) return []
    const all  = []
    let   page = 1
    while (true) {
      const r = await this.timedFetch(`${BASE}/riftbound/episodes?page=${page}&per_page=50`, { headers: this.headers })
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching Riftbound episodes`)
      const d     = await r.json()
      const batch = d.data || []
      all.push(...batch)
      if (!batch.length || page >= (d.paging?.total ?? 1)) break
      page++
    }
    return all.map(s => ({
      name:       s.name       || String(s.id),
      code:       s.code       || String(s.id),
      externalId: s.id,
      releaseDate: s.released_at || null,
      cardCount:  s.cards_printed_total || null,
      imageUrl:   s.logo       || null,
      provider:   'cardmarket',
    }))
  }

  async fetchCardsForSet(externalSetId) {
    if (!this.config.apiKey) return []
    const all  = []
    let   page = 1
    while (true) {
      const r = await this.timedFetch(
        `${BASE}/riftbound/episodes/${externalSetId}/cards?page=${page}&per_page=50`,
        { headers: this.headers }
      )
      if (!r.ok) break
      const d     = await r.json()
      const batch = d.data || []
      if (!batch.length) break
      all.push(...batch.map(c => this.normalizeCard(c)))
      if (page >= (d.paging?.total ?? 1)) break
      page++
    }
    return all
  }

  normalizeCard(c) {
    const cm = c.prices?.cardmarket || {}
    const priceEur = parseFloat(cm.lowest_near_mint) || null

    return {
      name:        c.name,
      number:      c.card_code_number || String(c.card_number || c.id),
      rarity:      c.rarity || null,
      setCode:     String(c.episode?.id || ''),
      setName:     c.episode?.name || null,
      finishTypes: ['Normal'],
      imageUrl:    c.image || null,
      providerIds: { tcgapi: String(c.id) },
      prices:      priceEur ? { Normal: { sell: priceEur, cmUrl: c.links?.cardmarket || null } } : null,
      metadata: {
        artist:       c.artist?.name || null,
        cardmarketId: c.cardmarket_id || null,
        color:        c.color || null,
      },
    }
  }
}
