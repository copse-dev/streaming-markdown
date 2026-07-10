// Uses jsdom because DOMPurify (the backend registered by the setup file) needs
// a spec-complete DOM, and because the origin policy runs at the sink gate over
// real parsed `<a>`/`<img>` elements.
import '../tests/setup-dom-jsdom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyLinkImagePolicy,
  getLinkImagePolicy,
  setLinkImagePolicy,
} from './link-image-policy.ts'
import {
  sanitizeRenderedMarkdown,
  setSanitizeExtension,
  setSanitizerBackend,
} from './sanitize.ts'
import { enforceSanitizerAllowlist } from './sanitize-browser.ts'
import { dompurifyBackend } from './sanitize-dompurify.ts'
import { setSanitizedHtml } from './html-sink.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

// Allow `<img>` through the core sink so the image policy has something to gate
// (image handling is otherwise host-injected). Mirrors what a real image host
// widens via setSanitizeExtension.
const IMG_EXTENSION = { allowedTags: ['img'], allowedAttr: ['src', 'alt'] }

const APP_ORIGIN = 'https://app.example.com'

// Every test that installs global registry state restores the defaults so the
// rest of the suite (and other suites) is unaffected — the convention the other
// registry tests (link-decorator, sanitize-backend) follow.
afterEach(() => {
  setLinkImagePolicy(null)
  setSanitizeExtension(null)
  setSanitizerBackend(dompurifyBackend)
})

function sanitizeImg(tag: string): string {
  setSanitizeExtension(IMG_EXTENSION)
  return sanitizeRenderedMarkdown(tag)
}

describe('setLinkImagePolicy — default (no policy)', () => {
  it('leaves rendered links byte-identical to today', () => {
    const html = renderMarkdownUnsafe('[docs](https://docs.example.com/page) and <https://auto.example.com>')
    const baseline = sanitizeRenderedMarkdown(html)
    assert.doesNotMatch(baseline, /blocked-link/)
    // Installing then removing a policy restores the exact baseline.
    setLinkImagePolicy({
      allowedLinkPrefixes: [],
      allowedImagePrefixes: [],
      defaultOrigin: APP_ORIGIN,
    })
    setLinkImagePolicy(null)
    assert.equal(sanitizeRenderedMarkdown(html), baseline)
  })

  it('getLinkImagePolicy reports null when unconfigured', () => {
    assert.equal(getLinkImagePolicy(), null)
  })

  it('getLinkImagePolicy round-trips the installed policy with defaults resolved', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: ['https://docs.example.com/'],
      allowedImagePrefixes: ['https://cdn.example.com/'],
      defaultOrigin: APP_ORIGIN,
    })
    const policy = getLinkImagePolicy()
    assert.ok(policy)
    assert.deepEqual(policy.allowedLinkPrefixes, ['https://docs.example.com/'])
    assert.deepEqual(policy.allowedImagePrefixes, ['https://cdn.example.com/'])
    assert.equal(policy.defaultOrigin, APP_ORIGIN)
    // Defaults are resolved on the way out.
    assert.equal(policy.allowDataImages, true)
    assert.equal(policy.blockedLinkClass, 'blocked-link')
    assert.equal(policy.blockedImageClass, 'blocked-image')
  })
})

