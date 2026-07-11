import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { type LinkDecorator } from './inline-links.ts'
import { getFenceHandler, type FenceHandler } from './fence-handlers.ts'
import { getCodeHighlighter, type CodeHighlighter } from './highlight.ts'
import { getMathSyntax } from './math-syntax.ts'
import { setDefaultConfig, withConfig, type MarkdownConfig } from './config.ts'
import { isEmailAutolinksEnabled } from './autolink-syntax.ts'
import { getEntityDecoder, getNamedEntities } from './entity-decoder.ts'
import { getInlinePasses } from './inline-passes.ts'
import { getSanitizerBackend } from './sanitize.ts'
import type { MathRenderer } from './math.ts'

// The config-injected API (#145/#137/#147) replaces the config-epoch mechanism.
// Two renders with different `MarkdownConfig` produce their own output in one
// process — no `set*`, no epoch — and every global slot is left untouched after.
describe('config-injected render (spike for #145)', () => {
  // The whole point is that these NEVER need resetting: per-call config is scoped
  // to one synchronous render and restored automatically, so no afterEach cleanup.
  const brackets: LinkDecorator = ({ title }) =>
    title ? ` title="${title}" data-demo="1"` : ' data-demo="1"'

  const demoFence: FenceHandler = {
    render: (code) => `<div class="demo-fence">${code.trim()}</div>`,
  }

  it('applies a per-call link decorator without a global setter', () => {
    const decorated = renderMarkdownUnsafe('[x](https://example.com)', { linkDecorator: brackets })
    assert.equal(decorated, '<p><a href="https://example.com" data-demo="1">x</a></p>')

    // Default is unchanged: a plain call (no config) still emits neutral anchors.
    assert.equal(
      renderMarkdownUnsafe('[x](https://example.com)'),
      '<p><a href="https://example.com">x</a></p>',
    )
  })

  it('applies per-call fence handlers layered over the built-ins, then restores', () => {
    const before = getFenceHandler('demo')
    const withHandler = renderMarkdownUnsafe('```demo\nhello\n```', {
      fenceHandlers: { demo: demoFence },
    })
    assert.match(withHandler, /<div class="demo-fence">hello<\/div>/)

    // The built-in mermaid handler still exists inside the scoped config...
    const withMermaid = renderMarkdownUnsafe('```mermaid\ngraph TD; A-->B\n```', {
      fenceHandlers: { demo: demoFence },
    })
    assert.match(withMermaid, /mermaid-diagram--pending/)

    // ...and the registry is unchanged afterwards: `demo` is gone again.
    assert.equal(getFenceHandler('demo'), before)
    assert.equal(getFenceHandler('demo'), null)
  })

  it('scopes math prose syntax per call and leaves the global override alone', () => {
    assert.equal(getMathSyntax(), null)
    const on = renderMarkdownUnsafe('$x$', { mathSyntax: true })
    const off = renderMarkdownUnsafe('$x$', { mathSyntax: false })
    // `mathSyntax:true` recognizes the `$…$` delimiters; `false` leaves them literal.
    assert.notEqual(on, off)
    assert.match(off, /\$x\$/)
    // Global override untouched by either call.
    assert.equal(getMathSyntax(), null)
  })

  it('lets two configs coexist in interleaved calls with no bleed', () => {
    const a: LinkDecorator = () => ' data-a="1"'
    const b: LinkDecorator = () => ' data-b="1"'
    const ra = renderMarkdownUnsafe('[l](https://a.test)', { linkDecorator: a })
    const rb = renderMarkdownUnsafe('[l](https://b.test)', { linkDecorator: b })
    const ra2 = renderMarkdownUnsafe('[l](https://a.test)', { linkDecorator: a })
    assert.match(ra, /data-a="1"/)
    assert.match(rb, /data-b="1"/)
    assert.equal(ra, ra2)
    assert.doesNotMatch(ra, /data-b/)
    assert.doesNotMatch(rb, /data-a/)
  })
})

