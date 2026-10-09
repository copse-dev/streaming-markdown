// `data-*` passes both sanitizer backends generically rather than name-by-name
// (DATA_ATTR_NAME_SOURCE). The native allowlist walk used to strip every data
// attribute DOMPurify's `ALLOW_DATA_ATTR` default kept, so the two shipped
// backends disagreed about host routing attributes (#146) and about the
// renderer's own footnote markers — a divergence invisible to a suite that runs
// only under jsdom + DOMPurify. These pin the parity.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dompurifyBackend } from './sanitize-dompurify.ts'
import { enforceSanitizerAllowlist } from './sanitize-browser.ts'
import { renderMarkdown } from './renderer.ts'
import { appLinkDecorator } from './host-workspace.ts'

const CONFIG = { allowedTags: ['a', 'p'], allowedAttr: ['href'] }

function nativeWalk(html: string): string {
  const host = document.createElement('div')
  host.innerHTML = html
  enforceSanitizerAllowlist(host, CONFIG)
  return host.innerHTML
}

describe('data-* sanitizer parity', () => {
  const cases = [
    ['host routing attributes (#146)', '<a href="/x" data-workspace-link="true" data-browser-link="true">y</a>'],
    ['renderer footnote markers', '<a href="#fn-1" data-footnote-ref data-footnote-backref>y</a>'],
    ['an arbitrary custom attribute', '<a href="/x" data-anything="1">y</a>'],
  ] as const

  for (const [name, html] of cases) {
    it(`keeps ${name} on both backends`, () => {
      assert.equal(nativeWalk(html), dompurifyBackend.sanitize(html, CONFIG))
      assert.match(nativeWalk(html), /data-/)
    })
  }

  it('still strips a non-data attribute outside the allowlist on both', () => {
    const html = '<a href="/x" style="position:fixed" title="t">y</a>'
    assert.equal(nativeWalk(html), dompurifyBackend.sanitize(html, CONFIG))
    assert.doesNotMatch(nativeWalk(html), /style=|title=/)
  })

  it('carries a host decorator’s attributes through with no sanitizeExtension (#146)', () => {
    const html = String(
      renderMarkdown('[docs](https://example.com/page)', {
        linkDecorator: appLinkDecorator,
        htmlPolicy: 'escape',
      }),
    )
    assert.match(html, /<a href="https:\/\/example\.com\/page"[^>]*data-browser-link="true"[^>]*>/)
  })

  it('lets a host re-narrow data-* through onElement', () => {
    const html = String(
      renderMarkdown('[docs](https://example.com/page)', {
        linkDecorator: appLinkDecorator,
        htmlPolicy: 'escape',
        sanitizeExtension: {
          onElement: (node) => {
            if (typeof node.getAttribute !== 'function') return
            for (const { name } of Array.from(node.attributes)) {
              if (name.startsWith('data-')) node.removeAttribute(name)
            }
          },
        },
      }),
    )
    assert.doesNotMatch(html, /data-/)
    assert.match(html, /<a href="https:\/\/example\.com\/page"/)
  })
})
