const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

function crc32(buf) {
  const table = []
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[i] = c
  }
  let crc = 0xFFFFFFFF
  for (const byte of buf) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function makeChunk(type, data) {
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function createIcon(size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // colour type: RGB

  // Colours
  const bg    = [6,   6,  10]   // #06060a  dark background
  const dark  = [13,  13, 20]   // #0d0d14  inner card bg
  const gold  = [212, 175, 55]  // #D4AF37  gold ring
  const goldL = [244, 208, 111] // #F4D06F  sheen highlight

  const R      = size * 0.42   // outer ring radius
  const rInner = R - size * 0.09 // ring width ~9%

  const rowSize = size * 3
  const raw = Buffer.alloc(size * (rowSize + 1))

  for (let y = 0; y < size; y++) {
    raw[y * (rowSize + 1)] = 0 // filter byte: None
    for (let x = 0; x < size; x++) {
      const i = y * (rowSize + 1) + 1 + x * 3
      const dx = x - size / 2
      const dy = y - size / 2
      const dist = Math.sqrt(dx * dx + dy * dy)

      let color
      if (dist > R) {
        color = bg
      } else if (dist > rInner) {
        // Gold ring with subtle top-right sheen
        const angle = Math.atan2(dy, dx)
        const sheen = (Math.cos(angle - Math.PI * 0.7) + 1) / 2 * 0.6
        color = [
          Math.round(gold[0] + (goldL[0] - gold[0]) * sheen),
          Math.round(gold[1] + (goldL[1] - gold[1]) * sheen),
          Math.round(gold[2] + (goldL[2] - gold[2]) * sheen),
        ]
      } else {
        color = dark
      }

      raw[i]     = color[0]
      raw[i + 1] = color[1]
      raw[i + 2] = color[2]
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

const publicDir = path.join(__dirname, '..', 'public')
for (const size of [192, 512]) {
  const dest = path.join(publicDir, `icon-${size}.png`)
  fs.writeFileSync(dest, createIcon(size))
  console.log(`Created ${dest}`)
}
