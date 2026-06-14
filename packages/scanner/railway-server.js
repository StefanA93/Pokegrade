/**
 * GradeDex Embedding Microservice
 * Deploy på Railway — kør `node railway-server.js`
 *
 * POST /embed
 *   Body: { image: "data:image/jpeg;base64,..." }
 *   Returns: { embedding: number[512] }
 *
 * GET /health
 *   Returns: { status: "ok", model: "ready"|"loading" }
 */

import http from 'http'
import { extractEmbedding } from './embedding-server.js'

const PORT   = process.env.PORT   || 3001
const SECRET = process.env.EMBED_SECRET || ''

// Pre-load modellen ved startup — ikke ved første request
let modelReady = false
console.log('Loading CLIP model...')
extractEmbedding(Buffer.alloc(1)).catch(() => {}).finally(() => {
  modelReady = true
  console.log('CLIP model ready')
})

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => data += chunk)
    req.on('end', () => {
      try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  cors(res)

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { status: 'ok', model: modelReady ? 'ready' : 'loading' })
  }

  if (req.method !== 'POST' || req.url !== '/embed') {
    return json(res, 404, { error: 'Not found — use POST /embed' })
  }

  // Auth (hvis EMBED_SECRET er sat)
  if (SECRET) {
    const auth = req.headers['authorization'] || ''
    if (auth !== `Bearer ${SECRET}`) return json(res, 401, { error: 'Unauthorized' })
  }

  try {
    const body = await readBody(req)
    const { image } = body
    if (!image) return json(res, 400, { error: 'image required (base64 dataURL)' })

    const base64 = image.replace(/^data:image\/\w+;base64,/, '')
    const buffer = Buffer.from(base64, 'base64')

    const embedding = await extractEmbedding(buffer)
    return json(res, 200, { embedding })
  } catch (err) {
    console.error('Embed error:', err.message)
    return json(res, 500, { error: 'Embedding failed' })
  }
})

server.listen(PORT, () => {
  console.log(`Embedding service listening on port ${PORT}`)
})