describe('config-injected backends (spike for #145)', () => {
  const shouty: CodeHighlighter = {
    highlight: (code) => `<span class="hi">${code.toUpperCase()}</span>`,
    highlightAuto: (code) => `<span class="hi">${code.toUpperCase()}</span>`,
  }

  it('applies a per-call code highlighter, then restores the global slot', () => {
    const before = getCodeHighlighter()
    const highlighted = renderMarkdownUnsafe('```js\nhello\n```', { codeHighlighter: shouty })
    assert.match(highlighted, /HELLO/)
    // Global slot untouched afterwards.
    assert.equal(getCodeHighlighter(), before)
    // A plain render falls back to escaped plain text.
    assert.doesNotMatch(renderMarkdownUnsafe('```js\nhello\n```'), /HELLO/)
  })
})

describe('withConfig scopes and restores every synchronous field', () => {
  it('applies each field then restores the prior module state in a finally', () => {
    const full: MarkdownConfig = {
      htmlPolicy: 'escape',
      safeHrefSchemes: ['https'],
      sanitizeExtension: null,
      linkImagePolicy: null,
      trustedTypesPolicy: null,
      mathSyntax: true,
      emailAutolinks: false,
      flankingPunctuationExclusion: () => false,
      bareUrlCjkBoundary: () => false,
      linkDecorator: () => '',
      fenceHandlers: { spikelang: { render: (c) => c } },
      codeHighlighter: { highlight: (c) => c, highlightAuto: (c) => c },
      rawImageRenderer: () => null,
      inlinePasses: [],
      entityDecoder: (t) => t,
      namedEntities: { spikeent: 'X' },
      sanitizerBackend: null,
    }
    // Snapshot the default (no-config) value of each field that has a remaining
    // getter. The deleted linkDecorator / rawImageRenderer getters are asserted via
    // rendered output in the per-call suites above, so they are dropped here.
    const before = {
      math: getMathSyntax(),
      email: isEmailAutolinksEnabled(),
      highlighter: getCodeHighlighter(),
      passes: getInlinePasses(),
      decoder: getEntityDecoder(),
      named: getNamedEntities()['spikeent'],
      sanitizer: getSanitizerBackend(),
      fence: getFenceHandler('spikelang'),
    }

    let sawInside = false
    const out = withConfig(full, () => {
      // Inside the scope every field reads back through its remaining getter.
      sawInside = true
      assert.equal(getMathSyntax(), true)
      assert.equal(isEmailAutolinksEnabled(), false)
      assert.equal(getCodeHighlighter(), full.codeHighlighter)
      assert.equal(getEntityDecoder(), full.entityDecoder)
      assert.notEqual(getEntityDecoder(), before.decoder)
      assert.equal(getNamedEntities()['spikeent'], 'X')
      assert.notEqual(getFenceHandler('spikelang'), null)
      assert.deepEqual(getInlinePasses(), [])
      return 'ran'
    })

    assert.ok(sawInside)
    assert.equal(out, 'ran')
    // Outside the scope every field returns to its default.
    assert.equal(getMathSyntax(), before.math)
    assert.equal(isEmailAutolinksEnabled(), before.email)
    assert.equal(getCodeHighlighter(), before.highlighter)
    // getInlinePasses returns the active config's array, whose identity differs
    // across scopes — compare by content not reference.
    assert.deepEqual(getInlinePasses(), before.passes)
    assert.equal(getEntityDecoder(), before.decoder)
    assert.equal(getNamedEntities()['spikeent'], before.named)
    assert.equal(getSanitizerBackend(), before.sanitizer)
    assert.equal(getFenceHandler('spikelang'), before.fence)
  })

  it('is a straight fn() call with zero touched slots for an empty config', () => {
    assert.equal(
      withConfig({}, () => 7),
      7,
    )
  })
})

