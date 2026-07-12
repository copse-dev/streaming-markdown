// Re-rooted append frames (ADR 0004 Phase 2): a raw container element left
// open by committed markdown must no longer degrade the rest of the stream to
// per-commit full morphs. The committed subtree stays byte-identical to the
// whole-string render at every commit — via re-rooting when the container
// survives sanitization, via ordinary freezing when the sanitizer unwraps it,
// and via the old fallback for shapes re-rooting cannot express — and the
// per-stream rendered-character total stays O(n), which is the cliff guard.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { splitForStreaming } from './streaming-split.ts'
import type { MarkdownConfig } from './config.ts'
import type { FrozenTailRenderer } from './streaming-frozen-tail.ts'

function completeEl(host: HTMLElement): HTMLElement {
  const el = host.querySelector('.stream-complete')
  assert.ok(el instanceof HTMLElement, 'stream-complete host exists')
  return el
}

const passthroughBackend = { sanitize: (html: string): string => html }

/**
 * Stream `md` chunk-by-chunk asserting the committed subtree equals the
 * whole-string render at every fully-committed frame; returns the renderer's
 * cumulative rendered-character diagnostic. The oracle renders under the SAME
 * config and is compared parse-normalized: a passthrough backend hands the
 * sink an unnormalized string, so the display contract is parse-equality (what
 * `innerHTML =` produces), which for a normalizing real sanitizer coincides
 * with byte equality.
 */
function streamAsserting(md: string, config: MarkdownConfig, step = 3): number {
  const host = document.createElement('div')
  const scratch = document.createElement('div')
  const r = new StreamingMarkdownRenderer(host, config)
  for (let cut = step; cut <= md.length + step; cut += step) {
    const prefix = md.slice(0, Math.min(cut, md.length))
    r.update(prefix)
    const split = splitForStreaming(prefix)
    if (split.pending !== '') continue
    scratch.innerHTML = String(renderMarkdown(split.complete, config))
    assert.equal(completeEl(host).innerHTML, scratch.innerHTML, `cut=${String(Math.min(cut, md.length))}`)
  }
  const frozenTail = (r as unknown as { frozenTail: FrozenTailRenderer }).frozenTail
  return frozenTail.renderedChars
}

const paragraphs = (n: number, label: string): string =>
  Array.from({ length: n }, (_, i) => `Paragraph ${label}-${String(i)} with **bold** and \`code\`.`).join('\n\n')

describe('re-rooted append frames (ADR 0004 Phase 2)', () => {
  it('keeps byte-parity with an unclosed <details> under a passthrough sanitizer', () => {
    const md = `${paragraphs(3, 'a')}\n\n<details>\n\n${paragraphs(6, 'b')}\n\n`
    streamAsserting(md, { sanitizerBackend: passthroughBackend })
  })

  it('keeps byte-parity with an unclosed <details> under the sanitizing default (unwrapped)', () => {
    const md = `${paragraphs(3, 'a')}\n\n<details>\n\n${paragraphs(6, 'b')}\n\n`
    streamAsserting(md, {})
  })

  it('keeps byte-parity when the container is allowlisted by the real sanitizer (<div>)', () => {
    // `div` IS in the sanitizer allowlist, so this exercises the surviving-
    // container re-root under the default sanitized configuration.
    const md = `${paragraphs(2, 'a')}\n\n<div class="wrap">\n\n${paragraphs(5, 'b')}\n\n`
    streamAsserting(md, {})
  })

  it('keeps byte-parity through a nested open chain (<div> then <details>)', () => {
    const md = `${paragraphs(2, 'a')}\n\n<div>\n\n${paragraphs(2, 'b')}\n\n<details>\n\n${paragraphs(4, 'c')}\n\n`
    streamAsserting(md, { sanitizerBackend: passthroughBackend })
  })

  it('keeps byte-parity when the close tag finally arrives', () => {
    const md = `${paragraphs(2, 'a')}\n\n<div>\n\n${paragraphs(3, 'b')}\n\n</div>\n\n${paragraphs(3, 'c')}\n\n`
    streamAsserting(md, { sanitizerBackend: passthroughBackend })
    streamAsserting(md, {})
  })

  it('keeps byte-parity for a details tag healed inside its list item', () => {
    // `</li>` closes the unclosed <details>, so nothing stays open at the
    // delta's EOF: the probe proves concatenation-safety and the delta
    // freezes normally (the changelog-entry shape that motivated Phase 2).
    const md = `- item with an open <details> tag inside\n- second item\n\n${paragraphs(5, 'b')}\n\n`
    streamAsserting(md, { sanitizerBackend: passthroughBackend })
    streamAsserting(md, {})
  })

  it('still falls back for an unclosed formatting element (reconstruction hazard)', () => {
    // An open <b> is NOT re-rootable: whole-string parsing reconstructs it
    // into every later block. Parity must hold via the full-morph fallback.
    const md = `before <b>bold\n\n${paragraphs(4, 'b')}\n\n`
    streamAsserting(md, { sanitizerBackend: passthroughBackend })
    streamAsserting(md, {})
  })

  it('holds the pending tail while the frozen raw <details> stays open (#138)', () => {
    const md = `${paragraphs(2, 'a')}\n\n<details>\n\n${paragraphs(3, 'b')}\n\npending tail line`
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host, { sanitizerBackend: passthroughBackend })
    for (let cut = 4; cut <= md.length + 4; cut += 4) r.update(md.slice(0, Math.min(cut, md.length)))
    // The committed details is a live frame; the display layer must keep
    // holding pending output rather than flashing it after the collapsed body.
    const pendingEls = host.querySelectorAll('.stream-pending-block, .stream-pending:not([hidden])')
    for (const el of pendingEls) {
      assert.doesNotMatch(el.textContent ?? '', /pending tail line/, 'pending held while details open')
    }
  })

  it('renders O(n) characters over a details-bearing stream (the cliff guard)', () => {
    // The O(n²) cliff this phase removes: an unclosed <details> used to force
    // a full-document render on EVERY commit. renderedChars is deterministic
    // and timing-free; compare against a details-free stream of the same size
    // and assert the growth is bounded, not quadratic.
    const clean = (n: number): number =>
      streamAsserting(`${paragraphs(n, 'x')}\n\n`, { sanitizerBackend: passthroughBackend })
    const detailed = (n: number): number =>
      streamAsserting(
        `${paragraphs(2, 'a')}\n\n<details>\n\n${paragraphs(n - 2, 'b')}\n\n`,
        { sanitizerBackend: passthroughBackend },
      )
    const ratio = detailed(24) / clean(24)
    assert.ok(
      ratio < 4,
      `details stream rendered ${ratio.toFixed(1)}× a clean stream's characters (bounded expected; O(n²) fallback regressed)`,
    )
    // And doubling the document must not quadruple the rendered total.
    const growth = detailed(32) / detailed(16)
    assert.ok(
      growth < 3.2,
      `rendered chars grew ${growth.toFixed(2)}× when the stream doubled (~2× expected; O(n²) fallback regressed)`,
    )
  })
})
