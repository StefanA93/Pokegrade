/**
 * Erstatter TCGPlayer image-URLs for YuGiOh-kort med
 * ygoprodeck.com billeder (stabil gratis CDN, ingen rate limit).
 *
 * Matcher ved at hente kort per sæt fra ygoprodeck og sammenligne kortnummer.
 * Brug: node scripts/fix-yugioh-images.js
 */
import 'dotenv/config'
import { dbSelect, dbUpdate, dbCount } from '../server/middleware/db.js'

const BASE = 'https://db.ygoprodeck.com/api/v7'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function ygoprodFetch(url, attempt = 0) {
  const ctrl = new AbortController()
  const t    = setTimeout(() => ctrl.abort(), 30000)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    clearTimeout(t)
    if (r.status === 400) return null   // set not found
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  } catch (err) {
    clearTimeout(t)
    if (attempt < 2) { await sleep(3000 * (attempt + 1)); return ygoprodFetch(url, attempt + 1) }
    return null
  }
}

async function run() {
  // Hent alle unikke set_name-værdier fra vores YuGiOh catalog
  console.log('\n🔍 Henter YuGiOh sæt fra catalog…')
  const allRows = []
  for (let offset = 0; ; offset += 1000) {
    const batch = await dbSelect('card_catalog',
      `game=eq.yugioh&phash_art=is.null&image_url=not.is.null&select=set_name&limit=1000&offset=${offset}`)
    allRows.push(...batch)
    if (batch.length < 1000) break
  }
  const uniqueSets = [...new Set(allRows.map(r => r.set_name).filter(Boolean))]
    .map(name => [name, name])
  console.log(`   ${uniqueSets.length} unikke sæt i catalog (med kort der mangler phash)\n`)

  let totalUpdated = 0
  let totalSkipped = 0
  let setsProcessed = 0
  const total = uniqueSets.length

  for (const [, setName] of uniqueSets) {
    // Prøv sæt-navne-varianter mod ygoprodeck
    // 1. Nøjagtigt navn, 2. Strip parenteser som "(2020 Date Reprint)", 3. Afkort ved " -"
    const namesToTry = [
      setName,
      setName.replace(/\s*\([^)]*\)\s*$/, '').trim(),            // fjern trailing (...)
      setName.replace(/\s*\([^)]*\)\s*/g, ' ').trim(),           // fjern alle (...)
      setName.split(' - ')[0].trim(),                             // afkort ved " - "
    ].filter((v, i, arr) => v && arr.indexOf(v) === i)           // unikke, ikke-tomme

    let data = null
    let matchedYgoName = null
    for (const name of namesToTry) {
      data = await ygoprodFetch(`${BASE}/cardinfo.php?cardset=${encodeURIComponent(name)}`)
      if (data?.data?.length) { matchedYgoName = name; break }
      await sleep(200)
    }

    if (!data?.data?.length) {
      setsProcessed++
      process.stdout.write(`\r  [${setsProcessed}/${total}] "${setName.slice(0, 28)}" → ikke fundet | opdateret: ${totalUpdated}`)
      await sleep(200)
      continue
    }

    // Byg map: kortnummer → ygoprodeck image URL
    // Bruger det matchede ygoprodeck sætnavn (matchedYgoName), ikke vores DB-navn
    const numToImage = new Map()
    for (const c of data.data) {
      const img = c.card_images?.[0]?.image_url
      if (!img) continue
      for (const setEntry of c.card_sets || []) {
        if (setEntry.set_name?.toLowerCase() === matchedYgoName.toLowerCase()) {
          const setCode = setEntry.set_code?.toLowerCase()
          if (setCode) {
            numToImage.set(setCode, img)
            numToImage.set(setCode.replace(/-/g, ''), img)
          }
        }
      }
    }

    if (!numToImage.size) { setsProcessed++; continue }

    // Hent vores catalog-kort for dette sæt (kun dem der mangler phash)
    const catalogCards = await dbSelect('card_catalog',
      `game=eq.yugioh&set_name=eq.${encodeURIComponent(setName)}&phash_art=is.null&select=id,number,image_url`)

    for (const card of catalogCards) {
      if (!card.image_url?.includes('tcgplayer.com')) { totalSkipped++; continue }
      if (!card.number) continue

      const numKey   = card.number.toLowerCase()
      const numKey2  = numKey.replace(/-/g, '')
      const ygoUrl   = numToImage.get(numKey) || numToImage.get(numKey2)
      if (!ygoUrl) continue

      await dbUpdate('card_catalog', { id: card.id }, { image_url: ygoUrl })
      totalUpdated++
    }

    setsProcessed++
    process.stdout.write(`\r  [${setsProcessed}/${total}] "${setName.slice(0, 25)}" | opdateret: ${totalUpdated}`)
    await sleep(200)
  }

  const broken = await dbCount('card_catalog', `game=eq.yugioh&phash_art=is.null&image_url=not.is.null`)
  console.log(`\n\n✅ Færdig!`)
  console.log(`   Image URLs opdateret: ${totalUpdated}`)
  console.log(`   Stadig uden phash:    ${broken}`)
  console.log(`\n➡  Kør nu: node scripts/backfill-artwork-phash.js yugioh`)
}

run().catch(err => { console.error(err); process.exit(1) })
