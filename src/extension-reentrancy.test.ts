import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import type { FenceHandler } from './fence-handlers.ts'
import type { InlinePass } from './inline-passes.ts'

// #151: the extension API (FenceHandler.render, inline passes) actively invites
// recursive renderMarkdownUnsafe calls. Those must not corrupt the OUTER
// document's document-scoped state — the footnote context (a module-level slot,
// #144) or its link-reference map. This exercises the recursive-render contract
// from BOTH extension seams over footnote- and link-ref-bearing content.
//
// The handler/pass is registered via the OUTER render's config; the nested
// renderMarkdownUnsafe call inside it inherits that config through withConfig's
// merge-over-parent semantics, so the seams stay registered across the reentrant
// call exactly as the old process-global registry guaranteed.

// A fence handler that recursively renders footnote-bearing content.
const recursiveFootnoteFence: FenceHandler = {
  render: () => renderMarkdownUnsafe('inner ref[^z]\n\n[^z]: inner note.'),
}

// An inline pass that, on a marker, recursively renders footnote-bearing content
// and emits it — the same reentrancy from the inline pipeline instead of a fence.
const recursiveFootnotePass: InlinePass = {
  name: 'recurse',
  apply(text, ctx) {
    if (!text.includes('RECURSE')) return text
    return text.replace('RECURSE', ctx.emit(renderMarkdownUnsafe('inner[^z]\n\n[^z]: inner note.')))
  },
}

describe('extension-API reentrancy: footnotes (#151)', () => {
  it('a fence handler recursively rendering footnotes leaves the outer document intact', () => {
    const html = renderMarkdownUnsafe(
      'Before[^a].\n\n```rec\n```\n\nAfter[^b].\n\n[^a]: note a.\n[^b]: note b.',
      { fenceHandlers: { rec: recursiveFootnoteFence } },
    )
    // Outer refs before AND after the nested render resolve, with uninterrupted
    // numbering (the inner render neither consumes a number nor resets it).
    assert.match(html, /Before<sup class="footnote-ref"><a href="#fn-a" id="fnref-a"[^>]*>1</)
    assert.match(html, /After<sup class="footnote-ref"><a href="#fn-b" id="fnref-b"[^>]*>2</)
    assert.doesNotMatch(html, /After\[\^b\]/)
    assert.match(html, /<li id="fn-a">/)
    assert.match(html, /<li id="fn-b">/)
    // The inner render keeps its own independent numbering.
    assert.match(html, /href="#fn-z" id="fnref-z"[^>]*>1</)
  })

  it('an inline pass recursively rendering footnotes leaves the outer document intact', () => {
    // The recursive render sits in its own block; the outer ref follows it.
    const html = renderMarkdownUnsafe('RECURSE\n\nAfter[^a].\n\n[^a]: note a.', {
      inlinePasses: [recursiveFootnotePass],
    })
    assert.match(html, /After<sup class="footnote-ref"><a href="#fn-a" id="fnref-a"[^>]*>1</)
    assert.doesNotMatch(html, /After\[\^a\]/)
    assert.match(html, /<li id="fn-a">/)
    assert.match(html, /href="#fn-z"/) // inner ref rendered independently
  })
})

describe('extension-API reentrancy: link references (#151)', () => {
  it('a recursive render does not leak its link-reference map into the outer document', () => {
    // Both documents define the SAME label `[ref]` with different destinations.
    // Link refs are per-render, so they must not cross: outer resolves to /outer,
    // the nested render to /inner.
    const html = renderMarkdownUnsafe('Outer [link][ref].\n\n```rec\n```\n\n[ref]: /outer', {
      fenceHandlers: { rec: { render: () => renderMarkdownUnsafe('[x][ref]\n\n[ref]: /inner') } },
    })
    assert.match(html, /<a href="\/outer">link<\/a>/)
    assert.match(html, /<a href="\/inner">x<\/a>/)
  })
})
