// PROTOTYPE (#url-policy): the completeness guard for "the policy sees every URL".
//
// That claim cannot be established by auditing call sites — the call sites are
// the thing being audited, and hand-enumeration is exactly what let `@import "…"`,
// `image-set("…")`, `srcset` and `poster` through. So this suite inverts the
// test: install a policy that blocks everything, render a corpus that exercises
// every URL-emitting construct, and assert that **no external URL survives
// anywhere in the output**.
//
// The scan deliberately does NOT use the package's own attribute classifier —
// it walks every attribute of every element regardless of name, plus `<style>`
// text. Reusing the classifier would only prove the classifier agrees with
// itself; scanning blind is what catches a sink nobody thought to classify.
//
// Corpus rule: URLs appear only in destination positions, never in link text,
// `alt`, or `title` — a URL sitting in prose is not a sink, and would be a false
// positive here.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withConfig } from './config.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { filterMarkupUrlsString } from './url-filter-markup.ts'
import type { UrlPolicy } from './url-policy.ts'

/** Blocks unconditionally: nothing it is shown may reach the output. */
const BLOCK_ALL: UrlPolicy = { baseOrigin: 'https://app.example.com', createURL: () => null }

// Any absolute destination the browser could fetch or navigate to. Deliberately
// broad — the point is to catch a value we failed to recognize as a URL.
const EXTERNAL_URL_RE = /(?:https?|ftps?|ws?s):\/\/[^\s"'()<>]+/i

/**
 * Every place markup can hide a URL, scanned without reference to the
 * package's own idea of which attributes carry one.
 */
function survivingUrls(html: string): string[] {
  const host = document.createElement('div')
  host.innerHTML = html
  const found: string[] = []
  for (const el of host.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      // Namespace declarations hold a URI that identifies a vocabulary and is
      // never dereferenced — `xmlns="http://www.w3.org/1999/xhtml"` on every
      // foreignObject child would otherwise read as an unpoliced sink.
      const name = attr.name.toLowerCase()
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue
      const hit = EXTERNAL_URL_RE.exec(attr.value)
      if (hit) found.push(`${el.tagName.toLowerCase()}[${attr.name}] = ${hit[0]}`)
    }
    if (el.tagName.toLowerCase() === 'style') {
      const hit = EXTERNAL_URL_RE.exec(el.textContent ?? '')
      if (hit) found.push(`<style> = ${hit[0]}`)
    }
  }
  return found
}

// Widened the way an image/media-rendering host widens it. Every one of these is
// a sink the core allowlist does not open on its own, and each is a chance for
// the gate to miss an attribute it was not told about by name.
const HOST_EXTENSION = {
  allowedTags: ['img', 'video', 'source', 'iframe', 'object'],
  allowedAttr: ['src', 'srcset', 'poster', 'data', 'alt'],
}

const MARKDOWN_CORPUS: Record<string, string> = {
  'inline link': '[label](https://one.example/a)',
  'inline image': '![label](https://two.example/b.png)',
  'reference link': '[label][ref]\n\n[ref]: https://three.example/c',
  'reference image': '![label][iref]\n\n[iref]: https://four.example/d.png',
  'shortcut reference': '[short]\n\n[short]: https://five.example/e',
  'angle autolink': '<https://six.example/f>',
  'bare autolink': 'see https://seven.example/g here',
  'www autolink': 'see www.eight.example/h here',
  'email autolink': 'mail nine@ten.example now',
  'link in emphasis': '**[label](https://eleven.example/i)**',
  'link in a table': '| h |\n| --- |\n| [label](https://twelve.example/j) |',
  'link in a list item': '- [label](https://thirteen.example/k)',
  'link in a blockquote': '> [label](https://fourteen.example/l)',
  'link in a footnote': 'text[^1]\n\n[^1]: [label](https://fifteen.example/m)',
  'link in a task list': '- [ ] [label](https://sixteen.example/n)',
  'raw anchor': '<a href="https://seventeen.example/o">label</a>',
  'raw image': '<img src="https://eighteen.example/p.png" alt="label">',
  'raw srcset': '<img srcset="https://nineteen.example/q.png 1x" alt="label">',
  'raw video poster': '<video poster="https://twenty.example/r.png"></video>',
  'raw source src': '<video><source src="https://twentyone.example/s.mp4"></video>',
  'raw iframe': '<iframe src="https://twentytwo.example/t"></iframe>',
  'raw object data': '<object data="https://twentythree.example/u"></object>',
  'raw style attribute': '<div style="background: url(https://twentyfour.example/v)">x</div>',
}

