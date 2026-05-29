import 'dotenv/config'
import { PokemonProvider } from '../packages/providers/pokemon.js'
import { dbSelect, dbUpsert } from '../server/middleware/db.js'

const provider = new PokemonProvider({ apiKey: process.env.PTCG_API_KEY })

function buildCatalogId(setId, number) {
  const safeNum = String(number || 'x').replace(/[^a-zA-Z0-9]/g, '')
  return `pokemon-${setId}-${safeNum}`.toLowerCase()
}

async function run() {
  const sets = await dbSelect('sets', `game_id=eq.pokemon&select=code&order=release_date.desc`)
  console.log(`Found ${sets.length} Pokémon sets to backfill prices for`)

  let totalPrices = 0
  let done = 0

  for (const set of sets) {
    try {
      const cards = await provider.fetchCardsForSet(set.code)
      const priceRows = []

      for (const c of cards) {
        if (!c.prices) continue
        const catalogId = buildCatalogId(set.code, c.number)
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

      done++
      process.stdout.write(`\r${done}/${sets.length} sets — ${totalPrices} prices saved`)
      await sleep(300)
    } catch (err) {
      console.error(`\nFailed ${set.code}: ${err.message}`)
    }
  }

  console.log(`\nDone! ${totalPrices} price rows saved across ${done} sets.`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

run().catch(err => { console.error(err); process.exit(1) })
