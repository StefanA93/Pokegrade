import 'dotenv/config'
import { PokemonProvider } from '../packages/providers/pokemon.js'
import { processAndUpload } from '../packages/storage/index.js'
import { computePhash } from '../packages/scanner/index.js'
import { dbSelect, dbUpsert, dbUpdate } from '../server/middleware/db.js'
import { indexCards } from '../packages/search/index.js'

const provider = new PokemonProvider({ apiKey: process.env.PTCG_API_KEY })

const CONCURRENCY        = 2
const DELAY_BETWEEN_SETS = 1200
const RATE_LIMIT_WAIT    = 60000
const TIMEOUT_WAIT       = 12000
const MAX_RETRIES        = 10

function buildCatalogId(setId, number) {
  const safeNum = String(number || 'x').replace(/[^a-zA-Z0-9]/g, '')
  return `pokemon-${setId}-${safeNum}`.toLowerCase()
}

async function fetchCardsWithRetry(setCode) {
  let attempt      = 0
  let timeouts     = 0
  const MAX_TIMEOUTS = 3

  while (true) {
    attempt++
    try {
      const cards = await provider.fetchCardsForSet(setCode)
      return cards
    } catch (err) {
      const msg = err.message || ''
      if (msg.includes('HTTP 404')) return []

      const isRateLimit = msg.includes('429') || msg.includes('Empty response')
      const isTimeout   = msg.includes('aborted') || msg.includes('timeout')

      if (isTimeout) {
        timeouts++
        if (timeouts >= MAX_TIMEOUTS) {
          process.stdout.write(`\n  [${setCode}] Springer over — svarer ikke efter ${MAX_TIMEOUTS} forsøg`)
          return []
        }
        const wait = Math.min(TIMEOUT_WAIT * timeouts, 60000)
        process.stdout.write(`\n  [${setCode}] Timeout — venter ${wait / 1000}s (forsøg ${timeouts}/${MAX_TIMEOUTS})`)
        await sleep(wait)
      } else if (isRateLimit) {
        if (attempt >= MAX_RETRIES) throw err
        process.stdout.write(`\n  [${setCode}] Rate limited — venter ${RATE_LIMIT_WAIT / 1000}s (forsøg ${attempt})`)
        await sleep(RATE_LIMIT_WAIT)
      } else {
        if (attempt >= MAX_RETRIES) throw err
        process.stdout.write(`\n  [${setCode}] Fejl: ${msg} — venter 5s (forsøg ${attempt})`)
        await sleep(5000)
      }
    }
  }
}

async function processImage(card, imageUrl) {
  const res = await fetch(imageUrl)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const [{ fullKey, thumbKey }, phash] = await Promise.all([
    processAndUpload({ sourceBuffer: buf, game: 'pokemon', setCode: card.set_id || 'unknown', number: card.number, name: card.name }),
    computePhash(buf),
  ])
  return { fullKey, thumbKey, phash }
}

async function run() {
  const sets = await dbSelect('sets', `game_id=eq.pokemon&select=code,name&order=release_date.desc`)
  console.log(`\nPokémon backfill — ${sets.length} sæt fra DB\n`)

  let totalPrices  = 0
  let totalImages  = 0
  let totalSkipped = 0
  let setsDone     = 0
  let setsEmpty    = 0

  for (const set of sets) {
    const setCode = set.code
    try {
      const cards = await fetchCardsWithRetry(setCode)

      if (!cards.length) {
        setsEmpty++
        setsDone++
        continue
      }

      const ids = cards.map(c => buildCatalogId(setCode, c.number))
      const existing = await dbSelect(
        'card_catalog',
        `id=in.(${ids.map(id => `"${id}"`).join(',')})&select=id,image_key,thumb_key,phash`
      )
      const existingMap = Object.fromEntries(existing.map(r => [r.id, r]))

      // Upsert kortkataloget
      const catalogRows = cards.map(c => ({
        id:           buildCatalogId(setCode, c.number),
        game:         'pokemon',
        name:         c.name,
        number:       c.number || null,
        set_id:       setCode,
        set_name:     c.setName || set.name,
        rarity:       c.rarity || null,
        finish_types: c.finishTypes || ['Normal'],
        image_url:    c.imageUrl || null,
        updated_at:   new Date().toISOString(),
      }))
      const dedupedCatalog = [...new Map(catalogRows.map(r => [r.id, r])).values()]
      await dbUpsert('card_catalog', dedupedCatalog, 'id')

      // Provider ID mapping
      const providerRows = cards.flatMap(c => {
        const catalogId = buildCatalogId(setCode, c.number)
        return Object.entries(c.providerIds || {})
          .filter(([, extId]) => extId)
          .map(([prov, extId]) => ({ catalog_id: catalogId, provider: prov, external_id: String(extId) }))
      })
      if (providerRows.length) {
        const dedupedProviders = [...new Map(providerRows.map(r => [`${r.catalog_id}:${r.provider}`, r])).values()]
        await dbUpsert('card_provider_ids', dedupedProviders, 'catalog_id,provider')
      }

      // Priser
      const priceRows = []
      for (const c of cards) {
        if (!c.prices) continue
        const catalogId = buildCatalogId(setCode, c.number)
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
        const dedupedPrices = [...new Map(priceRows.map(r => [`${r.catalog_id}:${r.finish}`, r])).values()]
        await dbUpsert('card_prices', dedupedPrices, 'catalog_id,finish')
        totalPrices += dedupedPrices.length
      }

      // Billeder — kun kort uden image_key eller med fejl
      const imageJobs = []
      for (const c of cards) {
        if (!c.imageUrl) continue
        const catalogId = buildCatalogId(setCode, c.number)
        const db = existingMap[catalogId]
        if (db?.image_key && db.image_key !== 'error') {
          totalSkipped++
        } else {
          imageJobs.push({ catalogId, imageUrl: c.imageUrl, name: c.name, number: c.number })
        }
      }

      for (let i = 0; i < imageJobs.length; i += CONCURRENCY) {
        const batch = imageJobs.slice(i, i + CONCURRENCY)
        await Promise.all(batch.map(async job => {
          try {
            const { fullKey, thumbKey, phash } = await processImage(job, job.imageUrl)
            await dbUpdate('card_catalog', { id: job.catalogId }, { image_key: fullKey, thumb_key: thumbKey, phash })
            const row = catalogRows.find(r => r.id === job.catalogId)
            if (row) await indexCards([{ ...row, thumb_key: thumbKey, phash }]).catch(() => null)
            totalImages++
          } catch {
            await dbUpdate('card_catalog', { id: job.catalogId }, { image_key: 'error' }).catch(() => null)
          }
        }))
      }

      setsDone++
      process.stdout.write(
        `\r${setsDone}/${sets.length} sæt | ${totalPrices} priser | ${totalImages} billeder | ${totalSkipped} skipped | ${setsEmpty} tomme`
      )
    } catch (err) {
      console.error(`\nGav op på sæt ${setCode} efter ${MAX_RETRIES} forsøg: ${err.message}`)
      setsDone++
    }

    await sleep(DELAY_BETWEEN_SETS)
  }

  console.log(`\n\nFærdig!`)
  console.log(`  Sæt i DB:           ${sets.length}`)
  console.log(`  Priser gemt:        ${totalPrices}`)
  console.log(`  Billeder hentet:    ${totalImages}`)
  console.log(`  Billeder skipped:   ${totalSkipped}`)
  console.log(`  Tomme sæt:          ${setsEmpty}`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

run().catch(err => { console.error(err); process.exit(1) })
