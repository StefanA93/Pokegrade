import 'dotenv/config'
import { PokemonProvider } from '../packages/providers/pokemon.js'
import { dbSelect, dbUpsert } from '../server/middleware/db.js'

const provider = new PokemonProvider({ apiKey: process.env.PTCG_API_KEY })

async function run() {
  // Brug sets-tabellen — har alle 173 registrerede PTCG-sæt med release_date
  const setRows = await dbSelect('sets', `game_id=eq.pokemon&select=code&order=release_date.desc&limit=300`)
  const setCodes = setRows.map(r => r.code).filter(Boolean)
  console.log(`Found ${setCodes.length} Pokémon sæt fra sets-tabel`)

  let totalPrices = 0
  let done = 0
  let skipped = 0

  for (const setCode of setCodes) {
    try {
      const cards = await provider.fetchCardsForSet(setCode)
      if (!cards.length) { skipped++; done++; continue }

      const priceRows = []

      for (const c of cards) {
        if (!c.prices) continue
        // Byg catalog_id i samme format som import-game.js (pokemon-setCode-safeNum)
        const safeNum   = String(c.number || 'x').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
        const catalogId = `pokemon-${setCode}-${safeNum}`
        if (!safeNum || safeNum === 'x') continue
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
      process.stdout.write(`\r${done}/${setCodes.length} sæt | ${totalPrices} priser | ${skipped} tomme`)
      await sleep(300)
    } catch (err) {
      console.error(`\nFejl ${setCode}: ${err.message}`)
      done++
    }
  }

  console.log(`\n✅ Færdig! ${totalPrices} prisrækker gemt på tværs af ${done} sæt (${skipped} tomme/ukendte).`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

run().catch(err => { console.error(err); process.exit(1) })
