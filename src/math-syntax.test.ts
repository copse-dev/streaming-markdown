import '../tests/setup-dom-jsdom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { tokenizeBlocks } from './block-tokenizer.ts'
import { hydratePendingMath, type MathRenderer } from './math.ts'
import { getMathSyntax, setMathSyntax } from './math-syntax.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import {
  pendingHoldIndex,
  renderStreamingMarkdown,
  StreamingMarkdownRenderer,
} from './streaming.ts'

// The math prose-syntax gate (#78): recognizing `$…$` / `$$…$$` / `\(…\)` /
// `\[…\]` in prose is a grammar change with realistic false positives
// (`set $PATH$ properly`), so it stays off by default — restoring the
// invariant that output is byte-identical until a host opts in — and is turned
// on explicitly via `setMathSyntax(true)` (the `MarkdownConfig.mathSyntax`
// writer). The ```math FENCE stays always-on (explicit author intent, like mermaid).

const stubRenderer: MathRenderer = {
  render: (source) => Promise.resolve({ html: `<span class="katex">${source}</span>` }),
}

/** Prose fixtures that must render as literal text while the gate is off. */
const PROSE_FIXTURES: [string, string][] = [
  ['env var', 'set $PATH$ properly'],
  ['inline dollar', 'Euler: $e^{i\\pi}+1=0$ wow'],
  ['inline double', 'so $$x^2$$ mid'],
  ['currency', 'costs $20 and $30 total'],
  ['dollar block', 'intro\n\n$$\nE = mc^2\n$$\n\noutro'],
  ['one-line dollar block', '$$E = mc^2$$'],
  ['bracket block', '\\[\nE = mc^2\n\\]'],
  ['one-line bracket block', '\\[ E = mc^2 \\]'],
  ['escaped parens', 'so \\(a_i + b\\) mid'],
]

afterEach(() => {
  setMathSyntax(null)
})

describe('gate off (default): byte-identical pre-math output', () => {
  it('defaults to no override (null)', () => {
    assert.equal(getMathSyntax(), null)
  })

  it('emits no math scaffolding for any prose fixture', () => {
    for (const [name, md] of PROSE_FIXTURES) {
      const html = renderMarkdownUnsafe(md)
      assert.doesNotMatch(html, /math-block|math-inline/, name)
    }
  })

  it('renders `set $PATH$ properly` (and friends) as literal prose', () => {
    assert.equal(renderMarkdownUnsafe('set $PATH$ properly'), '<p>set $PATH$ properly</p>')
    assert.equal(renderMarkdownUnsafe('Euler: $e^2$ wow'), '<p>Euler: $e^2$ wow</p>')
    // Escaped punctuation keeps its CommonMark literal reading.
    assert.equal(renderMarkdownUnsafe('so \\(a + b\\) mid'), '<p>so (a + b) mid</p>')
    assert.equal(renderMarkdownUnsafe('\\[ E = mc^2 \\]'), '<p>[ E = mc^2 ]</p>')
  })

  it('tokenizes $$ delimiter lines as ordinary paragraphs (no math_block)', () => {
    const kinds = tokenizeBlocks('$$\nE = mc^2\n$$\n').map((t) => t.kind)
    assert.ok(!kinds.includes('math_block'))
    assert.deepEqual(kinds, ['paragraph'])
  })

  it('does not hold streaming tails (`$x+` stays visible)', () => {
    for (const line of ['see $x plus', 'a $$half', 'ok \\(a+b', 'trailing $']) {
      assert.equal(pendingHoldIndex(line), line.length, line)
    }
  })

  it('streams a $$ line as plain pending prose, and both emitters converge', () => {
    const html = renderStreamingMarkdown('$$\nE = mc')
    assert.doesNotMatch(html, /math-block/)

    const doc = 'intro\n\n$$\nE = mc^2\n$$\n\nInline $a+b$ end.\n'
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    for (let i = 1; i <= doc.length; i++) renderer.update(doc.slice(0, i))
    const display = host.querySelector('.stream-complete')?.innerHTML
    assert.equal(display, sanitizeRenderedMarkdown(renderMarkdownUnsafe(doc)))
    assert.doesNotMatch(display ?? '', /math-block|math-inline/)
  })

  it('the ```math fence is NOT gated (explicit author intent, like mermaid)', () => {
    const html = renderMarkdownUnsafe('```math\nE = mc^2\n```')
    assert.match(
      html,
      /<div class="math-block math-block--pending"><pre class="math">E = mc\^2<\/pre><\/div>/,
    )
    // …including its forming state.
    assert.match(renderStreamingMarkdown('```math\nE = m'), /math-block--pending/)
  })
})

