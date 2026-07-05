// Backend-swapping and native-Sanitizer-narrowing coverage. Uses jsdom for a
// spec-complete DOM; jsdom has no native `Element.setHTML`, so the full browser
// backend can't run here, but its allowlist-narrowing walk (the security-critical
// part) is exercised directly against pre-parsed DOM.
import '../tests/setup-dom-jsdom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeRenderedMarkdown,
  setSanitizerBackend,
  type SanitizerBackend,
} from './sanitize.ts'
import {
  enforceSanitizerAllowlist,
  isBrowserSanitizerSupported,
} from './sanitize-browser.ts'
import { dompurifyBackend } from './sanitize-dompurify.ts'

// setup-dom-jsdom registers the DOMPurify backend; restore it after any test
// that swaps the backend so the rest of the suite is unaffected.
afterEach(() => setSanitizerBackend(dompurifyBackend))

describe('setSanitizerBackend', () => {
  it('routes sanitization through a swapped-in backend', () => {
    const seen: string[] = []
    const recordingBackend: SanitizerBackend = {
      sanitize(html) {
        seen.push(html)
        return '<p>from custom backend</p>'
      },
    }
    setSanitizerBackend(recordingBackend)
    const out = sanitizeRenderedMarkdown('<p>hi</p>')
    assert.equal(out, '<p>from custom backend</p>')
    assert.deepEqual(seen, ['<p>hi</p>'])
  })

  it('passes the merged core allowlist and an onElement gate to the backend', () => {
    const tags: string[] = []
    let hasGate = false
    setSanitizerBackend({
      sanitize(_html, config) {
        tags.push(...config.allowedTags)
        hasGate = typeof config.onElement === 'function'
        return ''
      },
    })
    sanitizeRenderedMarkdown('<p>x</p>')
    assert.ok(tags.includes('p'))
    assert.ok(tags.includes('code'))
    assert.equal(hasGate, true)
  })

  it('throws (never returns unsanitized HTML) when no backend is available', () => {
    // Clearing the backend falls back to the native API, which jsdom lacks.
    setSanitizerBackend(null)
    if (isBrowserSanitizerSupported()) return // real browser: default backend works
    assert.throws(() => sanitizeRenderedMarkdown('<p>x</p>'), /No HTML sanitizer backend/)
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

  it('strips attributes outside the allowlist', () => {
    const root = parse('<a href="/x" class="c" onclick="evil()" data-x="1">link</a>')
    enforceSanitizerAllowlist(root, config)
    assert.equal(root.innerHTML, '<a href="/x" class="c">link</a>')
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
