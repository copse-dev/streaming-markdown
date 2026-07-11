// Uses jsdom because the passthrough model defers to the DOMPurify sink as the
// sole arbiter — "renders as an element" / "is stripped" is a property of the
// SANITIZED output, not of the raw renderer string (#600). See
// docs/decisions/0002-raw-html-passthrough-default.md.
import '../tests/setup-dom-jsdom.ts'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from './streaming.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { setDefaultConfig } from './config.ts'

/** The default (passthrough) render, through the reference sink — the real path. */
const sank = (md: string): string => sanitizeRenderedMarkdown(renderMarkdownUnsafe(md))

describe('raw-HTML passthrough at rest (#600)', () => {
  it('renders allowlisted tags as real elements, preserving allowlisted attributes', () => {
    assert.equal(sank('<span class="x">hi</span>'), '<p><span class="x">hi</span></p>')
    // A block-level allowlisted tag renders as an element too (the sink reparents
    // it out of the auto-wrapped paragraph, which is fine — it is a real <div>).
    assert.match(sank('<div>hello</div>'), /<div>hello<\/div>/)
    // A hand-typed allowlisted table is a real table after the sink normalizes it.
    assert.match(sank('<table><tr><td>c</td></tr></table>'), /<table><tbody><tr><td>c<\/td>/)
  })

  it('unwraps a benign non-allowlisted tag to its text instead of literalizing it', () => {
    const html = sank('<article>content</article>')
    assert.match(html, /content/) // text survives
    assert.doesNotMatch(html, /<article/i) // tag is gone (stripped/unwrapped)
    assert.doesNotMatch(html, /&lt;article/i) // and NOT literalized as escaped prose
  })

  it('removes <script> entirely, contents included', () => {
    const html = sank('before<script>alert(document.cookie)</script>after')
    assert.match(html, /before/)
    assert.match(html, /after/)
    assert.doesNotMatch(html, /<script/i)
    assert.doesNotMatch(html, /alert/) // the script body is dropped, not just the tags
  })

  it('drops event handlers and dangerous hrefs on otherwise-allowlisted tags', () => {
    assert.doesNotMatch(sank('<a href="javascript:alert(1)">x</a>'), /javascript:/i)
    assert.doesNotMatch(sank('<span onclick="steal()">x</span>'), /onclick/i)
  })

  it('emits the raw tag verbatim from the (unsanitized) renderer string', () => {
    // The renderer defers to the sink: its own string output is intentionally
    // NOT self-safe under passthrough — hosts must sanitize (or opt into escape).
    assert.equal(renderMarkdownUnsafe('<div>hi</div>'), '<p><div>hi</div></p>')
  })
})

describe("htmlPolicy: 'escape' opt-out reproduces the historical literal-escape output", () => {
  it('literalizes every tag outside the benign inline allowlist', () => {
    assert.equal(renderMarkdownUnsafe('<div>hi</div>', { htmlPolicy: 'escape' }), '<p>&lt;div&gt;hi&lt;/div&gt;</p>')
    assert.equal(
      renderMarkdownUnsafe('<script>x</script>', { htmlPolicy: 'escape' }),
      '<p>&lt;script&gt;x&lt;/script&gt;</p>',
    )
  })

  it('still passes the benign attribute-less inline allowlist through', () => {
    assert.equal(renderMarkdownUnsafe('a <sub>2</sub> b', { htmlPolicy: 'escape' }), '<p>a <sub>2</sub> b</p>')
  })

  it('leaves ordinary escaped text (a lone `<`, `a < b`) identical under both policies', () => {
    for (const md of ['a < b', '5 < 6 && 7 > 3', 'x <3 y']) {
      assert.equal(renderMarkdownUnsafe(md), renderMarkdownUnsafe(md, { htmlPolicy: 'escape' }), md)
    }
  })
})

