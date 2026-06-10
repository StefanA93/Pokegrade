/**
 * Kopierer embedding (vector) → embedding_vec (vector) i batches med retry.
 * Kør: node scripts/migrate-embedding-vec.js
 */
import 'dotenv/config'

const SUPABASE_URL = process.env.SUPABASE_URL
const KEY          = process.env.SUPABASE_SERVICE_KEY
const FETCH_BATCH  = 100
const CONCUR       = 5
const MAX_RETRIES  = 4
const RETRY_DELAY  = 3000

const h = {
  'Content-Type': 'application/json',
  Authorization:  `Bearer ${KEY}`,
  apikey:         KEY,
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function withRetry(fn, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e
      process.stderr.write(`  Retry ${attempt}/${MAX_RETRIES} (${label}): ${e.message.slice(0, 60)}\n`)
      await sleep(RETRY_DELAY * attempt)
    }
  }
}

async function fetchBatch(offset) {
  return withRetry(async () => {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/card_catalog?embedding=not.is.null&embedding_vec=is.null&select=id,embedding&limit=${FETCH_BATCH}&offset=${offset}`,
      { headers: h, signal: AbortSignal.timeout(30000) }
    )
    if (!r.ok) throw new Error(`Fetch fejl: ${r.status} ${await r.text()}`)
    return r.json()
  }, `fetch offset=${offset}`)
}

async function patchRow(id, embedding) {
  return withRetry(async () => {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/card_catalog?id=eq.${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ embedding_vec: embedding }), signal: AbortSignal.timeout(15000) }
    )
    if (!r.ok) {
      const msg = await r.text()
      throw new Error(`HTTP ${r.status}: ${msg.slice(0, 80)}`)
    }
  }, id)
}

async function runConcurrent(tasks) {
  let i = 0, done = 0, errors = 0
  async function worker() {
    while (i < tasks.length) {
      const task = tasks[i++]
      try { await task(); done++ } catch (e) { errors++; process.stderr.write(`  Fejl (permanent): ${e.message.slice(0,60)}\n`) }
    }
  }
  await Promise.all(Array.from({ length: CONCUR }, worker))
  return { done, errors }
}

async function run() {
  console.log('🔄 Migrerer embedding → embedding_vec (concur=' + CONCUR + ', retry=' + MAX_RETRIES + ')...\n')
  let offset = 0, totalDone = 0, totalErrors = 0

  while (true) {
    let rows
    try {
      rows = await fetchBatch(offset)
    } catch (e) {
      console.error(`\nFatal fetch fejl ved offset ${offset}: ${e.message}`)
      console.log(`\n⚠️  Afbrudt ved offset ${offset}. Kør igen for at fortsætte (${totalDone} allerede gemt).`)
      process.exit(1)
    }

    if (!rows.length) break

    const tasks = rows.map(row => () => patchRow(row.id, row.embedding))
    const { done, errors } = await runConcurrent(tasks)
    totalDone += done
    totalErrors += errors

    offset += rows.length
    process.stdout.write(`\r  ${totalDone} migreret | ${totalErrors} fejl | offset ${offset}   `)
    await sleep(200)
  }

  console.log(`\n\n✅ Færdig: ${totalDone} embedding_vec opdateret, ${totalErrors} fejl`)
}

run().catch(err => { console.error('\nUventet fejl:', err.message); process.exit(1) })
