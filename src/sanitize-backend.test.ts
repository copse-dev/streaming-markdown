// Backend-swapping and native-Sanitizer-narrowing coverage. Uses jsdom for a
// spec-complete DOM; jsdom has no native `Element.setHTML`, so the full browser
// backend can't run here, but its allowlist-narrowing walk (the security-critical
// part) is exercised directly against pre-parsed DOM.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeRenderedMarkdown,
  type SanitizerBackend,
} from './sanitize.ts'
import {
  browserSanitizerBackend,
  enforceSanitizerAllowlist,
  isBrowserSanitizerSupported,
} from './sanitize-browser.ts'
import { withConfig } from './config.ts'

// setup-dom-jsdom installs the DOMPurify backend as the process default; each
// test that needs a different backend scopes it with `withConfig` for the single
// render, so no per-test restore is needed.

describe('sanitizerBackend', () => {
  it('routes sanitization through a swapped-in backend', () => {
    const seen: string[] = []
    const recordingBackend: SanitizerBackend = {
      sanitize(html) {
        seen.push(html)
        return '<p>from custom backend</p>'
      },
    }
    const out = withConfig({ sanitizerBackend: recordingBackend }, () =>
      sanitizeRenderedMarkdown('<p>hi</p>'),
    )
    assert.equal(out, '<p>from custom backend</p>')
    assert.deepEqual(seen, ['<p>hi</p>'])
  })

  it('passes the merged core allowlist and an onElement gate to the backend', () => {
    const tags: string[] = []
    let hasGate = false
    withConfig(
      {
        sanitizerBackend: {
          sanitize(_html, config) {
            tags.push(...config.allowedTags)
            hasGate = typeof config.onElement === 'function'
            return ''
          },
        },
      },
      () => sanitizeRenderedMarkdown('<p>x</p>'),
    )
    assert.ok(tags.includes('p'))
    assert.ok(tags.includes('code'))
    assert.equal(hasGate, true)
  })

  it('throws (never returns unsanitized HTML) when no backend is available', () => {
    if (isBrowserSanitizerSupported()) return // real browser: default backend works
    // `sanitizerBackend: null` falls back to the native API, which jsdom lacks.
    withConfig({ sanitizerBackend: null }, () => {
      assert.throws(() => sanitizeRenderedMarkdown('<p>x</p>'), /No HTML sanitizer backend/)
    })
  })
})

describe('isBrowserSanitizerSupported', () => {
  it('is false under jsdom (no native Element.setHTML)', () => {
    assert.equal(isBrowserSanitizerSupported(), false)
  })
})

// The native browser backend narrows an already-parsed subtree to the allowlist.
// These drive that walk directly, standing in for the native Sanitizer parse.
describe('enforceSanitizerAllowlist (native backend narrowing)', () => {
  function parse(html: string): HTMLDivElement {
    const root = document.createElement('div')
    root.innerHTML = html
    return root
  }

  const config = {
    allowedTags: ['p', 'strong', 'a', 'code'],
    allowedAttr: ['href', 'class'],
  }

  it('drops disallowed tags but keeps their text content', () => {
    const root = parse('<p>keep</p><section>bare text</section>')
    enforceSanitizerAllowlist(root, config)
    assert.equal(root.innerHTML, '<p>keep</p>bare text')
  })

  it('strips attributes outside the allowlist, event handlers included', () => {
    const root = parse('<a href="/x" class="c" onclick="evil()" style="position:fixed">link</a>')
    enforceSanitizerAllowlist(root, config)
    assert.equal(root.innerHTML, '<a href="/x" class="c">link</a>')
  })

  // `data-*` is the deliberate exception: it passes generically, matching
  // DOMPurify's `ALLOW_DATA_ATTR` default so the two backends agree
  // (sanitize-data-attributes.test.ts pins that parity).
  it('keeps data-* without an allowlist entry', () => {
    const root = parse('<a href="/x" data-x="1" data-footnote-ref>link</a>')
    enforceSanitizerAllowlist(root, config)
    assert.equal(root.innerHTML, '<a href="/x" data-x="1" data-footnote-ref="">link</a>')
  })

  it('drops content of dangerous containers rather than unwrapping them', () => {
    const root = parse('<p>ok</p><style>.x{color:red}</style>')
    enforceSanitizerAllowlist(root, config)
    assert.equal(root.innerHTML, '<p>ok</p>')
  })

  it('runs onElement for every kept element and honours removals', () => {
    const root = parse('<p class="drop-me">a</p><p class="keep">b</p>')
    enforceSanitizerAllowlist(root, {
      ...config,
      onElement(node) {
        if (node.getAttribute('class') === 'drop-me') node.remove()
      },
    })
    assert.equal(root.innerHTML, '<p class="keep">b</p>')
  })
})

