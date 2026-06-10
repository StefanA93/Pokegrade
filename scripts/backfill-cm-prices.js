/**
 * Backfill card_prices via Cardmarket API TCG (RapidAPI).
 * Dækker: lorcana, onepiece, pokemon (EN)
 * Priser: Cardmarket EUR (lowest_near_mint, 7d/30d average)
 *
 * Kræver: CARDMARKET_API_KEY i .env
 * Brug:
 *   node scripts/backfill-cm-prices.js all
 *   node scripts/backfill-cm-prices.js lorcana
 *   node scripts/backfill-cm-prices.js onepiece
 *   node scripts/backfill-cm-prices.js pokemon
 */
import 'dotenv/config'
import { dbSelect, dbUpsert } from '../server/middleware/db.js'

const KEY  = process.env.CARDMARKET_API_KEY
const HOST = 'cardmarket-api-tcg.p.rapidapi.com'
const BASE = `https://${HOST}`
const HEADERS = { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST }

const GAMES = {
  lorcana:   { slug: 'lorcana',   dbGame: 'lorcana'   },
  onepiece:  { slug: 'one-piece', dbGame: 'onepiece'  },
  pokemon:   { slug: 'pokemon',   dbGame: 'pokemon'   },
  riftbound: { slug: 'riftbound', dbGame: 'riftbound' },
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function cmFetch(path) {
  await sleep(250)
  const r = await fetch(`${BASE}${path}`, { headers: HEADERS })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`)
  return r.json()
}

async function fetchAllEpisodes(slug) {
  const all = []
  let page = 1
  while (true) {
    const d = await cmFetch(`/${slug}/episodes?page=${page}&per_page=50`)
    const batch = d.data || []
    all.push(...batch)
    if (!batch.length || page >= (d.paging?.total ?? 1)) break
    page++
  }
  return all
}

async function fetchEpisodeCards(slug, episodeId) {
  const all = []
  let page = 1
  while (true) {
    const d = await cmFetch(`/${slug}/episodes/${episodeId}/cards?page=${page}&per_page=50`)
    const batch = d.data || []
    all.push(...batch)
    if (!batch.length || page >= (d.paging?.total ?? 1)) break
    page++
  }
  return all
}

function extractPrices(card) {
  const cm = card.prices?.cardmarket || {}
  return {
    price_sell:  parseFloat(cm.lowest_near_mint)                              || null,
    price_low:   parseFloat(cm.lowest_near_mint_EU_only ?? cm.lowest_near_mint) || null,
    price_avg7:  parseFloat(cm['7d_average'])                                  || null,
    price_avg30: parseFloat(cm['30d_average'])                                 || null,
  }
}

function hasPrice(p) {
  return !!(p.price_sell || p.price_avg7 || p.price_avg30)
}

function extractNumberInt(number) {
  const m = String(number || '').match(/(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

async function buildCatalogMaps(dbGame) {
  const byNumber    = new Map() // number → string[] (alle catalog IDs med dette nummer)
  const byName      = new Map() // name → first catalog_id
  const bySetAndInt = new Map() // "setName|numInt" → first catalog_id (Lorcana-stil)
  let offset = 0
  process.stdout.write('  Indlæser katalog ')
  while (true) {
    const rows = await dbSelect(
      'card_catalog',
      `game=eq.${dbGame}&select=id,name,number,set_name&limit=1000&offset=${offset}`
    )
    if (!rows.length) break
    for (const r of rows) {
      if (r.number) {
        const key = r.number.toUpperCase()
        const arr = byNumber.get(key) ?? []
        if (!arr.includes(r.id)) arr.push(r.id)
        byNumber.set(key, arr)
        const keyDash = key.replace(' ', '-')
        if (keyDash !== key) {
          const arr2 = byNumber.get(keyDash) ?? []
          if (!arr2.includes(r.id)) arr2.push(r.id)
          byNumber.set(keyDash, arr2)
        }
      }
      const nameKey = r.name?.toLowerCase().trim()
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, r.id)

      const numInt = extractNumberInt(r.number)
      const setKey = r.set_name?.toLowerCase().trim()
      if (setKey && numInt != null) {
        const snKey = `${setKey}|${numInt}`
        if (!bySetAndInt.has(snKey)) bySetAndInt.set(snKey, r.id)
      }
    }
    offset += rows.length
    process.stdout.write('.')
    if (rows.length < 1000) break
  }
  console.log(` ${byNumber.size} nøgler (${byName.size} navne, ${bySetAndInt.size} sæt+int)\n`)
  return { byNumber, byName, bySetAndInt }
}

// Returnerer array af catalog IDs der matcher dette CM-kort
function matchCard(card, { byNumber, byName, bySetAndInt }) {
  // 1. card_number direkte (f.eks. "EB04-011" fra CM → matcher "EB04-011" i katalog)
  const rawNum = (card.card_number != null ? String(card.card_number) : '').toUpperCase().trim()
  if (rawNum && byNumber.has(rawNum)) return byNumber.get(rawNum)

  // 2. card_code_number (f.eks. "OP09-001", "UNL-131/219")
  const rawCode = (card.card_code_number || '').toUpperCase().trim()
  if (rawCode) {
    if (byNumber.has(rawCode)) return byNumber.get(rawCode)
    const dashed = rawCode.replace(' ', '-')
    if (byNumber.has(dashed)) return byNumber.get(dashed)
  }

  // 3. Sætnavn + heltal (Lorcana-stil: "Wilds Unknown"|46)
  const epName = (card.episode?.name || '').toLowerCase().trim()
  const cardInt = typeof card.card_number === 'number'
    ? card.card_number
    : extractNumberInt(card.card_number ?? card.card_code_number)
  if (epName && cardInt != null) {
    const snKey = `${epName}|${cardInt}`
    if (bySetAndInt.has(snKey)) return [bySetAndInt.get(snKey)]
  }

  // 4. Navn fallback
  const nameKey = (card.name || '').toLowerCase().trim()
  const byNameId = byName.get(nameKey)
  return byNameId ? [byNameId] : []
}

async function backfillGame(gameKey) {
  const { slug, dbGame } = GAMES[gameKey]
  console.log(`\n${'═'.repeat(62)}`)
  console.log(`💰 ${gameKey.toUpperCase()} — Cardmarket EU priser`)
  console.log('═'.repeat(62))

  const catalog  = await buildCatalogMaps(dbGame)
  const episodes = await fetchAllEpisodes(slug)
  console.log(`  ${episodes.length} sæt fundet\n`)

  let upserted = 0, unmatched = 0, noPrice = 0, skipped = 0

  for (let i = 0; i < episodes.length; i++) {
    const ep  = episodes[i]
    const pct = (((i + 1) / episodes.length) * 100).toFixed(0)
    process.stdout.write(
      `\r  [${i+1}/${episodes.length}] (${pct}%) ${String(ep.name ?? ep.id).slice(0, 24).padEnd(26)} ↑${upserted}`
    )

    let cards
    try {
      cards = await fetchEpisodeCards(slug, ep.id)
    } catch {
      skipped++
      continue
    }

    const seen = new Map()
    for (const card of cards) {
      const prices = extractPrices(card)
      if (!hasPrice(prices)) { noPrice++; continue }

      const matched = matchCard(card, catalog)
      if (!matched.length) { unmatched++; continue }

      for (const catalogId of matched) {
        const key = `${catalogId}:Normal`
        if (!seen.has(key)) {
          seen.set(key, {
            catalog_id:  catalogId,
            finish:      'Normal',
            price_sell:  prices.price_sell,
            price_low:   prices.price_low,
            price_avg7:  prices.price_avg7,
            price_avg30: prices.price_avg30,
            source:      'cardmarket',
            fetched_at:  new Date().toISOString(),
          })
        }
      }
    }

    const rows = [...seen.values()]
    if (rows.length) {
      await dbUpsert('card_prices', rows, 'catalog_id,finish')
      upserted += rows.length
    }
  }

  const total    = upserted + unmatched + noPrice
  const matchPct = total ? ((upserted / total) * 100).toFixed(1) : '0.0'
  console.log(`\n`)
  console.log(`  ✅ Upserted:      ${upserted}`)
  console.log(`  ❌ Ikke-matchet:  ${unmatched}`)
  console.log(`  ⏩ Ingen pris:    ${noPrice}`)
  console.log(`  Match rate:       ${matchPct}%`)
  return { upserted, unmatched, noPrice, skipped }
}

async function run() {
  if (!KEY) {
    console.error('❌ CARDMARKET_API_KEY mangler i .env')
    process.exit(1)
  }

  const arg    = process.argv[2] || 'all'
  const toRun  = arg === 'all' ? Object.keys(GAMES) : [arg]

  for (const g of toRun) {
    if (!GAMES[g]) {
      console.error(`❌ Ukendt spil: ${g}. Brug: ${Object.keys(GAMES).join(' | ')} | all`)
      process.exit(1)
    }
  }

  console.log(`\n🌐 Cardmarket API Backfill — ${toRun.join(', ')}`)

  const totals = { upserted: 0, unmatched: 0 }
  for (const g of toRun) {
    const r = await backfillGame(g)
    totals.upserted  += r.upserted
    totals.unmatched += r.unmatched
  }

  if (toRun.length > 1) {
    console.log(`\n${'═'.repeat(62)}`)
    console.log(`🏁 TOTAL: ${totals.upserted} priser gemt, ${totals.unmatched} ikke-matchet`)
  }
}

run().catch(err => { console.error(err); process.exit(1) })