describe('setLinkImagePolicy — links', () => {
  it('passes allowed absolute links untouched', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: ['https://docs.example.com/'],
      allowedImagePrefixes: [],
      defaultOrigin: APP_ORIGIN,
    })
    const html = sanitizeRenderedMarkdown(
      '<a href="https://docs.example.com/guide" target="_blank">x</a>',
    )
    assert.match(html, /href="https:\/\/docs\.example\.com\/guide"/)
    assert.doesNotMatch(html, /blocked-link/)
  })

  it('rewrites a blocked link to defaultOrigin and tags it', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: ['https://docs.example.com/'],
      allowedImagePrefixes: [],
      defaultOrigin: APP_ORIGIN,
    })
    const html = sanitizeRenderedMarkdown('<a href="https://evil.com/phish">x</a>')
    assert.match(html, /href="https:\/\/app\.example\.com\/?"/)
    assert.doesNotMatch(html, /evil\.com/)
    assert.match(html, /class="[^"]*blocked-link/)
  })

  it('neutralizes a blocked link (drops href) when defaultOrigin is empty', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: ['https://docs.example.com/'],
      allowedImagePrefixes: [],
      defaultOrigin: '',
    })
    const html = sanitizeRenderedMarkdown('<a href="https://evil.com/phish">x</a>')
    assert.doesNotMatch(html, /href=/)
    assert.doesNotMatch(html, /evil\.com/)
    assert.match(html, /class="[^"]*blocked-link/)
  })

  it('resolves an allowed relative link against defaultOrigin', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: [APP_ORIGIN + '/'],
      allowedImagePrefixes: [],
      defaultOrigin: APP_ORIGIN,
    })
    const html = sanitizeRenderedMarkdown('<a href="/docs/readme">x</a>')
    assert.match(html, /href="https:\/\/app\.example\.com\/docs\/readme"/)
    assert.doesNotMatch(html, /blocked-link/)
  })

  it('blocks a relative link that resolves outside the allowlist', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: ['https://app.example.com/docs/'],
      allowedImagePrefixes: [],
      defaultOrigin: APP_ORIGIN,
    })
    const html = sanitizeRenderedMarkdown('<a href="/admin/secret">x</a>')
    assert.match(html, /class="[^"]*blocked-link/)
  })

  it('applies to autolinks through the full pipeline', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: ['https://good.example.com/'],
      allowedImagePrefixes: [],
      defaultOrigin: APP_ORIGIN,
    })
    const html = sanitizeRenderedMarkdown(renderMarkdownUnsafe('see <https://evil.example.com/x>'))
    assert.match(html, /class="[^"]*blocked-link/)
    assert.doesNotMatch(html, /href="https:\/\/evil\.example\.com/)
  })

  it('honors a custom blockedLinkClass', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: [],
      allowedImagePrefixes: [],
      defaultOrigin: APP_ORIGIN,
      blockedLinkClass: 'sm-off-origin',
    })
    const html = sanitizeRenderedMarkdown('<a href="https://evil.com/">x</a>')
    assert.match(html, /class="[^"]*sm-off-origin/)
  })
})

describe('setLinkImagePolicy — link bypass hardening', () => {
  const policy = {
    allowedLinkPrefixes: ['https://good.com/'],
    allowedImagePrefixes: [],
    defaultOrigin: APP_ORIGIN,
  }

  const bypasses: Array<[string, string]> = [
    ['scheme-relative', '//evil.com/x'],
    ['case-folded scheme+host', 'HTTPS://Evil.COM/x'],
    ['embedded credentials', 'https://good.com@evil.com/x'],
    ['backslash authority', 'https:\\\\evil.com\\x'],
    ['leading whitespace', '   https://evil.com/x'],
    ['unicode confusable host', 'https://ех様evil.com/x'],
  ]

  for (const [name, href] of bypasses) {
    it(`blocks ${name} (${href})`, () => {
      setLinkImagePolicy(policy)
      // Feed the raw href straight into the sink (as a rendered anchor would).
      const html = sanitizeRenderedMarkdown(`<a href="${href.replace(/"/g, '&quot;')}">x</a>`)
      assert.match(html, /class="[^"]*blocked-link/, `${name} should be blocked`)
      assert.doesNotMatch(html, /evil/i, `${name} must not keep an evil host`)
    })
  }

  it('does NOT treat good.com@evil.com credentials as a match', () => {
    setLinkImagePolicy(policy)
    const html = sanitizeRenderedMarkdown('<a href="https://good.com@evil.com/x">x</a>')
    assert.match(html, /class="[^"]*blocked-link/)
  })
})

