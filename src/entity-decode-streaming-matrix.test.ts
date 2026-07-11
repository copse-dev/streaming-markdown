import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { renderProseInline } from './render-prose-inline.ts'

// #152: the safe-entity decoder (decodeSafeMarkdownEntities, escape.ts) runs on
// BOTH streaming pending paths — render-pending-line.ts (the block pending tail)
// and render-prose-inline.ts (committed prose) — so `&nbsp;` shows a real space
// while streaming instead of flashing the literal entity, and an *incomplete*
// entity suffix is held rather than flashed. This matrix pins that behavior
// through the pending paths (guarding the #143 hex-NBSP regex bug, which only
// manifested there), including the boundary that the LF ref `&#xa;` / `&#10;` is
// NOT a non-breaking space.

const NBSP = ' '

// Every spelling the safe decoder accepts — bare/`&amp;`-escaped × name/decimal/
// hex, hex with leading zeros and either case — all a non-breaking space.
const NBSP_SPELLINGS = [
  '&nbsp;',
  '&#160;',
  '&#xa0;',
  '&#xA0;',
  '&#x0a0;',
  '&#x00a0;',
  '&amp;nbsp;',
  '&amp;#160;',
  '&amp;#xa0;',
] as const

// Prefixes of a safe entity that have not yet completed — must be held, never
// flashed as literal `&…` text mid-stream.
const INCOMPLETE_PREFIXES = ['&', '&n', '&nb', '&nbs', '&nbsp', '&#', '&#16', '&#x', '&#xa0', '&amp;n'] as const

/** Drive the block pending-tail path (render-pending-line.ts) and read visible text. */
function pendingText(source: string): string {
  const host = document.createElement('div')
  new StreamingMarkdownRenderer(host).update(source)
  return host.textContent ?? ''
}

describe('safe-entity decode over the streaming pending tail (#152)', () => {
  it('decodes every non-breaking-space spelling to a real NBSP', () => {
    for (const spelling of NBSP_SPELLINGS) {
      const text = pendingText(`x${spelling}y`)
      assert.ok(text.includes(`x${NBSP}y`), `${spelling}: expected a real NBSP in the pending tail`)
      // No literal entity fragment leaks into the visible text.
      assert.ok(!text.includes('&'), `${spelling}: literal entity flashed in the pending tail`)
    }
  })

  it('holds an incomplete entity suffix instead of flashing it', () => {
    for (const prefix of INCOMPLETE_PREFIXES) {
      const text = pendingText(`x${prefix}`)
      assert.equal(text, 'x', `${prefix}: incomplete suffix should be held (not shown)`)
    }
  })

  it('resolves a held suffix to a NBSP once the entity completes', () => {
    // The hold must not drop data: the same renderer, fed the completion, upgrades
    // the held `&nbs…` to a real non-breaking space.
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('x&nbs')
    assert.equal(host.textContent, 'x') // held
    r.update('x&nbsp;y')
    assert.ok(host.textContent?.includes(`x${NBSP}y`), 'completed entity decodes to NBSP')
  })

  it('does NOT treat the line-feed ref &#xa; / &#10; as a non-breaking space (#143)', () => {
    // The #143 regex bug matched `&#xa;` (U+000A) as if it were the NBSP `&#xa0;`.
    // In the pending path the numeric LF ref decodes to a real newline, never NBSP.
    for (const lf of ['x&#xa;y', 'x&#10;y', 'x&#Xa;y']) {
      const text = pendingText(lf)
      assert.ok(!text.includes(NBSP), `${lf}: LF ref must not become a non-breaking space`)
    }
  })
})

describe('safe-entity decode over renderProseInline (#152)', () => {
  it('decodes every NBSP spelling to a real NBSP', () => {
    for (const spelling of NBSP_SPELLINGS) {
      const out = renderProseInline(`x${spelling}y`)
      assert.ok(out.includes(`x${NBSP}y`), `${spelling}: expected NBSP in prose output`)
    }
  })

  it('leaves the line-feed ref as a newline, not a NBSP', () => {
    const out = renderProseInline('x&#xa;y')
    assert.ok(!out.includes(NBSP), 'LF ref must not decode to NBSP')
    assert.ok(out.includes('\n'), 'LF ref decodes to a real newline')
  })
})
