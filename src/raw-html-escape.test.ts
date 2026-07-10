import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'

// Under the `'escape'` policy (the historical behavior, now an explicit opt-out
// — passthrough is the default, #600) the renderer preserves a small set of its
// own generated inline tags through the text-escaping pass (SAFE_OUTER_TAG_RE in
// escape.ts). Those tags are matched by shape, which a model can forge in raw
// prose, so the pass also re-validates tag CONTENT. These cases pin that
// boundary AND double as the guarantee that escape mode reproduces today's
// literal-escape output exactly: forged/dangerous tags must be escaped, while
// the renderer's own legitimate output must survive verbatim.
describe('raw-HTML escaping boundary (htmlPolicy: escape)', () => {
  const escaped = (md: string) => renderMarkdownUnsafe(md, { htmlPolicy: 'escape' })

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
