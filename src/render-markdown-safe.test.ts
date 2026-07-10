// The safe, default entry point (#104): `renderMarkdown` returns HTML that has
// already passed the sink sanitizer, so it is safe to assign to `innerHTML`
// without a separate sanitize step. Uses jsdom + the DOMPurify backend (the
// setup registers it) so the real sink runs.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

describe('renderMarkdown (safe, default entry point) — #104', () => {
  it('renders ordinary markdown as sanitized element HTML', () => {
    assert.equal(renderMarkdown('# Hi\n\n**bold**'), '<h1>Hi</h1>\n<p><strong>bold</strong></p>')
  })

  it('strips <script> and its body — even though the raw renderer passes it through', () => {
    const md = 'before<script>alert(document.cookie)</script>after'
    // The unsafe path emits the raw <script> verbatim (passthrough default)…
    assert.match(renderMarkdownUnsafe(md), /<script>/)
    // …but the safe default has already been through the sink.
    const safe = renderMarkdown(md)
    assert.match(safe, /before/)
    assert.match(safe, /after/)
    assert.doesNotMatch(safe, /<script/i)
    assert.doesNotMatch(safe, /alert/) // body dropped, not just the tags
  })

  it('drops event handlers and dangerous hrefs', () => {
    assert.doesNotMatch(renderMarkdown('<a href="javascript:alert(1)">x</a>'), /javascript:/i)
    assert.doesNotMatch(renderMarkdown('<span onclick="steal()">x</span>'), /onclick/i)
    assert.doesNotMatch(renderMarkdown('<img src=x onerror=alert(1)>'), /onerror/i)
  })

  it('is exactly sanitizeRenderedMarkdown(renderMarkdownUnsafe(...)) — the documented equivalence', () => {
    for (const md of [
      '# Title\n\ntext with `code` and [link](https://example.com)',
      '<div class="card">body <b>x</b></div>',
      'before<script>bad()</script>after',
      '| a | b |\n| - | - |\n| 1 | 2 |',
    ]) {
      assert.equal(renderMarkdown(md), sanitizeRenderedMarkdown(renderMarkdownUnsafe(md)))
    }
  })

  it('honors the htmlPolicy option (escape literalizes structural tags before the sink)', () => {
    // Under escape, the raw tag is literalized to text; the sink leaves that text.
    assert.match(renderMarkdown('<div>hi</div>', { htmlPolicy: 'escape' }), /&lt;div&gt;hi&lt;\/div&gt;/)
  })

  it('returns a value usable anywhere a string is (branded SanitizedHtml)', () => {
    const html: string = renderMarkdown('plain')
    assert.equal(html, '<p>plain</p>')
  })
})
