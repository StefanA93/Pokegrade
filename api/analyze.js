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
  const { frontImage, backImage, numberImage, matchedCard } = body
  // matchedCard: pre-identified card from api/match.js (embedding search)
  // When provided, Claude only grades condition — no identification needed

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

  const useGradingOnly = !!(matchedCard?.id)
  const prompt = useGradingOnly
    ? buildGradingPrompt(game, matchedCard)
    : buildIdentifyPrompt(game, !!backImage)

  const messageContent = [
    { type: 'text', text: prompt },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frontImage.replace(/^data:image\/\w+;base64,/, '') } },
  ]
  if (!useGradingOnly && numberImage && isValidImage(numberImage)) {
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

  // Catalog data — either from pre-matched card (embedding search) or lookup below
  let officialImageUrl = matchedCard?.image_url || null
  let catalogId = matchedCard?.id || null
  let catalogPriceEur = matchedCard?.price_eur || null
  let catalogCardmarketUrl = matchedCard?.cardmarket_url || null
  let verifiedRarity = matchedCard?.rarity || null
  let verifiedSetName = matchedCard?.set_name || null
  let verifiedNumber = matchedCard?.number || null
  let debugInfo = { cardName: matchedCard?.name || null, catalogHit: !!matchedCard?.id, source: matchedCard?.id ? 'embedding' : null }

  if (useGradingOnly && matchedCard?.name) {
    debugInfo.cardName = matchedCard.name
  }

  if (!useGradingOnly) try {
    const raw = analysisText
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start !== -1 && end !== -1) {
      const parsed = JSON.parse(raw.slice(start, end + 1))
      const cardName = parsed.cardName || null
      const cardNumber = parsed.cardNumber || null
      const setName = parsed.setName || null
      const ability = parsed.ability || null
      const attacks = Array.isArray(parsed.attacks) ? parsed.attacks.filter(Boolean) : []
      const hp = parsed.hp ? String(parsed.hp) : null
      const setEra = parsed.setEra || null
      debugInfo.cardName = cardName
      debugInfo.ability = ability
      debugInfo.hp = hp
      debugInfo.setEra = setEra

      // Number-based finish override — card number in premium zone cannot be Holo/Normal
      // e.g. 191/197 = 97% → must be SIR/IR/Secret, not Holo Rare
      let parsedFinishOverride = null
      if (parsed.finish && cardNumber?.includes('/') && game === 'pokemon') {
        const parts = cardNumber.split('/')
        const num = parseInt(parts[0].replace(/\D/g, ''), 10)
        const total = parseInt(parts[1].replace(/\D/g, ''), 10)
        const NON_PREMIUM = ['Normal', 'Holo Rare', 'Reverse Holo', 'Common', 'Uncommon']
        if (!isNaN(num) && !isNaN(total) && total > 0 && NON_PREMIUM.includes(parsed.finish)) {
          const ratio = num / total
          if (ratio > 0.80) {
            parsedFinishOverride = 'Special Illustration Rare'
            debugInfo.finishOverride = `${parsed.finish}→SIR (${num}/${total}=${Math.round(ratio*100)}%)`
          } else if (num > total) {
            parsedFinishOverride = 'Secret Rare'
            debugInfo.finishOverride = `${parsed.finish}→Secret (${num}>${total})`
          }
        }
      }

      const CATALOG_GAMES = ['pokemon', 'mtg', 'yugioh']

      if (cardName && CATALOG_GAMES.includes(game)) {
        const catalogHeaders = {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        }
        const fields = 'id,image_url,cardmarket_url,price_eur,rarity,set_name,number'

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
          if (row.rarity) verifiedRarity = row.rarity
          if (row.set_name) verifiedSetName = row.set_name
          if (row.number) verifiedNumber = row.number
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
        const parsedFinish = parsedFinishOverride || parsed.finish || null
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

          const ERA_TO_SET_PREFIX = {
            'SV': 'sv', 'SWSH': 'swsh', 'SM': 'sm', 'XY': 'xy',
            'BW': 'bw', 'HGSS': 'hgss', 'DP': 'dp', 'EX': 'ex', 'NEO': 'neo'
          }

          const queryPtcg = async (q, size = 10) => {
            const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&orderBy=-set.releaseDate&pageSize=${size}&select=id,images,cardmarket,set,rarity,number,abilities,attacks,hp`
            const r = await fetch(url, { headers: ptcgHeaders })
            if (!r.ok) { debugInfo.ptcgStatus = r.status; return [] }
            const d = await r.json()
            return d.data || []
          }

          // Pick best card using multi-signal scoring: ability(0.40) + attacks(0.30) + hp(0.15) + number(0.10) + rarity(0.05)
          const pickBest = (cards, targetRarityStr, targetNums, targetSetName, targetAbility, targetAttacks, targetHp) => {
            if (!cards.length) return null
            const englishCards = cards.filter(c => {
              const sid = c.set?.id || ''
              return !sid.startsWith('rsv') && !sid.startsWith('svsv') && c.set?.series !== 'Japanese'
            })
            if (!englishCards.length) return null
            let pool = englishCards

            if (setEra && ERA_TO_SET_PREFIX[setEra] && pool.length > 1) {
              const eraMatch = pool.filter(c => (c.set?.id || '').startsWith(ERA_TO_SET_PREFIX[setEra]))
              if (eraMatch.length) pool = eraMatch
            }

            if (targetSetName && pool.length > 1) {
              const setMatch = pool.filter(c =>
                c.set?.name?.toLowerCase().includes(targetSetName.toLowerCase()) ||
                targetSetName.toLowerCase().includes(c.set?.name?.toLowerCase() || '')
              )
              if (setMatch.length) pool = setMatch
            }

            const hasSignals = !!(targetAbility || targetAttacks?.length || targetHp)
            if (hasSignals) {
              const scored = pool.map(c => {
                let score = 0
                if (targetAbility) {
                  const cardAbilities = (c.abilities || []).map(a => (a.name || '').toLowerCase())
                  if (cardAbilities.some(a => a.includes(targetAbility.toLowerCase()))) score += 0.40
                }
                if (targetAttacks?.length) {
                  const cardAttacks = (c.attacks || []).map(a => (a.name || '').toLowerCase())
                  const matched = targetAttacks.filter(atk => cardAttacks.some(ca => ca.includes(atk.toLowerCase()))).length
                  score += (matched / targetAttacks.length) * 0.30
                }
                if (targetHp && c.hp === targetHp) score += 0.15
                if (targetNums?.length && targetNums.includes(c.number)) score += 0.10
                if (targetRarityStr) {
                  const kw = targetRarityStr.toLowerCase().split(' ')[0]
                  if (c.rarity?.toLowerCase().includes(kw)) score += 0.05
                }
                return { card: c, score }
              })
              scored.sort((a, b) => b.score - a.score)
              if (scored[0].score > 0) {
                debugInfo.pickScore = Math.round(scored[0].score * 100)
                return scored[0].card
              }
            }

            if (targetNums?.length && targetRarityStr) {
              for (const num of targetNums) {
                const m = pool.find(c => c.number === num && c.rarity?.toLowerCase().includes(targetRarityStr.toLowerCase().split(' ')[0]))
                if (m) return m
              }
            }
            if (targetNums?.length) {
              for (const num of targetNums) {
                const m = pool.find(c => c.number === num)
                if (m) return m
              }
            }
            if (targetRarityStr) {
              const keyword = targetRarityStr.toLowerCase().split(' ')[0]
              const m = pool.find(c => c.rarity?.toLowerCase().includes(keyword))
              if (m) return m
            }
            const isPremiumFinish = targetRarityStr &&
              /special|illustration|hyper|secret|rainbow|ultra|shiny|amazing|radiant|prism/i.test(targetRarityStr)
            if (targetNums?.length && isPremiumFinish) return null
            return pool[0]
          }

          const ptcgRarityStr = parsedFinish ? finishToRarity(parsedFinish) : null

          try {
            let candidates = []

            // Pass 0a: ability name — most precise identifier (large printed text, not foil)
            if (ability) {
              candidates = await queryPtcg(`name:"${cardName}" abilities.name:"${ability.replace(/"/g, '')}"`)
              if (candidates.length) debugInfo.ptcgQ = `ability:${ability}`
            }

            // Pass 0b: first attack name
            if (!candidates.length && attacks.length > 0) {
              candidates = await queryPtcg(`name:"${cardName}" attacks.name:"${attacks[0].replace(/"/g, '')}"`)
              if (candidates.length) debugInfo.ptcgQ = `attack:${attacks[0]}`
            }

            // Pass 0c: card number — most precise variant identifier (SIRs, Secrets, promos)
            // Runs before HP so a specific number like "139" always beats the weaker hp signal
            if (!candidates.length && cardNumber) {
              const rawNum = cardNumber.split('/')[0].trim()
              const strippedNum = rawNum.replace(/^0+(?=\d)/, '')
              candidates = await queryPtcg(`name:"${cardName}" number:${rawNum}`, 5)
              if (!candidates.length && strippedNum !== rawNum) {
                candidates = await queryPtcg(`name:"${cardName}" number:${strippedNum}`, 5)
              }
              if (candidates.length) debugInfo.ptcgQ = `name+number`
            }

            // Pass 0d: HP — narrows to specific card version when number lookup missed
            if (!candidates.length && hp) {
              candidates = await queryPtcg(`name:"${cardName}" hp:${hp}`)
              if (candidates.length) debugInfo.ptcgQ = `name+hp:${hp}`
            }

            // Pass 1: name + specific set name (skip if it's a generic series name)
            if (!candidates.length && normSet && !SERIES_NAMES.has(normSet)) {
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

            const best = pickBest(candidates, ptcgRarityStr, nums.length ? nums : null, normSet, ability, attacks, hp)
            if (best) {
              catalogId = best.id
              officialImageUrl = best.images?.large || best.images?.small || null
              catalogPriceEur = best.cardmarket?.prices?.averageSellPrice || null
              catalogCardmarketUrl = best.cardmarket?.url || null
              debugInfo.catalogHit = true
              debugInfo.source = 'ptcg'
              verifiedRarity = best.rarity || null
              verifiedSetName = best.set?.name || null
              verifiedNumber = best.number || null
              debugInfo.verified = `${verifiedRarity} · ${verifiedSetName} · #${verifiedNumber}`
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

        // Strategy 5: name + rarity — correct finish, newest first
        if (!catalogId && rarity) {
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}${rarityFilter}&select=${fields}&order=id.desc&limit=1`
          )
          if (rows[0]) applyHit(rows[0], 's5')
        }

        // Strategy 5b: name only — only for non-premium finishes (avoids returning wrong common/uncommon card)
        const isPremiumFinish = parsedFinish &&
          /Special Illustration|Illustration Rare|Hyper Rare|Secret Rare|Gold Secret|Full Art|Shiny Rare|Amazing Rare|Radiant Rare|Prism Star/i.test(parsedFinish)
        if (!catalogId && !isPremiumFinish) {
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&select=${fields}&order=id.desc&limit=1`
          )
          if (rows[0]) applyHit(rows[0], 's5b')
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
    verifiedRarity: verifiedRarity || null,
    verifiedSetName: verifiedSetName || null,
    verifiedNumber: verifiedNumber || null,
    debugInfo,
  }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  })
}