describe('urlPolicy completeness — markdown surface', () => {
  for (const [name, markdown] of Object.entries(MARKDOWN_CORPUS)) {
    it(`lets no URL through: ${name}`, () => {
      const html = withConfig({ urlPolicy: BLOCK_ALL, sanitizeExtension: HOST_EXTENSION }, () =>
        sanitizeRenderedMarkdown(renderMarkdownUnsafe(markdown)),
      )
      assert.deepEqual(survivingUrls(html), [], `unpoliced sink in "${name}": ${html}`)
    })
  }

  it('lets no URL through the whole corpus at once', () => {
    const all = Object.values(MARKDOWN_CORPUS).join('\n\n')
    const html = withConfig({ urlPolicy: BLOCK_ALL, sanitizeExtension: HOST_EXTENSION }, () =>
      sanitizeRenderedMarkdown(renderMarkdownUnsafe(all)),
    )
    assert.deepEqual(survivingUrls(html), [])
  })

  it('also holds on the unsanitized path, which never reaches the sink', () => {
    // Raw passthrough is gated at the sink by design — it never meets the inline
    // emitters — so `renderMarkdownUnsafe` output can only be held to the
    // constructs the renderer itself turns into links and images.
    const emitted = Object.entries(MARKDOWN_CORPUS)
      .filter(([name]) => !name.startsWith('raw '))
      .map(([, markdown]) => markdown)
      .join('\n\n')
    const html = withConfig({ urlPolicy: BLOCK_ALL }, () => renderMarkdownUnsafe(emitted))
    assert.deepEqual(survivingUrls(html), [])
  })
})

// The post-sink tier: markup a backend produced that never met the sanitizer.
// Shapes taken from what real mermaid 11 emits, plus the CSS forms that slipped
// past pattern matching. In jsdom this exercises the no-CSSOM fallback; the
// CSSOM path is covered by the browser probe (see filterStyleElement).
const POST_SINK_CORPUS: Record<string, string> = {
  'foreignObject img': '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://a1.example/a.png"></div></foreignObject></svg>',
  'svg image href': '<svg><image href="https://a2.example/b.png"/></svg>',
  'svg image xlink': '<svg><image xlink:href="https://a3.example/c.png"/></svg>',
  'svg anchor': '<svg><a xlink:href="https://a4.example/d"><text>x</text></a></svg>',
  'style url()': '<svg><style>.n{background:url(https://a5.example/e)}</style></svg>',
  'style @import string': '<svg><style>@import "https://a6.example/f";</style></svg>',
  'style @import url()': '<svg><style>@import url(https://a7.example/g);</style></svg>',
  'style image-set': '<svg><style>.n{background-image:image-set("https://a8.example/h" 1x)}</style></svg>',
  'style -webkit-image-set': '<svg><style>.n{background-image:-webkit-image-set("https://a9.example/i" 1x)}</style></svg>',
  'style @font-face src': '<svg><style>@font-face{font-family:f;src:url(https://b1.example/j)}</style></svg>',
  'style attribute': '<svg><g style="background:url(https://b2.example/k)"></g></svg>',
  'srcset in foreignObject': '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img srcset="https://b3.example/l.png 1x"></div></foreignObject></svg>',
}

describe('urlPolicy completeness — post-sink markup', () => {
  for (const [name, markup] of Object.entries(POST_SINK_CORPUS)) {
    it(`lets no URL through: ${name}`, () => {
      const out = withConfig({ urlPolicy: BLOCK_ALL }, () =>
        filterMarkupUrlsString(markup, 'diagram'),
      )
      assert.deepEqual(survivingUrls(out), [], `unpoliced sink in "${name}": ${out}`)
    })
  }

  it('keeps same-document fragment references, which are not a channel', () => {
    const markup = '<svg><use href="#node"/><g style="marker-end:url(#arrow)"></g></svg>'
    const out = withConfig({ urlPolicy: BLOCK_ALL }, () => filterMarkupUrlsString(markup, 'diagram'))
    assert.match(out, /href="#node"/)
    assert.match(out, /url\(#arrow\)/)
  })
})
