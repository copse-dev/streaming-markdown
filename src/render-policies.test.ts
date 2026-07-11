import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withRenderPolicies } from './render-policies.ts'
import { getHtmlPolicy } from './html-policy.ts'
import { getSafeHrefSchemes } from './inline-links.ts'
import { getLinkImagePolicy } from './link-image-policy.ts'
import { snapshotTrustedTypesPolicy, type TrustedTypesPolicy } from './html-sink.ts'
import { renderMarkdown, renderMarkdownUnsafe } from './renderer.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

const RESTRICT_TO_GOOD = {
  allowedLinkPrefixes: ['https://good.com/'],
  allowedImagePrefixes: [],
  defaultOrigin: 'https://good.com',
  allowDataImages: false,
}

// Per-render policy overrides (#137, ADR 0003): a policy passed at the call site
// (or captured by a StreamingMarkdownRenderer instance) must apply for that
// render only and leave the process-wide default untouched — the property that
// lets two consumers in one process hold different policies without bleed.

describe('withRenderPolicies', () => {
  it('scopes each policy inside the callback and restores it after', () => {
    const beforeSchemes = getSafeHrefSchemes()
    assert.equal(getHtmlPolicy(), 'passthrough')
    assert.equal(getLinkImagePolicy(), null)

    withRenderPolicies(
      { htmlPolicy: 'escape', safeHrefSchemes: ['https'], linkImagePolicy: RESTRICT_TO_GOOD },
      () => {
        assert.equal(getHtmlPolicy(), 'escape')
        assert.deepEqual(getSafeHrefSchemes(), ['https'])
        assert.ok(getLinkImagePolicy(), 'link/image policy active inside the scope')
      },
    )

    assert.equal(getHtmlPolicy(), 'passthrough')
    assert.deepEqual(getSafeHrefSchemes(), beforeSchemes)
    assert.equal(getLinkImagePolicy(), null)
  })

  it('restores policies even when the callback throws', () => {
    assert.throws(() =>
      withRenderPolicies({ htmlPolicy: 'escape', safeHrefSchemes: ['https'] }, () => {
        throw new Error('boom')
      }),
    )
    assert.equal(getHtmlPolicy(), 'passthrough')
    assert.ok(getSafeHrefSchemes().includes('mailto'), 'scheme allowlist restored after throw')
  })

  it('nested scopes restore to the enclosing value, not the global default', () => {
    withRenderPolicies({ htmlPolicy: 'escape' }, () => {
      assert.equal(getHtmlPolicy(), 'escape')
      withRenderPolicies({ htmlPolicy: 'passthrough' }, () => {
        assert.equal(getHtmlPolicy(), 'passthrough')
      })
      assert.equal(getHtmlPolicy(), 'escape', 'restored to the enclosing scope, not global')
    })
    assert.equal(getHtmlPolicy(), 'passthrough')
  })

  it('is a zero-op passthrough when no policy field is set', () => {
    assert.equal(
      withRenderPolicies({}, () => 42),
      42,
    )
  })

  it('scopes and restores the trusted-types policy slot', () => {
    const fake = { createHTML: (s: string) => s } as unknown as TrustedTypesPolicy
    assert.equal(snapshotTrustedTypesPolicy(), null)
    withRenderPolicies({ trustedTypesPolicy: fake }, () => {
      assert.equal(snapshotTrustedTypesPolicy(), fake)
    })
    assert.equal(snapshotTrustedTypesPolicy(), null)
  })
})

describe('per-render overrides take effect and do not leak', () => {
  it('render-time: safeHrefSchemes narrows the scheme allowlist for one render', () => {
    // Default allows mailto:.
    assert.match(renderMarkdownUnsafe('[x](mailto:a@b.com)'), /href="mailto:a@b\.com"/)
    // Override to https-only blocks it (the link falls back to literal text).
    assert.doesNotMatch(
      renderMarkdownUnsafe('[x](mailto:a@b.com)', { safeHrefSchemes: ['https'] }),
      /href="mailto/,
    )
    // No leak: the next default render allows mailto: again.
    assert.match(renderMarkdownUnsafe('[x](mailto:a@b.com)'), /href="mailto:a@b\.com"/)
  })

  it('sink-time: linkImagePolicy restricts origins for one render', () => {
    assert.match(String(renderMarkdown('[x](https://evil.com/p)')), /href="https:\/\/evil\.com\/p"/)
    const restricted = String(
      renderMarkdown('[x](https://evil.com/p)', { linkImagePolicy: RESTRICT_TO_GOOD }),
    )
    assert.doesNotMatch(restricted, /evil\.com/)
    assert.match(restricted, /class="blocked-link"/)
    // No leak.
    assert.match(String(renderMarkdown('[x](https://evil.com/p)')), /href="https:\/\/evil\.com\/p"/)
  })

  it('sink-time: sanitizeExtension applies to one render only', () => {
    const seen: string[] = []
    renderMarkdown('<span>hi</span>', {
      sanitizeExtension: {
        onElement: (_node, tagName) => {
          seen.push(tagName)
        },
      },
    })
    assert.ok(seen.length > 0, 'the extension gate ran during the scoped render')
    // No leak: a plain render does not invoke the (now-removed) extension.
    seen.length = 0
    renderMarkdown('<span>hi</span>')
    assert.equal(seen.length, 0, 'extension not retained after the render')
  })

  it('streaming: an instance applies its captured policy and does not leak', () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host, { safeHrefSchemes: ['https'] })
    renderer.update('[x](mailto:a@b.com)\n\n')
    assert.doesNotMatch(host.innerHTML, /href="mailto/, 'instance policy blocks the mailto link')
    // A default render elsewhere is unaffected.
    assert.match(renderMarkdownUnsafe('[x](mailto:a@b.com)'), /href="mailto:a@b\.com"/)
  })

  it('two instances hold different policies without bleeding into each other', () => {
    const strictHost = document.createElement('div')
    const openHost = document.createElement('div')
    const strict = new StreamingMarkdownRenderer(strictHost, { safeHrefSchemes: ['https'] })
    const open = new StreamingMarkdownRenderer(openHost)
    strict.update('[x](mailto:a@b.com)\n\n')
    open.update('[x](mailto:a@b.com)\n\n')
    assert.doesNotMatch(strictHost.innerHTML, /href="mailto/)
    assert.match(openHost.innerHTML, /href="mailto:a@b\.com"/)
  })
})
