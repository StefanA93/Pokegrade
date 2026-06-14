import 'dotenv/config'
import { dbCount, dbSelect } from '../server/middleware/db.js'

const GAMES = ['pokemon', 'yugioh', 'mtg', 'lorcana', 'onepiece', 'dragonball', 'pokemonjp', 'riftbound']

async function sampleUrls(game, filter, n = 5) {
  const rows = await dbSelect('card_catalog',
    `game=eq.${game}&${filter}&select=id,set_name,number,image_url&limit=${n}`)
  return rows
}

async function diagnoseGame(game) {
  const [total, hasPhash, noImg, hasImgNoPhash] = await Promise.all([
    dbCount('card_catalog', `game=eq.${game}`),
    dbCount('card_catalog', `game=eq.${game}&phash_art=not.is.null`),
    dbCount('card_catalog', `game=eq.${game}&image_url=is.null`),
    dbCount('card_catalog', `game=eq.${game}&phash_art=is.null&image_url=not.is.null`),
  ])
  const pct = total ? ((hasPhash / total) * 100).toFixed(1) : 0
  return { game, total, hasPhash, noImg, hasImgNoPhash, pct }
}

async function run() {
  console.log('\n📊 Phash_art dækning — diagnose\n')
  console.log('Spil'.padEnd(12) + 'Total'.padEnd(8) + 'Phash'.padEnd(8) + '%'.padEnd(7) + 'IngenBilled'.padEnd(13) + 'Billede+IngenPhash')
  console.log('─'.repeat(60))

  const results = []
  for (const game of GAMES) {
    const r = await diagnoseGame(game)
    results.push(r)
    const bar = r.pct >= 95 ? '✅' : r.pct >= 85 ? '🟡' : '🔴'
    console.log(
      `${bar} ${r.game.padEnd(10)}` +
      `${String(r.total).padEnd(8)}` +
      `${String(r.hasPhash).padEnd(8)}` +
      `${(r.pct + '%').padEnd(7)}` +
      `${String(r.noImg).padEnd(13)}` +
      `${r.hasImgNoPhash}`
    )
  }

  console.log('\n─'.repeat(60))
  console.log('\n🔍 Sample af billeder der IKKE kan hentes (image_url men ingen phash_art):\n')

  for (const { game, hasImgNoPhash, pct } of results) {
    if (hasImgNoPhash === 0) continue
    console.log(`\n── ${game} (${hasImgNoPhash} mangler, ${pct}% dækning) ──`)
    const samples = await sampleUrls(game, 'phash_art=is.null&image_url=not.is.null', 6)
    for (const s of samples) {
      const domain = s.image_url ? new URL(s.image_url).hostname : 'N/A'
      console.log(`  [${s.set_name?.slice(0,25)?.padEnd(25)}] ${domain}`)
      console.log(`    ${s.image_url?.slice(0, 90)}`)
    }

    // Grupper URL-domæner
    const domainRows = await dbSelect('card_catalog',
      `game=eq.${game}&phash_art=is.null&image_url=not.is.null&select=image_url&limit=500`)
    const domainCount = {}
    for (const r of domainRows) {
      if (!r.image_url) continue
      try {
        const h = new URL(r.image_url).hostname
        domainCount[h] = (domainCount[h] || 0) + 1
      } catch {}
    }
    const sorted = Object.entries(domainCount).sort((a,b) => b[1]-a[1])
    console.log(`  URL-domæner (sample 500):`)
    for (const [d, c] of sorted) console.log(`    ${String(c).padStart(5)}x  ${d}`)
  }

  console.log('\nFærdig!\n')
}

run().catch(e => { console.error(e); process.exit(1) })
