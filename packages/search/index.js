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
    filterableAttributes: ['gameId', 'setId', 'rarity', 'finishTypes', 'hasPrice', 'number', 'numberInt'],
    sortableAttributes:   ['name'],
    typoTolerance: {
      enabled: true,
      minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 }
    },
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
  })
  return index
}

function parseNumberInt(numberStr) {
  if (!numberStr) return null
  const m = String(numberStr).match(/^(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

export function cardToDocument(card) {
  const number = card.number || ''
  return {
    id:          card.id,
    name:        card.name,
    number,
    numberInt:   parseNumberInt(number),
    gameId:      card.game_id   || card.game,
    setId:       card.set_id    || card.setId || '',
    setName:     card.set_name  || card.setName || '',
    rarity:      card.rarity    || '',
    finishTypes: card.finish_types || card.finishTypes || ['Normal'],
    types:       card.metadata?.types || [],
    thumbKey:    card.thumb_key  || '',
    phash:       card.phash      || null,
    phashArt:    card.phash_art  || null,
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

export async function searchCards(query, { gameId, limit = 10, offset = 0, numberInt = null } = {}) {
  const filter = []
  if (gameId) filter.push(`gameId = ${gameId}`)
  if (numberInt !== null && Number.isFinite(numberInt)) filter.push(`numberInt = ${numberInt}`)

  const result = await getMeili().index(INDEX_NAME).search(query || '', {
    limit,
    offset,
    filter,
    attributesToRetrieve: ['id', 'name', 'number', 'numberInt', 'gameId', 'setName', 'rarity', 'finishTypes', 'thumbKey', 'phash', 'phashArt', 'hasPrice'],
    showRankingScore: true,
  })
  return result.hits.map(h => ({ ...h, _searchScore: h._rankingScore ?? 0.5 }))
}

export async function searchByEmbedding(embedding, gameId, limit = 15, threshold = 0.60) {
  const SUPABASE_URL = process.env.SUPABASE_URL
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
  if (!SUPABASE_URL || !SUPABASE_KEY) return []

  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_cards`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_game:      gameId || 'pokemon',
      match_count:     limit,
      match_threshold: threshold,
    }),
  })
  if (!r.ok) return []
  return r.json()
}

export async function indexStatus() {
  const stats = await getMeili().index(INDEX_NAME).getStats()
  return { numberOfDocuments: stats.numberOfDocuments, isIndexing: stats.isIndexing }
}
