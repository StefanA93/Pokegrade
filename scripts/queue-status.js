#!/usr/bin/env node
import 'dotenv/config'
import { syncQueue, priceQueue, imageQueue } from '../worker/queues.js'
import { indexStatus } from '../packages/search/index.js'

const [sync, price, image, search] = await Promise.all([
  syncQueue.getJobCounts(),
  priceQueue.getJobCounts(),
  imageQueue.getJobCounts(),
  indexStatus().catch(() => ({ numberOfDocuments: '?', isIndexing: '?' })),
])

console.log('\n═══════════════════════════════════')
console.log('  GradeDex Queue Status')
console.log('═══════════════════════════════════')
console.log('Sync queue:   ', sync)
console.log('Price queue:  ', price)
console.log('Image queue:  ', image)
console.log('Meilisearch:  ', search)
console.log('═══════════════════════════════════\n')

process.exit(0)
