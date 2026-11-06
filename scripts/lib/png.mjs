/**
 * A real PNG, made here, so an image test does not depend on a file somebody else left behind.
 *
 * `test-image-card.mjs` used to open `docs/shots/02-canvas.png` from the checkout, which is in
 * `.gitignore`: the test could only run at all if the capture script had been run recently, and on
 * a fresh clone it failed for a reason that had nothing to do with what it tests. This makes its
 * fixture instead.
 */
import { deflateSync } from 'node:zlib'

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** One PNG chunk: length, type, payload, CRC over type and payload. */
function chunk(type, payload) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(payload.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, crc])
}

/**
 * A `width` by `height` RGBA PNG of random pixels.
 *
 * Random rather than flat on purpose. Noise does not compress, so the file comes out well over a
 * kilobyte, which is what lets a test assert that real bytes were served rather than an empty
 * response with a 200 on it. A flat image of the same dimensions deflates to a few dozen bytes and
 * would pass a content type check while proving nothing.
 */
export function pngOfNoise(width = 64, height = 64) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1)
    raw[row] = 0 // filter type: none
    for (let x = 0; x < stride; x++) raw[row + 1 + x] = Math.floor(Math.random() * 256)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
