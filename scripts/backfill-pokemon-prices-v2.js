/**
 * Pokemon EN Cardmarket-priser via pokemontcg.io → card_prices.
 * Matcher pokemontcg.io kort til card_catalog via kortnavn (name-lookup).
 * Erstatter backfill-pokemon-prices.js som bruger forkert ID-format.
 */
import 'dotenv/config'
import { PokemonProvider } from '../packages/providers/pokemon.js'
import { dbSelect, dbUpsert } from '../server/middleware/db.js'

const provider = new PokemonProvider({ apiKey: process.env.PTCG_API_KEY })

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function buildNameMap() {
  const map    = new Map()
  let   offset = 0
  process.stdout.write('  Bygger navn-lookup fra DB ')
  while (true) {
    const rows = await dbSelect(
      'card_catalog',
      `game=eq.pokemon&select=id,name&limit=1000&offset=${offset}`
    )
    if (!rows.length) break
    for (const r of rows) {
      const key = r.name?.toLowerCase().trim()
      if (key && !map.has(key)) map.set(key, [])
      if (key) map.get(key).push(r.id)
    }
    offset += rows.length
    process.stdout.write('.')
    if (rows.length < 1000) break
  }
  console.log(` ${map.size} unikke navne\n`)
  return map
}

async function run() {
  console.log('\n💰 Pokemon EN — Cardmarket-priser via pokemontcg.io\n')

  const nameMap = await buildNameMap()

  const setRows = await dbSelect('sets', 'game_id=eq.pokemon&select=code,name&order=release_date.desc&limit=300')
  const sets    = setRows.filter(r => r.code)
  console.log(`  ${sets.length} sæt fra DB\n`)

  let totalPrices = 0
  let unmatched   = 0
  let skippedSets = 0

  for (let i = 0; i < sets.length; i++) {
    const { code, name } = sets[i]
    const pct = (((i + 1) / sets.length) * 100).toFixed(0)
    process.stdout.write(`\r  [${i + 1}/${sets.length}] (${pct}%) ${String(name || code).slice(0, 28).padEnd(30)} priser: ${totalPrices}`)

    let cards
    try {
      cards = await provider.fetchCardsForSet(code)
    } catch {
      skippedSets++
      await sleep(2000)
      continue
    }

    const priceRows = []
    for (const c of cards) {
      if (!c.prices) continue
      const cardName  = c.name?.toLowerCase().trim()
      const catalogIds = nameMap.get(cardName)
      if (!catalogIds?.length) { unmatched++; continue }

      for (const catalogId of catalogIds) {
        for (const [finish, p] of Object.entries(c.prices)) {
          if (!p) continue
          priceRows.push({
            catalog_id:  catalogId,
            finish,
            price_avg7:  p.avg7  || null,
            price_avg30: p.avg30 || null,
            price_low:   p.low   || null,
            price_sell:  p.sell  || null,
            price_trend: p.trend || null,
            cm_url:      p.cmUrl || null,
            source:      'cardmarket',
            fetched_at:  new Date().toISOString(),
          })
        }
      }
    }

    if (priceRows.length) {
      // Dedupliker på (catalog_id, finish) — behold første forekomst
      const seen    = new Set()
      const deduped = priceRows.filter(r => {
        const k = `${r.catalog_id}|${r.finish}`
        if (seen.has(k)) return false
        seen.add(k); return true
      })

      const CHUNK = 100
      for (let ci = 0; ci < deduped.length; ci += CHUNK) {
        try {
          await dbUpsert('card_prices', deduped.slice(ci, ci + CHUNK), 'catalog_id,finish')
          totalPrices += Math.min(CHUNK, deduped.length - ci)
        } catch (err) {
          if (!err.message.includes('23503')) {
            process.stdout.write(`\n  ❌ Upsert fejl (${name}): ${err.message.slice(0, 80)}\n`)
          }
        }
      }
    }

    await sleep(400)
  }

  console.log(`\n\n✅ Færdig!`)
  console.log(`   Prisrækker gemt:   ${totalPrices}`)
  console.log(`   Ikke-matchet:      ${unmatched}`)
  console.log(`   Sæt sprunget over: ${skippedSets}`)
}

run().catch(err => { console.error(err); process.exit(1) })
