import { describe, expect, it } from 'vitest'
import { decodeHtmlEntities, sanitizeNewsText } from './sanitizeNewsText.js'

describe('decodeHtmlEntities', () => {
  it.each([
    ['Showrunner&#8217;s Exit', 'Showrunner’s Exit'],
    ['News &#038; Updates', 'News & Updates'],
  ])('decodes a decimal numeric reference: %s', (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected)
  })

  it.each([
    ['News &#x26; Updates', 'News & Updates'],
    ['&#x2019;curtain call', '’curtain call'],
  ])('decodes a hexadecimal numeric reference: %s', (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected)
  })

  it.each([
    ['A &amp; B', 'A & B'],
    ['&quot;From&quot; Renewed', '"From" Renewed'],
    ["Tom&apos;s New Series", "Tom's New Series"],
    ['5 &lt; 10 &gt; 3', '5 < 10 > 3'],
  ])('decodes a standard named entity: %s', (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected)
  })

  it('decodes &nbsp; to a true non-breaking space (U+00A0) — collapsing it to a plain space is sanitizeNewsText\'s job, not decodeHtmlEntities\'', () => {
    const decoded = decodeHtmlEntities('One&nbsp;Two')
    expect(decoded).toBe('One' + String.fromCharCode(0xa0) + 'Two')
    expect(decoded.charCodeAt(3)).toBe(0xa0)
  })

  it('decodes a mix of decimal, hex, and named entities in one headline', () => {
    expect(decodeHtmlEntities('Netflix&#8217;s &quot;From&quot; &amp; &#x201C;You&#x201D; renewed'))
      .toBe('Netflix’s "From" & “You” renewed')
  })

  it('leaves an unknown named entity untouched instead of guessing', () => {
    expect(decodeHtmlEntities('Unknown &foobar; entity')).toBe('Unknown &foobar; entity')
  })

  it('leaves a malformed numeric reference untouched rather than throwing', () => {
    expect(() => decodeHtmlEntities('&#zzz; malformed')).not.toThrow()
    expect(decodeHtmlEntities('&#zzz; malformed')).toBe('&#zzz; malformed')
  })

  it('leaves an out-of-range code point untouched rather than throwing', () => {
    expect(() => decodeHtmlEntities('&#x110000; out of range')).not.toThrow()
    expect(decodeHtmlEntities('&#x110000; out of range')).toBe('&#x110000; out of range')
  })

  it('preserves the case distinction between named entities like Aacute and aacute', () => {
    expect(decodeHtmlEntities('&Aacute;&aacute;')).toBe('Áá')
  })

  it('decodes only once - a double-escaped script tag never becomes real markup', () => {
    const input = '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;Still Escaped'
    const output = decodeHtmlEntities(input)
    expect(output).toBe('&lt;script&gt;alert(1)&lt;/script&gt;Still Escaped')
    expect(output).not.toContain('<script>')
  })
})

describe('sanitizeNewsText', () => {
  it('decodes entities and strips a script block revealed by decoding', () => {
    expect(sanitizeNewsText('&lt;script&gt;alert(1)&lt;/script&gt;Headline')).toBe('Headline')
  })

  it('decodes entities and strips a style block revealed by decoding', () => {
    expect(sanitizeNewsText('&lt;style&gt;body{color:red}&lt;/style&gt;Headline')).toBe('Headline')
  })

  it('never lets double-encoded markup survive as an active tag', () => {
    const result = sanitizeNewsText('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;Still Escaped')
    expect(result).not.toContain('<script>')
    expect(result).toBe('&lt;script&gt;alert(1)&lt;/script&gt;Still Escaped')
  })

  it('strips real (non-entity) markup exactly as before', () => {
    expect(sanitizeNewsText('<p>The <b>network</b> confirmed <script>alert(1)</script>the next season.</p>'))
      .toBe('The network confirmed the next season.')
  })

  it('cleans up whitespace left behind after decoding and stripping', () => {
    const result = sanitizeNewsText('  One&nbsp;Two   &amp;   Three  ')
    expect(result).toBe('One' + String.fromCharCode(32) + 'Two & Three')
  })

  it('returns null for non-string or empty input', () => {
    expect(sanitizeNewsText(undefined)).toBeNull()
    expect(sanitizeNewsText(null)).toBeNull()
    expect(sanitizeNewsText('')).toBeNull()
    expect(sanitizeNewsText('   ')).toBeNull()
  })

  it('does not crash on malformed or unknown entities', () => {
    expect(() => sanitizeNewsText('&foobar; &#zzz; &#xzzzz; text')).not.toThrow()
  })

  it('is idempotent - running it twice on already-clean text changes nothing', () => {
    const once = sanitizeNewsText('Showrunner&#8217;s Exit &amp; More')
    expect(sanitizeNewsText(once)).toBe(once)
  })
})
