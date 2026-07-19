import { describe, expect, it } from 'vitest'
import { urlBase64ToUint8Array } from './vapidKey.js'

describe('urlBase64ToUint8Array', () => {
  it('converts a URL-safe base64 VAPID public key into raw bytes', () => {
    // 65-byte uncompressed P-256 point (0x04 prefix + 32 + 32), base64url-encoded.
    const raw = new Uint8Array(65)
    raw[0] = 4
    for (let i = 1; i < 65; i++) raw[i] = i
    const base64url = Buffer.from(raw)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    const result = urlBase64ToUint8Array(base64url)
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Array.from(result)).toEqual(Array.from(raw))
  })

  it('handles both - and _ URL-safe substitutions and missing padding', () => {
    // Bytes chosen so the standard base64 form contains both '+' and '/'.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf])
    const standard = Buffer.from(bytes).toString('base64') // "+/+/" family
    expect(standard).toMatch(/[+/]/)
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(Array.from(urlBase64ToUint8Array(urlSafe))).toEqual(Array.from(bytes))
  })

  it('throws on an empty or missing key instead of silently producing garbage', () => {
    expect(() => urlBase64ToUint8Array('')).toThrow(/VAPID public key/)
    expect(() => urlBase64ToUint8Array(undefined)).toThrow(/VAPID public key/)
  })
})
