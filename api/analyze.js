export const config = { runtime: 'edge' }

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const PTCG_API_KEY = process.env.PTCG_API_KEY || process.env.TCG_API_KEY

export default async function handler(req) {
  try {
    return await _handler(req)
  } catch (fatal) {
    return new Response(JSON.stringify({ error: 'Internal error', detail: fatal?.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })
  }
}

async function _handler(req) {
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

  // Tjek scan-limit (30/dag for Pro, 3 lifetime for gratis) — parallel for speed
  const today = new Date().toISOString().slice(0, 10)
  const [logsRes, profileRes] = await Promise.all([
    fetch(
      `${SUPABASE_URL}/rest/v1/scan_logs?user_id=eq.${userId}&scan_date=eq.${today}&select=count`,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          apikey: SUPABASE_SERVICE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'count=exact'
        }
      }
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=is_pro,total_scans`,
      {
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          apikey: SUPABASE_SERVICE_KEY
        }
      }
    )
  ])
  const countHeader = logsRes.headers.get('content-range')
  const dailyCount = countHeader ? parseInt(countHeader.split('/')[1] || '0') : 0
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
    const anthropicCtrl = new AbortController()
    const anthropicTimer = setTimeout(() => anthropicCtrl.abort(), 15000)
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
      }),
      signal: anthropicCtrl.signal
    })
    clearTimeout(anthropicTimer)
  } catch (e) {
    return new Response(JSON.stringify({ error: 'AI service slow or unavailable — please try again' }), { status: 502 })
  }

  if (!anthropicRes.ok) {
    const err = await anthropicRes.text()
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
  // Top-level AI finish — set once from parsed JSON, read at the end for safety override
  let _aiFinish = null
  // Hoisted AI fields — needed after the try block for set-name inference
  let _aiCardName = null
  let _aiHp = null
  let _aiAbility = null

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
      // Normalize denominators where AI folds a series prefix into the number
      // e.g. "100/XY123" → "100/123", "45/SV200" → "45/200"
      const cardNumber = parsed.cardNumber
        ? parsed.cardNumber.replace(/^(\d+)\/(XY|SV|SWSH|SM|BW|DP|HGSS)(\d+)$/i, '$1/$3')
        : null
      const setName = parsed.setName || null
      const ability = parsed.ability || null
      const attacks = Array.isArray(parsed.attacks) ? parsed.attacks.filter(Boolean) : []
      const hp = parsed.hp ? String(parsed.hp) : null
      const setEra = parsed.setEra || null
      _aiFinish = parsed.finish || null  // capture before any overrides, for safety net below
      _aiCardName = cardName
      _aiHp = hp
      _aiAbility = ability
      debugInfo.cardName = cardName
      debugInfo.ability = ability
      debugInfo.hp = hp
      debugInfo.setEra = setEra
      if (cardNumber && cardNumber !== parsed.cardNumber) debugInfo.numNorm = `${parsed.cardNumber}→${cardNumber}`

      // Number-based finish override
      let parsedFinishOverride = null
      if (game === 'pokemon') {
        // Promo detection: promo card numbers NEVER contain '/' (e.g. "SVP EN 113", "SWSH052")
        // Standard set cards always use X/Y format. No slash = promo.
        if (cardNumber && !cardNumber.includes('/') && cardNumber.trim().length > 1) {
          parsedFinishOverride = 'Promo'
          debugInfo.finishOverride = `promo-number:${cardNumber}`
        } else if (parsed.finish && cardNumber?.includes('/')) {
          const parts = cardNumber.split('/')
          const num = parseInt(parts[0].replace(/\D/g, ''), 10)
          const total = parseInt(parts[1].replace(/\D/g, ''), 10)
          const NON_PREMIUM = ['Normal', 'Holo Rare', 'Reverse Holo', 'Common', 'Uncommon']
          // Only override when number strictly EXCEEDS set total (genuine secret zone: X > Y).
          // Cards at 80-100% of total are WITHIN the set and can be IR, Ultra Rare or Double Rare
          // — do NOT auto-upgrade those to SIR, that was incorrect.
          if (!isNaN(num) && !isNaN(total) && total > 0 && num > total && NON_PREMIUM.includes(parsed.finish)) {
            parsedFinishOverride = 'Secret Rare'
            debugInfo.finishOverride = `${parsed.finish}→Secret (${num}>${total})`
          }
          // SIR requires number ABOVE set total (X > Y). If AI says SIR but X <= Y, it must be Ultra Rare.
          if (parsed.finish === 'Special Illustration Rare' && !isNaN(num) && !isNaN(total) && total > 0 && num <= total) {
            parsedFinishOverride = 'Ultra Rare'
            debugInfo.finishOverride = `SIR→Ultra Rare (${num}<=${total}, within set)`
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
            'Ultra Rare': 'Rare Ultra',
            'Full Art': 'Rare Ultra',
            'Double Rare': 'Rare Holo ex',
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
        // Exclude Japanese-only set IDs (rsv* = Japanese SV reprints) from Supabase lookups
        // Exclude Japanese SV reprint sets (rsv1, rsv2 … rsv99) from Supabase lookups.
        // rsv_ = 1-char suffix (rsv1–rsv9), rsv__ = 2-char suffix (rsv10–rsv99).
        // White Flare (rsv10pt5) is English and has a longer suffix — NOT excluded.
        const langFilter = game === 'pokemon' ? '&set_id=not.like.rsv_&set_id=not.like.rsv__' : ''

        // Map AI finish → pokemontcg.io rarity query term
        const finishRarityQuery = {
          'Special Illustration Rare': 'rarity:"Special Illustration Rare"',
          'Illustration Rare':         'rarity:"Illustration Rare"',
          'Hyper Rare':                'rarity:"Rare Rainbow"',
          'Secret Rare':               'rarity:"Rare Secret"',
          'Gold Secret Rare':          'rarity:"Rare Secret"',
          'Ultra Rare':                'rarity:"Rare Ultra"',
          'Full Art':                  'rarity:"Rare Ultra"',
          'Double Rare':               'rarity:"Rare Holo ex"',
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
          // Exact set name → pokemontcg.io set ID — enables direct set.id lookup (most precise)
          // IDs verified against pokemontcg.io API (printedTotal = Y in X/Y on physical card).
          const SET_NAME_TO_ID = {
            // Scarlet & Violet
            'Scarlet & Violet': 'sv1',   'Paldea Evolved': 'sv2',    'Obsidian Flames': 'sv3',
            'Scarlet & Violet 151': 'sv3pt5', '151': 'sv3pt5',
            'Paradox Rift': 'sv4',        'Paldean Fates': 'sv4pt5',
            'Temporal Forces': 'sv5',     'Twilight Masquerade': 'sv6',
            'Shrouded Fable': 'sv6pt5',   'Stellar Crown': 'sv7',
            'Surging Sparks': 'sv8',      'Prismatic Evolutions': 'sv8pt5',
            'Journey Together': 'sv9',    'Destined Rivals': 'sv10',
            'Black Bolt': 'zsv10pt5',     'White Flare': 'rsv10pt5',
            // Sword & Shield
            'Sword & Shield': 'swsh1',   'Rebel Clash': 'swsh2',    'Darkness Ablaze': 'swsh3',
            'Vivid Voltage': 'swsh4',    'Battle Styles': 'swsh5',   'Chilling Reign': 'swsh6',
            'Evolving Skies': 'swsh7',   'Fusion Strike': 'swsh8',   'Brilliant Stars': 'swsh9',
            'Astral Radiance': 'swsh10', 'Lost Origin': 'swsh11',    'Silver Tempest': 'swsh12',
            'Crown Zenith': 'swsh12pt5',
            // Sun & Moon (including common Claude aliases like "Sun & Moon Base Set")
            'Sun & Moon': 'sm1',         'Sun & Moon Base Set': 'sm1', 'Guardians Rising': 'sm2',  'Burning Shadows': 'sm3',
            'Shining Legends': 'sm3pt5', 'Crimson Invasion': 'sm4',  'Ultra Prism': 'sm5',
            'Forbidden Light': 'sm6',    'Celestial Storm': 'sm7',   'Dragon Majesty': 'sm7a',
            'Lost Thunder': 'sm8',       'Team Up': 'sm9',           'Unbroken Bonds': 'sm10',
            'Unified Minds': 'sm11',     'Cosmic Eclipse': 'sm12',
            // XY
            'XY': 'xy1',            'Flashfire': 'xy2',     'Furious Fists': 'xy3',
            'Phantom Forces': 'xy4','Primal Clash': 'xy5',  'Roaring Skies': 'xy6',
            'Ancient Origins': 'xy7','BREAKthrough': 'xy8', 'BREAKpoint': 'xy9',
            'Fates Collide': 'xy10','Steam Siege': 'xy11',  'Evolutions': 'xy12',
            // Mega Evolution era (SV 2025–2026)
            'Mega Evolution': 'me1',       // printedTotal 132
            'Phantasmal Flames': 'me2',    // printedTotal  94  (set code PFL EN)
            'Ascended Heroes': 'me2pt5',   // printedTotal 217
            'Perfect Order': 'me3',        // printedTotal  88
            'Chaos Rising': 'me4',         // printedTotal  86
          }

          debugInfo.hasApiKey = !!PTCG_API_KEY

          // pokemontcg.io stores XY Mega Pokémon as "M X-EX" (e.g. "M Venusaur-EX")
          // Claude may return "Mega Venusaur-EX" or "Mega Venusaur EX" — normalize both forms
          let ptcgCardName = cardName
          if (cardName && /^Mega\s+/i.test(cardName)) {
            ptcgCardName = cardName.replace(/^Mega\s+/i, 'M ')  // "Mega " → "M "
            ptcgCardName = ptcgCardName.replace(/\s+EX$/i, '-EX') // " EX" → "-EX" at end
          }
          if (ptcgCardName !== cardName) debugInfo.ptcgNameNorm = `${cardName}→${ptcgCardName}`
          // SV-era sets may store "M X-EX" as "M X ex" (abbreviated, lowercase suffix)
          const svExName = ptcgCardName.replace(/-EX$/i, ' ex')
          // SV-era Mega sets (e.g. me1) may store as "Mega X ex" (full "Mega" + lowercase ex)
          const megaSvExName = (cardName && /^Mega\s+/i.test(cardName))
            ? cardName.replace(/[\s-]+EX$/i, ' ex')  // "Mega Venusaur-EX" → "Mega Venusaur ex"
            : null

          const ERA_TO_SET_PREFIX = {
            'SV': 'sv', 'SWSH': 'swsh', 'SM': 'sm', 'XY': 'xy',
            'BW': 'bw', 'HGSS': 'hgss', 'DP': 'dp', 'EX': 'ex', 'NEO': 'neo'
          }

          const queryPtcg = async (q, size = 10) => {
            const url = `https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&orderBy=-set.releaseDate&pageSize=${size}&select=id,name,images,cardmarket,set,rarity,number,abilities,attacks,hp`
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), 3000)
            try {
              const r = await fetch(url, { headers: ptcgHeaders, signal: ctrl.signal })
              clearTimeout(timer)
              if (!r.ok) { debugInfo.ptcgStatus = r.status; return [] }
              const d = await r.json()
              return d.data || []
            } catch {
              clearTimeout(timer)
              return []
            }
          }

          // Pick best card using multi-signal scoring: ability(0.40) + attacks(0.30) + hp(0.15) + number(0.10) + rarity(0.05)
          const pickBest = (cards, targetRarityStr, targetNums, targetSetName, targetAbility, targetAttacks, targetHp) => {
            if (!cards.length) return null
            const englishCards = cards.filter(c => {
              const sid = c.set?.id || ''
              // Exclude Japanese SV reprint sets (rsv1–rsv99) but ALLOW rsv10pt5 (White Flare, English).
              // Japanese rsv IDs are rsv + 1–2 digits only. White Flare = rsv10pt5 (has 'pt5' suffix).
              return !/^rsv\d{1,2}$/.test(sid) && !sid.startsWith('svsv') && c.set?.series !== 'Japanese'
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

            // Cross-era rarity synonyms: pokemontcg.io uses different strings for same tier
            // across generations (e.g. "Rare Rainbow" in SWSH = "Hyper Rare" in SV).
            const RARITY_SYN = {
              'rare rainbow': ['rare rainbow', 'hyper rare'],
              'hyper rare': ['hyper rare', 'rare rainbow'],
              'rare ultra': ['rare ultra', 'ultra rare'],
              'ultra rare': ['ultra rare', 'rare ultra'],
              'rare secret': ['rare secret', 'secret rare'],
              'special illustration rare': ['special illustration rare'],
              'illustration rare': ['illustration rare'],
              'rare holo ex': ['rare holo ex', 'double rare'],
            }
            const raritySynonyms = targetRarityStr
              ? (RARITY_SYN[targetRarityStr.toLowerCase()] || [targetRarityStr.toLowerCase().split(' ')[0]])
              : []
            const rarityMatch = c => raritySynonyms.some(s => (c.rarity || '').toLowerCase().includes(s))

            if (targetNums?.length && targetRarityStr) {
              for (const num of targetNums) {
                const m = pool.find(c => c.number === num && rarityMatch(c))
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
              const m = pool.find(rarityMatch)
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

            // Pass 0_direct: exact set name → set.id lookup (most precise — skips fuzzy matching)
            // Only runs when AI returns a known specific set name (not a series name)
            const knownSetId = normSet ? SET_NAME_TO_ID[normSet] : null

            // Era-set consistency check: if the mapped set ID is SV-era but Claude reported
            // an older era (SM, XY, SWSH etc.), both the set name and number are hallucinated.
            // Primary case: White Flare (rsv10pt5) / Black Bolt (zsv10pt5) reprints —
            // Claude sees Deino, knows it from SM1, returns "Sun & Moon Base Set" + "93/149".
            const SV_ERA_PREFIXES = ['sv', 'rsv', 'zsv', 'me']
            const knownSetIsSV = knownSetId && SV_ERA_PREFIXES.some(p => knownSetId.startsWith(p))
            const eraIsNotSV = setEra && setEra !== 'SV'
            const eraSetConflict = knownSetIsSV && eraIsNotSV
            if (eraSetConflict) {
              debugInfo.eraConflict = `setId:${knownSetId}(SV) vs setEra:${setEra} → number hallucinated`
            }

            // Mega Pokémon HP cross-validation (pokemon only):
            // XY-era Mega cards top out at ~240 HP. If AI reads HP > 300 for a Mega Pokémon
            // but mapped to an XY-era set ID, it confused a Mega Evolution era set with "Evolutions"
            // (xy12, 2016). Override the set to me1 as the most likely Mega Evolution set.
            // The denominator cross-check below may further refine to me2/me3/me4 if applicable.
            let effectiveSetId = knownSetId
            let megaHpOverride = false
            if (
              knownSetId &&
              /^xy/.test(knownSetId) &&
              cardName &&
              /^(Mega|M )\s/i.test(cardName) &&
              parseInt(hp, 10) > 300
            ) {
              effectiveSetId = 'me1'
              megaHpOverride = true
              debugInfo.megaHpSetOverride = `${knownSetId}→me1 (HP${hp}>300, Mega card — denom check may refine)`
            }

            // Denominator uniqueness cross-check:
            // If Claude reads a denominator that UNIQUELY identifies set X, but the AI's
            // stated set name points to set Y (X≠Y), the card number was almost certainly
            // hallucinated on heavy foil. Flag it so number-based passes are skipped —
            // name + set.id is always more reliable than a hallucinated number.
            // printedTotal values verified via pokemontcg.io API.
            // Only include denominators that are globally unique across all English sets.
            // Shared denominators (182=sv4=sv10, 162=sv5=xy8, 159=sv9=swsh12pt5, etc.) are excluded.
            const UNIQUE_DENOM_TO_SET = {
              '165': 'sv3pt5',  // 151            — unique (no other EN set has 165 base)
              '193': 'sv2',     // Paldea Evolved  — unique
              '197': 'sv3',     // Obsidian Flames — unique
              '091': 'sv4pt5',  // Paldean Fates   — unique
              '167': 'sv6',     // Twilight Masquerade — unique
              '064': 'sv6pt5',  // Shrouded Fable  — unique in modern era
              '142': 'sv7',     // Stellar Crown   — unique
              '191': 'sv8',     // Surging Sparks  — unique
              '132': 'me1',     // Mega Evolution  — unique
              '094': 'me2',     // Phantasmal Flames (PFL) — unique in modern era
              '217': 'me2pt5',  // Ascended Heroes — unique
              '088': 'me3',     // Perfect Order   — unique
            }
            const _cardDenom = cardNumber?.split('/')?.[1]?.trim()?.replace(/\D/g, '')
            const _denomImpliedSet = _cardDenom ? UNIQUE_DENOM_TO_SET[_cardDenom] : null
            // numberSuspect: fires when denominator implies a different set than the AI's set name,
            // OR when Claude's reported era contradicts the SV-era set that the set name maps to
            // (e.g. Claude says "Sun & Moon Base Set" + era SM, but SET_NAME_TO_ID says rsv10pt5 = SV).
            const numberSuspect = !!(_denomImpliedSet && knownSetId && _denomImpliedSet !== knownSetId) || eraSetConflict
            if (numberSuspect) {
              // Denominator is harder to confabulate than a set name — use it to correct the wrong set
              if (_denomImpliedSet && knownSetId && _denomImpliedSet !== knownSetId) {
                debugInfo.numSuspect = `denom:${_cardDenom}→${_denomImpliedSet}≠${knownSetId} (foil hallucination — using denom set)`
                effectiveSetId = _denomImpliedSet
              }
            }
            // If set name unknown but denominator uniquely identifies a set, use that as the anchor
            if (!effectiveSetId && _denomImpliedSet) {
              effectiveSetId = _denomImpliedSet
              debugInfo.setIdFromDenom = `denom-only:${_cardDenom}→${_denomImpliedSet}`
            }

            if (effectiveSetId && ptcgCardName) {
              const rawNum = cardNumber?.split('/')?.[0]?.trim()
              const strippedNum = rawNum ? rawNum.replace(/^0+(?=\d)/, '') : null
              // set.id + number is a unique key — try WITHOUT name to bypass name-format issues
              // Skip when numberSuspect: denominator cross-check flagged the number as hallucinated.
              // Fall through to name+setId search which uses the more reliable set-name reading.
              if (rawNum && !numberSuspect) {
                candidates = await queryPtcg(`set.id:${effectiveSetId} number:${rawNum}`, 1)
                if (!candidates.length && strippedNum && strippedNum !== rawNum) {
                  candidates = await queryPtcg(`set.id:${effectiveSetId} number:${strippedNum}`, 1)
                }
                if (candidates.length) {
                  debugInfo.ptcgQ = `setId+number:${effectiveSetId}#${rawNum}`
                  // Discard if found card is a different Pokémon — AI may have misread the card number
                  // (e.g. sv3#003 = Charizard when AI is looking for Exeggutor). Without this check,
                  // the wrong card blocks all later ability/name passes from running.
                  const aiSpecies = ptcgCardName.toLowerCase()
                    .replace(/^(mega|m)\s+/i, '')
                    .replace(/[-\s]+(ex|gx|vmax|vstar|tera)(\s|$)/i, '')
                    .split(/[\s\-]/)[0]
                  if (aiSpecies.length >= 4) {
                    const foundCardName = (candidates[0]?.name || '').toLowerCase()
                    if (!foundCardName.includes(aiSpecies)) {
                      debugInfo.p0dMismatch = `${candidates[0]?.id}(${candidates[0]?.name})≠${aiSpecies}`
                      candidates = []
                    }
                  }
                  // HP mismatch check: if AI read a specific HP but found card has different HP,
                  // the number is likely hallucinated (reprint cards differ in HP from original).
                  // e.g. White Flare Deino has HP:80 but SM1 Deino #93 has HP:60.
                  if (candidates.length && hp && candidates[0]?.hp && candidates[0].hp !== hp) {
                    debugInfo.p0dHpMismatch = `${candidates[0].id}(HP${candidates[0].hp})≠AI(HP${hp}) → discarded`
                    candidates = []
                  }
                }
              }
              // Fallback: name + set.id (broader, name-dependent)
              if (!candidates.length) {
                candidates = await queryPtcg(`name:"${ptcgCardName}" set.id:${effectiveSetId}`, 10)
                if (candidates.length) debugInfo.ptcgQ = `name+setId:${effectiveSetId}`
              }

              // Pass 0_premium: HR / SIR / IR cards have numbers in the most unreadable foil zone.
              // When set is known, search directly by name + setId + exact rarity — skips the
              // unreliable number entirely and finds the right variant directly.
              // Tries both SV-era and SWSH-era rarity strings for the same tier.
              if (!candidates.length && parsedFinish) {
                const PREM_RARITY_MAP = {
                  'Hyper Rare':                  ['"Hyper Rare"', '"Rare Rainbow"'],
                  'Special Illustration Rare':   ['"Special Illustration Rare"'],
                  'Illustration Rare':           ['"Illustration Rare"'],
                  'Amazing Rare':                ['"Amazing Rare"'],
                  'Shiny Rare':                  ['"Shiny Rare"'],
                }
                const premRarities = PREM_RARITY_MAP[parsedFinish] || []
                for (const nameVariant of [ptcgCardName, svExName].filter((v, i, a) => v && a.indexOf(v) === i)) {
                  for (const r of premRarities) {
                    if (candidates.length) break
                    const hits = await queryPtcg(`name:"${nameVariant}" set.id:${effectiveSetId} rarity:${r}`, 3)
                    if (hits.length) {
                      candidates = hits
                      debugInfo.ptcgQ = `prem:${r.replace(/"/g, '')}+${effectiveSetId}`
                    }
                  }
                  if (candidates.length) break
                }
              }
            }

            // Helper: discard candidates that are all from a wrong era (when era is known).
            // Prevents early passes from locking onto cards from a different generation.
            const eraPrefix = setEra ? ERA_TO_SET_PREFIX[setEra] : null
            function eraOk(pool) {
              if (!eraPrefix || !pool.length) return pool
              const inEra = pool.filter(c => (c.set?.id || '').startsWith(eraPrefix))
              return inEra.length ? inEra : pool // fall back to full pool only if era yields 0
            }

            // Pass 0c: card number — most precise single-card identifier
            // Run BEFORE ability/attack so a specific number (e.g. 100/108) beats a shared ability
            // Skip when numberSuspect: the number was flagged as likely hallucinated on foil
            if (!candidates.length && cardNumber && !numberSuspect) {
              const rawNum = cardNumber.split('/')[0].trim()
              const strippedNum = rawNum.replace(/^0+(?=\d)/, '')
              // Try all name variants: normalized, SV abbreviated ex, original, SV full Mega ex
              const nameQuerySet = new Set([ptcgCardName])
              if (svExName !== ptcgCardName) nameQuerySet.add(svExName)
              if (cardName !== ptcgCardName) nameQuerySet.add(cardName)
              if (megaSvExName && !nameQuerySet.has(megaSvExName)) nameQuerySet.add(megaSvExName)
              const nameQueries = [...nameQuerySet]
              for (const n of nameQueries) {
                if (candidates.length) break
                let numHits = await queryPtcg(`name:"${n}" number:${rawNum}`, 5)
                if (!numHits.length && strippedNum !== rawNum) {
                  numHits = await queryPtcg(`name:"${n}" number:${strippedNum}`, 5)
                }
                if (numHits.length) {
                  candidates = eraOk(numHits)
                  debugInfo.ptcgQ = `name+number(${n})`
                  // HP mismatch: discard if found card HP doesn't match AI-read HP.
                  // Catches reprint hallucination: e.g. AI returns sm1-93 Deino (HP60)
                  // but the physical card is White Flare Deino (HP80).
                  if (hp && candidates[0]?.hp && candidates[0].hp !== hp) {
                    debugInfo.p0cHpMismatch = `${candidates[0].id}(HP${candidates[0].hp})≠AI(HP${hp}) → discarded`
                    candidates = []
                  }
                }
              }
            }

            // Pass 0a: ability name — most precise identifier (large printed text, not foil)
            if (!candidates.length && ability) {
              const abilityHits = await queryPtcg(`name:"${ptcgCardName}" abilities.name:"${ability.replace(/"/g, '')}"`)
              if (abilityHits.length) {
                candidates = eraOk(abilityHits)
                debugInfo.ptcgQ = `ability:${ability}`
              }
            }

            // Pass 0b: first attack name
            if (!candidates.length && attacks.length > 0) {
              const attackHits = await queryPtcg(`name:"${ptcgCardName}" attacks.name:"${attacks[0].replace(/"/g, '')}"`)
              if (attackHits.length) {
                candidates = eraOk(attackHits)
                debugInfo.ptcgQ = `attack:${attacks[0]}`
              }
            }

            // Pass 0d: HP — narrows to specific card version when number lookup missed
            if (!candidates.length && hp) {
              candidates = await queryPtcg(`name:"${ptcgCardName}" hp:${hp}`)
              if (candidates.length) debugInfo.ptcgQ = `name+hp:${hp}`
            }

            // Pass 1: name + specific set name (skip if it's a generic series name)
            if (!candidates.length && normSet && !SERIES_NAMES.has(normSet)) {
              candidates = await queryPtcg(`name:"${ptcgCardName}" set.name:"${normSet}"`)
              debugInfo.ptcgQ = `name+set`
            }

            // Pass 2: series name → base set ID (e.g. "Scarlet & Violet (SV)" → sv1)
            if (!candidates.length && SERIES_TO_BASE[normSet]) {
              candidates = await queryPtcg(`name:"${ptcgCardName}" set.id:${SERIES_TO_BASE[normSet]}`)
              debugInfo.ptcgQ = `name+setId`
            }

            // Pass 3: promo sets (Promo finish or "Promo" in set name)
            if (!candidates.length && parsedFinish === 'Promo') {
              candidates = await queryPtcg(`name:"${ptcgCardName}" supertype:Pokémon`)
              debugInfo.ptcgQ = `promo`
            }

            // Pass 3c: name + rarity — for premium finishes with wrong/missing number
            if (!candidates.length && parsedFinish && finishRarityQuery[parsedFinish]) {
              candidates = await queryPtcg(`name:"${ptcgCardName}" ${finishRarityQuery[parsedFinish]}`)
              debugInfo.ptcgQ = `name+rarity`
            }

            // Pass 4: name only — top 10 newest, pick by rarity/number
            if (!candidates.length) {
              candidates = await queryPtcg(`name:"${ptcgCardName}"`)
              debugInfo.ptcgQ = `name-only`
            }

            // Pass 6: ability-only — last resort when name is OCR-misread (e.g. "Gochitelle" → "Gothitelle")
            if (!candidates.length && ability) {
              const allAbility = await queryPtcg(`abilities.name:"${ability.replace(/"/g, '')}"`, 20)
              candidates = eraOk(allAbility)
              if (!candidates.length) candidates = allAbility
              if (candidates.length) debugInfo.ptcgQ = `ability-only:${ability}`
            }

            debugInfo.ptcgCount = candidates.length

            const best = pickBest(candidates, ptcgRarityStr, nums.length ? nums : null, normSet, ability, attacks, hp)
            // Ability-only / attack-only passes are last resorts with very low signal precision.
            // Require a much higher score (70%) to commit — needs ability + attacks + HP all matching.
            const isLatePass = /ability-only|attack-only/.test(debugInfo.ptcgQ || '')
            // Only commit to PTCG result if score is high enough (≥45%, or ≥70% for late passes).
            const MIN_PTCG_SCORE = isLatePass ? 70 : 45
            const ptcgScore = debugInfo.pickScore // percentage (0-100), undefined if fallback path
            // When ptcgScore is undefined the fallback (rarity/number match without signal scoring) fired.
            // Still gate on MIN_PTCG_SCORE for late passes to avoid committing low-confidence late results.
            const scoreOk = ptcgScore !== undefined
              ? ptcgScore >= MIN_PTCG_SCORE
              : !isLatePass  // undefined score on late pass = no commit

            // Set sanity gate: if AI gave a specific known set name, reject PTCG cards from a
            // different set. Prevents e.g. committing me1-143 (Mega Evolution Helioptile IR) when
            // AI clearly said "Obsidian Flames". megaHpOverride skips this — that override
            // intentionally targets a different set than what the AI stated.
            let ptcgSetOk = true
            if (best && scoreOk && !megaHpOverride && !numberSuspect && normSet && !SERIES_NAMES.has(normSet) && best.set?.name) {
              const bl = best.set.name.toLowerCase()
              const nl = normSet.toLowerCase()
              if (!bl.includes(nl) && !nl.includes(bl)) {
                ptcgSetOk = false
                debugInfo.ptcgSetMismatch = `${best.id}(${best.set.name})≠${normSet}`
              }
            }

            if (best && scoreOk && ptcgSetOk) {
              let commitCard = best
              const aiSaysUltraRare = parsedFinish === 'Ultra Rare'
              const ptcgSaysPremium = /Special Illustration|Illustration Rare|Rare Rainbow/i.test(best.rarity || '')

              // If AI says Ultra Rare but PTCG found SIR/IR, look for the Ultra Rare variant
              // in the same set — it exists at a different (lower) card number
              if (aiSaysUltraRare && ptcgSaysPremium && best.set?.id) {
                try {
                  let urCommit = null

                  // Pass A: name-based UR search — verify rarity is exactly "Rare Ultra"
                  const urNames = [...new Set([ptcgCardName, svExName, cardName, megaSvExName].filter(Boolean))]
                  for (const n of urNames) {
                    if (urCommit) break
                    const hits = await queryPtcg(
                      `name:"${n}" set.id:${best.set.id} rarity:"Rare Ultra"`, 3
                    )
                    const validHit = hits.find(c => /^Rare Ultra$/i.test(c.rarity || ''))
                    if (validHit) urCommit = validHit
                  }

                  // Pass B: set.id + card number — most direct, bypasses name format entirely
                  // e.g. set.id:me1 number:155 → finds the Ultra Rare at that exact position
                  if (!urCommit && cardNumber) {
                    const rawNum2 = cardNumber.split('/')[0].trim()
                    const stripped2 = rawNum2.replace(/^0+(?=\d)/, '')
                    const numsToTry = stripped2 !== rawNum2 ? [rawNum2, stripped2] : [rawNum2]
                    for (const n of numsToTry) {
                      if (urCommit) break
                      const numHits = await queryPtcg(`set.id:${best.set.id} number:${n}`, 3)
                      const urHit = numHits.find(c => /^Rare Ultra$/i.test(c.rarity || ''))
                      if (urHit) {
                        urCommit = urHit
                        debugInfo.ptcgUrNumHit = `${best.set.id}#${n}→${urHit.id}`
                      }
                    }
                  }

                  // Pass C: set + rarity + ability — bypasses BOTH name and number issues.
                  // Most reliable when AI misreads the card number (e.g. 002 instead of 155).
                  // Finds the UR in the same set that shares the ability with the SIR.
                  if (!urCommit && ability) {
                    const abilityUrHits = await queryPtcg(
                      `set.id:${best.set.id} rarity:"Rare Ultra" abilities.name:"${ability.replace(/"/g, '')}"`, 5
                    )
                    const urHit = abilityUrHits.find(c => /^Rare Ultra$/i.test(c.rarity || ''))
                    if (urHit) {
                      urCommit = urHit
                      debugInfo.ptcgUrAbilityHit = `${best.set.id} UR+${ability}→${urHit.id}`
                    }
                  }

                  if (urCommit) {
                    commitCard = urCommit
                    debugInfo.ptcgUrFallback = `SIR→UR: ${best.id}→${urCommit.id}`
                  }
                } catch { /* keep best */ }
              }

              catalogId = commitCard.id
              officialImageUrl = commitCard.images?.large || commitCard.images?.small || null
              catalogPriceEur = commitCard.cardmarket?.prices?.trendPrice || commitCard.cardmarket?.prices?.averageSellPrice || null
              catalogCardmarketUrl = commitCard.cardmarket?.url || null
              debugInfo.catalogHit = true
              debugInfo.source = 'ptcg'
              verifiedRarity = (aiSaysUltraRare && ptcgSaysPremium && !debugInfo.ptcgUrFallback)
                ? 'Rare Ultra'
                : (commitCard.rarity || null)
              verifiedSetName = commitCard.set?.name || null
              verifiedNumber = commitCard.number || null
              debugInfo.verified = `${verifiedRarity} · ${verifiedSetName} · #${verifiedNumber}`
              debugInfo.rarityDbg = `aiUR:${aiSaysUltraRare} ptcgPrem:${ptcgSaysPremium} urFb:${debugInfo.ptcgUrFallback || 'none'} → ${verifiedRarity}`
            } else if (best) {
              debugInfo.ptcgSkipped = `skipped ${best.id}: ${!ptcgSetOk ? `set≠${normSet}` : `score ${ptcgScore}%<${MIN_PTCG_SCORE}%`}`
            }
          } catch (ptcgErr) {
            debugInfo.ptcgError = ptcgErr.message
          }

          // Global UR recovery: fires when all set-constrained PTCG passes failed (or were score-gated)
          // and AI says Ultra Rare with a known ability.
          // Core problem: AI misidentifies the set (e.g. "Evolutions" instead of "Mega Evolution")
          // → knownSetId targets wrong set → number/name/ability searches all miss the real card.
          // This bypass searches globally without set constraint: ability + name + rarity:"Rare Ultra".
          // Trigger GUR for any premium finish — AI inconsistently calls same card
          // "Ultra Rare", "Secret Rare", "Full Art" etc. depending on scan quality.
          const _gurPremium = _aiFinish && /Ultra Rare|Secret Rare|Special Illustration|Illustration Rare|Rare Rainbow|Hyper Rare|Full Art|Double Rare/i.test(_aiFinish)
          debugInfo.gurCheck = `cat:${catalogId ? 'set' : 'null'} fin:${_aiFinish || 'null'} ab:${ability ? 'set' : 'null'} gp:${String(!!_gurPremium)}`
          if (!catalogId && _gurPremium && ability) {
            const _gurAbility = ability.replace(/"/g, '')
            const gurNames = [...new Set([ptcgCardName, svExName, cardName, megaSvExName].filter(Boolean))]
            debugInfo.gurAttempt = `fin:${_aiFinish} ability:${_gurAbility} names:${gurNames.join('|')}`
            try {
              // Pass GUR-A: ability + name + rarity:"Rare Ultra"
              for (const n of gurNames) {
                if (catalogId) break
                const gurHits = await queryPtcg(
                  `abilities.name:"${_gurAbility}" name:"${n}" rarity:"Rare Ultra"`, 5
                )
                debugInfo.gurCountA = (debugInfo.gurCountA || 0) + gurHits.length
                const gurHit = gurHits.find(c => /^Rare Ultra$/i.test(c.rarity || ''))
                if (gurHit) {
                  catalogId = gurHit.id
                  officialImageUrl = gurHit.images?.large || gurHit.images?.small || null
                  catalogPriceEur = gurHit.cardmarket?.prices?.trendPrice || gurHit.cardmarket?.prices?.averageSellPrice || null
                  catalogCardmarketUrl = gurHit.cardmarket?.url || null
                  debugInfo.catalogHit = true
                  debugInfo.source = 'ptcg-global-ur'
                  verifiedRarity = 'Rare Ultra'
                  verifiedSetName = gurHit.set?.name || null
                  verifiedNumber = gurHit.number || null
                  debugInfo.verified = `${verifiedRarity} · ${verifiedSetName} · #${verifiedNumber}`
                  debugInfo.ptcgGlobalUr = `GUR-A:${n}+${ability}→${gurHit.id}`
                }
              }
              // Pass GUR-B: ability only + rarity — no name constraint
              // Tries both "Rare Ultra" (pre-SV) and "Ultra Rare" (SV-era) since pokemontcg.io
              // uses different strings across generations for the same card tier.
              if (!catalogId) {
                let gurBHits = await queryPtcg(`abilities.name:"${_gurAbility}" rarity:"Rare Ultra"`, 10)
                if (!gurBHits.length) {
                  gurBHits = await queryPtcg(`abilities.name:"${_gurAbility}" rarity:"Ultra Rare"`, 10)
                }
                debugInfo.gurCountB = gurBHits.length
                const gurBHit = gurBHits.find(c => /^(Rare Ultra|Ultra Rare)$/i.test(c.rarity || ''))
                if (gurBHit) {
                  catalogId = gurBHit.id
                  officialImageUrl = gurBHit.images?.large || gurBHit.images?.small || null
                  catalogPriceEur = gurBHit.cardmarket?.prices?.trendPrice || gurBHit.cardmarket?.prices?.averageSellPrice || null
                  catalogCardmarketUrl = gurBHit.cardmarket?.url || null
                  debugInfo.catalogHit = true
                  debugInfo.source = 'ptcg-global-ur'
                  verifiedRarity = 'Rare Ultra'
                  verifiedSetName = gurBHit.set?.name || null
                  verifiedNumber = gurBHit.number || null
                  debugInfo.verified = `${verifiedRarity} · ${verifiedSetName} · #${verifiedNumber}`
                  debugInfo.ptcgGlobalUr = `GUR-B:${ability}→${gurBHit.id}`
                }
              }
              // Pass GUR-C: ability only, NO rarity constraint — finds card even if rarity is
              // stored differently in pokemontcg.io (e.g. me1 set uses different rarity strings)
              if (!catalogId) {
                const gurCHits = await queryPtcg(`abilities.name:"${_gurAbility}"`, 20)
                debugInfo.gurCountC = gurCHits.length
                if (gurCHits.length) debugInfo.gurCIds = gurCHits.slice(0, 4).map(c => `${c.id}(${c.rarity})`).join(' ')
                // Only commit if the Pokémon species name matches.
                // Split each name variant into tokens, skip short/ambiguous tokens (≤2 chars like
                // "M", "ex") and use the first meaningful word (e.g. "venusaur" from "M Venusaur-EX").
                // This avoids "M" from "M Venusaur-EX" matching every card whose name contains "m".
                const matchesSpecies = c => {
                  const cName = (c.name || '').toLowerCase()
                  return gurNames.some(n => {
                    const tokens = n.toLowerCase().split(/[\s\-]+/)
                    const speciesToken = tokens.find(t => t.length >= 4)
                    return speciesToken ? cName.includes(speciesToken) : false
                  })
                }
                const speciesMatches = gurCHits.filter(matchesSpecies)
                let gurCHit = null
                if (speciesMatches.length) {
                  // "Secret Rare" included: AI often calls me1-era Ultra Rares "Secret Rare"
                  // because they're numbered above set total (X > Y), a pattern traditionally
                  // used for secrets. The ★★ colour (silver = UR, gold = SIR) is the real signal.
                  if (/Ultra Rare|Full Art|Secret Rare/i.test(_aiFinish || '')) {
                    gurCHit = speciesMatches.find(c => /^Rare Ultra$/i.test(c.rarity || ''))
                           || speciesMatches.find(c => /^Ultra Rare$/i.test(c.rarity || ''))
                           || speciesMatches[0]
                  } else if (/Special Illustration/i.test(_aiFinish || '')) {
                    gurCHit = speciesMatches.find(c => /Special Illustration/i.test(c.rarity || '')) || speciesMatches[0]
                  } else if (/Illustration Rare/i.test(_aiFinish || '')) {
                    gurCHit = speciesMatches.find(c => /^Illustration Rare$/i.test(c.rarity || '')) || speciesMatches[0]
                  } else {
                    gurCHit = speciesMatches[0]
                  }
                }
                if (gurCHit) {
                  catalogId = gurCHit.id
                  officialImageUrl = gurCHit.images?.large || gurCHit.images?.small || null
                  catalogPriceEur = gurCHit.cardmarket?.prices?.trendPrice || gurCHit.cardmarket?.prices?.averageSellPrice || null
                  catalogCardmarketUrl = gurCHit.cardmarket?.url || null
                  debugInfo.catalogHit = true
                  debugInfo.source = 'ptcg-global-ur'
                  verifiedRarity = /^(Rare Ultra|Ultra Rare)$/i.test(gurCHit.rarity || '') ? 'Rare Ultra' : (gurCHit.rarity || null)
                  verifiedSetName = gurCHit.set?.name || null
                  verifiedNumber = gurCHit.number || null
                  debugInfo.verified = `${verifiedRarity} · ${verifiedSetName} · #${verifiedNumber}`
                  debugInfo.ptcgGlobalUr = `GUR-C:${_gurAbility}→${gurCHit.id}`
                }
              }
            } catch (gurErr) {
              debugInfo.gurError = gurErr.message
            }
          }
        }

        // Strategy Promo: when finish is Promo, search directly in promo sets (svp*, swshp*, etc.)
        // Runs before all other strategies — promo cards have unique set_ids separate from base sets
        if (!catalogId && parsedFinish === 'Promo' && game === 'pokemon') {
          const promoSetFilters = ['svp', 'swshp', 'smp', 'xyp', 'bwp']
          for (const promoSet of promoSetFilters) {
            if (catalogId) break
            const rows = await tryFetch(
              `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&set_id=like.${promoSet}*&select=${fields}&order=id.desc&limit=5`
            )
            if (rows[0]) applyHit(rows[0], `promo-${promoSet}`)
          }
        }

        // Strategy 1: number + set name in catalog (URL-safe: encode & as %26)
        if (!catalogId && nums.length && setName) {
          for (const num of nums) {
            if (catalogId) break
            const safeSet = encodeURIComponent(`*${setName}*`)
            const rows = await tryFetch(
              `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&number=eq.${encodeURIComponent(num)}&set_name=ilike.${safeSet}${langFilter}&select=${fields}&limit=1`
            )
            if (rows[0]) applyHit(rows[0], 's1')
          }
        }

        // Strategy 2: number + set total to disambiguate same-number cards across sets
        if (!catalogId && nums.length && setTotal) {
          for (const num of nums) {
            if (catalogId) break
            const rows = await tryFetch(
              `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&number=eq.${encodeURIComponent(num)}${langFilter}&select=${fields}&order=updated_at.desc&limit=10`
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
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&set_name=ilike.${encodeURIComponent(`*${setName}*`)}${rarityFilter}${langFilter}&select=${fields}&limit=1`
          )
          if (rows[0]) applyHit(rows[0], 's3')
        }

        // Strategy 3b: name + set without rarity (looser)
        if (!catalogId && setName) {
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}&set_name=ilike.${encodeURIComponent(`*${setName}*`)}${langFilter}&select=${fields}&limit=1`
          )
          if (rows[0]) applyHit(rows[0], 's3b')
        }

        // Strategy 4: name + rarity (most reliable fallback for SIR/IR/etc.)
        // For Pokémon: when AI has a specific set name, constrain to it to avoid cross-set false
        // matches (e.g. me1-135 when AI said "Obsidian Flames"). setName is in outer scope;
        // normSet/SERIES_NAMES are only in the inner pokemon block so are not referenced here.
        if (!catalogId && rarity) {
          const s4SetFilter = (game === 'pokemon' && setName)
            ? `&set_name=ilike.${encodeURIComponent(`*${setName}*`)}` : ''
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}${rarityFilter}${s4SetFilter}${langFilter}&select=${fields}&order=price_eur.desc.nullslast&limit=1`
          )
          if (rows[0]) applyHit(rows[0], 's4')
        }

        // Strategy 5: name + rarity — correct finish, newest first
        if (!catalogId && rarity) {
          const s5SetFilter = (game === 'pokemon' && setName)
            ? `&set_name=ilike.${encodeURIComponent(`*${setName}*`)}` : ''
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}${rarityFilter}${s5SetFilter}${langFilter}&select=${fields}&order=id.desc&limit=1`
          )
          if (rows[0]) applyHit(rows[0], 's5')
        }

        // Strategy 5b: name only — only for non-premium finishes (avoids returning wrong common/uncommon card)
        const isPremiumFinish = parsedFinish &&
          /Special Illustration|Illustration Rare|Hyper Rare|Secret Rare|Gold Secret|Ultra Rare|Full Art|Shiny Rare|Amazing Rare|Radiant Rare|Prism Star/i.test(parsedFinish)
        if (!catalogId && !isPremiumFinish) {
          const rows = await tryFetch(
            `${SUPABASE_URL}/rest/v1/card_catalog?${gameFilter}&${nameFilter}${langFilter}&select=${fields}&order=id.desc&limit=1`
          )
          if (rows[0]) applyHit(rows[0], 's5b')
        }
      }
    }
  } catch (e) {
    debugInfo.error = e.message
  }

  // SUPABASE RARITY SANITY: if Supabase committed a card whose rarity contradicts the AI,
  // revert the commit. Prevents xy12-2 (Rare Holo EX) from being committed when AI says Ultra Rare.
  // Only applies to Supabase strategies (s1-s5b), not PTCG (which has its own scoring).
  if (catalogId && /^s\d/.test(debugInfo.source || '') && _aiFinish) {
    const _aiPremium = /Ultra Rare|Special Illustration|Illustration Rare|Rare Rainbow|Hyper Rare|Full Art|Double Rare|Secret Rare|Shiny|Amazing|Radiant|Prism/i.test(_aiFinish)
    const _dbPremium = !verifiedRarity || /Ultra Rare|Special Illustration|Illustration Rare|Rare Rainbow|Hyper Rare|Full Art|Double Rare|Secret Rare|Shiny|Amazing|Radiant|Prism/i.test(verifiedRarity)
    if (_aiPremium && !_dbPremium) {
      debugInfo.supabaseReverted = `${debugInfo.source}(${verifiedRarity}) reverted: AI=${_aiFinish}`
      catalogId = null; officialImageUrl = null; catalogPriceEur = null; catalogCardmarketUrl = null
      verifiedRarity = null; verifiedSetName = null; verifiedNumber = null
      debugInfo.catalogHit = false; debugInfo.source = null
    }
  }

  // TOP-LEVEL SAFETY OVERRIDE: if AI identified Ultra Rare but catalog returned SIR/IR,
  // trust the AI. The rarity symbol (silver vs gold ★★) is visually unambiguous.
  // This catches cases where the UR variant search accepted a wrong card or failed silently.
  if (/Ultra Rare|Secret Rare|Full Art/i.test(_aiFinish || '') && /Special Illustration Rare|Illustration Rare|Rare Rainbow/i.test(verifiedRarity || '')) {
    const _prevRarity = verifiedRarity
    verifiedRarity = 'Rare Ultra'
    debugInfo.rarityForcedUR = `${_prevRarity} → Rare Ultra (AI said Ultra Rare)`
  }

  // If AI says Ultra Rare and no catalog matched, set verifiedRarity from AI so display is correct.
  if (!catalogId && /Ultra Rare/i.test(_aiFinish || '')) {
    verifiedRarity = 'Rare Ultra'
    debugInfo.rarityFromAi = 'Ultra Rare (no catalog match)'
  }

  // When no catalog match but strong signals indicate Mega Evolution (me1, SV 2025):
  // Mega card + HP > 300 + known ability = confidently set verifiedSetName so the display
  // shows "Mega Evolution" even while the set is not yet indexed in pokemontcg.io.
  // Only applies to Pokémon — other games don't have this signal set.
  if (
    game === 'pokemon' &&
    !catalogId &&
    _aiCardName &&
    /^(Mega|M )\s/i.test(_aiCardName) &&
    parseInt(_aiHp, 10) > 300 &&
    _aiAbility &&
    !verifiedSetName
  ) {
    verifiedSetName = 'Mega Evolution'
    debugInfo.setFromHp = 'Mega Evolution (HP>300 + Mega card + ability)'
  }

  debugInfo.aiFinish = _aiFinish

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
  "estimatedRawValue": "<UNGRADED raw market price in EUR for NM condition — raw (unslabbed) NM copy price TODAY, not a PSA graded price>",
  "estimatedPSAValue": "<same as estimatedRawValue — copy the same raw NM price here>",
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