function buildGradingPrompt(game, card) {
  const gameNames = { pokemon: 'Pokémon', mtg: 'Magic: The Gathering', yugioh: 'Yu-Gi-Oh!' }
  const gameName = gameNames[game] || game || 'TCG'
  const cardDesc = [card.name, card.rarity, card.set_name, card.number ? `#${card.number}` : null]
    .filter(Boolean).join(' — ')

  return `You are an expert ${gameName} card grader. The card shown is:
${cardDesc}

Your ONLY task is to assess the physical condition of this specific card.
Do NOT try to identify the card — it is already identified above.
Assume the card is Near Mint unless you observe specific defects.

Grade these four dimensions carefully:
- CENTERING: Measure how centered the card borders appear (left/right, top/bottom ratio)
- CORNERS: Look for fraying, bending, wear at each of the four corners
- EDGES: Inspect for chipping, roughness, whitening along card edges
- SURFACE: Check for scratches, print lines, indentations, haze, holofoil damage

Return ONLY valid JSON, no markdown, no extra text:
{
  "cardName": "${card.name}",
  "finish": "${card.rarity || 'Unknown'}",
  "confidence": "<High|Mid|Low>",
  "centering": "<precise centering observation>",
  "corners": "<corner condition>",
  "edges": "<edge condition>",
  "surface": "<surface condition>",
  "mainIssues": ["<specific defect if any>"],
  "worthGrading": <true|false>,
  "estimatedPSAValue": "<NM market value estimate in EUR>",
  "gradingFee": "~25€",
  "recommendation": "<short actionable recommendation in English>"
}`
}

