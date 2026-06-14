/**
 * Opdaterer image_url for One Piece kort der mangler phash_art.
 * Bruger den officielle Bandai OP Card Game site som alternativ til TCGPlayer CDN (404).
 * URL-mønster: https://en.onepiece-cardgame.com/images/cardlist/card/{number}.png
 *
 * Kør: node scripts/fix-onepiece-images.js
 * Derefter: node scripts/backfill-artwork-phash.js onepiece
 */
import 'dotenv/config'
import { dbSelect, dbUpdate } from '../server/middleware/db.js'

const BANDAI_BASE = 'https://en.onepiece-cardgame.com/images/cardlist/card'
const VERIFY_SAMPLE = 20

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function urlExists(url) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
    clearTimeout(t)
    return r.ok
  } catch {
    return false
  }
}

async function run() {
  console.log('\n🏴‍☠️ One Piece image fix via en.onepiece-cardgame.com\n')

  // Hent alle OP singles uden phash_art
  process.stdout.write('  Indlæser one piece katalog ')
  const missing = []
  let offset = 0
  while (true) {
    const rows = await dbSelect(
      'card_catalog',
      `game=eq.onepiece&phash_art=is.null&number=not.like.product-*&select=id,number,image_url&limit=500&offset=${offset}`
    )
    if (!rows.length) break
    missing.push(...rows)
    offset += rows.length
    process.stdout.write('.')
    if (rows.length < 500) break
  }
  console.log(` ${missing.length} kort mangler phash_art\n`)

  // Verificer et lille sample inden fuld kørsel
  console.log(`  Verificerer ${VERIFY_SAMPLE} tilfældige URL'er...`)
  const sample = missing.slice(0, VERIFY_SAMPLE)
  let okCount = 0
  for (const card of sample) {
    const url = `${BANDAI_BASE}/${card.number}.png`
    if (await urlExists(url)) okCount++
  }
  const pct = ((okCount / VERIFY_SAMPLE) * 100).toFixed(0)
  console.log(`  Sample: ${okCount}/${VERIFY_SAMPLE} (${pct}%) URL'er virker\n`)

  if (okCount < VERIFY_SAMPLE * 0.5) {
    console.error('❌ For mange fejl i sample — afbryder')
    process.exit(1)
  }

  let updated = 0, errors = 0

  for (const card of missing) {
    const newUrl = `${BANDAI_BASE}/${card.number}.png`
    if (newUrl === card.image_url) continue

    try {
      await dbUpdate('card_catalog', { id: card.id }, { image_url: newUrl })
      updated++
      if (updated % 100 === 0) process.stdout.write(`\r  ↑${updated} opdateret`)
      await sleep(15)
    } catch (err) {
      process.stderr.write(`\n  FEJL (${card.id}): ${err.message.slice(0, 60)}\n`)
      errors++
    }
  }

  console.log(`\n\n══════════════════════════════════════`)
  console.log(`✅ Opdateret:  ${updated}`)
  console.log(`❌ Fejl:       ${errors}`)
  console.log(`\nKør nu: node scripts/backfill-artwork-phash.js onepiece`)
}

run().catch(e => { console.error(e); process.exit(1) })
