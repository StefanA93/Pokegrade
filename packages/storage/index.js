import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'

let _client = null

function getS3() {
  if (!_client) {
    _client = new S3Client({
      region:      'auto',
      endpoint:    process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  }
  return _client
}

const BUCKET = process.env.R2_BUCKET || 'gradedex-cards'
const CDN    = process.env.R2_CDN_URL || ''

export function buildImageKey(game, setCode, number, slug) {
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
  const safeNum  = (number || 'x').replace(/\//g, '-')
  return `images/${game}/${setCode}/${safeNum}-${safeSlug}.webp`
}

export function buildThumbKey(game, setCode, number, slug) {
  const key = buildImageKey(game, setCode, number, slug)
  return key.replace(`images/${game}/${setCode}/`, `images/${game}/${setCode}/thumbs/`)
}

export function cdnUrl(key) {
  return key && CDN ? `${CDN}/${key}` : null
}

export async function processAndUpload({ sourceUrl, sourceBuffer, game, setCode, number, name }) {
  let rawBuffer = sourceBuffer
  if (!rawBuffer && sourceUrl) {
    const res = await fetch(sourceUrl)
    if (!res.ok) throw new Error(`Failed to fetch image: ${sourceUrl}`)
    rawBuffer = Buffer.from(await res.arrayBuffer())
  }
  if (!rawBuffer) throw new Error('No image source provided')

  const slug     = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
  const fullKey  = buildImageKey(game, setCode, number, slug)
  const thumbKey = buildThumbKey(game, setCode, number, slug)

  const [fullWebp, thumbWebp] = await Promise.all([
    sharp(rawBuffer).resize(800, null, { withoutEnlargement: true }).webp({ quality: 85 }).toBuffer(),
    sharp(rawBuffer).resize(200, null, { withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
  ])

  const s3 = getS3()
  await Promise.all([
    s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: fullKey,  Body: fullWebp,  ContentType: 'image/webp' })),
    s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: thumbKey, Body: thumbWebp, ContentType: 'image/webp' })),
  ])

  return { fullKey, thumbKey, fullUrl: cdnUrl(fullKey), thumbUrl: cdnUrl(thumbKey) }
}

export async function deleteImage(key) {
  if (!key) return
  await getS3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
}

export async function imageExists(key) {
  try {
    await getS3().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}
