/**
 * Pipeline Simulation Test v2 — L1 (phash) + L2 (CLIP) på tværs af alle 8 TCGs.
 * Ingen billeddownloads — tester direkte mod DB og match_cards RPC.
 *
 * Tests:
 *   L1  — phash self-match + near-duplicate detection
 *   L2a — self-match (HNSW approximation check)
 *   L2b — NOISE-test: stored embedding + Gaussian noise → simulerer kamerafoto
 *   L3  — blinde kort (mangler BÅDE phash OG embedding → pipeline blind)
 *
 * Kør: node scripts/test-pipeline-simulation.js
 */
import 'dotenv/config'
import { dbSelect } from '../server/middleware/db.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const SAMPLE       = 50    // 50 samples giver ±7pp konfidensinterval (±14pp ved 20)
const PHASH_LIMIT  = 5000
const NOISE_STD    = 0.08  // Gaussian støj std — svarer til typisk kamera-variation

// YGO + DBS: 0.97+ nabo-sim + rarity-varianter deler phash → phash re-ranking skader
const PHASH_WEIGHTS = {
  yugioh:     { clip: 1.00, phash: 0.00, phashArt: 0.00 },
  dragonball: { clip: 1.00, phash: 0.00, phashArt: 0.00 },
  default:    { clip: 0.65, phash: 0.25, phashArt: 0.10 },
}

const GAMES = [
  { id: 'pokemon',    label: 'Pokemon EN'  },
  { id: 'pokemonjp',  label: 'Pokemon JP'  },
  { id: 'mtg',        label: 'MTG'         },
  { id: 'yugioh',     label: 'Yu-Gi-Oh'   },
  { id: 'onepiece',   label: 'One Piece'   },
  { id: 'lorcana',    label: 'Lorcana'     },
  { id: 'dragonball', label: 'Dragon Ball' },
  { id: 'riftbound',  label: 'Riftbound'   },
]

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)) }
function pct(n, d)  { return d === 0 ? ' —   ' : `${((n / d) * 100).toFixed(1)}%` }
function pad(s, n)  { return String(s ?? '').padEnd(n) }
function rpad(s, n) { return String(s ?? '').padStart(n) }
function bar(n, max, w = 18) {
  const f = max === 0 ? 0 : Math.round((n / max) * w)
  return '█'.repeat(f) + '░'.repeat(w - f)
}

// ── Hamming distance ──────────────────────────────────────────────────────────
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}

// ── Gaussian noise + L2 normalization (simulerer kamera-embedding variance) ──
function addNoise(embedding, std = NOISE_STD) {
  // Box-Muller transform til Gaussian noise
  const noisy = embedding.map(v => {
    const u1 = Math.random(), u2 = Math.random()
    const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    return v + gauss * std
  })
  // L2-normalisér (CLIP embeddings er unit-normerede)
  const norm = Math.sqrt(noisy.reduce((s, v) => s + v * v, 0))
  return norm > 0 ? noisy.map(v => v / norm) : noisy
}

// ── REST helpers ──────────────────────────────────────────────────────────────
const sbh = () => ({
  'Content-Type': 'application/json',
  Authorization:  `Bearer ${SUPABASE_KEY}`,
  apikey:         SUPABASE_KEY,
})

async function countWhere(game, filter) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&${filter}&select=id`,
    { headers: { ...sbh(), Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } }
  )
  return parseInt((r.headers.get('content-range') || '0/0').split('/')[1] || '0', 10)
}

async function countTotal(game) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/card_catalog?game=eq.${game}&select=id`,
    { headers: { ...sbh(), Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } }
  )
  return parseInt((r.headers.get('content-range') || '0/0').split('/')[1] || '0', 10)
}

async function sampleCards(game, col, n) {
  return dbSelect('card_catalog',
    `game=eq.${game}&${col}=not.is.null&select=id,name,${col},phash,phash_art&limit=${n}`)
}

async function fetchPhashPool(game) {
  const pool = []
  let offset = 0
  while (pool.length < PHASH_LIMIT) {
    const batch = await dbSelect('card_catalog',
      `game=eq.${game}&phash=not.is.null&select=id,phash&limit=1000&offset=${offset}`)
    pool.push(...batch)
    if (batch.length < 1000) break
    offset += batch.length
  }
  return pool
}