describe('raw-HTML passthrough while streaming (#600, #21/#29)', () => {
  it('holds a tag arriving in fragments — no partial/unsafe DOM before it closes', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    // Feed the tag one character at a time; until the `>` arrives the forming
    // tag is held out of the visible tail.
    const full = 'intro <div class="x">hi</div>'
    for (let i = 1; i <= 'intro <div class="x"'.length; i++) {
      r.update(full.slice(0, i))
      const text = host.textContent ?? ''
      // The half-typed tag source never surfaces as visible text…
      assert.doesNotMatch(text, /<div/)
      assert.doesNotMatch(text, /class=/)
      // …and no partial/dangerous element is ever attached.
      assert.equal(host.querySelectorAll('script').length, 0)
    }
  })

  it('a raw element straddling the freeze boundary settles byte-identically to at rest', () => {
    // `<div>…</div>` opens, spans a blank-line block boundary, and closes — the
    // hard case the design note calls out. Stream it in small chunks, then assert
    // the committed DOM equals a fresh full sanitized render (the #21/#29
    // frozen-tail byte-identity invariant).
    // Trailing blank line so the final `after` paragraph also commits — then the
    // whole committed region must equal a fresh full sanitized render.
    const doc = 'para one\n\n<div class="card">body <b>x</b></div>\n\nafter\n\n'
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    for (let i = 1; i <= doc.length; i++) r.update(doc.slice(0, i))
    const committed = host.querySelector('.stream-complete')?.innerHTML ?? ''
    assert.equal(committed, sank(doc))
    assert.match(committed, /<div class="card">body <b>x<\/b><\/div>/)
  })

  it('never leaks partial tag source or an unsanitized script across any prefix cut', () => {
    const doc = 'lead <span class="k">key</span> and <script>bad()</script> tail\n\nnext'
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    for (let i = 1; i <= doc.length; i++) {
      r.update(doc.slice(0, i))
      assert.equal(host.querySelectorAll('script').length, 0)
      assert.doesNotMatch(host.innerHTML, /bad\(\)/)
    }
    // The committed frame renders the allowlisted span and drops the script body.
    const committed = host.querySelector('.stream-complete')?.innerHTML ?? ''
    assert.match(committed, /<span class="k">key<\/span>/)
    assert.doesNotMatch(committed, /bad\(\)/)
  })

  it('the string streaming path commits raw HTML identically to the at-rest render', () => {
    // For a fully-committed prefix (trailing blank line), the streaming string
    // emitter must equal the at-rest sanitized render of the same prefix.
    const prefix = '# Title\n\n<div class="note"><b>hi</b></div>\n\n'
    assert.equal(renderStreamingMarkdown(prefix), sank(prefix))
  })

  it('a block element opened and closed across blank-line blocks freezes byte-identically', () => {
    // `<div>` (allowlisted) opens, spans blank-line block boundaries, then closes.
    // The frozen-tail path must not close it early per-fragment (which would spill
    // the inner blocks OUT of the element) — every committed frame must match the
    // whole-string render. Regression for the passthrough freeze guard (#600).
    const doc = 'p0\n\n<div class="wrap">\n\ninner one\n\ninner two\n\n</div>\n\nafter\n\n'
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    for (let i = 1; i <= doc.length; i++) r.update(doc.slice(0, i))
    const committed = host.querySelector('.stream-complete')?.innerHTML ?? ''
    assert.equal(committed, sank(doc))
    // The inner blocks are INSIDE the div, not siblings after it.
    assert.match(committed, /<div class="wrap">[\s\S]*inner one[\s\S]*inner two[\s\S]*<\/div>/)
  })
})

