// Deterministically renders the approved Rerun icon (design/rerun-icon-approved*.svg)
// into the public/ PWA and favicon assets. No runtime or rendering dependency is
// added: this parses the committed SVG source with small regexes (the source
// shape is simple and stable) and rasterizes paths itself.
import { deflateSync } from 'node:zlib'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const designDir = resolve(root, 'design')
const outputDir = resolve(root, 'public')

// ---------- PNG encoding (no dependency: minimal RGBA PNG writer) ----------

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

// ---------- Tiny SVG source reader (regex-based, source shape is fixed) ----------

function parseViewBox(svg) {
  const match = svg.match(/viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/)
  const [, minX, minY, w, h] = match
  return { minX: Number(minX), minY: Number(minY), width: Number(w), height: Number(h) }
}

function parseGradientStops(svg, id) {
  const gradientMatch = svg.match(new RegExp(`<linearGradient id="${id}"[^>]*>([\\s\\S]*?)</linearGradient>`))
  const stops = [...gradientMatch[1].matchAll(/<stop offset="([\d.]+)" stop-color="(#[0-9a-fA-F]+)"/g)]
    .map(([, offset, color]) => ({ offset: Number(offset), color: hexToRgb(color) }))
  return stops
}

function parseRects(svg) {
  return [...svg.matchAll(/<rect ([^/]*)\/>/g)].map(([, attrs]) => {
    const get = (name, fallback = 0) => {
      // Negative lookbehind avoids "x" matching inside "rx", or "width" inside "stroke-width".
      const m = attrs.match(new RegExp(`(?<![\\w-])${name}="([-\\d.]+)"`))
      return m ? Number(m[1]) : fallback
    }
    const fillMatch = attrs.match(/fill="([^"]*)"/)
    const strokeMatch = attrs.match(/stroke="([^"]*)"/)
    return {
      x: get('x', 0),
      y: get('y', 0),
      width: get('width'),
      height: get('height'),
      rx: get('rx', 0),
      fill: fillMatch ? fillMatch[1] : null,
      stroke: strokeMatch ? strokeMatch[1] : null,
      strokeWidth: get('stroke-width', 0),
    }
  })
}

function parseStrokedPaths(svg) {
  const groupMatch = svg.match(/<g fill="none"[^>]*>([\s\S]*?)<\/g>/)
  return [...groupMatch[1].matchAll(/<path d="([^"]+)" stroke-width="([\d.]+)"\/>/g)]
    .map(([, d, strokeWidth]) => ({ d, strokeWidth: Number(strokeWidth) }))
}

function parseFilledPath(svg) {
  const match = svg.match(/<path d="([^"]+)" fill="url\(#mark\)"\/>/)
  return match[1]
}

// ---------- SVG path (M/L/H/V/C, absolute only, matches source) flattening ----------

function flattenPath(d, samplesPerCurve = 24) {
  const tokens = d.match(/[MLHVC]|-?\d*\.?\d+/gi)
  const points = []
  let i = 0
  let cx = 0

  let cy = 0
  const next = () => Number(tokens[i++])
  while (i < tokens.length) {
    const cmd = tokens[i++]
    if (cmd === 'M' || cmd === 'L') {
      cx = next(); cy = next()
      points.push([cx, cy])
    } else if (cmd === 'H') {
      cx = next()
      points.push([cx, cy])
    } else if (cmd === 'V') {
      cy = next()
      points.push([cx, cy])
    } else if (cmd === 'C') {
      const x1 = next(); const y1 = next(); const x2 = next(); const y2 = next(); const x = next(); const y = next()
      for (let s = 1; s <= samplesPerCurve; s++) {
        const t = s / samplesPerCurve
        const mt = 1 - t
        const px = mt ** 3 * cx + 3 * mt ** 2 * t * x1 + 3 * mt * t ** 2 * x2 + t ** 3 * x
        const py = mt ** 3 * cy + 3 * mt ** 2 * t * y1 + 3 * mt * t ** 2 * y2 + t ** 3 * y
        points.push([px, py])
      }
      cx = x; cy = y
    } else {
      throw new Error(`Unsupported path command "${cmd}" in approved icon source`)
    }
  }
  return points
}

// ---------- Color helpers ----------

function hexToRgb(hex) {
  const value = hex.replace('#', '')
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ]
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

function sampleStops(stops, t) {
  const clamped = Math.max(0, Math.min(1, t))
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]; const b = stops[i + 1]
    if (clamped >= a.offset && clamped <= b.offset) {
      const localT = (clamped - a.offset) / (b.offset - a.offset || 1)
      return [0, 1, 2].map((c) => Math.round(lerp(a.color[c], b.color[c], localT)))
    }
  }
  return stops[stops.length - 1].color
}

