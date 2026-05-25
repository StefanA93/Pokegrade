import { Worker } from 'bullmq'
import { getRedis } from '../packages/cache/index.js'
import { getProvider } from '../packages/providers/index.js'
import { indexCards } from '../packages/search/index.js'
import { dbInsert, dbUpsert, dbSelect } from '../server/middleware/db.js'
import { enqueueSyncSet, enqueueImageDownload } from './queues.js'

export function createSyncWorker() {
  return new Worker('sync', async job => {
    if (job.name === 'sync-game') {
      await handleSyncGame(job)
    } else if (job.name === 'sync-set') {
      await handleSyncSet(job)
    } else if (job.name === 'reindex-game') {
      await handleReindexGame(job)
    }
  }, {
    connection: getRedis(),
    concurrency: 3,
    limiter: { max: 50, duration: 60000 },
  })
}

async function handleSyncGame(job) {
  const { gameId } = job.data
  job.log(`Syncing all sets for ${gameId}`)

  const provider = getProvider(gameId)
  const sets = await provider.fetchAllSets()
  job.log(`Found ${sets.length} sets`)

  let dbSetRows = []
  try {
    dbSetRows = await dbUpsert('sets',
      sets.map(s => ({
        game_id:      gameId,
        name:         s.name,
        code:         s.code,
        release_date: s.releaseDate || null,
        card_count:   s.cardCount   || null,
        image_url:    s.imageUrl    || null,
        provider_ids: { [s.provider]: s.externalId },
      })),
      'game_id,code'
    )
  } catch (err) {
    job.log(`Set upsert error: ${err.message}`)
  }

  for (let i = 0; i < sets.length; i++) {
    const s    = sets[i]
    const dbId = dbSetRows[i]?.id
    await job.updateProgress(Math.floor((i / sets.length) * 50))
    await enqueueSyncSet(gameId, s.externalId, dbId)
    await sleep(200)
  }
}

async function handleSyncSet(job) {
  const { gameId, externalSetId, setDbId } = job.data
  job.log(`Syncing cards for ${gameId}/${externalSetId}`)

  const provider = getProvider(gameId)
  let cards
  try {
    cards = await provider.fetchCardsForSet(externalSetId)
  } catch (err) {
    job.log(`Fetch failed: ${err.message}`)
    throw err
  }

  job.log(`Fetched ${cards.length} cards`)

  const catalogRows = cards.map(c => ({
    id:          buildCatalogId(gameId, externalSetId, c.number),
    game:        gameId,
    name:        c.name,
    number:      c.number || null,
    set_id:      externalSetId,
    set_name:    c.setName || null,
    set_db_id:   setDbId || null,
    rarity:      c.rarity || null,
    finish_types: c.finishTypes || ['Normal'],
    image_url:   c.imageUrl || null,
    updated_at:  new Date().toISOString(),
  }))

  const inserted = await dbUpsert('card_catalog', catalogRows, 'id').catch(err => {
    job.log(`Catalog upsert error: ${err.message}`)
    return []
  })

  const providerIdRows = []
  for (const c of cards) {
    const catalogId = buildCatalogId(gameId, externalSetId, c.number)
    for (const [prov, extId] of Object.entries(c.providerIds || {})) {
      if (extId) providerIdRows.push({ catalog_id: catalogId, provider: prov, external_id: String(extId) })
    }
  }
  if (providerIdRows.length) {
    await dbUpsert('card_provider_ids', providerIdRows, 'catalog_id,provider').catch(() => null)
  }

  await indexCards(catalogRows)

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]
    const catalogId = buildCatalogId(gameId, externalSetId, c.number)
    if (c.imageUrl) {
      await enqueueImageDownload(catalogId, c.imageUrl, gameId, externalSetId, c.number, c.name)
    }
    await job.updateProgress(Math.floor((i / cards.length) * 100))
    await sleep(50)
  }
}

async function handleReindexGame(job) {
  const { gameId } = job.data
  const cards = await dbSelect(
    'card_catalog',
    `game=eq.${gameId}&select=id,game,name,number,set_id,set_name,rarity,finish_types,thumb_key,phash,price_eur,price_avg7`
  )
  await indexCards(cards)
  job.log(`Reindexed ${cards.length} cards for ${gameId}`)
}

function buildCatalogId(gameId, setId, number) {
  const safeNum = String(number || 'x').replace(/[^a-zA-Z0-9]/g, '')
  return `${gameId}-${setId}-${safeNum}`.toLowerCase()
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
