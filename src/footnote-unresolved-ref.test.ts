import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { withConfig } from './config.ts'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from './streaming.ts'

/**
 * #230 — a footnote reference that is not (yet) resolvable keeps its literal
 * text but is wrapped in `<span class="footnote-ref-unresolved">`: visually
 * identical to GitHub's literal render, but addressable, so a streaming host
 * can dim or hide not-yet-defined citations until their definitions commit
 * and the reference upgrades to the numbered link in place (#110).
 */

const UNRESOLVED = 'footnote-ref-unresolved'

describe('unresolved footnote references wrap in a marker span (#230)', () => {
  it('wraps an unresolved ref, preserving the literal text', () => {
    assert.equal(
      renderMarkdownUnsafe('cite[^chat] here'),
      `<p>cite<span class="${UNRESOLVED}">[^chat]</span> here</p>`,
    )
  })

  it('renders a resolved ref as the numbered sup link, unwrapped', () => {
    const html = renderMarkdownUnsafe('cite[^a] here\n\n[^a]: def\n')
    assert.match(html, /<sup class="footnote-ref">/)
    assert.ok(!html.includes(UNRESOLVED))
  })

  it('leaves a ref followed by ( or [ to link resolution (GitHub reading)', () => {
    assert.equal(
      renderMarkdownUnsafe('see [^chat](http://x.example/) go'),
      '<p>see <a href="http://x.example/">^chat</a> go</p>',
    )
    const collapsed = renderMarkdownUnsafe('see [^chat][ref] go\n\n[ref]: http://x.example/\n')
    assert.ok(!collapsed.includes(UNRESOLVED), 'reference-link form stays out of the wrapper')
  })

  it('escapes HTML-dangerous label characters inside the wrapper', () => {
    assert.equal(
      renderMarkdownUnsafe('x [^<b>&] y'),
      `<p>x <span class="${UNRESOLVED}">[^&lt;b&gt;&amp;]</span> y</p>`,
    )
  })

  it('footnotes: false leaves the literal text untouched (no wrapper)', () => {
    assert.equal(
      withConfig({ footnotes: false }, () => renderMarkdownUnsafe('cite[^chat] here')),
      '<p>cite[^chat] here</p>',
    )
  })

  it('never wraps inside code spans', () => {
    const html = renderMarkdownUnsafe('use `[^chat]` syntax')
    assert.ok(!html.includes(UNRESOLVED))
    assert.match(html, /<code>\[\^chat\]<\/code>/)
  })

  it('wraps in the pending tail of both emitters', () => {
    const doc = 'cite[^chat] still going'
    const str = renderStreamingMarkdown(doc).toString()
    assert.ok(str.includes(`<span class="${UNRESOLVED}">[^chat]</span>`))
    const host = document.createElement('div')
    new StreamingMarkdownRenderer(host).update(doc)
    const pending = host.querySelector('.stream-complete p.stream-pending-block')
    assert.ok(pending?.querySelector(`span.${UNRESOLVED}`), 'DOM pending tail carries the wrapper')
  })

  it('upgrades the wrapper to a numbered link when the definition commits', () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.update('cite[^a] text\n\nmore prose\n\n')
    const complete = host.querySelector('.stream-complete') as HTMLElement
    assert.ok(complete.querySelector(`span.${UNRESOLVED}`), 'unresolved before the definition')
    renderer.update('cite[^a] text\n\nmore prose\n\n[^a]: the definition\n\n')
    assert.equal(complete.querySelector(`span.${UNRESOLVED}`), null, 'wrapper gone after resolve')
    assert.ok(complete.querySelector('sup.footnote-ref a'), 'numbered link in its place')
  })

  it('streamed output converges with the at-rest render at every clean commit', () => {
    const doc = 'A[^1] and B[^2].\n\nMiddle prose here.\n\n[^1]: first\n[^2]: second\n'
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    for (let cut = 1; cut <= doc.length; cut++) renderer.update(doc.slice(0, cut))
    assert.equal(
      host.querySelector('.stream-complete')?.innerHTML ?? '',
      sanitizeRenderedMarkdown(renderMarkdownUnsafe(doc)).toString(),
    )
  })
})