// The full native backend calls `Element.setHTML`, which jsdom lacks; stub it to
// stand in for the native Sanitizer parse. `setHTML`'s *default* config strips
// `class` (breaking highlight.js/mermaid hooks), so the backend must hand it the
// allowlist — these assert it does, and that the result survives end to end.
describe('browserSanitizerBackend (native setHTML path)', () => {
  type SetHTMLOptions = {
    sanitizer?: { elements?: readonly string[]; attributes?: readonly string[] }
  }
  type SetHTMLFn = (this: Element, html: string, options?: SetHTMLOptions) => void

  function withSetHTML(impl: SetHTMLFn, run: () => void): void {
    const proto = Element.prototype as unknown as { setHTML?: SetHTMLFn }
    const had = Object.prototype.hasOwnProperty.call(proto, 'setHTML')
    const orig = proto.setHTML
    proto.setHTML = impl
    try {
      run()
    } finally {
      if (had && orig) proto.setHTML = orig
      else delete proto.setHTML
    }
  }

  const config = { allowedTags: ['pre', 'code', 'span'], allowedAttr: ['class'] }
  const input =
    '<pre><code class="hljs lang-ts"><span class="hljs-keyword">const</span></code></pre>'

  it('passes the allowlist (incl. class) to setHTML and keeps hljs class hooks', () => {
    let passed: SetHTMLOptions | undefined
    withSetHTML(
      function (html, options) {
        passed = options
        // A config-respecting setHTML keeps `class`; the default config strips it,
        // which is the regression this guards. The allowlist walk narrows the rest.
        this.innerHTML = html
      },
      () => {
        const out = browserSanitizerBackend.sanitize(input, config)
        assert.ok(
          passed?.sanitizer?.attributes?.includes('class'),
          'class passed to the setHTML attribute allowlist',
        )
        assert.ok(
          passed?.sanitizer?.elements?.includes('span'),
          'span passed to the setHTML element allowlist',
        )
        assert.match(out, /<span class="hljs-keyword">const<\/span>/)
      },
    )
  })

  it('sanitizeInto parses in a detached div host and moves the nodes into the target', () => {
    withSetHTML(
      function (html) {
        this.innerHTML = html
      },
      () => {
        const target = document.createElement('code')
        target.innerHTML = 'stale'
        browserSanitizerBackend.sanitizeInto?.(target, input, config)
        // Serializes exactly like the string path (same div-host parse context).
        assert.equal(target.innerHTML, browserSanitizerBackend.sanitize(input, config))
      },
    )
  })

  it('falls back to plain setHTML when the options argument is rejected', () => {
    let plainCalls = 0
    withSetHTML(
      function (html, options) {
        if (options) throw new TypeError('options not supported')
        plainCalls++
        this.innerHTML = html
      },
      () => {
        const out = browserSanitizerBackend.sanitize(input, config)
        assert.equal(plainCalls, 1)
        // Still narrows to the allowlist (class is allowed here, so it survives).
        assert.match(out, /class="hljs-keyword"/)
      },
    )
  })
})
