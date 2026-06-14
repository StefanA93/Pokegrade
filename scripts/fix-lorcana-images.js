/**
 * Opdaterer image_url for Lorcana kort der mangler phash_art.
 * Bruger lorcana-api.com (Ravensburger CDN) som alternativ til TCGPlayer CDN (404).
 * Matcher på set_name + kortnummer.
 *
 * Kør: node scripts/fix-lorcana-images.js
 * Derefter: node scripts/backfill-artwork-phash.js lorcana
 */
import 'dotenv/config'
import { dbSelect, dbUpdate } from '../server/middleware/db.js'

const LORCANA_API = 'https://api.lorcana-api.com/cards/all'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchAllLorcanaApiCards() {
  const all = []
  let page = 1
  while (true) {
    const r = await fetch(`${LORCANA_API}?page=${page}&pageSize=500`)
    if (!r.ok) throw new Error(`lorcana-api.com HTTP ${r.status}`)
    const batch = await r.json()
    if (!Array.isArray(batch) || !batch.length) break
    all.push(...batch)
    if (batch.length < 500) break
    page++
    await sleep(300)
  }
  return all
}

function normalizeSetName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

async function run() {
  console.log('\n🃏 Lorcana image fix via lorcana-api.com (Ravensburger CDN)\n')

  process.stdout.write('  Henter kort fra lorcana-api.com...')
  const apiCards = await fetchAllLorcanaApiCards()
  console.log(` ${apiCards.length} kort hentet`)

  // Byg lookup: normalizedSetName:cardNum → imageUrl
  const lookup = new Map()
  for (const c of apiCards) {
    if (!c.Image || !c.Set_Name || c.Card_Num == null) continue
    const key = `${normalizeSetName(c.Set_Name)}:${c.Card_Num}`
    lookup.set(key, c.Image)
  }
  console.log(`  ${lookup.size} opslag bygget\n`)

  // Hent alle Lorcana singles uden phash_art
  process.stdout.write('  Indlæser lorcana katalog ')
  const missing = []
  let offset = 0
  while (true) {
    const rows = await dbSelect(
      'card_catalog',
      `game=eq.lorcana&phash_art=is.null&number=not.like.product-*&select=id,number,set_name,image_url&limit=500&offset=${offset}`
    )
    if (!rows.length) break
    missing.push(...rows)
    offset += rows.length
    process.stdout.write('.')
    if (rows.length < 500) break
  }
  console.log(` ${missing.length} kort mangler phash_art\n`)

  let updated = 0, notFound = 0, sameUrl = 0

  for (const card of missing) {
    // Udtræk kortnummer: "126/204" → 126
    const numPart = parseInt(card.number?.split('/')[0], 10)
    if (!numPart || isNaN(numPart)) { notFound++; continue }

    const key = `${normalizeSetName(card.set_name)}:${numPart}`
    const newUrl = lookup.get(key)

    if (!newUrl) { notFound++; continue }
    if (newUrl === card.image_url) { sameUrl++; continue }

    try {
      await dbUpdate('card_catalog', { id: card.id }, { image_url: newUrl })
      updated++
      if (updated % 100 === 0) process.stdout.write(`\r  ↑${updated} opdateret | ❓${notFound} ikke-matchet`)
      await sleep(20)
    } catch (err) {
      process.stderr.write(`\n  FEJL (${card.id}): ${err.message.slice(0, 60)}\n`)
    }
  }

  console.log(`\n\n══════════════════════════════════════`)
  console.log(`✅ Opdateret:       ${updated}`)
  console.log(`⏩ Allerede ens:    ${sameUrl}`)
  console.log(`❓ Ikke matchet:    ${notFound}`)
  console.log(`\nKør nu: node scripts/backfill-artwork-phash.js lorcana`)
}

run().catch(e => { console.error(e); process.exit(1) })
