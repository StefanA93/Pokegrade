import { Worker } from 'bullmq'
import { getBullRedis, cacheDel, CacheKeys } from '../packages/cache/index.js'
import { getProvider } from '../packages/providers/index.js'
import { dbSelect, dbUpsert } from '../server/middleware/db.js'

export function createPriceWorker() {
  return new Worker('prices', async job => {
    if (job.name === 'sync-prices') {
      await handleSyncPrices(job)
    }
  }, {
    connection: getBullRedis(),
    concurrency: 2,
    limiter: { max: 30, duration: 60000 },
  })
}

async function handleSyncPrices(job) {
  const { gameId } = job.data
  job.log(`Syncing prices for ${gameId}`)

  if (gameId === 'pokemon') {
    return handlePokemonPrices(job)
  }

  return handleGenericPrices(job)
}

async function handlePokemonPrices(job) {
  const sets = await dbSelect('sets', `game_id=eq.pokemon&select=code&order=release_date.desc`)
  job.log(`Fetching prices for ${sets.length} Pokémon sets`)

  const provider = getProvider('pokemon')
  let totalPrices = 0

  for (let i = 0; i < sets.length; i++) {
    const set = sets[i]
    await job.updateProgress(Math.floor((i / sets.length) * 100))

    try {
      const cards = await provider.fetchCardsForSet(set.code)
      const priceRows = []

      for (const c of cards) {
        if (!c.prices) continue
        const catalogId = buildCatalogId('pokemon', set.code, c.number)
        for (const [finish, p] of Object.entries(c.prices)) {
          if (!p) continue
          const priceValue = p.avg7 || p.sell || p.trend || null
          if (!priceValue) continue
          priceRows.push({
            catalog_id:  catalogId,
            finish,
            price_avg7:  p.avg7  || null,
            price_avg30: p.avg30 || null,
            price_low:   p.low   || null,
            price_sell:  p.sell  || null,
            price_trend: p.trend || null,
            cm_url:      p.cmUrl || null,
            fetched_at:  new Date().toISOString(),
          })
        }
      }

      if (priceRows.length) {
        await dbUpsert('card_prices', priceRows, 'catalog_id,finish')
        totalPrices += priceRows.length
      }

      await sleep(500)
    } catch (err) {
      job.log(`Price error for set ${set.code}: ${err.message}`)
    }
  }

  job.log(`Updated ${totalPrices} price rows across ${sets.length} Pokémon sets`)
}

async function handleGenericPrices(job) {
  const { gameId } = job.data
  const provider = getProvider(gameId)

  let offset = 0
  const PAGE = 500
  let updated = 0
  let total = 0

  while (true) {
    const cards = await dbSelect(
      'card_catalog',
      `game=eq.${gameId}&select=id,name,number,set_id,finish_types&limit=${PAGE}&offset=${offset}&order=id.asc`
    )

    if (!cards.length) break
    total += cards.length

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]
      await job.updateProgress(Math.floor(((offset + i) / Math.max(total, 1)) * 100))

      try {
        const priceData = await provider.fetchPrices?.(card.id)
        if (!priceData) continue

        const priceRows = []
        const today = new Date().toISOString().split('T')[0]

        for (const [finish, p] of Object.entries(priceData)) {
          if (!p) continue
          const priceValue = p.avg7 || p.sell || p.trend || null
          if (!priceValue) continue

          priceRows.push({
            catalog_id:  card.id,
            finish,
            price_avg7:  p.avg7  || null,
            price_avg30: p.avg30 || null,
            price_low:   p.low   || null,
            price_sell:  p.sell  || null,
            price_trend: p.trend || null,
            cm_url:      p.cmUrl || null,
            fetched_at:  new Date().toISOString(),
          })

          await snapshotPriceHistory(card.id, finish, priceValue, today)
        }

        if (priceRows.length) {
          await dbUpsert('card_prices', priceRows, 'catalog_id,finish')
          await cacheDel(CacheKeys.card(card.id))
          updated++
        }
      } catch (err) {
        job.log(`Price error for ${card.id}: ${err.message}`)
      }

      await sleep(100)
    }

    if (cards.length < PAGE) break
    offset += PAGE
  }

  job.log(`Updated prices for ${updated} cards (${total} processed)`)
}

async function snapshotPriceHistory(catalogId, finish, price, today) {
  const existing = await dbSelect(
    'price_history',
    `catalog_id=eq.${encodeURIComponent(catalogId)}&finish=eq.${encodeURIComponent(finish)}&order=recorded_at.desc&limit=1`
  )
  const lastPrice = existing[0]?.price

  const changed = !lastPrice || Math.abs((price - lastPrice) / lastPrice) > 0.01
  if (!changed) return

  await dbUpsert('price_history', [{
    catalog_id:  catalogId,
    finish,
    price,
    recorded_at: today,
  }], 'catalog_id,finish,recorded_at').catch(() => null)
}

function buildCatalogId(gameId, setId, number) {
  const safeNum = String(number || 'x').replace(/[^a-zA-Z0-9]/g, '')
  return `${gameId}-${setId}-${safeNum}`.toLowerCase()
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
