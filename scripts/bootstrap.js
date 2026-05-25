#!/usr/bin/env node
/**
 * Bootstrap script — run once after deploy to:
 * 1. Configure Meilisearch index settings
 * 2. Seed all sets for all games
 * 3. Trigger initial price sync
 *
 * Usage:
 *   node scripts/bootstrap.js
 *   node scripts/bootstrap.js --game pokemon
 *   node scripts/bootstrap.js --reindex-only
 */
import 'dotenv/config'
import { configureIndex } from '../packages/search/index.js'
import { enqueueSyncGame, enqueuePriceSync } from '../worker/queues.js'
import { getAllGameIds } from '../packages/providers/index.js'

const args   = process.argv.slice(2)
const game   = args.includes('--game') ? args[args.indexOf('--game') + 1] : null
const games  = game ? [game] : getAllGameIds()
const onlyReindex = args.includes('--reindex-only')

console.log('🔧 Configuring Meilisearch index...')
await configureIndex()
console.log('✓ Meilisearch configured')

if (!onlyReindex) {
  for (const gameId of games) {
    console.log(`📦 Queuing sync for ${gameId}...`)
    await enqueueSyncGame(gameId)
    await enqueuePriceSync(gameId)
  }
  console.log(`✓ Queued sync + price jobs for: ${games.join(', ')}`)
  console.log('  Workers will process them. Monitor with:')
  console.log('  node scripts/queue-status.js')
} else {
  console.log('ℹ  --reindex-only: skipping sync jobs')
}

console.log('\n✅ Bootstrap complete')
process.exit(0)
