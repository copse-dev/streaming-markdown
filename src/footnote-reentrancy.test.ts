import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FenceHandler } from './fence-handlers.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

// #144: renderMarkdownCore installs a document-scoped footnote context in a
// module-level slot and used to clear it to `null` in `finally`. The extension
// API invites recursive renderMarkdownUnsafe calls (a fence handler / inline
// pass rendering footnote-bearing content), so a nested render would strand the
// OUTER document's context: every `[^ref]` after the nested render rendered
// literal instead of a link. The fix saves and restores the prior context
// (mirroring the scoped setHtmlPolicy `previous` pattern). These pin it.

// A fence handler that recursively renders its own footnote-bearing content —
// the exact reentrancy the extension API allows. It installs and (previously)
// tore down the footnote context while the outer render was mid-flight.
const recursiveFootnoteHandler: FenceHandler = {
  render(code) {
    return `<div class="recursed">${renderMarkdownUnsafe(code)}</div>`
  },
}

describe('footnote-context reentrancy (#144)', () => {
  it('a recursive footnote render does not strand the outer context', () => {
    const md = [
      'Before[^a].',
      '',
      '```recurse',
      'inner ref[^x]',
      '',
      '[^x]: inner note.',
      '```',
      '',
      'After[^b].',
      '',
      '[^a]: note a.',
      '[^b]: note b.',
    ].join('\n')

    const html = renderMarkdownUnsafe(md, { fenceHandlers: { recurse: recursiveFootnoteHandler } })

    // The ref BEFORE the nested render links (never in question)…
    assert.match(html, /Before<sup class="footnote-ref"><a href="#fn-a"/)
    // …and the ref AFTER it still links — the regression was this rendering the
    // literal text `After[^b].` because the inner render cleared the context.
    assert.match(html, /After<sup class="footnote-ref"><a href="#fn-b"/)
    assert.doesNotMatch(html, /After\[\^b\]/)
    // Outer numbering is uninterrupted (1, then 2) — the inner render neither
    // consumed an outer number nor reset the sequence.
    assert.match(html, /href="#fn-a" id="fnref-a">1</)
    assert.match(html, /href="#fn-b" id="fnref-b">2</)
    // Both outer definitions appear in the trailing section.
    assert.match(html, /<li id="fn-a">/)
    assert.match(html, /<li id="fn-b">/)
    // The nested render produced its own, independent numbering (its ref is #1
    // within its own context, not #2 of the outer document).
    assert.match(html, /<div class="recursed">.*href="#fn-x" id="fnref-x">1<.*<\/div>/s)
  })

  it('a ref after the nested render resolves even when the outer has no earlier ref', () => {
    // Guards the pure-stranding case: nothing advances the outer context before
    // the nested render, so a null-restore would leave the sole outer ref literal.
    const md = [
      '```recurse',
      'inner[^x]',
      '',
      '[^x]: in.',
      '```',
      '',
      'After[^a].',
      '',
      '[^a]: note a.',
    ].join('\n')

    const html = renderMarkdownUnsafe(md, { fenceHandlers: { recurse: recursiveFootnoteHandler } })
    assert.match(html, /After<sup class="footnote-ref"><a href="#fn-a"/)
    assert.doesNotMatch(html, /After\[\^a\]/)
    assert.match(html, /<li id="fn-a">/)
  })
})
