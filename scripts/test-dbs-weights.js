/**
 * Hurtig A/B test: Dragon Ball phash=0.20 vs ren CLIP
 * Kør: node scripts/test-dbs-weights.js
 */
import 'dotenv/config'
import { dbSelect } from '../server/middleware/db.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const SAMPLE       = 50
const NOISE_STD    = 0.08

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}

function addNoise(emb, std) {
  const noisy = emb.map(v => {
    const u1 = Math.random(), u2 = Math.random()
    return v + Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * std
  })
  const norm = Math.sqrt(noisy.reduce((s, v) => s + v * v, 0))
  return norm > 0 ? noisy.map(v => v / norm) : noisy
}

const sbh = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${SUPABASE_KEY}`,
  apikey: SUPABASE_KEY,
})

async function matchCards(embedding, count) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_cards`, {
    method: 'POST',
    headers: sbh(),
    body: JSON.stringify({
      query_embedding: `[${embedding.join(',')}]`,
      game_filter: 'dragonball',
      match_count: count,
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!r.ok) return null
  return r.json()
}

async function runTest(weights, label, sample) {
  let top1 = 0, top5 = 0

  for (const card of sample) {
    let emb = card.embedding
    if (typeof emb === 'string') emb = JSON.parse(emb)
    if (!Array.isArray(emb)) continue

    const noisyEmb = addNoise(emb, NOISE_STD)
    const results  = await matchCards(noisyEmb, 30)
    if (!results?.length) continue

    const w = weights
    const reranked = results.map(c => {
      const clipScore  = typeof c.similarity === 'number' ? c.similarity : 0
      const phashScore = w.phash > 0 && c.phash && card.phash
        ? 1 - hamming(card.phash, c.phash) / 64 : 0
      return { id: c.id, score: clipScore * w.clip + phashScore * w.phash }
    }).sort((a, b) => b.score - a.score).slice(0, 5)

    const rank = reranked.findIndex(c => c.id === card.id) + 1
    if (rank === 1) top1++
    if (rank >= 1 && rank <= 5) top5++
    await sleep(40)
  }

  const t1 = ((top1 / sample.length) * 100).toFixed(1)
  const t5 = ((top5 / sample.length) * 100).toFixed(1)
  console.log(`  ${label.padEnd(30)} Top-1: ${top1}/${sample.length} (${t1}%)   Top-5: ${top5}/${sample.length} (${t5}%)`)
}

async function run() {
  console.log('\nDragon Ball A/B: phash weight test\n')
  console.log(`Henter ${SAMPLE} Dragon Ball kort...`)

  const sample = await dbSelect('card_catalog',
    `game=eq.dragonball&embedding=not.is.null&select=id,name,embedding,phash&limit=${SAMPLE}`)

  console.log(`Klar — ${sample.length} kort\n`)

  // Kør CLIP-only først (hurtigere at sammenligne)
  process.stdout.write('  Test A (ren CLIP 1.00/0.00)...         ')
  await runTest({ clip: 1.00, phash: 0.00 }, 'Ren CLIP (1.00/0.00)', sample)

  process.stdout.write('  Test B (CLIP+phash 0.80/0.20)...       ')
  await runTest({ clip: 0.80, phash: 0.20 }, 'CLIP+phash (0.80/0.20)', sample)

  process.stdout.write('  Test C (CLIP+phash 0.90/0.10)...       ')
  await runTest({ clip: 0.90, phash: 0.10 }, 'CLIP+phash (0.90/0.10)', sample)

  console.log('\nFærdig.')
}

run().catch(err => { console.error(err); process.exit(1) })