CARD NUMBER — CRITICAL: The second image is an enlarged crop of the bottom of the card.
- Standard set cards: number is ALWAYS in "X/Y" format where BOTH X and Y are PURE DIGITS (e.g. "045/165", "215/197", "100/123")
- The set series abbreviation (XY, SV, SWSH, SM, BW) may appear immediately after the number with NO space — e.g. "100/123XY MEGA EVOLUTION" or "100/108 XY EVOLUTIONS". These abbreviations are set branding, NOT part of the number.
- CRITICAL: If the denominator starts with a series abbreviation (XY, SV, SWSH, SM, BW) followed by digits — e.g. you think the number is "100/XY123" — you are wrong. The denominator is ONLY the digits: return "100/123", not "100/XY123".
- The denominator is ALWAYS a plain number. It never contains letters. If you see letters in the denominator, strip them.
- Promo cards: standalone code without "/" (e.g. "SVP EN 113", "SWSH052", "XY123") → return exactly as-is and set finish = Promo
- Return null ONLY if completely unreadable
- ⚠️ DO NOT HALLUCINATE NUMBERS: On Hyper Rare, Illustration Rare, Rainbow Rare, and other premium foil cards, the card number is printed over heavy holographic foil — individual digits may be nearly invisible. Read what you can LITERALLY SEE on THIS specific card. Never output a number you recall from memory about this card type (e.g. if you know Switch appears as 206/165 in the 151 set, do NOT write those digits unless you can physically read them here). A null is always better than a recalled-but-wrong number that causes misidentification.

