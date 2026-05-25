import Redis from 'ioredis'

let _client = null

export function getRedis() {
  if (!_client) {
    _client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    })
  }
  return _client
}

export const TTL = {
  CARD:        86400,   // 24h
  PRICE:        3600,   // 1h
  SET:          86400,  // 24h
  SET_CARDS:    21600,  // 6h
  SEARCH:        900,   // 15min
  RATE_LIMIT:     60,   // 1min sliding window
}

export const CacheKeys = {
  card:       id          => `card:${id}`,
  cardPrice:  (id, finish) => `price:${id}:${finish}`,
  set:        id          => `set:${id}`,
  setCards:   id          => `setcards:${id}`,
  search:     (q, game)   => `search:${game || 'all'}:${q.toLowerCase().trim()}`,
  rateLimit:  ip          => `rl:${ip}`,
  syncState:  gameId      => `sync:${gameId}`,
}

export async function cacheGet(key) {
  const val = await getRedis().get(key)
  return val ? JSON.parse(val) : null
}

export async function cacheSet(key, value, ttl) {
  const redis = getRedis()
  const serialized = JSON.stringify(value)
  if (ttl) {
    await redis.setex(key, ttl, serialized)
  } else {
    await redis.set(key, serialized)
  }
}

export async function cacheDel(...keys) {
  if (keys.length) await getRedis().del(...keys)
}

export async function cacheThrough(key, ttl, fetchFn) {
  const cached = await cacheGet(key)
  if (cached !== null) return cached
  const fresh = await fetchFn()
  if (fresh !== null && fresh !== undefined) await cacheSet(key, fresh, ttl)
  return fresh
}

export async function isRateLimited(ip, limit = 60) {
  const key = CacheKeys.rateLimit(ip)
  const redis = getRedis()
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, TTL.RATE_LIMIT)
  return count > limit
}