async function matchCards(embedding, game, count = 20) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_cards`, {
    method:  'POST',
    headers: sbh(),
    body:    JSON.stringify({
      query_embedding: `[${embedding.join(',')}]`,
      game_filter:     game,
      match_count:     count,
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!r.ok) return null
  return r.json()
}

// ── L1: phash self-match + near-dup detection ─────────────────────────────────
async function testL1(game) {
  const sample = await sampleCards(game, 'phash', SAMPLE)
  if (!sample.length) return { tested: 0, selfMatch: 0, avgNeighbor: null, nearDups: [] }

  const pool = await fetchPhashPool(game)
  if (pool.length < 2) return { tested: 0, selfMatch: 0, avgNeighbor: null, nearDups: [] }

  // Merge sample ind i pool for at undgå miss på store spil
  const poolMap = new Map(pool.map(c => [c.id, c]))
  for (const c of sample) poolMap.set(c.id, c)
  const merged = [...poolMap.values()]

  let selfMatch = 0
  const neighborDists = []
  const nearDups = []

  for (const card of sample) {
    const myHash = card.phash
    if (!myHash) continue

    const ranked = merged
      .map(c => ({ id: c.id, dist: hamming(myHash, c.phash) }))
      .sort((a, b) => a.dist - b.dist)

    if (ranked[0]?.id === card.id) selfMatch++

    const neighbor = ranked.find(c => c.id !== card.id)
    if (neighbor) {
      neighborDists.push(neighbor.dist)
      // Flad: dist ≤ 8 = visuel næsten-dublet → OCR afgørende
      if (neighbor.dist <= 8) {
        nearDups.push({ card: card.id, neighbor: neighbor.id, dist: neighbor.dist })
      }
    }
  }

  const avgNeighbor = neighborDists.length
    ? (neighborDists.reduce((s, d) => s + d, 0) / neighborDists.length).toFixed(1)
    : null

  return { tested: sample.length, selfMatch, avgNeighbor, poolSize: merged.length, nearDups }
}

// ── L2a: CLIP self-match (HNSW approximation check) ─────────────────────────
async function testL2Self(game) {
  const sample = await sampleCards(game, 'embedding', SAMPLE)
  if (!sample.length) return { tested: 0, selfMatch: 0, avgNeighbor: null }

  let selfMatch = 0
  const neighborSims = []

  for (const card of sample) {
    let emb = card.embedding
    if (typeof emb === 'string') emb = JSON.parse(emb)
    if (!Array.isArray(emb)) continue

    const results = await matchCards(emb, game, 20)
    if (!results?.length) continue

    if (results[0]?.similarity >= 0.9999 || results.some(c => c.id === card.id && c.similarity >= 0.9999))
      selfMatch++

    const neighbor = results.find(c => c.id !== card.id)
    if (neighbor?.similarity) neighborSims.push(neighbor.similarity)
    await sleep(40)
  }

  const avgNeighbor = neighborSims.length
    ? (neighborSims.reduce((s, v) => s + v, 0) / neighborSims.length).toFixed(3)
    : null

  return { tested: sample.length, selfMatch, avgNeighbor }
}

// ── L2b: NOISE-test (realistisk kamera-simulation) ───────────────────────────
// Simulerer fuld pipeline: CLIP+noise → 30 kandidater → phash re-ranking → top-5
async function testL2Noise(game) {
  const sample = await sampleCards(game, 'embedding', SAMPLE)
  if (!sample.length) return { tested: 0, top1: 0, top5: 0 }

  let top1 = 0, top5 = 0

  for (const card of sample) {
    let emb = card.embedding
    if (typeof emb === 'string') emb = JSON.parse(emb)
    if (!Array.isArray(emb)) continue

    // Tilføj kamera-lignende støj og hent 30 kandidater (nok til phash re-ranking)
    const noisyEmb = addNoise(emb, NOISE_STD)
    const results  = await matchCards(noisyEmb, game, 30)
    if (!results?.length) continue

    // Re-rank med CLIP + phash + phash_art (spejler scan-free.js scoring)
    // YGO/DBS: phash-re-ranking skader (0.97+ nabo-sim + mange rarity-varianter med ens phash)
    // → ren CLIP-score for disse spil; phash bruges kun som OCR-tiebreaker i prod
    const w = PHASH_WEIGHTS[game] ?? PHASH_WEIGHTS.default
    const reranked = results.map(c => {
      const clipScore     = typeof c.similarity === 'number' ? c.similarity : 0
      const phashScore    = w.phash > 0 && c.phash && card.phash
        ? 1 - hamming(card.phash, c.phash) / 64 : 0
      const phashArtScore = w.phashArt > 0 && c.phash_art && card.phash_art
        ? 1 - hamming(card.phash_art, c.phash_art) / 64 : 0
      return { id: c.id, score: clipScore * w.clip + phashScore * w.phash + phashArtScore * w.phashArt }
    }).sort((a, b) => b.score - a.score).slice(0, 5)

    const rank = reranked.findIndex(c => c.id === card.id) + 1
    if (rank === 1) top1++
    if (rank >= 1 && rank <= 5) top5++
    await sleep(40)
  }

  return { tested: sample.length, top1, top5 }
}

// ── L3: Blinde kort (ingen phash OG ingen embedding) ─────────────────────────
async function countBlind(game) {
  // Kort der mangler BEGGE signaler — pipelinen er helt blind for dem
  const [total, hasPhash, hasEmb] = await Promise.all([
    countTotal(game),
    countWhere(game, 'phash=not.is.null'),
    countWhere(game, 'embedding=not.is.null'),
  ])
  // Estimat: antag uafhængighed (konservativ)
  const missingPhash = total - hasPhash
  const missingEmb   = total - hasEmb
  // Faktisk blinde = mangler begge (hent præcist antal)
  const blind = await countWhere(game, 'phash=is.null&embedding=is.null')
  return { total, hasPhash, hasEmb, missingPhash, missingEmb, blind }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗')
  console.log('║      GradeDex — Pipeline Simulation Test v2 (L1 + L2a + L2b)      ║')
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n')
  console.log(`${SAMPLE} samples/spil · noise std=${NOISE_STD} · phash pool ${PHASH_LIMIT}\n`)

  const results = []

  for (const { id, label } of GAMES) {
    process.stdout.write(`  ${pad(label, 13)}`)
    process.stdout.write(` coverage`)

    const blind = await countBlind(id)

    process.stdout.write(` L1`)
    const l1 = await testL1(id)
    await sleep(80)

    process.stdout.write(` L2a`)
    const l2a = await testL2Self(id)
    await sleep(80)

    process.stdout.write(` L2b(noise)`)
    const l2b = await testL2Noise(id)

    process.stdout.write(' ✓\n')
    results.push({ id, label, blind, l1, l2a, l2b })
  }

  // ── Coverage ──────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(78))
  console.log('  COVERAGE + BLINDE KORT')
  console.log('═'.repeat(78))
  console.log(pad('Spil', 13), rpad('Total', 7), pad('phash%', 8), pad('emb%', 8), pad('Blinde', 8), 'CLIP-bar')
  console.log('─'.repeat(78))

  for (const s of results) {
    const { total, hasPhash, hasEmb, blind } = s.blind
    const blindWarn = blind > 0 ? ` ⚠ ${blind}` : ' ✓'
    console.log(
      pad(s.label, 13), rpad(total.toLocaleString(), 7),
      pad(pct(hasPhash, total), 8),
      pad(pct(hasEmb, total), 8),
      pad(blindWarn, 8),
      bar(hasEmb, total)
    )
  }

  // ── L1 phash ─────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(78))
  console.log('  L1 — PHASH SELF-MATCH + NEAR-DUPLICATES')
  console.log('═'.repeat(78))
  console.log(pad('Spil', 13), pad('Self-match', 14), pad('Ø Nabo dist', 13), pad('Near-dups ≤8', 13), 'Status')
  console.log('─'.repeat(78))

  for (const s of results) {
    const { tested, selfMatch, avgNeighbor, nearDups } = s.l1
    if (!tested) { console.log(pad(s.label, 13), '— ingen phash'); continue }
    const rate   = pct(selfMatch, tested)
    const ndStr  = nearDups.length > 0 ? `${nearDups.length} par ⚠` : '0 ✓'
    const distStr = avgNeighbor !== null
      ? `${avgNeighbor} (${parseFloat(avgNeighbor) < 10 ? '⚠tæt' : 'ok'})`
      : '—'
    const status = selfMatch === tested ? '✅' : selfMatch >= tested * 0.8 ? '⚠️' : '❌'
    console.log(pad(s.label, 13), pad(`${selfMatch}/${tested} (${rate})`, 14), pad(distStr, 13), pad(ndStr, 13), status)
  }

  // ── L2a self-match ────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(78))
  console.log('  L2a — CLIP SELF-MATCH (HNSW approximation check)')
  console.log('═'.repeat(78))
  console.log(pad('Spil', 13), pad('Self-match', 14), pad('Ø Nabo sim', 12), 'Clustering')
  console.log('─'.repeat(78))

  for (const s of results) {
    const { tested, selfMatch, avgNeighbor } = s.l2a
    if (!tested) { console.log(pad(s.label, 13), '— ingen embeddings'); continue }
    const qual = !avgNeighbor ? '—'
      : parseFloat(avgNeighbor) >= 0.95 ? '🔴 meget tæt (OCR kritisk!)'
      : parseFloat(avgNeighbor) >= 0.87 ? '🟡 tæt (OCR vigtig)'
      : '🟢 god adskillelse'
    console.log(pad(s.label, 13), pad(`${selfMatch}/${tested} (${pct(selfMatch, tested)})`, 14),
      pad(avgNeighbor ?? '—', 12), qual)
  }

  // ── L2b noise-test ────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(78))
  console.log(`  L2b — NOISE-TEST (kamera-simulation, std=${NOISE_STD})`)
  console.log('  Dette er den realistiske test — embedding + støj → find korrekt kort')
  console.log('═'.repeat(78))
  console.log(pad('Spil', 13), pad('Top-1', 14), pad('Top-5', 14), 'Vurdering')
  console.log('─'.repeat(78))

  for (const s of results) {
    const { tested, top1, top5 } = s.l2b
    if (!tested) { console.log(pad(s.label, 13), '— ingen embeddings'); continue }
    const r1 = pct(top1, tested)
    const r5 = pct(top5, tested)
    const grade = top1 / tested >= 0.85 ? '✅ Klar til prod'
      : top5 / tested >= 0.85            ? '⚠️  Top-5 ok, top-1 svag'
      : '❌ Kræver opmærksomhed'
    console.log(pad(s.label, 13), pad(`${top1}/${tested} (${r1})`, 14), pad(`${top5}/${tested} (${r5})`, 14), grade)
  }

  // ── Samlet ────────────────────────────────────────────────────────────────
  const totalBlind  = results.reduce((s, r) => s + r.blind.blind, 0)
  const totalCards  = results.reduce((s, r) => s + r.blind.total, 0)
  const totalPhash  = results.reduce((s, r) => s + r.blind.hasPhash, 0)
  const totalEmb    = results.reduce((s, r) => s + r.blind.hasEmb, 0)
  const l1SM = results.reduce((a, r) => a + r.l1.selfMatch, 0)
  const l1T  = results.reduce((a, r) => a + r.l1.tested, 0)
  const l2bT1 = results.reduce((a, r) => a + r.l2b.top1, 0)
  const l2bT  = results.reduce((a, r) => a + r.l2b.tested, 0)
  const l2bT5 = results.reduce((a, r) => a + r.l2b.top5, 0)
  const allNearDups = results.flatMap(r => r.l1.nearDups.map(d => ({ game: r.label, ...d })))

  console.log('\n' + '═'.repeat(78))
  console.log('  SAMLET RESUMÉ')
  console.log('═'.repeat(78))
  console.log(`Kort i DB:               ${totalCards.toLocaleString()}`)
  console.log(`Med phash (L1):          ${totalPhash.toLocaleString()} (${pct(totalPhash, totalCards)})`)
  console.log(`Med embedding (L2):      ${totalEmb.toLocaleString()} (${pct(totalEmb, totalCards)})`)
  console.log(`Blinde kort (ingen L1+L2): ${totalBlind} ${totalBlind > 0 ? '⚠' : '✓'}`)
  console.log()
  console.log(`L1 phash self-match:     ${l1SM}/${l1T} (${pct(l1SM, l1T)})`)
  console.log(`L2b noise top-1:         ${l2bT1}/${l2bT} (${pct(l2bT1, l2bT)})  ← realistisk metric`)
  console.log(`L2b noise top-5:         ${l2bT5}/${l2bT} (${pct(l2bT5, l2bT)})`)

  if (allNearDups.length) {
    console.log(`\n⚠️  Near-duplicate par (phash dist ≤ 8) — OCR nummer er afgørende for disse:`)
    for (const d of allNearDups.slice(0, 10)) {
      console.log(`   [${d.game}] ${d.card} ↔ ${d.neighbor} (dist=${d.dist})`)
    }
    if (allNearDups.length > 10) console.log(`   ... og ${allNearDups.length - 10} flere`)
  }

  console.log()
  console.log('ℹ️  L2b noise-test = den realistiske præcision (kamerafoto ≠ stored embedding)')
  console.log('ℹ️  Top-5 > 85% = pipeline kan altid finde kortet i kandidat-listen')
  console.log('ℹ️  Near-dups dist ≤ 8 = phash kan forveksle → OCR kortnummer afgør')
  console.log('═'.repeat(78))
  console.log()
}

run().catch(err => { console.error(err); process.exit(1) })