SET NAME — CRITICAL: Read the SPECIFIC set name from the small text at the very bottom of the card.
Known English set names (return these exactly):
Scarlet & Violet era: Scarlet & Violet, Paldea Evolved, Obsidian Flames, 151, Paradox Rift, Paldean Fates, Temporal Forces, Twilight Masquerade, Shrouded Fable, Stellar Crown, Surging Sparks, Prismatic Evolutions, Journey Together, Destined Rivals, Black Bolt, White Flare.
Mega Evolution era: Mega Evolution, Phantasmal Flames, Ascended Heroes, Perfect Order, Chaos Rising.
Sword & Shield era: Brilliant Stars, Astral Radiance, Lost Origin, Silver Tempest, Crown Zenith, Evolving Skies, Fusion Strike, Chilling Reign, Battle Styles, Rebel Clash, Vivid Voltage, Darkness Ablaze.
XY era: Evolutions, Steam Siege, Fates Collide, BREAKpoint, BREAKthrough, Ancient Origins, Roaring Skies, Primal Clash, Phantom Forces, Furious Fists, Flashfire.
- Do NOT return a series name like "Scarlet & Violet Series" — return the exact product name.
- If Japanese, unreadable, or uncertain → return null. NEVER guess.
- The set name is printed in plain readable text and is FAR MORE RELIABLE than the card number on premium foil cards. Prioritize reading the set name accurately — it is the single most important field for correct identification.

