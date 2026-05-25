import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { getRedis } from '../packages/cache/index.js'

import { cardsRoutes }      from './routes/cards.js'
import { setsRoutes }       from './routes/sets.js'
import { searchRoutes }     from './routes/search.js'
import { scanRoutes }       from './routes/scan.js'
import { collectionRoutes } from './routes/collection.js'
import { adminRoutes }      from './routes/admin.js'

const PORT = parseInt(process.env.PORT || '3001')
const HOST = process.env.HOST || '0.0.0.0'

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: true,
})

await fastify.register(cors, {
  origin: [
    'https://gradedex.vercel.app',
    'https://gradedex-v2.vercel.app',
    /\.vercel\.app$/,
    ...(process.env.NODE_ENV === 'development' ? ['http://localhost:5173', 'http://localhost:3000'] : [])
  ],
  credentials: true,
})

await fastify.register(multipart, {
  limits: { fileSize: 15 * 1024 * 1024, files: 1 }
})

await fastify.register(rateLimit, {
  global: true,
  max: 120,
  timeWindow: '1 minute',
  redis: getRedis(),
  keyGenerator: req => req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
  errorResponseBuilder: () => ({
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again in a minute.' }
  })
})

fastify.get('/health', async () => ({
  status: 'ok',
  ts: new Date().toISOString(),
  version: process.env.npm_package_version || '1.0.0'
}))

const API = '/api/v1'
fastify.register(cardsRoutes,      { prefix: API })
fastify.register(setsRoutes,       { prefix: API })
fastify.register(searchRoutes,     { prefix: API })
fastify.register(scanRoutes,       { prefix: API })
fastify.register(collectionRoutes, { prefix: API })
fastify.register(adminRoutes,      { prefix: API })

fastify.setErrorHandler((err, req, reply) => {
  fastify.log.error(err)
  reply.code(err.statusCode || 500).send({
    error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal server error' }
  })
})

try {
  await fastify.listen({ port: PORT, host: HOST })
  fastify.log.info(`GradeDex API listening on ${HOST}:${PORT}`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
