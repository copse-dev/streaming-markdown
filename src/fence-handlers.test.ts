import '../tests/setup-dom-jsdom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml } from './escape.ts'
import {
  type FenceHandler,
  FORMING_FENCE_PRE_CLASS,
  getFenceHandler,
  setFenceHandler,
} from './fence-handlers.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { buildFormingFenceHtml, syncFormingFenceDom } from './streaming-fence-dom.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

// The fence-handler registry (#53): custom emission for fenced blocks by info
// language, with the built-in mermaid scaffolding as the reference handler.

// A minimal math-style handler emitting only allowlisted tags (div/pre + class).
// Registering it under 'math' shadows the built-in handler for these tests —
// which emits the same scaffolding shape — proving hosts can replace built-ins.
const mathHandler: FenceHandler = {
  render(code) {
    return `<div class="math-block math-block--pending"><pre class="math">${escapeHtml(code.trimEnd())}</pre></div>`
  },
}

// Capture the built-in handlers once so cleanup can restore them after tests
// that unregister or shadow them.
const BUILTIN_MERMAID = getFenceHandler('mermaid')
const BUILTIN_MATH = getFenceHandler('math')

afterEach(() => {
  setFenceHandler('math', BUILTIN_MATH)
  setFenceHandler('mermaid', BUILTIN_MERMAID)
})

describe('fence handler registry', () => {
  it('ships the built-in mermaid and math handlers', () => {
    assert.ok(getFenceHandler('mermaid'))
    assert.ok(getFenceHandler('math'))
    assert.equal(getFenceHandler('graphviz'), null)
  })

  it('resolves the fence language case-insensitively', () => {
    assert.equal(getFenceHandler('MERMAID'), getFenceHandler('mermaid'))
    const html = renderMarkdownUnsafe('```MERMAID\ngraph TD\nA-->B\n```')
    assert.match(html, /mermaid-diagram--pending/)
  })

  it('unregistering mermaid restores the default <pre><code> emission', () => {
    setFenceHandler('mermaid', null)
    const html = renderMarkdownUnsafe('```mermaid\ngraph TD\nA-->B\n```')
    assert.doesNotMatch(html, /mermaid-diagram/)
    assert.match(html, /<pre><code class="hljs lang-mermaid">/)
  })
})

describe('custom handler: at-rest render', () => {
  it('renders a registered language through its handler', () => {
    setFenceHandler('math', mathHandler)
    const html = renderMarkdownUnsafe('before\n\n```math\nE = mc^2\n```\n\nafter')
    assert.match(html, /<div class="math-block math-block--pending"><pre class="math">E = mc\^2<\/pre><\/div>/)
    assert.doesNotMatch(html, /hljs lang-math/)
    // Surrounding prose is unaffected.
    assert.match(html, /<p>before<\/p>/)
    assert.match(html, /<p>after<\/p>/)
  })

  it('escaped handler scaffolding survives the sanitizer sink', () => {
    setFenceHandler('math', mathHandler)
    const html = sanitizeRenderedMarkdown(renderMarkdownUnsafe('```math\nx < y & "z"\n```'))
    assert.match(html, /class="math-block math-block--pending"/)
    assert.match(html, /x &lt; y &amp; "z"|x &lt; y &amp;amp; "z"/)
  })

  it('unregistered languages keep the default highlighted emission', () => {
    const html = renderMarkdownUnsafe('```graphviz\ndigraph { a -> b }\n```')
    assert.match(html, /<pre><code class="hljs lang-graphviz">/)
  })
})