MEGA EVOLUTION vs EVOLUTIONS — CRITICAL DISTINCTION (extremely common confusion):
- "Mega Evolution" (me1, 2025 SV era) and "Evolutions" (xy12, 2016 XY era) are COMPLETELY DIFFERENT sets with COMPLETELY DIFFERENT cards.
- "Mega Evolution" (me1, 2025): Mega Pokémon with HP 330–400+. Card numbers go up to 132 in main set, but Ultra Rare variants ARE numbered ABOVE set total (e.g. 155/132 — this is a SILVER ★★ Ultra Rare, NOT a SIR). Set name printed at bottom reads exactly "Mega Evolution".
- "Evolutions" (xy12, 2016): Reprints of original Base Set cards. Mega Pokémon have HP 210–240 MAX. Card numbers go up to 108 (e.g. 002/108, 100/108). Set name printed at bottom reads exactly "Evolutions".
- "Phantasmal Flames" (me2, nov 2025): The SECOND Mega Evolution set. Set code: "PFL EN". 94 base cards (denominator 094). Ultra Rare Trainer/Pokémon cards numbered ABOVE set total (e.g. Switch 123/094).
- "Ascended Heroes" (me2pt5, jan 2026): THIRD Mega Evolution set (special). Set code: "ASC EN". 217 base cards (denominator 217). Large special set like Prismatic Evolutions.
- "Perfect Order" (me3, mar 2026): FOURTH Mega Evolution set. Set code: "POR EN". 88 base cards (denominator 088).
- "Chaos Rising" (me4, may 2026): FIFTH Mega Evolution set. Set code: "CRI EN". 86 base cards (denominator 086).
For ALL Mega Evolution era sets (me1–me4): Mega Pokémon have HP 330–400+. Ultra Rare cards (★★ silver) ARE numbered above set total.
- If you see a Mega Pokémon card with HP above 300 → it CANNOT be from "Evolutions" (xy12). It MUST be from "Mega Evolution" (me1) or another SV-era set. Do NOT default to "Evolutions" based on visual similarity.
- CARD NUMBER must be read from the PHYSICAL card — NEVER inferred from memory or prior knowledge. If the card shows "155/132" → return "155/132". Do not substitute a number you recall from another version of the card.

