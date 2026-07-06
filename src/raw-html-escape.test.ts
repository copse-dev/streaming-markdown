import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'

// The renderer preserves a small set of its own generated inline tags through
// the text-escaping pass (SAFE_OUTER_TAG_RE in escape.ts). Those tags are matched
// by shape, which a model can forge in raw prose, so the pass also re-validates
// tag CONTENT. These cases pin that boundary: forged/dangerous tags must be
// escaped, while the renderer's own legitimate output must survive verbatim.
describe('raw-HTML escaping boundary', () => {
  const escaped = (md: string) => renderMarkdown(md)

  it('escapes a raw javascript: anchor typed in prose', () => {
    const html = escaped('<a href="javascript:alert(1)">click</a>')
    assert.doesNotMatch(html, /<a href="javascript:/i)
    assert.match(html, /&lt;a href=&quot;javascript:/i)
  })

  it('escapes a raw data: anchor', () => {
    const html = escaped('<a href="data:text/html,<script>alert(1)</script>">x</a>')
    assert.doesNotMatch(html, /<a href="data:/i)
  })

  it('escapes an entity-obfuscated javascript: anchor', () => {
    const html = escaped('<a href="&#x6a;avascript:alert(1)">x</a>')
    assert.doesNotMatch(html, /<a href="&#x6a;avascript:/i)
  })

  it('escapes a forged data-md-rendered img with an onerror handler', () => {
    const html = escaped('<img src=x onerror="alert(1)" data-md-rendered="1">')
    assert.doesNotMatch(html, /<img[^>]*onerror/i)
    assert.match(html, /&lt;img/i)
  })

  it('escapes a forged data-md-rendered img with a javascript: src', () => {
    const html = escaped('<img data-md-rendered="1" src="javascript:x">')
    assert.doesNotMatch(html, /<img[^>]*src="javascript:/i)
  })

  it('escapes an attributed em carrying an event handler', () => {
    const html = escaped('<em onmouseover="alert(1)">x</em>')
    assert.doesNotMatch(html, /<em[^>]*onmouseover/i)
  })

  it('escapes an attributed code carrying an event handler', () => {
    const html = escaped('<code onmouseover="alert(1)">x</code>')
    assert.doesNotMatch(html, /<code[^>]*onmouseover/i)
  })

  it('preserves a legitimate markdown link', () => {
    assert.match(escaped('[link](https://example.com)'), /<a href="https:\/\/example\.com"/)
  })

  it('preserves a legitimate rendered image', () => {
    assert.match(escaped('![moon](moon.jpg)'), /<img src="moon\.jpg" alt="moon" data-md-rendered="1" \/>/)
  })

  it('preserves autolinks with uncommon-but-inert schemes', () => {
    assert.match(escaped('<ftp://example.com/x>'), /<a href="ftp:\/\/example\.com\/x">/)
    assert.match(escaped('<foo://bar>'), /<a href="foo:\/\/bar">/)
  })

  it('preserves benign attribute-less inline HTML', () => {
    assert.match(escaped('<sub>2</sub> and <kbd>Esc</kbd>'), /<sub>2<\/sub> and <kbd>Esc<\/kbd>/)
  })
})

// The angle-autolink verbatim pattern must match email autolinks in linear time;
// an unclosed `<a@word.word…` previously drove quadratic backtracking (ReDoS) on
// every inline segment the code-span / backslash-escape passes scan.
describe('angle-autolink ReDoS resistance', () => {
  it('renders a long unclosed pseudo-autolink without super-linear blowup', () => {
    const md = 'before <a@' + 'word.'.repeat(20000) + ' after'
    const start = process.hrtime.bigint()
    renderMarkdown(md)
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    // Quadratic behaviour took seconds at a fraction of this size; a generous
    // ceiling still fails loudly if the backtracking pattern is reintroduced.
    assert.ok(elapsedMs < 1000, `render took ${elapsedMs.toFixed(0)}ms (expected linear)`)
  })
})
