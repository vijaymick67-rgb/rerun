import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = resolve(root, 'public')
const COLORS = {
  background: [15, 17, 21, 255],
  surface: [23, 26, 33, 255],
  accent: [91, 141, 239, 255],
  text: [229, 231, 235, 255],
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type)
  const body = Buffer.concat([typeBuffer, data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body), 0)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  return Buffer.concat([length, body, checksum])
}

function encodePng(width, height, rgba) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    scanlines[rowStart] = 0
    rgba.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function makeCanvas(size) {
  const scale = 3
  const width = size * scale
  const pixels = Buffer.alloc(width * width * 4)
  for (let i = 0; i < width * width; i++) pixels.set(COLORS.background, i * 4)
  return { pixels, size, scale, width }
}

function setPixel(canvas, x, y, color) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.width) return
  canvas.pixels.set(color, (y * canvas.width + x) * 4)
}

function fillCircle(canvas, cx, cy, radius, color) {
  const min = Math.floor(cx - radius)
  const max = Math.ceil(cx + radius)
  for (let y = min; y <= max; y++) {
    for (let x = min; x <= max; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) setPixel(canvas, x, y, color)
    }
  }
}

function strokeArc(canvas, cx, cy, radius, width, start, end, color) {
  const steps = Math.ceil(Math.abs(end - start) * radius / 8)
  for (let i = 0; i <= steps; i++) {
    const angle = start + (end - start) * (i / steps)
    fillCircle(canvas, cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, width / 2, color)
  }
}

function fillTriangle(canvas, points, color) {
  const minX = Math.floor(Math.min(...points.map(([x]) => x)))
  const maxX = Math.ceil(Math.max(...points.map(([x]) => x)))
  const minY = Math.floor(Math.min(...points.map(([, y]) => y)))
  const maxY = Math.ceil(Math.max(...points.map(([, y]) => y)))
  const [a, b, c] = points
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = [x, y]
      const d1 = sign(p, a, b)
      const d2 = sign(p, b, c)
      const d3 = sign(p, c, a)
      if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) setPixel(canvas, x, y, color)
    }
  }
}

function drawMark(canvas, maskable) {
  const center = canvas.width / 2
  const radius = canvas.width * (maskable ? 0.265 : 0.34)
  const stroke = canvas.width * (maskable ? 0.07 : 0.075)
  const start = Math.PI * 0.25
  const end = Math.PI * 1.72

  strokeArc(canvas, center, center, radius, stroke, start, end, COLORS.accent)
  const tipX = center + Math.cos(start) * radius
  const tipY = center + Math.sin(start) * radius
  const tangent = [Math.sin(start), -Math.cos(start)]
  const normal = [Math.cos(start), Math.sin(start)]
  fillTriangle(canvas, [
    [tipX + tangent[0] * stroke * 1.8, tipY + tangent[1] * stroke * 1.8],
    [tipX - tangent[0] * stroke * 0.5 + normal[0] * stroke, tipY - tangent[1] * stroke * 0.5 + normal[1] * stroke],
    [tipX - tangent[0] * stroke * 0.5 - normal[0] * stroke, tipY - tangent[1] * stroke * 0.5 - normal[1] * stroke],
  ], COLORS.accent)

  fillCircle(canvas, center, center, canvas.width * 0.14, COLORS.surface)
  strokeArc(canvas, center, center, canvas.width * 0.14, canvas.width * 0.035, 0, Math.PI * 2, COLORS.text)
  fillTriangle(canvas, [
    [center - canvas.width * 0.02, center - canvas.width * 0.075],
    [center - canvas.width * 0.02, center + canvas.width * 0.075],
    [center + canvas.width * 0.085, center],
  ], COLORS.text)
}

function downsample(canvas) {
  const output = Buffer.alloc(canvas.size * canvas.size * 4)
  for (let y = 0; y < canvas.size; y++) {
    for (let x = 0; x < canvas.size; x++) {
      const sums = [0, 0, 0, 0]
      for (let sy = 0; sy < canvas.scale; sy++) {
        for (let sx = 0; sx < canvas.scale; sx++) {
          const index = (((y * canvas.scale) + sy) * canvas.width + (x * canvas.scale) + sx) * 4
          for (let channel = 0; channel < 4; channel++) sums[channel] += canvas.pixels[index + channel]
        }
      }
      const index = (y * canvas.size + x) * 4
      output[index] = Math.round(sums[0] / canvas.scale ** 2)
      output[index + 1] = Math.round(sums[1] / canvas.scale ** 2)
      output[index + 2] = Math.round(sums[2] / canvas.scale ** 2)
      output[index + 3] = 255
    }
  }
  return output
}

function writeIcon(name, size, maskable = false) {
  const canvas = makeCanvas(size)
  drawMark(canvas, maskable)
  writeFileSync(resolve(outputDir, name), encodePng(size, size, downsample(canvas)))
}

mkdirSync(outputDir, { recursive: true })
writeIcon('icon-192.png', 192)
writeIcon('icon-512.png', 512)
writeIcon('icon-maskable-512.png', 512, true)
writeIcon('apple-touch-icon.png', 180)
