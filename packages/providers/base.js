export class TCGProvider {
  constructor(config = {}) {
    this.config = config
  }

  async fetchAllSets() { throw new Error(`${this.constructor.name}.fetchAllSets not implemented`) }
  async fetchCardsForSet(externalSetId) { throw new Error(`${this.constructor.name}.fetchCardsForSet not implemented`) }
  async fetchCard(externalId) { throw new Error(`${this.constructor.name}.fetchCard not implemented`) }
  async fetchPrices(externalId) { return null }

  timedFetch(url, opts = {}, ms = 30000) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), ms)
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t))
  }

  normalizeCard(raw) {
    return {
      name:        '',
      number:      null,
      rarity:      null,
      finishTypes: ['Normal'],
      imageUrl:    null,
      providerIds: {},
      prices:      null,
      metadata:    {}
    }
  }
}
