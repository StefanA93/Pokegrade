export const config = { runtime: 'edge' }

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const PTCG_API_KEY = process.env.PTCG_API_KEY || process.env.TCG_API_KEY

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
  const { frontImage, backImage, numberImage } = body

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
  const messageContent = [
    { type: 'text', text: prompt },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frontImage.replace(/^data:image\/\w+;base64,/, '') } },
  ]
  if (numberImage && isValidImage(numberImage)) {
    messageContent.push({ type: 'text', text: 'ENLARGED card number area (bottom of card) — read the card number from this zoomed image:' })
    messageContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: numberImage.replace(/^data:image\/\w+;base64,/, '') } })
  }
  if (backImage) {
    messageContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: backImage.replace(/^data:image\/\w+;base64,/, '') } })
  }
  const messages = [{ role: 'user', content: messageContent }]

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
        model: 'claude-sonnet-4-5',
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

        function applyHit(row, strategy) {
          catalogId = row.id
          officialImageUrl = row.image_url
          catalogPriceEur = row.price_eur
          catalogCardmarketUrl = row.cardmarket_url
          debugInfo.catalogHit = true
          debugInfo.source = strategy || 'supabase'
        }

        const nums = numVariants(cardNumber)
        const setTotal = cardNumber?.includes('/') ? cardNumber.split('/')[1]?.trim() : null
        const gameFilter = `game=eq.${encodeURIComponent(game)}`
        const nameFilter = `name=ilike.${encodeURIComponent(cardName)}`

        // Map AI finish → pokemontcg.io rarity query term
        const finishRarityQuery = {
          'Special Illustration Rare': 'rarity:"Special Illustration Rare"',
          'Illustration Rare':         'rarity:"Illustration Rare"',
          'Hyper Rare':                'rarity:"Rare Rainbow"',
          'Secret Rare':               'rarity:"Rare Secret"',
          'Gold Secret Rare':          'rarity:"Rare Secret"',
          'Full Art':                  'rarity:"Rare Ultra"',
          'Holo Rare':                 'rarity:"Rare Holo"',
          'Shiny Rare':                'rarity:"Shiny Rare"',
          'Amazing Rare':              'rarity:"Amazing Rare"',
          'Radiant Rare':              'rarity:"Radiant Rare"',
          'Prism Star':                'rarity:"Rare Prism"',
          'Normal':                    'rarity:"Common"',
          'Reverse Holo':              'rarity:"Common" OR rarity:"Uncommon" OR rarity:"Rare"',
        }
        const parsedFinish = parsed.finish || null
        const rarityQuery = finishRarityQuery[parsedFinish] || null

        // Strategy 0 (Pokémon only): pokemontcg.io live lookup with multi-result best-pick
        if (game === 'pokemon' && cardName) {
          const ptcgHeaders = PTCG_API_KEY ? { 'X-Api-Key': PTCG_API_KEY } : {}

          // Sanitise AI set name: null it if AI returned a description instead of a real set name
          const BAD_SET_PATTERNS = /unknown|illegible|cannot|unreadable|unclear|not visible|blurry|n\/a/i
          const cleanSet = (setName && !BAD_SET_PATTERNS.test(setName)) ? setName : null
          // Strip parenthetical suffixes like "(SV)", "(swsh)" etc.
          const normaliseSet = s => s ? s.replace(/\s*\(.*?\)\s*/g, '').trim() : s
          const normSet = normaliseSet(cleanSet)

          // Generic series names that do NOT correspond to specific sets
          const SERIES_NAMES = new Set([
            'Scarlet & Violet', 'Sword & Shield', 'Sun & Moon', 'XY',
            'Black & White', 'HeartGold & SoulSilver', 'HeartGold SoulSilver',
            'Diamond & Pearl', 'EX Series', 'EX', 'Neo', 'Base Set Series',
          ])
          // Map series → base set ID
          const SERIES_TO_BASE = {
            'Scarlet & Violet': 'sv1', 'Sword & Shield': 'swsh1',
            'Sun & Moon': 'sm1', 'XY': 'xy1', 'Black & White': 'bw1',
            'HeartGold SoulSilver': 'hgss1', 'HeartGold & SoulSilver': 'hgss1',
            'Diamond & Pearl': 'dp1',
          }

          debugInfo.hasApiKey = !!PTCG_API_KEY

          const queryPtcg = async (q, size = 10) => {
            const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&orderBy=-set.releaseDate&pageSize=${size}&select=id,images,cardmarket,set,rarity,number`
            const r = await fetch(url, { headers: ptcgHeaders })
            if (!r.ok) { debugInfo.ptcgStatus = r.status; return [] }
            const d = await r.json()
            return d.data || []
          }

          // Pick best card from a list of candidates
          const pickBest = (cards, targetRarityStr, targetNums) => {
            if (!cards.length) return null
            // English-only list (Japanese set IDs typically start with r, j, or have jp/ko suffix)
            const englishCards = cards.filter(c => {
              const sid = c.set?.id || ''
              return !sid.startsWith('rsv') && !sid.startsWith('svsv') && c.set?.series !== 'Japanese'
            })
            const pool = englishCards.length ? englishCards : cards

            // 1. Number + rarity exact match
            if (targetNums?.length && targetRarityStr) {
              for (const num of targetNums) {
                const m = pool.find(c => c.number === num && c.rarity?.toLowerCase().includes(targetRarityStr.toLowerCase().split(' ')[0]))
                if (m) return m
              }
            }
            // 2. Exact number match (any rarity)
            if (targetNums?.length) {
              for (const num of targetNums) {
                const m = pool.find(c => c.number === num)
                if (m) return m
              }
            }
            // 3. Rarity match — newest English card with matching rarity
            if (targetRarityStr) {
              const keyword = targetRarityStr.toLowerCase().split(' ')[0]
              const m = pool.find(c => c.rarity?.toLowerCase().includes(keyword))
              if (m) return m
            }
            // 4. Newest English card — but NOT for premium finishes with a known number
            // (returning wrong card is worse than returning null for SIR/Secret/IR etc.)
            const isPremiumFinish = targetRarityStr &&
              /special|illustration|hyper|secret|rainbow|ultra|shiny|amazing|radiant|prism/i.test(targetRarityStr)
            if (targetNums?.length && isPremiumFinish) return null
            return pool[0]
          }

          const ptcgRarityStr = parsedFinish ? finishToRarity(parsedFinish) : null

          try {
            let candidates = []

            // Pass 1: name + specific set name (skip if it's a generic series name)
            if (normSet && !SERIES_NAMES.has(normSet)) {
              candidates = await queryPtcg(`name:"${cardName}" set.name:"${normSet}"`)
              debugInfo.ptcgQ = `name+set`
            }

            // Pass 2: series name → base set ID (e.g. "Scarlet & Violet (SV)" → sv1)
            if (!candidates.length && SERIES_TO_BASE[normSet]) {
              candidates = await queryPtcg(`name:"${cardName}" set.id:${SERIES_TO_BASE[normSet]}`)
              debugInfo.ptcgQ = `name+setId`
            }

            // Pass 3: promo sets (Promo finish or "Promo" in set name)
            if (!candidates.length && parsedFinish === 'Promo') {
              candidates = await queryPtcg(`name:"${cardName}" supertype:Pokémon`)
              debugInfo.ptcgQ = `promo`
            }

            // Pass 3b: name + card number — finds SIRs/Secrets that may not appear in top-10 name-only
            if (!candidates.length && cardNumber) {
              const mainNum = cardNumber.split('/')[0].trim().replace(/^0+(?=\d)/, '')
              candidates = await queryPtcg(`name:"${cardName}" number:${mainNum}`, 5)
              debugInfo.ptcgQ = `name+number`
            }

            // Pass 3c: name + rarity — for premium finishes with wrong/missing number
            if (!candidates.length && parsedFinish && finishRarityQuery[parsedFinish]) {
              candidates = await queryPtcg(`name:"${cardName}" ${finishRarityQuery[parsedFinish]}`)
              debugInfo.ptcgQ = `name+rarity`
            }

            // Pass 4: name only — top 10 newest, pick by rarity/number
            if (!candidates.length) {
              candidates = await queryPtcg(`name:"${cardName}"`)
              debugInfo.ptcgQ = `name-only`
            }

            // Pass 5: partial name (no quotes) — catches "Gothitelle ex", promos
            if (!candidates.length) {
              candidates = await queryPtcg(`name:${cardName.replace(/["\s]/g, '*')}`)
              debugInfo.ptcgQ = `name-partial`
            }

            debugInfo.ptcgCount = candidates.length

            const best = pickBest(candidates, ptcgRarityStr, nums.length ? nums : null)
            if (best) {
              catalogId = best.id
              officialImageUrl = best.images?.large || best.images?.small || null
              catalogPriceEur = best.cardmarket?.prices?.averageSellPrice || null
              catalogCardmarketUrl = best.cardmarket?.url || null
              debugInfo.catalogHit = true
              debugInfo.source = 'ptcg'
            }
          } catch (ptcgErr) {
            debugInfo.ptcgError = ptcgErr.message
          }
        }

        // Strategy 1: number + set name in catalog (URL-safe: encode & as %26)
        if (!catalogId && nums.length && setName) {
          for (const num of nums) {
            if (catalogId) break
            const safeSet = encodeURIComponent(`*${setName}*`)
            const rows = await tryFetch(
              `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&number=eq.${encodeURIComponent(num)}&set_name=ilike.${safeSet}&select=${fields}&limit=1`
            )
            if (rows[0]) applyHit(rows[0], 's1')
          }
        }

        // Strategy 2: number + set total to disambiguate same-number cards across sets
        if (!catalogId && nums.length && setTotal) {
          for (const num of nums) {
            if (catalogId) break
            const rows = await tryFetch(
              `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&number=eq.${encodeURIComponent(num)}&select=${fields}&order=updated_at.desc&limit=10`
            )
            const match = (rows || []).find(r => r.set_id && r.image_url)
            if (match) applyHit(match, 's2')
          }
        }

        const finish = parsed.finish || null
        const rarity = finishToRarity(finish)
        const rarityFilter = rarity ? `&rarity=ilike.${encodeURIComponent(`*${rarity}*`)}` : ''

        // Strategy 3: name + set + rarity
        if (!catalogId && setName) {
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&set_name=ilike.${encodeURIComponent(`*${setName}*`)}${rarityFilter}&select=${fields}&limit=1`
          )
          if (rows[0]) applyHit(rows[0], 's3')
        }

        // Strategy 3b: name + set without rarity (looser)
        if (!catalogId && setName) {
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&set_name=ilike.${encodeURIComponent(`*${setName}*`)}&select=${fields}&limit=1`
          )
          if (rows[0]) applyHit(rows[0], 's3b')
        }

        // Strategy 4: name + rarity (most reliable fallback for SIR/IR/etc.)
        if (!catalogId && rarity) {
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}${rarityFilter}&select=${fields}&order=price_eur.desc.nullslast&limit=1`
          )
          if (rows[0]) applyHit(rows[0], 's4')
        }

        // Strategy 5: name only — newest set first (id desc sorts sv > swsh > neo > base alphabetically)
        if (!catalogId) {
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&select=${fields}&order=id.desc&limit=1`
          )
          if (rows[0]) applyHit(rows[0], 's5')
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