// A collapsible element that HIDES its children by default: the streaming tail
// must not flash the collapsed body, and committed children must live inside the
// element (not spill out as visible siblings). Needs the host to allowlist
// details/summary so they render as real elements.
describe('raw-HTML passthrough: forming <details> (#600)', () => {
  // The whole block renders with details/summary allowlisted; install it as the
  // process default for the block and clear it after (the `setDefaultConfig`
  // "install once" seam), so entry points and the low-level `sank` helper all see it.
  beforeEach(() =>
    setDefaultConfig({ sanitizeExtension: { allowedTags: ['details', 'summary'] } }),
  )
  afterEach(() => setDefaultConfig({ sanitizeExtension: null }))

  const DOC = [
    '<details>',
    '<summary>Click to expand</summary>',
    '',
    'secret one',
    '',
    'secret two',
    '',
    '</details>',
    '',
    'after the details.',
    '',
  ].join('\n')

  it('keeps committed children inside the collapsed <details>, byte-identical to at rest', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    for (let i = 1; i <= DOC.length; i++) r.update(DOC.slice(0, i))
    const committed = host.querySelector('.stream-complete')?.innerHTML ?? ''
    assert.equal(committed, sank(DOC))
    // Both body paragraphs are inside the <details>, before its close.
    assert.match(committed, /<details>[\s\S]*secret one[\s\S]*secret two[\s\S]*<\/details>/)
  })

  it('never flashes the collapsed body in the pending tail while the body streams', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    // Cut mid-body: `secret two` is still forming and `</details>` has not arrived.
    const cut = '<details>\n<summary>Click to expand</summary>\n\nsecret one\n\nsecret tw'
    for (let i = 1; i <= cut.length; i++) {
      r.update(cut.slice(0, i))
      const pendingEls = host.querySelectorAll(
        '.stream-pending-block, .stream-pending:not([hidden])',
      )
      for (const el of pendingEls) {
        assert.doesNotMatch(el.textContent ?? '', /secret (one|two)/)
      }
    }
  })

  it('holds the pending tail in the string path too while <details> is open', () => {
    const cut = '<details>\n<summary>Click to expand</summary>\n\nsecret one\n\nsecret tw'
    const out = renderStreamingMarkdown(cut)
    assert.doesNotMatch(out, /stream-pending/)
    assert.doesNotMatch(out, /secret tw/) // the forming body line is held, not shown
    assert.match(out, /<summary>Click to expand<\/summary>/) // the summary still committed
  })

  it('reveals the pending tail again once the <details> closes', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    // Full details committed, then a new paragraph streams after it.
    r.update('<details>\n<summary>S</summary>\n\nbody\n\n</details>\n\nafter tai')
    const pending = host.querySelector('.stream-pending-block, .stream-pending:not([hidden])')
    assert.match(pending?.textContent ?? '', /after tai/)
  })

  it('DOM emitter holds the tail when the open <details> is the unsettled tail (#138)', () => {
    // The <details> is open and the whole run (soft-broken, single newlines) is
    // still the unsettled tail, so nothing has frozen and the incremental fast
    // path runs with an empty delta. It previously left the open-`<details>` flag
    // unset — so the DOM emitter flashed the collapsed body even though the
    // string emitter held it. Both must hold it now.
    const cut = '<details>\n<summary>x</summary>\nsecret pending tail'
    const host = document.createElement('div')
    new StreamingMarkdownRenderer(host).update(cut)
    const pendingEls = host.querySelectorAll('.stream-pending-block, .stream-pending:not([hidden])')
    for (const el of pendingEls) {
      assert.doesNotMatch(el.textContent ?? '', /secret pending tail/)
    }
    // No desync: the DOM committed subtree equals the string emitter's output.
    const domCommitted = host.querySelector('.stream-complete')?.innerHTML ?? ''
    assert.equal(domCommitted, sanitizeRenderedMarkdown(renderStreamingMarkdown(cut)).toString())
  })
})

// A realistic agent-style document that embeds raw HTML — the at-rest
// regression fixture. Allowlisted structure renders; non-allowlisted
// (<details>/<summary>) unwraps; a stray script is removed entirely.
const RAW_HTML_DOCUMENT = [
  '# Release notes',
  '',
  'Highlights this cycle:',
  '',
  '<ul>',
  '<li>Faster streaming</li>',
  '<li>Raw-HTML <b>passthrough</b></li>',
  '</ul>',
  '',
  '<details>',
  '<summary>Internal details</summary>',
  'Deferred to the sink sanitizer.',
  '</details>',
  '',
  '<div class="callout">See the <a href="https://example.com/docs">docs</a>.</div>',
  '',
  '<script>trackPageView()</script>',
  '',
  'Thanks for reading.',
].join('\n')

describe('raw-HTML at-rest regression fixture (#600)', () => {
  const html = sank(RAW_HTML_DOCUMENT)

  it('renders allowlisted structure as real elements', () => {
    assert.match(html, /<ul>/)
    assert.match(html, /<li>Faster streaming<\/li>/)
    assert.match(html, /Raw-HTML <b>passthrough<\/b>/)
    assert.match(html, /<div class="callout">/)
    assert.match(html, /<a href="https:\/\/example\.com\/docs"[^>]*>docs<\/a>/)
  })

  it('unwraps non-allowlisted <details>/<summary> to their text', () => {
    assert.doesNotMatch(html, /<details/i)
    assert.doesNotMatch(html, /<summary/i)
    assert.doesNotMatch(html, /&lt;details/i) // not literalized either
    assert.match(html, /Internal details/)
    assert.match(html, /Deferred to the sink sanitizer\./)
  })

  it('removes the embedded script entirely', () => {
    assert.doesNotMatch(html, /<script/i)
    assert.doesNotMatch(html, /trackPageView/)
  })

  it("escape mode literalizes the same document's structural tags", () => {
    const escaped = renderMarkdownUnsafe(RAW_HTML_DOCUMENT, { htmlPolicy: 'escape' })
    assert.match(escaped, /&lt;div class=&quot;callout&quot;&gt;/)
    assert.match(escaped, /&lt;script&gt;trackPageView\(\)&lt;\/script&gt;/)
  })
})
