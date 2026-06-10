/**
 * Verificer cardmarket-api-tcg på RapidAPI efter du har subscribet.
 * Viser rå API-svar så vi kan bekræfte endpoint/felt-format.
 *
 * Brug: node scripts/test-cardmarket-api.js
 */
import 'dotenv/config'

const KEY  = process.env.CARDMARKET_API_KEY
const HOST = 'cardmarket-api-tcg.p.rapidapi.com'
const BASE = `https://${HOST}`

if (!KEY) {
  console.error('❌ CARDMARKET_API_KEY mangler i .env')
  console.error('   Sæt nøglen fra: https://rapidapi.com/tcggopro/api/cardmarket-api-tcg')
  process.exit(1)
}

const headers = {
  'x-rapidapi-key':  KEY,
  'x-rapidapi-host': HOST,
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function probe(label, url) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`📡 ${label}`)
  console.log(`   ${url}`)
  await sleep(500)
  try {
    const r = await fetch(url, { headers })
    console.log(`   Status: ${r.status} ${r.statusText}`)
    if (!r.ok) { console.log('   ❌ Fejlede'); return null }
    const json = await r.json()
    const preview = JSON.stringify(json, null, 2).slice(0, 1500)
    console.log(preview + (preview.length >= 1500 ? '\n   [afkortet...]' : ''))
    return json
  } catch (err) {
    console.log(`   ❌ ${err.message}`)
    return null
  }
}

function firstWithCards(sets) {
  const arr = Array.isArray(sets) ? sets : (sets.data || [])
  return arr.find(s => (s.cards_total || 0) > 0) || null
}

async function run() {
  console.log(`\n🔑 Key: ${KEY.slice(0, 10)}...`)
  console.log(`🌐 Host: ${HOST}\n`)

  // ── Lorcana ──────────────────────────────────────────────
  const lorSets = await probe('Lorcana sæt', `${BASE}/lorcana/episodes`)

  if (lorSets) {
    const set = firstWithCards(lorSets)
    if (set) {
      console.log(`   → Bruger sæt: ${set.name} (id:${set.id}, cards:${set.cards_total})`)
      await probe(`Lorcana KORTDATA (sæt ${set.id})`, `${BASE}/lorcana/episodes/${set.id}/cards`)
    }
  }

  // ── One Piece — søger på tværs af sider ───────────────────
  let opSet = null
  for (let page = 1; page <= 5 && !opSet; page++) {
    const r = await probe(`One Piece sæt side ${page}`, `${BASE}/one-piece/episodes?page=${page}`)
    if (!r) break
    opSet = firstWithCards(r)
    if ((r.data || []).length === 0) break
  }
  if (opSet) {
    console.log(`   → Bruger sæt: ${opSet.name} (id:${opSet.id}, cards:${opSet.cards_total})`)
    await probe(`One Piece KORTDATA (sæt ${opSet.id})`, `${BASE}/one-piece/episodes/${opSet.id}/cards`)
  }

  // ── Dragon Ball Super ─────────────────────────────────────
  const dbsSlugs = ['dragon-ball-super', 'dragonball', 'dragon-ball']
  for (const slug of dbsSlugs) {
    const r = await probe(`Dragon Ball Super (slug: ${slug})`, `${BASE}/${slug}/episodes?limit=2`)
    if (r) break
  }

  // ── Pokemon Japan ─────────────────────────────────────────
  // CM har JP-kort under Pokemon med sprog-filter — tester om de er separat tilgængelige
  const jpSlugs = ['pokemon-japan', 'pokemon-japanese', 'pokemon-jp']
  for (const slug of jpSlugs) {
    const r = await probe(`Pokemon Japan (slug: ${slug})`, `${BASE}/${slug}/episodes?limit=2`)
    if (r) { console.log('   ✅ Pokemon Japan slug virker!'); break }
  }

  // ── Pokemon EN (validering + JP-filter test) ──────────────
  await probe('Pokemon episodes (alle)', `${BASE}/pokemon/episodes?limit=3`)
  await probe('Pokemon episodes (language=ja filter test)', `${BASE}/pokemon/episodes?language=ja&limit=2`)

  // ── Lorcana ældre sæt med priser ─────────────────────────
  // Sæt 414 er nyt (maj 2026) — prøv sæt 5 (Into the Inklands el. lign.)
  await probe('Lorcana kort fra sæt 5 (ældre, forventer priser)', `${BASE}/lorcana/episodes/5/cards?per_page=3`)

  // ── Pokemon EN kortdata ───────────────────────────────────
  // Sæt 413 = Chaos Rising, cards_total=122
  await probe('Pokemon EN kort fra sæt 413 (Chaos Rising)', `${BASE}/pokemon/episodes/413/cards?per_page=3`)

  // ── One Piece kortdata — test selv om cards_total=0 ───────
  // Sæt 366 = Emperors in the New World (OP09), set-total EUR 9014
  await probe('One Piece kort fra sæt 366 (OP09)', `${BASE}/one-piece/episodes/366/cards?per_page=3`)

  console.log(`\n${'═'.repeat(60)}`)
  console.log('✅ Test færdig.')
  console.log('   Del outputtet så vi kan verificere feltnavn-mapping og JP-support.')
}

run().catch(err => { console.error(err); process.exit(1) })
