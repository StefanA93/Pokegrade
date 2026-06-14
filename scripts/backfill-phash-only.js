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
const PATCH_CONCURRENCY = 10   // parallelle DB-patches per batch
const BATCH_SIZE        = 200  // antal kort per runde
const TIMEOUT_MS        = 20000
const DELAY_BATCH_MS    = GAME === 'mtg' ? 800 : 300

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchBuf(url, attempt = 0) {
  const ctrl = new AbortController()
  const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    clearTimeout(t)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  } catch (err) {
    clearTimeout(t)
    // Retry kun på netværksfejl/timeouts — ikke på permanente HTTP 4xx-fejl
    const isPermanent = /HTTP 4\d\d/.test(err.message)
    if (!isPermanent && attempt < 2) {
      await sleep(2000 * (attempt + 1))
      return fetchBuf(url, attempt + 1)
    }
    throw err
  }
}

async function run() {
  const total = await dbCount('card_catalog', `game=eq.${GAME}&phash=is.null&image_url=not.is.null`)
  let done    = 0
  let errors  = 0
  let batches = 0
  const failed = new Set()

  console.log(`\nPhash backfill [${GAME}] — ${total} kort mangler phash\n`)

  while (true) {
    // Hop forbi kendte 404-kort ved at øge offset indtil vi finder en brugbar batch
    let offset = 0
    let rows   = []
    while (rows.length === 0) {
      const all = await dbSelect(
        'card_catalog',
        `game=eq.${GAME}&phash=is.null&image_url=not.is.null&select=id,image_url&limit=${BATCH_SIZE}&offset=${offset}`
      )
      if (!all.length) { rows = null; break }
      rows = all.filter(r => !failed.has(r.id))
      if (rows.length === 0) offset += BATCH_SIZE
    }
    if (rows === null) break

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
          failed.add(row.id)
          return null
        }
      }))
      results.push(...chunkResults.filter(Boolean))
    }

    // Parallelle PATCH-requests — kun phash opdateres, ingen NOT NULL-konflikter
    let saved = 0
    for (let i = 0; i < results.length; i += PATCH_CONCURRENCY) {
      const chunk = results.slice(i, i + PATCH_CONCURRENCY)
      const outcomes = await Promise.allSettled(
        chunk.map(async r => {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await dbUpdate('card_catalog', { id: r.id }, { phash: r.phash })
              return
            } catch (err) {
              if (attempt < 2 && /DB update failed: 5\d\d/.test(err.message)) {
                await sleep(1000 * (attempt + 1))
              } else {
                throw err
              }
            }
          }
        })
      )
      for (const o of outcomes) {
        if (o.status === 'fulfilled') saved++
        else { errors++; failed.add(chunk[outcomes.indexOf(o)]?.id) }
      }
    }
    done += saved

    batches++
    const pct = total > 0 ? ((done / total) * 100).toFixed(1) : '?'
    process.stdout.write(`\r  Batch ${batches} | ${done}/${total} (${pct}%) gemt | ${errors} fejl (${failed.size} skippet)`)

    await sleep(DELAY_BATCH_MS)
  }

  console.log(`\n\nFærdig!`)
  console.log(`  Phash gemt:   ${done}`)
  console.log(`  Fejl/skippet: ${errors}`)
}

run().catch(err => { console.error(err); process.exit(1) })