describe('gate on via setMathSyntax(true)', () => {
  it('activates the prose grammar (inline and block)', () => {
    setMathSyntax(true)
    assert.match(renderMarkdownUnsafe('set $PATH$ properly'), /math-inline math-inline--pending/)
    assert.match(renderMarkdownUnsafe('$$\nE = mc^2\n$$'), /math-block math-block--pending/)
  })

  it('holds streaming tails once the grammar is on', () => {
    setMathSyntax(true)
    assert.equal('see $x plus'.slice(0, pendingHoldIndex('see $x plus')), 'see ')
  })

  it('end-to-end: enable, render, hydrate (the loadKatex one-call story)', async () => {
    // A host enables the grammar with `setMathSyntax(true)` (or `{ mathSyntax }`
    // config) and passes the loaded backend per hydration call — modelled here
    // with the stub.
    setMathSyntax(true)
    const host = document.createElement('div')
    host.innerHTML = renderMarkdownUnsafe('$$\nE = mc^2\n$$')
    const count = await hydratePendingMath(host, { renderer: stubRenderer })
    assert.equal(count, 1)
    assert.ok(host.querySelector('.math-block--rendered .katex'))
  })
})

describe('setMathSyntax override', () => {
  it('true forces the grammar on without a renderer (scaffolding-only hosts)', async () => {
    setMathSyntax(true)
    assert.equal(getMathSyntax(), true)
    const html = renderMarkdownUnsafe('inline $a+b$ here')
    assert.match(html, /math-inline math-inline--pending/)
    // No renderer: hydration is a no-op and the scaffolding stays pending.
    const host = document.createElement('div')
    host.innerHTML = html
    assert.equal(await hydratePendingMath(host), 0)
    assert.ok(host.querySelector('.math-inline--pending'))
  })

  it('false forces the grammar off', () => {
    setMathSyntax(false)
    assert.equal(renderMarkdownUnsafe('set $PATH$ properly'), '<p>set $PATH$ properly</p>')
    assert.doesNotMatch(renderMarkdownUnsafe('$$\nx\n$$'), /math-block/)
    assert.equal(pendingHoldIndex('see $x plus'), 'see $x plus'.length)
    // The explicitly labeled fence still works — that is the KaTeX-for-fences-
    // only configuration.
    assert.match(renderMarkdownUnsafe('```math\nx\n```'), /math-block--pending/)
  })

  it('a toggle between renders re-parses cleanly at rest', () => {
    // The flag is read by the shared tokenizer/pipeline: whole at-rest renders
    // are consistent under whichever state is current. (Mid-stream toggles
    // only affect regions rendered afterwards — recreate the streaming
    // renderer for a clean switch; see setMathSyntax docs.)
    const md = '$$\nx\n$$'
    setMathSyntax(true)
    assert.match(renderMarkdownUnsafe(md), /math-block/)
    setMathSyntax(false)
    assert.doesNotMatch(renderMarkdownUnsafe(md), /math-block/)
    setMathSyntax(true)
    assert.match(renderMarkdownUnsafe(md), /math-block/)
  })
})