WHITE FLARE & BLACK BOLT — REPRINT SETS (jul 2025, SV era):
- "White Flare" (set code: WHT EN) and "Black Bolt" (set code: BLK EN) are July 2025 reprint sets in the SCARLET & VIOLET era. The era is ALWAYS SV, NEVER SM, XY, SWSH, or any older generation.
- These sets reprint SV-era Pokémon with new artwork. The cards look like standard SV cards in style and layout.
- HOW TO IDENTIFY: Look at the set code printed in the bottom-left corner of the card. "WHT EN" = White Flare. "BLK EN" = Black Bolt. If you see "WHT EN" → return setName exactly "White Flare". If you see "BLK EN" → return setName exactly "Black Bolt". Also look for the text "White Flare" or "Black Bolt" printed at the very bottom center.
- Both sets have 86 base cards (denominator 086). Secret zone cards go up to 173 (White Flare) or similar for Black Bolt.
- CRITICAL: If a card Pokémon (e.g. Deino, Ralts, Dratini) appears in White Flare or Black Bolt, DO NOT return the card's original set (e.g. "Sun & Moon" or "XY"). The card's set is "White Flare" or "Black Bolt" — read the set code at the bottom. A Deino in White Flare has set code "WHT EN" and is numbered within /086, NOT "93/149" (which is the Sun & Moon version).
- ⚠️ DO NOT HALLUCINATE: If you see a card with SV-era design (2025 copyright, modern layout) but recognize the Pokémon from an older set, the card is a REPRINT. Return the set name and number from the physical card, never from memory.