describe('setLinkImagePolicy — images', () => {
  it('passes an allowed image untouched', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: [],
      allowedImagePrefixes: ['https://cdn.example.com/'],
      defaultOrigin: APP_ORIGIN,
    })
    const html = sanitizeImg('<img src="https://cdn.example.com/a.png" alt="a">')
    assert.match(html, /src="https:\/\/cdn\.example\.com\/a\.png"/)
    assert.doesNotMatch(html, /blocked-image/)
  })

  it('neutralizes a blocked image by stripping src and tagging it', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: [],
      allowedImagePrefixes: ['https://cdn.example.com/'],
      defaultOrigin: APP_ORIGIN,
    })
    const html = sanitizeImg('<img src="https://tracker.evil.com/pixel.gif" alt="x">')
    assert.doesNotMatch(html, /src=/)
    assert.doesNotMatch(html, /evil\.com/)
    assert.match(html, /class="[^"]*blocked-image/)
    // Element and alt text survive.
    assert.match(html, /<img[^>]*alt="x"/)
  })

  it('leaves a src-less (deferred hydration) image alone', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: [],
      allowedImagePrefixes: ['https://cdn.example.com/'],
      defaultOrigin: APP_ORIGIN,
    })
    const html = sanitizeImg('<img alt="pending">')
    assert.doesNotMatch(html, /blocked-image/)
    // An explicitly empty src is treated the same (nothing to vet).
    assert.doesNotMatch(sanitizeImg('<img src="" alt="empty">'), /blocked-image/)
  })

  it('silently drops a malformed allowed-prefix entry instead of throwing', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: [],
      // `:://` is not a parseable URL — it must be dropped, not crash install.
      allowedImagePrefixes: [':://not a url', 'https://cdn.example.com/'],
      defaultOrigin: APP_ORIGIN,
    })
    assert.match(
      sanitizeImg('<img src="https://cdn.example.com/a.png" alt="a">'),
      /src="https:\/\/cdn\.example\.com\/a\.png"/,
    )
  })

  it('allows data: images by default (allowDataImages defaults true)', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: [],
      allowedImagePrefixes: [],
      defaultOrigin: APP_ORIGIN,
    })
    const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const html = sanitizeImg(`<img src="${data}" alt="d">`)
    assert.match(html, /src="data:image\/png;base64,/)
    assert.doesNotMatch(html, /blocked-image/)
  })

  it('strips base64 data: images when allowDataImages is false', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: [],
      allowedImagePrefixes: [],
      defaultOrigin: APP_ORIGIN,
      allowDataImages: false,
    })
    const html = sanitizeImg('<img src="data:image/png;base64,AAAA" alt="d">')
    assert.doesNotMatch(html, /src=/)
    assert.match(html, /class="[^"]*blocked-image/)
  })

  it('resolves an allowed relative image against defaultOrigin', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: [],
      allowedImagePrefixes: [APP_ORIGIN + '/'],
      defaultOrigin: APP_ORIGIN,
    })
    const html = sanitizeImg('<img src="/img/logo.png" alt="l">')
    assert.match(html, /src="https:\/\/app\.example\.com\/img\/logo\.png"/)
  })

  it('blocks a scheme-relative image src', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: [],
      allowedImagePrefixes: ['https://cdn.example.com/'],
      defaultOrigin: APP_ORIGIN,
    })
    const html = sanitizeImg('<img src="//evil.com/x.png" alt="x">')
    assert.doesNotMatch(html, /src=/)
    assert.match(html, /class="[^"]*blocked-image/)
  })
})

describe('setLinkImagePolicy — sink + backend coverage', () => {
  it('enforces through setSanitizedHtml (node path / Trusted-Types sink)', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: ['https://good.com/'],
      allowedImagePrefixes: [],
      defaultOrigin: APP_ORIGIN,
    })
    const el = document.createElement('div')
    setSanitizedHtml(el, '<a href="https://evil.com/x">x</a>')
    const anchor = el.querySelector('a')
    assert.ok(anchor)
    assert.ok(anchor.classList.contains('blocked-link'))
    assert.equal(anchor.getAttribute('href'), APP_ORIGIN)
  })

  it('applies under the native-backend allowlist walk (enforceSanitizerAllowlist)', () => {
    setLinkImagePolicy({
      allowedLinkPrefixes: ['https://good.com/'],
      allowedImagePrefixes: ['https://cdn.example.com/'],
      defaultOrigin: APP_ORIGIN,
    })
    const root = document.createElement('div')
    root.innerHTML =
      '<a href="https://evil.com/x">l</a><img src="https://evil.com/p.png" alt="i">'
    // The real native backend runs this walk after setHTML; drive it directly
    // with a config whose per-element gate is the policy (jsdom lacks setHTML).
    enforceSanitizerAllowlist(root, {
      allowedTags: ['a', 'img'],
      allowedAttr: ['href', 'src', 'alt', 'class'],
      onElement: applyLinkImagePolicy,
    })
    const anchor = root.querySelector('a')
    const img = root.querySelector('img')
    assert.ok(anchor?.classList.contains('blocked-link'))
    assert.equal(anchor?.getAttribute('href'), APP_ORIGIN)
    assert.ok(img?.classList.contains('blocked-image'))
    assert.equal(img?.getAttribute('src'), null)
  })
})
