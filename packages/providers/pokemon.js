import { TCGProvider } from './base.js'

const BASE = 'https://api.pokemontcg.io/v2'

export class PokemonProvider extends TCGProvider {
  get headers() {
    return this.config.apiKey
      ? { 'X-Api-Key': this.config.apiKey }
      : {}
  }

  async fetchAllSets() {
    const PAGE = 100
    const all  = []
    let page   = 1

    while (true) {
      const r = await this.timedFetch(
        `${BASE}/sets?pageSize=${PAGE}&page=${page}&orderBy=-releaseDate`,
        { headers: this.headers }
      )
      if (r.status === 429) throw new Error(`Rate limited (429) fetching sets page ${page}`)
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching sets page ${page}`)
      const text = await r.text()
      if (!text) throw new Error(`Empty response fetching sets page ${page}`)
      const { data, totalCount } = JSON.parse(text)
      all.push(...(data || []))
      if (all.length >= totalCount || !(data?.length)) break
      page++
    }

    return all.map(s => ({
      name:        s.name,
      code:        s.id,
      releaseDate: s.releaseDate || null,
      cardCount:   s.total || null,
      imageUrl:    s.images?.logo || null,
      externalId:  s.id,
      provider:    'ptcg'
    }))
  }

  async fetchCardsForSet(externalSetId) {
    const PAGE = 250
    const all  = []
    let page   = 1

    while (true) {
      const r = await this.timedFetch(
        `${BASE}/cards?q=set.id:${externalSetId}&pageSize=${PAGE}&page=${page}&orderBy=number`,
        { headers: this.headers }
      )
      if (r.status === 429) throw new Error(`Rate limited (429) for set ${externalSetId} page ${page}`)
      if (!r.ok) throw new Error(`HTTP ${r.status} for set ${externalSetId}`)
      const text = await r.text()
      if (!text) throw new Error(`Empty response for set ${externalSetId} page ${page}`)
      const { data, totalCount } = JSON.parse(text)
      all.push(...(data || []))
      if (all.length >= totalCount || !(data?.length)) break
      page++
    }

    return all.map(c => this.normalizeCard(c))
  }

  async fetchCard(externalId) {
    const r = await this.timedFetch(`${BASE}/cards/${externalId}`, { headers: this.headers })
    const { data } = await r.json()
    return data ? this.normalizeCard(data) : null
  }

  normalizeCard(c) {
    const p = c.cardmarket?.prices
    const hasRH = c.subtypes?.includes('Reverse Holo') ||
                  (p && (p.reverseHoloTrend || p.reverseHoloAvg7)) || false

    const prices = {}
    if (p) {
      prices['Normal'] = {
        avg7:  p.avg7      || p.trendPrice        || null,
        avg30: p.avg30     || null,
        low:   p.lowPrice  || null,
        sell:  p.averageSellPrice || null,
        trend: p.trendPrice || null,
        cmUrl: c.cardmarket?.url || null,
        updatedAt: c.cardmarket?.updatedAt || null
      }
      if (hasRH) {
        prices['Reverse Holo'] = {
          avg7:  p.reverseHoloAvg7  || null,
          avg30: p.reverseHoloAvg30 || null,
          low:   p.reverseHoloLow   || null,
          sell:  p.reverseHoloSell  || null,
          trend: p.reverseHoloTrend || null,
          cmUrl: c.cardmarket?.url  || null,
          updatedAt: c.cardmarket?.updatedAt || null
        }
      }
    }

    return {
      name:        c.name,
      number:      c.number,
      rarity:      c.rarity || null,
      setCode:     c.set?.id || null,
      setName:     c.set?.name || null,
      finishTypes: hasRH ? ['Normal', 'Reverse Holo'] : ['Normal'],
      imageUrl:    c.images?.large || c.images?.small || null,
      providerIds: { ptcg: c.id },
      prices,
      metadata: {
        hp:        c.hp || null,
        types:     c.types || [],
        supertype: c.supertype || null,
        subtypes:  c.subtypes || []
      }
    }
  }
}