FINISH — Identify in this exact priority order:

STEP 0 — PROMO CHECK (always first):
Look at the card number zone (bottom-right) and bottom-left corner of the artwork for:
- A black star with "PROMO" text printed on it
- A standalone code without "/" like "SVP EN 113", "SWSH052", "SM229"
- A WINNER, STAFF, or event stamp
Promo cards CAN have full-bleed edge-to-edge artwork identical to SIR — artwork style does NOT determine this. If ANY promo marking exists → finish = Promo. Return cardNumber as the promo code exactly.

STEP 1 — NUMBER ZONE CHECK (X/Y format only):
- X > Y (e.g. 215/197, number exceeds set total) → card is in secret zone. Cannot be Normal, Holo Rare, Reverse Holo, Common, or Uncommon.
- X < Y but X/Y > 80% (e.g. 166/197 = 84%) → card is in upper set zone. Can be Illustration Rare, Ultra Rare, or Double Rare.
- X/Y ≤ 80% → standard zone. Can be any non-secret rarity.
- SIR cards are ALWAYS in the secret zone (X > Y). A card numbered within the set total (X < Y) cannot be a SIR.

STEP 2 — VISUAL IDENTIFICATION (use rarity symbol + artwork to confirm):
★★★ gold = Hyper Rare: Entire card is gold metallic including borders, text boxes, and artwork area.
★★ gold = Special Illustration Rare (SIR): GOLD ★★ symbol. Truly edge-to-edge full-bleed artwork — NO card frame, NO name box, NO attack text boxes visible anywhere. Pokémon name floats as tiny text directly over the illustration. Always an ex-Pokémon. ALWAYS numbered ABOVE set total (X > Y). Heavy etched ridged foil texture.
★★ silver = Ultra Rare: SILVER ★★ symbol. Full Art ex card or Trainer Full Art — extended artwork, but the card RETAINS a visible frame: you can see the name box at the top, HP, attack text boxes, and/or energy costs. Usually numbered WITHIN set total (X < Y), BUT in "Mega Evolution" (me1) Ultra Rare cards ARE numbered above set total (e.g. 155/132). The ★★ COLOUR is the decisive factor — SILVER = Ultra Rare, GOLD = Special Illustration Rare. DO NOT confuse with SIR — the card frame elements are still present.
★ gold = Illustration Rare (IR): Artwork extends significantly beyond art box. Card name/HP area at the TOP retains partial standard frame. Always a non-ex Pokémon. Numbered WITHIN set total.
★★ black = Double Rare: Standard ex card layout with visible art box. Numbered in lower half of set.
★ black = Rare (Holo): Standard rectangular art box CLEARLY VISIBLE. Holofoil only inside art rectangle.
◇ = Reverse Holo: Standard layout, holofoil on BORDERS and TEXT areas, artwork is flat.
● / ◆ = Normal / Common / Uncommon: No holofoil anywhere.
★ Amazing Rare (AR): SWSH era only. Rainbow/prismatic swirl in art box, standard frame visible.
★ Promo: See Step 0. Requires visible promo stamp or code.