function buildIdentifyPrompt(game, hasBack) {
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

SET NAME — CRITICAL: Read the SPECIFIC set name from the small text at the very bottom of the card (e.g. "Obsidian Flames", "Paradox Rift", "Paldean Fates", "Temporal Forces", "Twilight Masquerade").
- Do NOT return a series name like "Scarlet & Violet" — return the exact product set name.
- If the text is in Japanese characters, unreadable, or you are unsure — return null. NEVER guess a set name.
- Japanese-language cards: always return null for setName — do not guess an English equivalent.

FINISH — Identify using BOTH the card number AND visual appearance. Number is more reliable than visual on foil cards.

STEP 1 — NUMBER CHECK (most reliable, do this first):
- If card number X/Y where X ÷ Y > 0.80 (e.g. 191/197 = 97%) → card is in premium zone, cannot be Normal/Holo/Reverse Holo
- If X > Y entirely (e.g. 215/197) → definitely Secret/Special Rare

STEP 2 — VISUAL IDENTIFICATION (use these exact rules):
★ Special Illustration Rare (SIR): The illustration covers the ENTIRE card face from edge to edge. You CANNOT see a rectangular border around the artwork. The Pokémon name appears as small white/metallic text floating directly over the illustration. The card background bleeds to all four edges. Attack/ability boxes appear as translucent overlays on the art. Dark cosmic, galaxy, nature scenes with no card frame = SIR.
★ Illustration Rare (IR): Art extends significantly beyond the standard art box but the card name area at the TOP still has partial standard frame elements. The overall layout is "partially standard, partially extended art."
★ Hyper Rare: Entire card including text has rainbow gradient shimmer. Standard card frame still visible underneath the rainbow effect.
★ Gold Secret Rare: Gold-colored card border, number exceeds set total, metallic gold text.
★ Holo Rare: Standard rectangular art box is CLEARLY VISIBLE. Holofoil pattern appears ONLY inside the artwork rectangle. Card name, HP bar, and all text areas are in the standard non-holo layout. The border of the art box is always visible.
★ Reverse Holo: Standard card layout with a holofoil shimmer on the CARD BORDER and TEXT AREAS, but the artwork itself is flat/non-holo.
★ Normal / Common / Uncommon: No holofoil anywhere on the card.
★ Amazing Rare (AR): SWSH era only (Sword & Shield sets: Vivid Voltage, Fusion Strike, Brilliant Stars etc.). Rainbow/prismatic swirl fills the artwork area, NOT covering the text/HP areas. The card has a standard frame — art box border is visible. Different from Hyper Rare where the rainbow covers the entire card including text.
★ Promo: A physical "PROMO" stamp or special event logo is clearly printed on the card. Do NOT call Promo if no stamp is visible — it is more likely a Holo Rare or Normal card.

CRITICAL DISTINCTION — SIR vs Holo Rare:
- Holo Rare ALWAYS has a visible rectangular border around the artwork. You can see where the art box starts and ends.
- SIR NEVER has an art box border. The illustration is the entire card. If you see a dark/cosmic/artistic background with no visible art box rectangle = SIR, not Holo Rare.
- A card cannot be Holo Rare if its number is above 80% of the set total.

The card is assumed Near Mint — estimate market value at NM prices.

ABILITY & ATTACKS — Read these from the card body text (large, clear font — not foil). These are the most reliable identifiers.
- "Ability: [Name]" printed above the ability description box
- Attack names printed in bold before each attack's cost and damage
- HP number printed in the top-right corner of the card

Return ONLY valid JSON, no markdown, no extra text:
{
  "cardName": "<name exactly as printed on card>",
  "cardNumber": "<number e.g. 045/165 — null only if unreadable in BOTH images>",
  "setName": "<specific set name from copyright line e.g. Obsidian Flames, Paradox Rift, Paldean Fates — null if unreadable, NEVER a description of why it is unreadable>",
  "finish": "<one of: Normal | Holo Rare | Reverse Holo | Full Art | Secret Rare | Hyper Rare | Special Illustration Rare | Illustration Rare | Gold Secret Rare | Amazing Rare | Shiny Rare | Radiant Rare | Prism Star | 1st Edition | Shadowless | Promo — REQUIRED, never null for Pokémon>",
  "ability": "<ability name exactly as printed e.g. Distorted Future — null if card has no Ability>",
  "attacks": ["<attack 1 name>", "<attack 2 name>"],
  "hp": "<HP number only e.g. 150 — null if not a Pokémon>",
  "supertype": "<Basic|Stage 1|Stage 2|ex|V|VMAX|VSTAR|GX|EX|Trainer|Energy>",
  "setEra": "<SV|SWSH|SM|XY|BW|HGSS|DP|EX|NEO|BASE — era the card belongs to>",
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
