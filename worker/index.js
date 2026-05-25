import 'dotenv/config'
import { createSyncWorker }  from './sync-worker.js'
import { createPriceWorker } from './price-worker.js'
import { createImageWorker } from './image-worker.js'
import { setupCronJobs }     from './queues.js'
import { configureIndex }    from '../packages/search/index.js'

console.log('[worker] Starting GradeDex workers...')

const syncWorker  = createSyncWorker()
const priceWorker = createPriceWorker()
const imageWorker = createImageWorker()

syncWorker.on('completed', job => console.log(`[sync]  ✓ ${job.name} ${JSON.stringify(job.data)}`))
syncWorker.on('failed',    (job, err) => console.error(`[sync]  ✗ ${job?.name}:`, err.message))

priceWorker.on('completed', job => console.log(`[price] ✓ ${job.name} ${JSON.stringify(job.data)}`))
priceWorker.on('failed',    (job, err) => console.error(`[price] ✗ ${job?.name}:`, err.message))

imageWorker.on('completed', job => console.log(`[image] ✓ ${job.name} ${job.data?.cardId}`))
imageWorker.on('failed',    (job, err) => console.error(`[image] ✗ ${job?.name}:`, err.message))

await configureIndex().catch(err => console.warn('[worker] Meilisearch not ready:', err.message))
await setupCronJobs().catch(err => console.warn('[worker] Cron setup failed:', err.message))

console.log('[worker] All workers running. Cron jobs scheduled.')

async function shutdown(signal) {
  console.log(`[worker] ${signal} — shutting down...`)
  await Promise.all([
    syncWorker.close(),
    priceWorker.close(),
    imageWorker.close(),
  ])
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