// Gradient direction is objectBoundingBox-relative (0..1 across the element's own
// 1024x1024 box), independent of any viewBox padding used for maskable safe zone.
function makeGradientSampler(stops, x1, y1, x2, y2, boxSize) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  return (ex, ey) => {
    const u = ex / boxSize - x1
    const v = ey / boxSize - y1
    const t = (u * dx + v * dy) / lenSq
    return sampleStops(stops, t)
  }
}

// ---------- Rasterizer ----------

function makeCanvas(pixelSize) {
  const pixels = Buffer.alloc(pixelSize * pixelSize * 4)
  return { pixels, size: pixelSize }
}

function setPixel(canvas, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return
  const i = (y * canvas.size + x) * 4
  canvas.pixels[i] = r
  canvas.pixels[i + 1] = g
  canvas.pixels[i + 2] = b
  canvas.pixels[i + 3] = 255
}

function fillCircle(canvas, cx, cy, radius, color) {
  const min = Math.floor(cx - radius)
  const max = Math.ceil(cx + radius)
  const minY = Math.floor(cy - radius)
  const maxY = Math.ceil(cy + radius)
  for (let y = minY; y <= maxY; y++) {
    for (let x = min; x <= max; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) setPixel(canvas, x, y, color)
    }
  }
}

// Standard rounded-box signed distance function (Inigo Quilez). <= 0 means inside.
function sdRoundBox(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r)
  const qy = Math.abs(py - cy) - (halfH - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - r
}

function fillRoundedRect(canvas, transform, rect, colorFn, { squareCorners = false, extendToCanvasEdge = false } = {}) {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const halfW = rect.width / 2
  const halfH = rect.height / 2
  const radius = squareCorners ? 0 : rect.rx
  for (let py = 0; py < canvas.size; py++) {
    for (let px = 0; px < canvas.size; px++) {
      const [ex, ey] = transform.toElement(px, py)
      const inside = extendToCanvasEdge || sdRoundBox(ex, ey, cx, cy, halfW, halfH, radius) <= 0
      if (inside) setPixel(canvas, px, py, colorFn(ex, ey))
    }
  }
}

function strokeRoundedRectRing(canvas, transform, rect, strokeWidth, color) {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const halfW = rect.width / 2
  const halfH = rect.height / 2
  const half = strokeWidth / 2
  for (let py = 0; py < canvas.size; py++) {
    for (let px = 0; px < canvas.size; px++) {
      const [ex, ey] = transform.toElement(px, py)
      const d = sdRoundBox(ex, ey, cx, cy, halfW, halfH, rect.rx)
      if (Math.abs(d) <= half) setPixel(canvas, px, py, color)
    }
  }
}

function strokePolyline(canvas, transform, points, strokeWidthElement, colorFn) {
  const strokeWidthPixels = strokeWidthElement * transform.scale
  const radius = strokeWidthPixels / 2
  for (let i = 0; i < points.length - 1; i++) {
    const [ex1, ey1] = points[i]
    const [ex2, ey2] = points[i + 1]
    const [x1, y1] = transform.toCanvas(ex1, ey1)
    const [x2, y2] = transform.toCanvas(ex2, ey2)
    const dist = Math.hypot(x2 - x1, y2 - y1)
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius * 0.5)))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const x = lerp(x1, x2, t)
      const y = lerp(y1, y2, t)
      const ex = lerp(ex1, ex2, t)
      const ey = lerp(ey1, ey2, t)
      fillCircle(canvas, x, y, radius, colorFn(ex, ey))
    }
  }
}

function fillPolygon(canvas, transform, elementPoints, color) {
  const points = elementPoints.map(([ex, ey]) => transform.toCanvas(ex, ey))
  const minX = Math.floor(Math.min(...points.map(([x]) => x)))
  const maxX = Math.ceil(Math.max(...points.map(([x]) => x)))
  const minY = Math.floor(Math.min(...points.map(([, y]) => y)))
  const maxY = Math.ceil(Math.max(...points.map(([, y]) => y)))
  const [a, b, c] = points
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = [x, y]
      const d1 = sign(p, a, b); const d2 = sign(p, b, c); const d3 = sign(p, c, a)
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0
      if (!(hasNeg && hasPos)) setPixel(canvas, x, y, color)
    }
  }
}

// ---------- Icon source model ----------

