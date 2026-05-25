import { MeiliSearch } from 'meilisearch'

const INDEX_NAME = 'cards'

let _client = null

export function getMeili() {
  if (!_client) {
    _client = new MeiliSearch({
      host:   process.env.MEILISEARCH_URL  || 'http://localhost:7700',
      apiKey: process.env.MEILISEARCH_KEY  || '',
    })
  }
  return _client
}

export async function configureIndex() {
  const index = getMeili().index(INDEX_NAME)
  await index.updateSettings({
    searchableAttributes: ['name', 'number', 'setName', 'rarity', 'types'],
    filterableAttributes: ['gameId', 'setId', 'rarity', 'finishTypes', 'hasPrice'],
    sortableAttributes:   ['name'],
    typoTolerance: {
      enabled: true,
      minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 }
    },
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
  })
  return index
}

export function cardToDocument(card) {
  return {
    id:          card.id,
    name:        card.name,
    number:      card.number    || '',
    gameId:      card.game_id   || card.game,
    setId:       card.set_id    || card.setId || '',
    setName:     card.set_name  || card.setName || '',
    rarity:      card.rarity    || '',
    finishTypes: card.finish_types || card.finishTypes || ['Normal'],
    types:       card.metadata?.types || [],
    thumbKey:    card.thumb_key  || '',
    phash:       card.phash      || null,
    hasPrice:    !!(card.price_eur || card.price_avg7),
  }
}

export async function indexCards(cards) {
  const docs = cards.map(cardToDocument)
  const index = getMeili().index(INDEX_NAME)
  await index.addDocuments(docs, { primaryKey: 'id' })
}

export async function deleteFromIndex(ids) {
  await getMeili().index(INDEX_NAME).deleteDocuments(ids)
}

export async function searchCards(query, { gameId, limit = 10, offset = 0 } = {}) {
  const filter = gameId ? [`gameId = ${gameId}`] : []
  const result = await getMeili().index(INDEX_NAME).search(query, {
    limit,
    offset,
    filter,
    attributesToRetrieve: ['id', 'name', 'number', 'gameId', 'setName', 'rarity', 'finishTypes', 'thumbKey', 'phash', 'hasPrice'],
  })
  return result.hits.map(h => ({ ...h, _searchScore: (result.estimatedTotalHits > 0) ? 0.9 : 0.5 }))
}

export async function indexStatus() {
  const stats = await getMeili().index(INDEX_NAME).getStats()
  return { numberOfDocuments: stats.numberOfDocuments, isIndexing: stats.isIndexing }
}
