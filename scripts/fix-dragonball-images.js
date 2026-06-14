/**
 * Fikser brudte TCGPlayer image-URLs for Dragon Ball Super kort
 * ved at låne image_url fra et andet kort med SAMME kortnummer der virker.
 *
 * Logik: 2nd edition / pre-release / release event kort har identisk kunst
 * som 1st edition — vi kopierer blot image_url fra den fungerende sibling.
 *
 * Kør: node scripts/fix-dragonball-images.js
 * Derefter: node scripts/backfill-artwork-phash.js dragonball
 */
import 'dotenv/config'
import { dbSelect, dbUpdate } from '../server/middleware/db.js'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function run() {
  console.log('\n🐉 Dragon Ball Super image fix (sibling lookup)\n')

  // Hent alle DBS kort der mangler phash_art men har image_url
  console.log('  Henter brudte DBS kort...')
  const broken = []
  for (let offset = 0; ; offset += 1000) {
    const batch = await dbSelect('card_catalog',
      `game=eq.dragonball&phash_art=is.null&image_url=not.is.null&select=id,number,set_name,image_url&limit=1000&offset=${offset}`)
    broken.push(...batch)
    if (batch.length < 1000) break
  }
  console.log(`  ${broken.length} kort mangler phash_art\n`)

  // Byg lookup: number → working image_url (fra kort med phash_art)
  console.log('  Henter fungerende kort med phash_art...')
  const working = {}
  for (let offset = 0; ; offset += 1000) {
    const batch = await dbSelect('card_catalog',
      `game=eq.dragonball&phash_art=not.is.null&select=number,image_url&limit=1000&offset=${offset}`)
    for (const c of batch) {
      if (c.number && c.image_url && !working[c.number]) {
        working[c.number] = c.image_url
      }
    }
    if (batch.length < 1000) break
  }
  console.log(`  ${Object.keys(working).length} unikke kortnumre med fungerende billeder\n`)

  // Match og opdater
  let updated = 0
  let alreadySame = 0
  let noMatch = 0
  const batchSize = 100
  const toUpdate = []

  for (const card of broken) {
    const siblingUrl = working[card.number]
    if (!siblingUrl) {
      noMatch++
      continue
    }
    if (siblingUrl === card.image_url) {
      alreadySame++
      continue
    }
    toUpdate.push({ id: card.id, image_url: siblingUrl })
  }

  console.log(`  Kan fikse: ${toUpdate.length} | Ingen sibling: ${noMatch} | Allerede ens: ${alreadySame}\n`)

  for (let i = 0; i < toUpdate.length; i += batchSize) {
    const batch = toUpdate.slice(i, i + batchSize)
    await Promise.all(batch.map(c =>
      dbUpdate('card_catalog', { id: c.id }, { image_url: c.image_url })
    ))
    updated += batch.length
    process.stdout.write(`\r  ↑${updated} opdateret`)
    await sleep(50)
  }

  console.log('\n')
  console.log('══════════════════════════════════════')
  console.log(`✅ Opdateret:      ${updated}`)
  console.log(`❓ Ingen sibling:  ${noMatch}`)
  console.log(`⏩ Allerede ens:   ${alreadySame}`)
  console.log('\nKør nu: node scripts/backfill-artwork-phash.js dragonball')
}

run().catch(err => { console.error(err); process.exit(1) })
