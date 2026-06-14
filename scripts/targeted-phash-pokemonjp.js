/**
 * Målrettet phash backfill — kun pokemon-card.com URLs.
 * Springer TCGPlayer-URLer over (de er 404).
 * Kør: node scripts/targeted-phash-pokemonjp.js
 */
import 'dotenv/config'
import { computeArtworkPhash } from '../packages/scanner/phash.js'
import { dbSelect, dbUpdate } from '../server/middleware/db.js'

const CONCUR = 5
const DL_TIMEOUT = 15000

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function downloadImage(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), DL_TIMEOUT)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }})
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  } finally { clearTimeout(t) }
}

async function run() {
  console.log('\n🎌 Targeted phash backfill — kun pokemon-card.com URLs\n')
  let saved = 0, errors = 0, offset = 0

  while (true) {
    const rows = await dbSelect('card_catalog',
      `game=eq.pokemonjp&phash_art=is.null&image_url=like.https://www.pokemon-card.com/*&select=id,image_url&limit=200&offset=${offset}`)
    if (!rows.length) break

    const queue = [...rows]
    const results = []
    while (queue.length) {
      const batch = queue.splice(0, CONCUR)
      const res = await Promise.all(batch.map(async row => {
        try {
          const buf = await downloadImage(row.image_url)
          const phash = await computeArtworkPhash(buf, 'pokemonjp')
          return { id: row.id, phash }
        } catch { return null }
      }))
      results.push(...res)
    }

    for (const r of results) {
      if (!r) { errors++; continue }
      try { await dbUpdate('card_catalog', { id: r.id }, { phash_art: r.phash }); saved++ }
      catch { errors++ }
    }
    if (results.filter(Boolean).length === 0) {
      // Ingen succeser → alle billeder i batch fejlede, slut
      break
    }
    // offset=0 altid: succesfulde kort falder ud af queryen automatisk
    process.stdout.write(`\r  ${saved} gemt | ${errors} fejl`)
    await sleep(150)
  }
  console.log(`\n\n✅ Færdig: ${saved} phash gemt, ${errors} fejl`)
}

run().catch(err => { console.error(err); process.exit(1) })
