/**
 * Phash-only backfill — beregner perceptuel hash for alle kort der mangler det.
 * Downloader fra image_url (pokemontcg.io), uploader INTET til R2.
 * Bruger parallelle PATCH-requests: ingen NOT NULL-konflikter, korrekt update-semantik.
 * Kør: node scripts/backfill-phash-only.js
 */
import 'dotenv/config'
import { computePhash } from '../packages/scanner/index.js'
import { dbSelect, dbUpdate, dbCount } from '../server/middleware/db.js'

const GAME              = process.argv[2] || 'pokemon'
const CONCURRENCY       = GAME === 'mtg' ? 3 : 8   // Scryfall er rate-limited
const PATCH_CONCURRENCY = 40   // parallelle DB-patches per batch
const BATCH_SIZE        = 200  // antal kort per runde
const TIMEOUT_MS        = 20000
const DELAY_BATCH_MS    = GAME === 'mtg' ? 800 : 300

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchBuf(url, attempt = 0) {
  const ctrl = new AbortController()
  const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  } catch (err) {
    clearTimeout(t)
    if (attempt < 2) {
      await sleep(2000 * (attempt + 1))
      return fetchBuf(url, attempt + 1)
    }
    throw err
  } finally {
    clearTimeout(t)
  }
}

async function run() {
  const total = await dbCount('card_catalog', `game=eq.${GAME}&phash=is.null&image_url=not.is.null`)
  let done    = 0
  let errors  = 0
  let batches = 0

  console.log(`\nPhash backfill [${GAME}] — ${total} kort mangler phash\n`)

  // Brug ALTID offset=0: processerede kort forsvinder fra phash=is.null-queryen
  while (true) {
    const rows = await dbSelect(
      'card_catalog',
      `game=eq.${GAME}&phash=is.null&image_url=not.is.null&select=id,image_url&limit=${BATCH_SIZE}&offset=0`
    )
    if (!rows.length) break

    // Download og beregn phash parallelt (CONCURRENCY ad gangen)
    const results = []
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY)
      const chunkResults = await Promise.all(chunk.map(async row => {
        try {
          const buf   = await fetchBuf(row.image_url)
          const phash = await computePhash(buf)
          return { id: row.id, phash }
        } catch {
          errors++
          return null
        }
      }))
      results.push(...chunkResults.filter(Boolean))
    }

    // Parallelle PATCH-requests — kun phash opdateres, ingen NOT NULL-konflikter
    for (let i = 0; i < results.length; i += PATCH_CONCURRENCY) {
      const chunk = results.slice(i, i + PATCH_CONCURRENCY)
      await Promise.all(chunk.map(r => dbUpdate('card_catalog', { id: r.id }, { phash: r.phash })))
    }
    done += results.length

    batches++
    const pct = total > 0 ? ((done / total) * 100).toFixed(1) : '?'
    process.stdout.write(`\r  Batch ${batches} | ${done}/${total} (${pct}%) gemt | ${errors} fejl`)

    await sleep(DELAY_BATCH_MS)
  }

  console.log(`\n\nFærdig!`)
  console.log(`  Phash gemt:  ${done}`)
  console.log(`  Fejl:        ${errors}`)
}

run().catch(err => { console.error(err); process.exit(1) })
