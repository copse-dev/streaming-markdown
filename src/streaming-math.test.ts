import '../tests/setup-dom-jsdom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { hydratePendingMath, setMathRenderer } from './math.ts'
import { renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import {
  pendingHoldIndex,
  renderStreamingMarkdown,
  StreamingMarkdownRenderer,
} from './streaming.ts'

// Streaming math (#70): open `$$` / `\[` blocks (and ```math fences) show a
// forming pending-math state instead of raw delimiters; half-open inline `$x+`
// holds via pendingHoldIndex; and both emitters converge on the at-rest render.

/** Visible streaming HTML (committed + forming + live tail), as the fuzz test extracts it. */
function extractStreamingDisplay(host: HTMLElement): string {
  const parts: string[] = []
  const complete = host.querySelector('.stream-complete')
  if (complete) parts.push(complete.innerHTML)
  const forming = host.querySelector('.stream-forming')
  if (forming instanceof HTMLElement && !forming.hidden) parts.push(forming.innerHTML)
  const pending = host.querySelector('.stream-pending')
  if (pending instanceof HTMLElement && !pending.hidden && pending.innerHTML !== '') {
    parts.push(pending.innerHTML)
  }
  return parts.join('')
}

function streamCharByChar(markdown: string): HTMLElement {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  for (let i = 1; i <= markdown.length; i++) renderer.update(markdown.slice(0, i))
  return host
}

const MATH_DOCS: [string, string][] = [
  ['$$ block', 'intro\n\n$$\nE = mc^2\n$$\n\noutro\n'],
  ['one-line $$', 'a\n\n$$E = mc^2$$\n\nb\n'],
  ['bracket block', 'a\n\n\\[\n\\frac{x}{y}\n\\]\n\nb\n'],
  ['one-line bracket', '\\[ E = mc^2 \\]\n\ndone\n'],
  ['math fence', 'x\n\n```math\nE = mc^2\n```\n\ny\n'],
  ['inline forms', 'Euler: $e^{i\\pi}+1=0$ and \\(a_i\\) and $$x^2$$ end.\n'],
  ['currency', 'costs $20 and $30 total\n'],
  ['prose $$ line', '$$ not math after all\nmore prose\n'],
]

describe('streaming display math: forming state', () => {
  it('an open $$ block renders as forming pending-math scaffolding (string emitter)', () => {
    const html = renderStreamingMarkdown('intro\n\n$$\nE = mc')
    assert.match(html, /math-block math-block--pending stream-fence-forming/)
    assert.match(html, /<pre class="math">E = mc<\/pre>/)
    assert.doesNotMatch(html, /\$\$/)
  })

  it('an open \\[ block renders as forming scaffolding without raw delimiters', () => {
    const html = renderStreamingMarkdown('\\[\n\\frac{a}{b')
    assert.match(html, /math-block--pending/)
    assert.match(html, /\\frac\{a\}\{b/)
    assert.doesNotMatch(html, /\\\[/)
  })

  it('a partial one-liner holds its body in the forming block (no `$$` flash)', () => {
    const html = renderStreamingMarkdown('$$E = mc^')
    assert.match(html, /math-block--pending/)
    assert.match(html, /E = mc\^/)
    assert.doesNotMatch(html, /\$\$/)
  })

  it('an open ```math fence uses the built-in forming scaffolding (string emitter)', () => {
    const html = renderStreamingMarkdown('```math\nE = mc')
    assert.match(html, /math-block math-block--pending stream-fence-forming/)
    assert.match(html, /<pre class="math">E = mc<\/pre>/)
  })

  it('the DOM emitter reuses the forming scaffolding nodes across updates', () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.update('$$\nE = m')
    const block = host.querySelector('.math-block')
    const pre = host.querySelector('pre.math')
    assert.ok(block && pre)
    renderer.update('$$\nE = mc^2')
    assert.equal(host.querySelector('.math-block'), block, 'root reused')
    assert.equal(host.querySelector('pre.math'), pre, 'pre reused')
    assert.equal(pre?.textContent, 'E = mc^2')
  })

  it('never flashes raw display delimiters at any cut of any math doc', () => {
    for (const [name, doc] of MATH_DOCS) {
      const host = document.createElement('div')
      const renderer = new StreamingMarkdownRenderer(host)
      for (let i = 1; i <= doc.length; i++) {
        renderer.update(doc.slice(0, i))
        const text = host.textContent ?? ''
        // Raw `$$` / `\[` may legitimately show once committed as prose (the
        // "prose $$ line" doc) — but never while mid-line.
        if (!doc.slice(0, i).includes('\n') || doc[i - 1] !== '\n') {
          if (name !== 'prose $$ line') {
            assert.ok(!text.includes('$$'), `${name}: raw $$ at cut ${String(i)}: ${text}`)
            assert.ok(!text.includes('\\['), `${name}: raw \\[ at cut ${String(i)}: ${text}`)
          }
        }
      }
    }
  })
})

describe('streaming math: convergence between emitters and at-rest render', () => {
  it('char-by-char DOM streaming converges to the sanitized at-rest render', () => {
    for (const [name, doc] of MATH_DOCS) {
      const host = streamCharByChar(doc)
      const display = host.querySelector('.stream-complete')?.innerHTML
      const atRest = sanitizeRenderedMarkdown(renderMarkdown(doc))
      assert.equal(display, atRest, name)
    }
  })

  it('string and DOM emitters agree on the final frame', () => {
    for (const [name, doc] of MATH_DOCS) {
      const host = streamCharByChar(doc)
      assert.equal(extractStreamingDisplay(host), renderStreamingMarkdown(doc), name)
    }
  })
})

describe('inline math streaming hold', () => {
  const visible = (s: string): string => s.slice(0, pendingHoldIndex(s))

  it('holds a half-open $ span so `$x+` never flashes', () => {
    assert.equal(visible('see $x plus'), 'see ')
    assert.equal(visible('a $$half'), 'a ')
    assert.equal(visible('ok \\(a+b'), 'ok ')
    assert.equal(visible('trailing $'), 'trailing ')
  })

  it('does not hold currency', () => {
    assert.equal(visible('costs $20 and'), 'costs $20 and')
    assert.equal(visible('price 20$'), 'price 20$')
    assert.equal(visible('$5 vs $10'), '$5 vs $10')
  })

  it('does not hold three-plus dollar runs (never delimiters)', () => {
    assert.equal(visible('a $$$ b'), 'a $$$ b')
  })

  it('does not hold complete spans or escaped/code dollars', () => {
    assert.equal(visible('done $x$ tail'), 'done $x$ tail')
    assert.equal(visible('done \\(x\\) tail'), 'done \\(x\\) tail')
    assert.equal(visible('escaped \\$ stays'), 'escaped \\$ stays')
    assert.equal(visible('run `$x` now'), 'run `$x` now')
  })

  it('a mid-sentence math span upgrades in place as the closer arrives', () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.update('Euler: $e^{i\\pi}')
    assert.ok(!(host.textContent ?? '').includes('$'), 'opener held')
    renderer.update('Euler: $e^{i\\pi}+1=0$ done.\n')
    assert.ok(host.querySelector('.math-inline.math-inline--pending'))
    assert.equal(host.querySelector('.math-inline')?.textContent, 'e^{i\\pi}+1=0')
  })
})

describe('re-render upgrade in place (hydration after streaming)', () => {
  afterEach(() => setMathRenderer(null))

  it('committed scaffolding hydrates without re-rendering the markdown', async () => {
    setMathRenderer({
      render: (source, { displayMode }) =>
        Promise.resolve({
          html: `<span class="katex" data-display="${String(displayMode)}">${source}</span>`,
        }),
    })
    const doc = '$$\nE = mc^2\n$$\n\nInline $a+b$ done.\n'
    const host = streamCharByChar(doc)

    const count = await hydratePendingMath(host)

    assert.equal(count, 2)
    assert.ok(host.querySelector('.math-block--rendered [data-display="true"]'))
    assert.ok(host.querySelector('.math-inline--rendered [data-display="false"]'))
    assert.ok(!host.querySelector('.math-block--pending'))
    assert.ok(!host.querySelector('.math-inline--pending'))
  })
})
