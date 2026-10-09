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

  it('links allowlisted-scheme autolinks and drops unlisted ones (#139)', () => {
    // ftp is on the default scheme allowlist, so it still links…
    assert.match(escaped('<ftp://example.com/x>'), /<a href="ftp:\/\/example\.com\/x">/)
    // …but an arbitrary scheme now fails closed (autolinks share the markdown-link
    // allowlist) rather than rendering a live `<a href>`.
    assert.doesNotMatch(escaped('<foo://bar>'), /<a /)
  })

  it('preserves benign attribute-less inline HTML', () => {
    assert.match(escaped('<sub>2</sub> and <kbd>Esc</kbd>'), /<sub>2<\/sub> and <kbd>Esc<\/kbd>/)
  })

  // #146 dropped the host-specific `data-*` link attributes from the core
  // allowlists, but only the sink got a replacement hook — this gate was left
  // with none, so a host `linkDecorator` emitting them had its `<a …>` open tag
  // escaped to literal text while the matching `</a>` survived. The gate now
  // matches the generic `data-*` shape.
  describe('anchors carrying decorator data-* attributes', () => {
    const decorated = (attrs: string, policy: 'escape' | 'escape-all' = 'escape') =>
      renderMarkdownUnsafe('[the docs](https://example.com/page)', {
        htmlPolicy: policy,
        linkDecorator: () => attrs,
      })

    it('preserves a host decorator\u2019s browser-link anchor', () => {
      const html = decorated(' target="_blank" rel="noopener noreferrer" data-browser-link="true"')
      assert.match(html, /<a href="https:\/\/example\.com\/page" target="_blank" rel="noopener noreferrer" data-browser-link="true">/)
      assert.doesNotMatch(html, /&lt;a /)
    })

    it('preserves a host decorator\u2019s workspace-link anchor', () => {
      const html = decorated(' class="workspace-markdown-link" data-workspace-link="true"')
      assert.match(html, /<a href="[^"]*" class="workspace-markdown-link" data-workspace-link="true">/)
      assert.doesNotMatch(html, /&lt;a /)
    })

    it('preserves them under escape-all too', () => {
      const html = decorated(' data-browser-link="true"', 'escape-all')
      assert.match(html, /<a href="[^"]*" data-browser-link="true">/)
    })

    it('leaves no stray unbalanced </a> behind', () => {
      const html = decorated(' data-browser-link="true"')
      assert.equal((html.match(/<a /g) ?? []).length, (html.match(/<\/a>/g) ?? []).length)
    })

    it('accepts a valueless data attribute and interleaved ordering', () => {
      assert.match(decorated(' data-x class="c" data-y="1" title="t"'), /<a href="[^"]*" data-x class="c" data-y="1" title="t">/)
    })

    it('still escapes a raw anchor whose data-* rides alongside an event handler', () => {
      const html = escaped('<a href="https://example.com" data-browser-link="true" onclick="alert(1)">x</a>')
      assert.doesNotMatch(html, /<a[^>]*onclick/i)
      assert.match(html, /&lt;a /i)
    })

    it('still escapes a raw javascript: anchor wearing a data-* attribute', () => {
      const html = escaped('<a href="javascript:alert(1)" data-workspace-link="true">x</a>')
      assert.doesNotMatch(html, /<a href="javascript:/i)
      assert.match(html, /&lt;a /i)
    })

    it('drops a non-data unknown attribute but keeps the anchor', () => {
      assert.match(escaped('<a href="https://example.com" datax="1">x</a>'), /<a href="https:\/\/example\.com">/)
    })
  })

  // The shape test above is all-or-nothing and fails badly, not safely: `</a>`
  // is a separate arm and survives on its own, so one unrecognised attribute
  // used to yield escaped source text plus a stray unbalanced close tag.
  describe('unrecognised anchor attributes degrade instead of mangling', () => {
    it('drops the unknown attribute and keeps a well-formed anchor', () => {
      const html = escaped('<a href="https://example.com" style="position:fixed" datax="1">x</a>')
      assert.match(html, /<a href="https:\/\/example\.com">x<\/a>/)
      assert.doesNotMatch(html, /style=/i)
    })

    it('leaves no unbalanced </a> for an unrecognised attribute', () => {
      const html = escaped('<a href="https://example.com" style="x">y</a>')
      assert.equal((html.match(/<a /g) ?? []).length, (html.match(/<\/a>/g) ?? []).length)
    })

    it('keeps the allowlisted attributes while dropping the rest', () => {
      const html = escaped('<a href="https://example.com" style="x" class="c" data-k="v" title="t">y</a>')
      assert.match(html, /<a href="https:\/\/example\.com" class="c" data-k="v" title="t">/)
    })

    it('still refuses a dangerous scheme rather than narrowing to it', () => {
      const html = escaped('<a href="javascript:alert(1)" style="x">y</a>')
      assert.doesNotMatch(html, /<a href="javascript:/i)
      assert.match(html, /&lt;a /i)
    })

    it('still refuses an event handler rather than dropping just that attribute', () => {
      const html = escaped('<a href="https://example.com" onclick="alert(1)">y</a>')
      assert.doesNotMatch(html, /<a /i)
      assert.match(html, /&lt;a /i)
    })

    it('leaves an unquoted href escaped whole (no scheme to validate)', () => {
      assert.match(escaped('<a href=javascript:alert(1) style="x">y</a>'), /&lt;a /i)
    })

    it('does not turn a non-anchor unknown tag into markup', () => {
      assert.match(escaped('<div class="x">y</div>'), /&lt;div /i)
    })

    it('does not mint an href-less anchor from a href-shaped attribute value', () => {
      assert.match(escaped('<a data-x="href=">y</a>'), /&lt;a /i)
    })
  })
})
