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

async function run() {
  console.log(`\n🔑 Key: ${KEY.slice(0, 10)}...`)
  console.log(`🌐 Host: ${HOST}\n`)

  // ── Lorcana ──────────────────────────────────────────────
  const lorSets = await probe('Lorcana sæt', `${BASE}/lorcana/episodes`)

  if (lorSets) {
    const sets   = Array.isArray(lorSets) ? lorSets : (lorSets.data || lorSets.episodes || [])
    const first  = sets[0]
    if (first) {
      const id = first.id || first.code || first.set_code
      await probe(`Lorcana kort fra sæt ${id}`, `${BASE}/lorcana/episodes/${id}/cards`)
    }
  }

  // ── One Piece ─────────────────────────────────────────────
  const opSets = await probe('One Piece sæt', `${BASE}/one-piece/episodes`)

  if (opSets) {
    const sets  = Array.isArray(opSets) ? opSets : (opSets.data || opSets.episodes || [])
    const first = sets[0]
    if (first) {
      const id = first.id || first.code || first.set_code
      await probe(`One Piece kort fra sæt ${id}`, `${BASE}/one-piece/episodes/${id}/cards`)
    }
  }

  // ── Validering: Pokémon virker ────────────────────────────
  await probe('Pokémon episodes (API-validering)', `${BASE}/pokemon/episodes?limit=2`)

  console.log(`\n${'═'.repeat(60)}`)
  console.log('✅ Test færdig.')
  console.log('   Del outputtet så vi kan verificere feltnavn-mapping i providers.')
}

run().catch(err => { console.error(err); process.exit(1) })