describe('custom handler: forming (streaming string path)', () => {
  it('uses forming.html while the fence is open', () => {
    setFenceHandler('math', {
      ...mathHandler,
      forming: {
        html(code) {
          return `<div class="math-block math-block--pending ${FORMING_FENCE_PRE_CLASS}"><pre class="math">${escapeHtml(code)}</pre></div>`
        },
      },
    })
    const html = buildFormingFenceHtml('```math\nE = mc')
    assert.match(html, /math-block--pending/)
    assert.match(html, new RegExp(FORMING_FENCE_PRE_CLASS))
    assert.match(html, /E = mc/)
  })

  it('falls back to render() when the handler has no forming shape', () => {
    setFenceHandler('math', mathHandler)
    const html = buildFormingFenceHtml('```math\nE = mc')
    assert.match(html, /<div class="math-block math-block--pending"><pre class="math">E = mc<\/pre><\/div>/)
  })
})

describe('custom handler: forming (incremental DOM path)', () => {
  it('default sync replaces container HTML with sanitized forming markup', () => {
    setFenceHandler('math', mathHandler)
    const el = document.createElement('div')
    syncFormingFenceDom(el, '```math\nE = mc')
    assert.equal(el.querySelectorAll('.math-block').length, 1)
    assert.equal(el.querySelector('pre.math')?.textContent, 'E = mc')

    syncFormingFenceDom(el, '```math\nE = mc^2')
    assert.equal(el.querySelectorAll('.math-block').length, 1)
    assert.equal(el.querySelector('pre.math')?.textContent, 'E = mc^2')
  })

  it('handler sync gets incremental control and node reuse', () => {
    setFenceHandler('math', {
      ...mathHandler,
      forming: {
        html(code) {
          return `<div class="math-block ${FORMING_FENCE_PRE_CLASS}"><pre class="math">${escapeHtml(code)}</pre></div>`
        },
        sync(container, code) {
          let root = container.querySelector<HTMLElement>(`.math-block.${FORMING_FENCE_PRE_CLASS}`)
          if (!root) {
            container.replaceChildren()
            root = document.createElement('div')
            root.className = `math-block ${FORMING_FENCE_PRE_CLASS}`
            const pre = document.createElement('pre')
            pre.className = 'math'
            root.append(pre)
            container.append(root)
          }
          const pre = root.querySelector('pre.math')
          if (pre) pre.textContent = code
        },
      },
    })
    const el = document.createElement('div')
    syncFormingFenceDom(el, '```math\nE = mc')
    const root = el.querySelector('.math-block')
    const pre = el.querySelector('pre.math')
    assert.ok(root && pre)

    syncFormingFenceDom(el, '```math\nE = mc^2')
    assert.equal(el.querySelector('.math-block'), root, 'root reused')
    assert.equal(el.querySelector('pre.math'), pre, 'pre reused')
    assert.equal(pre?.textContent, 'E = mc^2')
  })

  it('switches cleanly from a handled fence to a plain code fence', () => {
    setFenceHandler('math', mathHandler)
    const el = document.createElement('div')
    syncFormingFenceDom(el, '```math\nE = mc')
    assert.ok(el.querySelector('.math-block'))

    syncFormingFenceDom(el, '```ts\nconst x = 1')
    assert.equal(el.querySelectorAll('.math-block').length, 0)
    assert.ok(el.querySelector(`pre.${FORMING_FENCE_PRE_CLASS} > code`))
  })
})

describe('custom handler: streaming convergence', () => {
  it('char-by-char streaming converges to the sanitized at-rest render', () => {
    setFenceHandler('math', mathHandler)
    const source = 'intro paragraph\n\n```math\n\\frac{a}{b} < 1\n```\n\noutro\n'
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    for (let i = 1; i <= source.length; i++) {
      renderer.update(source.slice(0, i))
    }
    renderer.update(source)
    const expected = document.createElement('div')
    expected.innerHTML = sanitizeRenderedMarkdown(renderMarkdownUnsafe(source))
    assert.equal(
      host.querySelector('.math-block')?.outerHTML,
      expected.querySelector('.math-block')?.outerHTML,
    )
    assert.match(host.innerHTML, /<p>intro paragraph<\/p>/)
    assert.match(host.innerHTML, /<p>outro<\/p>/)
  })
})