describe('setDefaultConfig', () => {
  // The only process-wide mutation point left. Every branch restores the
  // touched field to its built-in default (`null`) before returning, so these
  // cannot bleed into other suites in this file.
  it('merges into the process defaults, visible outside any scope', () => {
    try {
      setDefaultConfig({ mathSyntax: true })
      assert.equal(getMathSyntax(), true)
      // A later call merges rather than replaces: an unrelated field survives.
      setDefaultConfig({ emailAutolinks: false })
      assert.equal(getMathSyntax(), true)
      assert.equal(isEmailAutolinksEnabled(), false)
    } finally {
      setDefaultConfig({ mathSyntax: null, emailAutolinks: true })
    }
  })

  it('is overridden per render and null-cleared back to the built-in default', () => {
    try {
      setDefaultConfig({ mathSyntax: true })
      // Per-render config wins over the process default...
      assert.equal(
        withConfig({ mathSyntax: false }, () => getMathSyntax()),
        false,
      )
      // ...and a render that sets nothing inherits the default.
      assert.equal(
        withConfig({}, () => getMathSyntax()),
        true,
      )
      // `null` clears the field back to the built-in default.
      setDefaultConfig({ mathSyntax: null })
      assert.equal(getMathSyntax(), null)
    } finally {
      setDefaultConfig({ mathSyntax: null })
    }
  })

  it('throws when called inside an active withConfig scope', () => {
    assert.throws(
      () =>
        withConfig({}, () => {
          setDefaultConfig({ mathSyntax: true })
        }),
      /cannot be called during a render/,
    )
    // The failed call mutated nothing.
    assert.equal(getMathSyntax(), null)
  })
})

describe('StreamingMarkdownRenderer.hydrate (spike for #145)', () => {
  // A fake KaTeX-shaped renderer; the point is that it arrives via config, not a
  // global setMathRenderer, and hydrate() reads it off the instance.
  const fakeMath: MathRenderer = {
    render: (source) => Promise.resolve({ html: `<span class="k">${source.trim()}</span>` }),
  }

  it('hydrates pending math from the constructor config, no global registration', async () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host, {
      mathSyntax: true,
      mathRenderer: fakeMath,
    })
    renderer.update('$x+1$')
    assert.match(host.innerHTML, /math-inline--pending/)
    const counts = await renderer.hydrate()
    assert.equal(counts.math, 1)
    assert.match(host.innerHTML, /math-inline--rendered/)
    assert.match(host.innerHTML, /class="k"/)
  })

  it('hydrates pending diagrams from the constructor config, no global registration', async () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host, {
      diagramRenderer: {
        render: () => Promise.resolve({ svg: '<svg data-demo="ok"></svg>' }),
      },
    })
    renderer.update('```mermaid\ngraph TD; A-->B\n```')
    assert.match(host.innerHTML, /mermaid-diagram--pending/)
    const counts = await renderer.hydrate()
    assert.equal(counts.diagrams, 1)
    assert.match(host.innerHTML, /mermaid-diagram--rendered/)
    assert.match(host.innerHTML, /data-demo="ok"/)
  })

  it('forwards transformHtml / transformSvg through hydrate()', async () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host, {
      mathSyntax: true,
      mathRenderer: fakeMath,
      diagramRenderer: { render: () => Promise.resolve({ svg: '<svg></svg>' }) },
    })
    renderer.update('$x$\n\n```mermaid\ngraph TD; A-->B\n```')
    let mathSeen = false
    let svgSeen = false
    await renderer.hydrate({
      transformHtml: (h) => {
        mathSeen = true
        return h
      },
      transformSvg: (s) => {
        svgSeen = true
        return s
      },
    })
    assert.ok(mathSeen, 'transformHtml forwarded')
    assert.ok(svgSeen, 'transformSvg forwarded')
  })

  it('is a no-op for a tier whose renderer is not configured', async () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host, { mathSyntax: true })
    renderer.update('$x+1$')
    const counts = await renderer.hydrate()
    assert.deepEqual(counts, { math: 0, diagrams: 0 })
    assert.match(host.innerHTML, /math-inline--pending/)
  })
})
