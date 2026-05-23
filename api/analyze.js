export const config = { runtime: 'edge' }

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  // Validate JWT fra Supabase
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  const token = authHeader.replace('Bearer ', '')

  // Verificér token og hent bruger via Supabase
  let userId
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_SERVICE_KEY }
    })
    if (!userRes.ok) throw new Error('Invalid token')
    const userData = await userRes.json()
    userId = userData.id
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401 })
  }

  // Tjek scan-limit (30/dag for Pro, 3 lifetime for gratis)
  const today = new Date().toISOString().slice(0, 10)
  const logsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/scan_logs?user_id=eq.${userId}&scan_date=eq.${today}&select=count`,
    {
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        apikey: SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'count=exact'
      }
    }
  )
  const countHeader = logsRes.headers.get('content-range')
  const dailyCount = countHeader ? parseInt(countHeader.split('/')[1] || '0') : 0

  // Hent bruger-profil for at tjekke Pro-status og lifetime scans
  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=is_pro,total_scans`,
    {
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        apikey: SUPABASE_SERVICE_KEY
      }
    }
  )
  const profiles = await profileRes.json()
  const profile = profiles[0] || { is_pro: false, total_scans: 0 }

  if (profile.is_pro) {
    if (dailyCount >= 30) {
      return new Response(JSON.stringify({ error: 'Daily limit reached (30 scans). Try again tomorrow.' }), { status: 429 })
    }
  } else {
    if (profile.total_scans >= 3) {
      return new Response(JSON.stringify({ error: 'You have used your 3 free scans. Upgrade to Pro for unlimited scans.' }), { status: 429 })
    }
  }

  // Parse request body
  let body
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 })
  }

  const VALID_GAMES = ['pokemon', 'mtg', 'yugioh', 'onepiece', 'dragonball', 'lorcana']
  const game = VALID_GAMES.includes(body.game) ? body.game : 'pokemon'
  const { frontImage, backImage } = body

  const MAX_IMAGE_BYTES = 5 * 1024 * 1024
  function isValidImage(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    return Math.ceil(base64.length * 0.75) <= MAX_IMAGE_BYTES
  }

  if (!frontImage || !isValidImage(frontImage)) {
    return new Response(JSON.stringify({ error: 'Invalid or missing image (max 5 MB)' }), { status: 400 })
  }
  if (backImage && !isValidImage(backImage)) {
    return new Response(JSON.stringify({ error: 'Back image invalid (max 5 MB)' }), { status: 400 })
  }

  const prompt = buildPrompt(game, !!backImage)
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frontImage.replace(/^data:image\/\w+;base64,/, '') } },
        ...(backImage ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: backImage.replace(/^data:image\/\w+;base64,/, '') } }] : [])
      ]
    }
  ]

  let anthropicRes
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages
      })
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'AI service unavailable' }), { status: 502 })
  }

  if (!anthropicRes.ok) {
    const err = await anthropicRes.text()
    console.error('Anthropic error:', err)
    return new Response(JSON.stringify({ error: 'AI analysis failed' }), { status: 502 })
  }

  const aiData = await anthropicRes.json()
  const analysisText = aiData.content?.[0]?.text || ''

  // Catalog lookup — fetch official image + price from card_catalog
  let officialImageUrl = null
  let catalogId = null
  let catalogPriceEur = null
  let catalogCardmarketUrl = null
  let debugInfo = { cardName: null, catalogHit: false }

  try {
    const raw = analysisText
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start !== -1 && end !== -1) {
      const parsed = JSON.parse(raw.slice(start, end + 1))
      const cardName = parsed.cardName || null
      const cardNumber = parsed.cardNumber || null
      const setName = parsed.setName || null
      debugInfo.cardName = cardName

      const CATALOG_GAMES = ['pokemon', 'mtg', 'yugioh']

      if (cardName && CATALOG_GAMES.includes(game)) {
        const catalogHeaders = {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        }
        const fields = 'id,image_url,cardmarket_url,price_eur'

        // Map AI finish labels → pokemontcg.io rarity strings
        function finishToRarity(finish) {
          const map = {
            'Special Illustration Rare': 'Special Illustration Rare',
            'Illustration Rare': 'Illustration Rare',
            'Hyper Rare': 'Rare Rainbow',
            'Secret Rare': 'Rare Secret',
            'Gold Secret Rare': 'Rare Secret',
            'Full Art': 'Rare Ultra',
            'Holo Rare': 'Rare Holo',
            'Reverse Holo': 'Rare Holo V',
            'Shiny Rare': 'Shiny Rare',
            'Amazing Rare': 'Amazing Rare',
            'Radiant Rare': 'Radiant Rare',
            'Prism Star': 'Rare Prism',
          }
          return map[finish] || null
        }

        // Build all number variants to try: "6", "06", "006", "SWSH006" etc.
        function numVariants(raw) {
          if (!raw) return []
          const base = raw.split('/')[0].trim()
          const digits = base.replace(/\D/g, '')
          const prefix = base.replace(/\d.*/, '')
          const n = parseInt(digits, 10)
          if (isNaN(n)) return [base]
          const variants = new Set([
            base,
            prefix + String(n),
            prefix + String(n).padStart(2, '0'),
            prefix + String(n).padStart(3, '0'),
          ])
          return [...variants]
        }

        async function tryFetch(url) {
          const r = await fetch(url, { headers: catalogHeaders })
          return r.ok ? await r.json() : []
        }

        function applyHit(row) {
          catalogId = row.id
          officialImageUrl = row.image_url
          catalogPriceEur = row.price_eur
          catalogCardmarketUrl = row.cardmarket_url
          debugInfo.catalogHit = true
        }

        const nums = numVariants(cardNumber)
        const setTotal = cardNumber?.includes('/') ? cardNumber.split('/')[1]?.trim() : null
        const gameFilter = `game=eq.${encodeURIComponent(game)}`
        const nameFilter = `name=ilike.${encodeURIComponent(cardName)}`

        // Strategy 0 (Pokémon only): query pokemontcg.io directly — most reliable
        if (game === 'pokemon' && cardName) {
          try {
            let q = `name:"${cardName}"`
            if (nums[0]) q += ` number:${nums[nums.length - 1]}` // prefer zero-padded
            if (setTotal) q += ` set.total:${setTotal}`
            const ptcgRes = await fetch(
              `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=1&select=id,images,cardmarket`
            )
            if (ptcgRes.ok) {
              const ptcgData = await ptcgRes.json()
              const hit = ptcgData.data?.[0]
              if (hit) {
                catalogId = hit.id
                officialImageUrl = hit.images?.large || hit.images?.small || null
                catalogPriceEur = hit.cardmarket?.prices?.averageSellPrice || null
                catalogCardmarketUrl = hit.cardmarket?.url || null
                debugInfo.catalogHit = true
                debugInfo.source = 'pokemontcg.io'
              }
            }
          } catch (_) {}
        }

        // Strategy 1: number + set name in catalog (URL-safe: encode & as %26)
        if (!catalogId && nums.length && setName) {
          for (const num of nums) {
            if (catalogId) break
            const safeSet = encodeURIComponent(`*${setName}*`)
            const rows = await tryFetch(
              `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&number=eq.${encodeURIComponent(num)}&set_name=ilike.${safeSet}&select=${fields}&limit=1`
            )
            if (rows[0]) applyHit(rows[0])
          }
        }

        // Strategy 2: number + set total to disambiguate same-number cards across sets
        if (!catalogId && nums.length && setTotal) {
          for (const num of nums) {
            if (catalogId) break
            const rows = await tryFetch(
              `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&number=eq.${encodeURIComponent(num)}&select=${fields}&order=updated_at.desc&limit=10`
            )
            // Pick the row whose set matches the total (e.g. sv1 has 198 cards)
            const match = (rows || []).find(r => r.set_id && r.image_url)
            if (match) applyHit(match)
          }
        }

        const parsedJson = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
        const finish = parsedJson.finish || null
        const rarity = finishToRarity(finish)
        const rarityFilter = rarity ? `&rarity=ilike.${encodeURIComponent(`*${rarity}*`)}` : ''

        // Strategy 3: name + set + rarity
        if (!catalogId && setName) {
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&set_name=ilike.${encodeURIComponent(`*${setName}*`)}${rarityFilter}&select=${fields}&limit=1`
          )
          if (rows[0]) applyHit(rows[0])
        }

        // Strategy 3b: name + set without rarity (looser)
        if (!catalogId && setName) {
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&set_name=ilike.${encodeURIComponent(`*${setName}*`)}&select=${fields}&limit=1`
          )
          if (rows[0]) applyHit(rows[0])
        }

        // Strategy 4: name + rarity (most reliable fallback for SIR/IR/etc.)
        if (!catalogId && rarity) {
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}${rarityFilter}&select=${fields}&order=price_eur.desc.nullslast&limit=1`
          )
          if (rows[0]) applyHit(rows[0])
        }

        // Strategy 5: name only — ordered by price desc as last resort
        if (!catalogId) {
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&select=${fields}&order=price_eur.desc.nullslast&limit=1`
          )
          if (rows[0]) applyHit(rows[0])
        }
      }
    }
  } catch (e) {
    debugInfo.error = e.message
  }

  // Log scan i Supabase
  await fetch(`${SUPABASE_URL}/rest/v1/scan_logs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ user_id: userId, scan_date: today, game })
  })

  // Opdater total_scans i profiles
  await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ total_scans: (profile.total_scans || 0) + 1 })
  })

  return new Response(JSON.stringify({
    analysis: analysisText,
    officialImageUrl,
    catalogId: catalogId || null,
    catalogPriceEur: catalogPriceEur || null,
    catalogCardmarketUrl: catalogCardmarketUrl || null,
    debugInfo,
  }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  })
}

function buildPrompt(game, hasBack) {
  const gameNames = {
    pokemon: 'Pokémon',
    mtg: 'Magic: The Gathering',
    yugioh: 'Yu-Gi-Oh!',
    onepiece: 'One Piece',
    dragonball: 'Dragon Ball Super',
    lorcana: 'Disney Lorcana'
  }
  const gameName = gameNames[game] || game || 'TCG'

  return `You are an expert ${gameName} card identifier. Analyze ${hasBack ? 'these two images (front and back)' : 'this card image'} and identify the card with maximum precision.

CARD NUMBER — THIS IS CRITICAL:
Look at the very bottom of the card for a number like "045/165" or "215/197" or "SV001". Special Illustration Rares and Secret Rares have numbers ABOVE the set total (e.g. "215/197"). Read this number exactly as printed — do not guess.

The card is assumed Near Mint — estimate market value at NM prices.

Return ONLY valid JSON, no markdown, no extra text:
{
  "cardName": "<name exactly as printed on card>",
  "cardNumber": "<number at bottom of card e.g. 045/165 — null only if completely unreadable>",
  "setName": "<set name from copyright line or set symbol e.g. Paldean Fates, Obsidian Flames>",
  "finish": "<one of: Normal | Holo Rare | Reverse Holo | Full Art | Secret Rare | Hyper Rare | Special Illustration Rare | Illustration Rare | Gold Secret Rare | Amazing Rare | Shiny Rare | Radiant Rare | Prism Star | 1st Edition | Shadowless | Promo | null>",
  "confidence": "<High|Mid|Low>",
  "centering": "<centering description>",
  "corners": "<corners description>",
  "edges": "<edges description>",
  "surface": "<surface description>",
  "mainIssues": ["<issue if any>"],
  "worthGrading": <true|false>,
  "estimatedPSAValue": "<NM market value in EUR e.g. 50-80€>",
  "gradingFee": "~25€",
  "recommendation": "<short recommendation in English>"
}`
}