CARD NUMBER — CRITICAL: The second image is an enlarged crop of the bottom of the card — use it to read the number (e.g. "045/165" or "215/197"). Secret/Special Rares have numbers ABOVE set total. Return null ONLY if completely unreadable even in the enlarged view.

SET NAME — CRITICAL: Read the SPECIFIC set name from the copyright line at the very bottom of the card (e.g. "Obsidian Flames", "Paradox Rift", "Paldean Fates", "Temporal Forces"). Do NOT return a series name like "Scarlet & Violet" — return the exact product name printed on the card.

FINISH — MUST always be identified from visual appearance (never return null for Pokémon):
- Full painted illustration bleeding to card edges, no standard frame = Special Illustration Rare or Illustration Rare
- Art extends to all edges with rainbow shimmer or gold border = Hyper Rare or Full Art
- Standard card frame with holofoil pattern in artwork area = Holo Rare
- Standard frame with foil on non-art areas only = Reverse Holo
- Standard frame, no foil anywhere = Normal
- Number clearly exceeds set total = Secret Rare or higher

The card is assumed Near Mint — estimate market value at NM prices.

Return ONLY valid JSON, no markdown, no extra text:
{
  "cardName": "<name exactly as printed on card>",
  "cardNumber": "<number e.g. 045/165 — null only if unreadable in BOTH images>",
  "setName": "<specific set name from copyright line e.g. Obsidian Flames, Paradox Rift, Paldean Fates — null if unreadable, NEVER a description of why it is unreadable>",
  "finish": "<one of: Normal | Holo Rare | Reverse Holo | Full Art | Secret Rare | Hyper Rare | Special Illustration Rare | Illustration Rare | Gold Secret Rare | Amazing Rare | Shiny Rare | Radiant Rare | Prism Star | 1st Edition | Shadowless | Promo — REQUIRED, never null for Pokémon>",
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
