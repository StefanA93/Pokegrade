import 'dotenv/config'
import { MTGProvider } from '../packages/providers/mtg.js'
import { dbSelect, dbUpsert } from '../server/middleware/db.js'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function buildSetNumberMap(setCode) {
  const map = new Map()
  let offset = 0
  while (true) {
    const rows = await dbSelect(
      'card_catalog',
      `game=eq.mtg&set_id=eq.${setCode}&select=id,number&limit=500&offset=${offset}`
    )
    if (!rows.length) break
    for (const r of rows) {
      if (r.number) map.set(String(r.number).toLowerCase(), r.id)
    }
    offset += rows.length
    if (rows.length < 500) break
  }
  return map
}

async function run() {
  const provider = new MTGProvider()

  const setRows = await dbSelect('sets', 'game_id=eq.mtg&select=code,name&order=release_date.desc&limit=500')
  const sets    = setRows.filter(r => r.code)
  console.log(`\n💰 MTG — ${sets.length} sæt fundet\n`)

  let totalPrices = 0, skippedSets = 0, unmatched = 0

  for (let i = 0; i < sets.length; i++) {
    const { code, name } = sets[i]
    const pct = (((i + 1) / sets.length) * 100).toFixed(0)
    process.stdout.write(`\r  [${i + 1}/${sets.length}] (${pct}%) ${String(name || code).slice(0, 28).padEnd(30)} priser: ${totalPrices}`)

    let cards
    try {
      cards = await provider.fetchCardsForSet(code)
    } catch {
      skippedSets++
      await sleep(500)
      continue
    }

    const numMap = await buildSetNumberMap(code)

    const priceRows = []
    for (const c of cards) {
      if (!c.prices) continue
      const catalogId = numMap.get(String(c.number || '').toLowerCase())
      if (!catalogId) { unmatched++; continue }

      for (const [finish, p] of Object.entries(c.prices)) {
        if (!p?.sell) continue
        priceRows.push({
          catalog_id: catalogId,
          finish,
          price_sell: p.sell,
          cm_url:     p.cmUrl || null,
          source:     'cardmarket',
          fetched_at: new Date().toISOString(),
        })
      }
    }

    if (priceRows.length) {
      try {
        await dbUpsert('card_prices', priceRows, 'catalog_id,finish')
        totalPrices += priceRows.length
      } catch (err) {
        process.stdout.write(`\n  ❌ Upsert fejl (${name || code}): ${err.message.slice(0, 80)}\n`)
      }
    }

    await sleep(150)
  }

  console.log(`\n\n✅ Færdig!`)
  console.log(`   Prisrækker upserted: ${totalPrices}`)
  console.log(`   Sæt sprunget over:   ${skippedSets}`)
  console.log(`   Ikke-matchet:        ${unmatched}`)
}

run().catch(err => { console.error(err); process.exit(1) })
