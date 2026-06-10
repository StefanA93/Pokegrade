import Redis from 'ioredis'

let _client = null
let _bullClient = null
let _redisOk = true

export function getRedis() {
  if (!_client) {
    _client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    })
    _client.on('error', () => { _redisOk = false })
    _client.on('ready', () => { _redisOk = true })
  }
  return _client
}

export function getBullRedis() {
  if (!_bullClient) {
    _bullClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    })
  }
  return _bullClient
}

export const TTL = {
  CARD:        86400,
  PRICE:        3600,
  SET:          86400,
  SET_CARDS:    21600,
  SEARCH:        900,
  RATE_LIMIT:     60,
}

export const CacheKeys = {
  card:       id           => `card:${id}`,
  cardPrice:  (id, finish) => `price:${id}:${finish}`,
  set:        id           => `set:${id}`,
  setCards:   id           => `setcards:${id}`,
  search:     (q, game)    => `search:${game || 'all'}:${q.toLowerCase().trim()}`,
  rateLimit:  ip           => `rl:${ip}`,
  syncState:  gameId       => `sync:${gameId}`,
}

export async function cacheGet(key) {
  if (!_redisOk) return null
  try {
    const val = await getRedis().get(key)
    return val ? JSON.parse(val) : null
  } catch { return null }
}

export async function cacheSet(key, value, ttl) {
  if (!_redisOk) return
  try {
    const redis = getRedis()
    const s = JSON.stringify(value)
    if (ttl) await redis.setex(key, ttl, s)
    else await redis.set(key, s)
  } catch { /* ignore */ }
}

export async function cacheDel(...keys) {
  if (!_redisOk || !keys.length) return
  try { await getRedis().del(...keys) } catch { /* ignore */ }
}

export async function cacheThrough(key, ttl, fetchFn) {
  const cached = await cacheGet(key)
  if (cached !== null) return cached
  const fresh = await fetchFn()
  if (fresh !== null && fresh !== undefined) await cacheSet(key, fresh, ttl)
  return fresh
}

export async function isRateLimited(ip, limit = 120) {
  if (!_redisOk) return false
  try {
    const key = CacheKeys.rateLimit(ip)
    const redis = getRedis()
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, TTL.RATE_LIMIT)
    return count > limit
  } catch { return false }
}