function loadIconSource(svgText) {
  const viewBox = parseViewBox(svgText)
  const bgStops = parseGradientStops(svgText, 'bg')
  const markStops = parseGradientStops(svgText, 'mark')
  const rects = parseRects(svgText)
  const [backgroundRect, borderRect] = rects
  const strokedPaths = parseStrokedPaths(svgText).map((p) => ({ ...p, points: flattenPath(p.d) }))
  const filledTriangle = flattenPath(parseFilledPath(svgText))
  return { viewBox, bgStops, markStops, backgroundRect, borderRect, strokedPaths, filledTriangle }
}

function makeTransform(viewBox, pixelSize) {
  const scale = pixelSize / viewBox.width
  return {
    scale,
    toCanvas: (ex, ey) => [(ex - viewBox.minX) * scale, (ey - viewBox.minY) * scale],
    toElement: (px, py) => [px / scale + viewBox.minX, py / scale + viewBox.minY],
  }
}

function renderIcon(source, pixelSize, { forceOpaqueSquare = false, extendBackgroundToEdge = false } = {}) {
  const supersample = 4
  const canvas = makeCanvas(pixelSize * supersample)
  const transform = makeTransform(source.viewBox, pixelSize * supersample)

  const bgSampler = makeGradientSampler(source.bgStops, 0, 0, 1, 1, source.backgroundRect.width)
  fillRoundedRect(canvas, transform, source.backgroundRect, bgSampler, {
    squareCorners: forceOpaqueSquare,
    extendToCanvasEdge: extendBackgroundToEdge,
  })

  if (source.borderRect && !forceOpaqueSquare) {
    strokeRoundedRectRing(canvas, transform, source.borderRect, source.borderRect.strokeWidth, hexToRgb(source.borderRect.stroke))
  }

  const markSampler = makeGradientSampler(source.markStops, 0.15, 0.1, 0.85, 0.9, source.backgroundRect.width)
  for (const path of source.strokedPaths) {
    strokePolyline(canvas, transform, path.points, path.strokeWidth, markSampler)
  }
  fillPolygon(canvas, transform, source.filledTriangle, markSampler(462, 748))

  return downsample(canvas, pixelSize, supersample)
}

function downsample(canvas, size, scale) {
  const output = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sums = [0, 0, 0, 0]
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const index = (((y * scale) + sy) * canvas.size + (x * scale) + sx) * 4
          for (let c = 0; c < 4; c++) sums[c] += canvas.pixels[index + c]
        }
      }
      const index = (y * size + x) * 4
      output[index] = Math.round(sums[0] / scale ** 2)
      output[index + 1] = Math.round(sums[1] / scale ** 2)
      output[index + 2] = Math.round(sums[2] / scale ** 2)
      output[index + 3] = 255
    }
  }
  return output
}

// ---------- Main ----------

mkdirSync(outputDir, { recursive: true })

const regularSvgPath = resolve(designDir, 'rerun-icon-approved.svg')
const maskableSvgPath = resolve(designDir, 'rerun-icon-approved-maskable.svg')
const regularSource = loadIconSource(readFileSync(regularSvgPath, 'utf8'))
const maskableSource = loadIconSource(readFileSync(maskableSvgPath, 'utf8'))

function writePng(name, pixels, size) {
  writeFileSync(resolve(outputDir, name), encodePng(size, size, pixels))
}

writePng('icon-192.png', renderIcon(regularSource, 192), 192)
writePng('icon-512.png', renderIcon(regularSource, 512), 512)
// Apple touch icons must have an opaque edge-to-edge background (iOS applies its
// own corner mask); the approved source's rx-rounded corners would otherwise
// leave transparent corner pixels, so the background is squared off for this
// render only. The committed source SVG is untouched.
writePng('apple-touch-icon.png', renderIcon(regularSource, 180, { forceOpaqueSquare: true }), 180)
// The maskable source's rect only fills its own 1024x1024 box, inset within the
// padded 1184x1184 viewBox that provides the safe-zone breathing room. Extending
// the background gradient across that full padded canvas (a crop-safety
// correction, not a change to geometry/color/concept) avoids a transparent ring
// showing through when the OS applies a circular or rounded-square mask.
writePng('icon-maskable-512.png', renderIcon(maskableSource, 512, { extendBackgroundToEdge: true }), 512)

copyFileSync(regularSvgPath, resolve(outputDir, 'favicon.svg'))
copyFileSync(regularSvgPath, resolve(outputDir, 'rerun-icon.svg'))

console.log('Generated icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png, favicon.svg, rerun-icon.svg from approved design sources.')