CRITICAL RULES:
- SIR requires ALL of: GOLD ★★ symbol + edge-to-edge art + NO card frame visible + ex Pokémon + number ABOVE set total (X > Y) + no promo stamp
- Ultra Rare: SILVER ★★ symbol + Full Art ex or Trainer Full Art + card frame elements still visible. Usually X < Y, but "Mega Evolution" (me1) Ultra Rares ARE above set total — ★★ colour is always the deciding factor. If ★★ is SILVER → Ultra Rare regardless of position.
- IR requires: extended art + partial top frame + non-ex Pokémon + number within set total
- A card with number WITHIN the set total (X < Y) CANNOT be SIR — it must be Ultra Rare or lower
- Promo cards can look exactly like SIR — the promo stamp/code is the only difference

The card is assumed Near Mint — estimate market value at NM prices.

ABILITY & ATTACKS & HP — Read these PHYSICALLY from the card image. Do NOT use prior knowledge or memory — the card in the image may differ from other cards with the same Pokémon name.
- HP: the number printed in the TOP-RIGHT corner next to the damage counter icon. Read it EXACTLY as shown. Mega Pokémon in the SV-era "Mega Evolution" set have HP 330–400 (e.g. 380 HP). If you recall a Mega Pokémon having ~230 HP, you are thinking of the OLD XY-era "Evolutions" version — IGNORE that memory and read what is physically printed.
- Ability name: the word(s) printed in BOLD immediately after "Ability:" above the ability description box. Read what is physically printed — do not recall or guess.
- Attack names: printed in bold at the start of each attack line. Read each name exactly as printed.
- If text is unclear, return null for that field — never substitute with memorized data.

Return ONLY valid JSON, no markdown, no extra text:
{
  "cardName": "<name exactly as printed on card>",
  "cardNumber": "<standard cards: X/Y format e.g. 045/165 | promo cards: full code e.g. SVP EN 113 | null only if unreadable>",
  "setName": "<exact set name e.g. Twilight Masquerade, Surging Sparks — null if unreadable or Japanese>",
  "finish": "<Normal | Holo Rare | Reverse Holo | Double Rare | Ultra Rare | Illustration Rare | Special Illustration Rare | Hyper Rare | Secret Rare | Gold Secret Rare | Amazing Rare | Shiny Rare | Radiant Rare | Prism Star | 1st Edition | Shadowless | Promo — REQUIRED, never null for Pokémon>",
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
  "estimatedRawValue": "<UNGRADED raw market price in EUR for NM condition — the price a collector pays for a raw (unslabbed) NM copy TODAY, e.g. 40-60€. Do NOT estimate a PSA 9 or PSA 10 graded price — raw only>",
  "estimatedPSAValue": "<same as estimatedRawValue — copy the same raw NM price here>",
  "gradingFee": "~25€",
  "recommendation": "<short recommendation in English>"
}`
}
