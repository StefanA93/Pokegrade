/**
 * Backfill/refresh card_prices for Pokemon Japan via TCGCSV (TCGPlayer JP kategori 85).
 * Gratis, ingen API-nøgle, 448 JP sæt fra 1996-Base til nu.
 * Opdateres dagligt ~20:00 UTC af TCGCSV — kør dette script efter kl. 21:00 UTC.
 *
 * Erstatter tcgapi.dev som JP-priskilde. Dækker både vintage og moderne sæt.
 * Matcher på: DB set_name → TCGCSV groupName + kortnavn normalisering.
 * Kør: node scripts/backfill-pokemonjp-prices.js
 */
import 'dotenv/config'
import { dbSelect, dbUpsert } from '../server/middleware/db.js'

const TCGCSV_BASE = 'https://tcgcsv.com/tcgplayer/85'
const DELAY       = 250  // ms mellem kald — TCGCSV har ingen officiel rate limit

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[éèêë]/g, 'e').replace(/[àâä]/g, 'a').replace(/[ùûü]/g, 'u')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// DB set_name (normaliseret) → søgeterm i TCGCSV group name
const SET_HINTS = {
  'base expansion pack':            'expansion pack',
  'mystery of the fossils':         'mystery of the fossils',
  'rocket gang':                    'rocket gang',
  'gym heroes':                     'gym heroes',
  'gym challenge':                  'gym challenge',
  'gold  silver  to a new world':   'gold silver',
  'crossing the ruins':             'crossing the ruins',
  'neo genesis':                    'neo genesis',
  'neo discovery':                  'neo discovery',
  'neo revelation':                 'neo revelation',
  'neo destiny':                    'neo destiny',
  'pokemon web':                    'web',
  'pokmon web':                     'web',
  'expedition':                     'expedition',
  'aquapolis':                      'aquapolis',
  'skyridge':                       'skyridge',
  'pokemon vs':                     'vs',
  'vending machine':                'vending',
  'southern islands':               'southern islands',
  'challenge from the darkness':    'challenge from the darkness',
  'offense and defense':            'offense and defense',
  'unnumbered promotional':         'promotional',
  'player placement trainer':       'promotional',
  'players club':                   'players club',
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'GradeDex/1.0 (gradedex.app)', Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`)
  return r.json()
}

async function fetchGroups() {
  const d = await fetchJson(`${TCGCSV_BASE}/groups`)
  return d.results || d
}

async function fetchGroupData(groupId) {
  const [products, prices] = await Promise.all([
    fetchJson(`${TCGCSV_BASE}/${groupId}/products`),
    fetchJson(`${TCGCSV_BASE}/${groupId}/prices`),
  ])
  return {
    products: products.results || products,
    prices:   prices.results   || prices,
  }
}

function findGroup(dbSetName, groups) {
  const n = normName(dbSetName)

  // 1. SET_HINTS eksakt søgning
  for (const [hint, target] of Object.entries(SET_HINTS)) {
    if (n.includes(hint) || hint.includes(n)) {
      const m = groups.find(g => normName(g.name).includes(target))
      if (m) return m
    }
  }

  // 2. Direkte substring (begge veje)
  const direct = groups.find(g => {
    const gn = normName(g.name)
    return gn.includes(n) || n.includes(gn)
  })
  if (direct) return direct

  // 3. Første signifikante ord
  const word = n.split(' ').find(w => w.length > 3)
  if (word) return groups.find(g => normName(g.name).includes(word)) || null

  return null
}

async function run() {
  console.log('\n💰 Pokemon Japan pris-refresh via TCGCSV (TCGPlayer JP kategori 85)\n')

  // Hent hele JP-kataloget grupperet på set_name
  process.stdout.write('  Indlæser katalog ')
  const bySet = new Map()
  let offset = 0
  while (true) {
    const rows = await dbSelect(
      'card_catalog',
      `game=eq.pokemonjp&select=id,name,number,set_name&limit=1000&offset=${offset}`
    )
    if (!rows.length) break
    for (const c of rows) {
      if (!bySet.has(c.set_name)) bySet.set(c.set_name, [])
      bySet.get(c.set_name).push(c)
    }
    offset += rows.length
    process.stdout.write('.')
    if (rows.length < 1000) break
  }
  const totalCards = [...bySet.values()].reduce((s, a) => s + a.length, 0)
  console.log(` ${totalCards} kort i ${bySet.size} sæt\n`)

  // Hent alle TCGCSV grupper
  process.stdout.write('  Henter TCGCSV grupper... ')
  const groups = await fetchGroups()
  console.log(`${groups.length} grupper\n`)

  let totalUpserted = 0
  let totalNoMatch  = 0
  let totalNoPrice  = 0
  let setsMatched   = 0

  const sortedSets = [...bySet.entries()].sort((a, b) => b[1].length - a[1].length)

  for (let i = 0; i < sortedSets.length; i++) {
    const [setName, cards] = sortedSets[i]
    const pct = (((i + 1) / sortedSets.length) * 100).toFixed(0)

    const group = findGroup(setName, groups)
    if (!group) {
      process.stdout.write(`  ⚠  [${pct}%] Ingen match: ${setName.slice(0, 50)}\n`)
      totalNoMatch += cards.length
      continue
    }

    process.stdout.write(`  [${pct}%] ${setName.slice(0, 38).padEnd(38)} → ${group.name.slice(0, 28)}`)
    setsMatched++

    let groupData
    try {
      groupData = await fetchGroupData(group.groupId)
      await sleep(DELAY)
    } catch (err) {
      process.stdout.write(` ❌ ${err.message.slice(0, 50)}\n`)
      continue
    }

    // Byg produktnavn → productId map
    const productByName = new Map()
    for (const p of groupData.products) {
      const key = normName(p.name)
      if (!productByName.has(key)) productByName.set(key, p.productId)
    }

    // Byg productId → {normal, foil} prismap
    const priceMap = new Map()
    for (const p of groupData.prices) {
      if (!priceMap.has(p.productId)) priceMap.set(p.productId, {})
      const entry = priceMap.get(p.productId)
      const isFoil = /holofoil|foil/i.test(p.subTypeName || '')
      entry[isFoil ? 'foil' : 'normal'] = p
    }

    const rows = []
    let setSaved = 0

    for (const card of cards) {
      const productId = productByName.get(normName(card.name))
      if (!productId) { totalNoPrice++; continue }

      const prices = priceMap.get(productId)
      if (!prices) { totalNoPrice++; continue }

      for (const [finish, p] of [['Normal', prices.normal], ['Holofoil', prices.foil]]) {
        if (!p) continue
        const sell = parseFloat(p.marketPrice) || null
        const low  = parseFloat(p.lowPrice)    || null
        const mid  = parseFloat(p.midPrice)    || null
        if (!sell && !low) continue

        rows.push({
          catalog_id:  card.id,
          finish,
          source:      'tcgplayer',
          price_sell:  sell,
          price_low:   low,
          price_avg7:  mid,
          price_avg30: null,
        })
        setSaved++
      }
    }

    if (rows.length) {
      await dbUpsert('card_prices', rows, 'catalog_id,finish')
      totalUpserted += setSaved
      process.stdout.write(` ✓ ${setSaved}\n`)
    } else {
      process.stdout.write(` ⚠ 0 match\n`)
    }

    await sleep(DELAY)
  }

  console.log('\n══════════════════════════════════════════')
  console.log('✅ Upserted:        ', totalUpserted)
  console.log('⚠  Ingen sæt-match:', totalNoMatch)
  console.log('⏩ Ingen produkt:   ', totalNoPrice)
  console.log(`Match rate:          ${((totalUpserted / totalCards) * 100).toFixed(1)}%`)
  console.log(`Sæt matchet:         ${setsMatched}/${sortedSets.length}`)
}

run().catch(e => { console.error(e); process.exit(1) })
