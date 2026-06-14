/**
 * Løser DBS 2nd Edition + promo-sæt med broken TCGPlayer URLs.
 *
 * Strategi 1: 2nd Edition → borrow image fra 1st edition (samme kortnummer).
 * Strategi 2: Pre-release/promo → borrow fra det tilsvarende main-sæt.
 *
 * Kør: node scripts/fix-dragonball-images-v2.js
 */
import 'dotenv/config'
import { dbSelect, dbUpdate, dbCount } from '../server/middleware/db.js'

// Sæt-par: broken sæt → donor sæt (samme kortnumre, samme artwork)
const SET_PAIRS = [
  ['Rise of the Unison Warrior (2nd Edition)', 'Rise of the Unison Warrior'],
  ['Vermilion Bloodline (2nd Edition)',         'Vermilion Bloodline'],
  ['Vicious Rejuvenation Pre-Release Cards',   'Vicious Rejuvenation'],
  ['Vermilion Bloodline Pre-Release Cards',    'Vermilion Bloodline'],
  ['Universal Onslaught Pre-Release Cards',    'Universal Onslaught'],
  ['Prismatic Clash Release Event',            'Prismatic Clash'],
  ['Fearsome Rivals Release Event',            'Fearsome Rivals'],
  ['Three Glorious Fighters Release Event',    'Three Glorious Fighters'],
  ['Cross Spirits Pre-Release Cards',          'Cross Spirits'],
  ['Realm of the Gods Pre-Release Cards',      'Realm of the Gods'],
  ['Legend of the Dragon Balls Pre-Release Cards', 'Legend of the Dragon Balls'],
]

async function buildDonorMap(donorSetName) {
  const all = []
  for (let offset = 0; ; offset += 500) {
    const batch = await dbSelect('card_catalog',
      `game=eq.dragonball&set_name=eq.${encodeURIComponent(donorSetName)}&image_url=not.is.null&select=number,image_url&limit=500&offset=${offset}`)
    all.push(...batch)
    if (batch.length < 500) break
  }
  return new Map(all.map(r => [r.number?.trim(), r.image_url]))
}

async function fixPair(brokenSet, donorSet) {
  const donorMap = await buildDonorMap(donorSet)
  if (!donorMap.size) {
    console.log(`  ⚠️  Ingen donor-kort fundet for: ${donorSet}`)
    return 0
  }

  // Hent alle kort i broken-sættet der mangler phash (har vi ikke kunnet hashe dem)
  const broken = []
  for (let offset = 0; ; offset += 500) {
    const batch = await dbSelect('card_catalog',
      `game=eq.dragonball&set_name=eq.${encodeURIComponent(brokenSet)}&phash_art=is.null&select=id,number,image_url&limit=500&offset=${offset}`)
    broken.push(...batch)
    if (batch.length < 500) break
  }

  let fixed = 0
  for (const card of broken) {
    const num = card.number?.trim()
    const donorUrl = donorMap.get(num)
    if (!donorUrl) continue
    if (donorUrl === card.image_url) continue
    await dbUpdate('card_catalog', { id: card.id }, { image_url: donorUrl })
    fixed++
  }
  return fixed
}

async function run() {
  console.log('\n🐉 DBS image fix v2 — 2nd editions + pre-release sæt\n')

  let totalFixed = 0
  for (const [brokenSet, donorSet] of SET_PAIRS) {
    const missingPhash = await dbCount('card_catalog',
      `game=eq.dragonball&set_name=eq.${encodeURIComponent(brokenSet)}&phash_art=is.null`)
    if (!missingPhash) {
      process.stdout.write(`  ✅ ${brokenSet.slice(0,45).padEnd(45)} alle har phash allerede\n`)
      continue
    }
    const fixed = await fixPair(brokenSet, donorSet)
    totalFixed += fixed
    process.stdout.write(
      `  ${fixed > 0 ? '✅' : '⚠️ '} ${brokenSet.slice(0,45).padEnd(45)} ${fixed}/${missingPhash} image URLs opdateret → fra: ${donorSet}\n`
    )
  }

  const totalMissing = await dbCount('card_catalog', 'game=eq.dragonball&phash_art=is.null')
  console.log(`\nTotal image URLs opdateret: ${totalFixed}`)
  console.log(`DBS kort stadig uden phash_art: ${totalMissing}`)
  console.log('\n➡  Kør nu: node scripts/backfill-artwork-phash.js dragonball')
}

run().catch(e => { console.error(e); process.exit(1) })
