import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import {
  getLinkDecorator,
  setLinkDecorator,
  type LinkDecorator,
  neutralLinkDecorator,
} from './inline-links.ts'
import { getFenceHandler, setFenceHandler, type FenceHandler } from './fence-handlers.ts'
import { getMathSyntax, setMathSyntax } from './math-syntax.ts'

// SPIKE demo (#145/#137/#147): the config-injected API replaces the config-epoch.
// Two renders with different `MarkdownConfig` produce their own output in one
// process — no `set*`, no epoch — and every global slot is left untouched after.
describe('config-injected render (spike for #145)', () => {
  // Belt-and-braces: the whole point is that these NEVER need resetting because
  // the config never mutates them, but restore anyway so a regression here can't
  // leak into other suites.
  afterEach(() => {
    setLinkDecorator(null)
    setMathSyntax(null)
    setFenceHandler('demo', null)
  })

  const brackets: LinkDecorator = ({ title }) =>
    title ? ` title="${title}" data-demo="1"` : ' data-demo="1"'

  const demoFence: FenceHandler = {
    render: (code) => `<div class="demo-fence">${code.trim()}</div>`,
  }

  it('applies a per-call link decorator without a global setter', () => {
    const decorated = renderMarkdownUnsafe('[x](https://example.com)', { linkDecorator: brackets })
    assert.equal(decorated, '<p><a href="https://example.com" data-demo="1">x</a></p>')

    // Default is unchanged: a plain call still emits neutral anchors, and the
    // global active decorator is still the neutral built-in.
    assert.equal(
      renderMarkdownUnsafe('[x](https://example.com)'),
      '<p><a href="https://example.com">x</a></p>',
    )
    assert.equal(getLinkDecorator(), neutralLinkDecorator)
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
