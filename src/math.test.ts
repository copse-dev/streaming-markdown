import '../tests/setup-dom-jsdom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { tokenizeBlocks } from './block-tokenizer.ts'
import {
  getMathRenderer,
  hydratePendingMath,
  type MathRenderer,
  setMathRenderer,
} from './math.ts'
import { renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

// First-class math support (#70): all four block/inline surface forms emit the
// same inert two-phase scaffolding (escaped source inside allowlisted tags),
// and `hydratePendingMath` upgrades it after the sink sanitizer — the mermaid
// shape, with KaTeX behind `@copse/streaming-markdown/math/katex`.

const BLOCK_SCAFFOLD_RE =
  /<div class="math-block math-block--pending"><pre class="math">([^<]*)<\/pre><\/div>/
const INLINE_SCAFFOLD_RE = /<span class="math-inline math-inline--pending">([^<]*)<\/span>/

function blockSource(html: string): string | null {
  return BLOCK_SCAFFOLD_RE.exec(html)?.[1] ?? null
}

function inlineSource(html: string): string | null {
  return INLINE_SCAFFOLD_RE.exec(html)?.[1] ?? null
}

describe('display math at rest', () => {
  it('renders a ```math fence as pending block scaffolding', () => {
    const html = renderMarkdown('```math\nE = mc^2\n```')
    assert.equal(blockSource(html), 'E = mc^2')
  })

  it('renders $$ blocks with own-line delimiters', () => {
    const html = renderMarkdown('before\n\n$$\n\\frac{a}{b}\n$$\n\nafter')
    assert.equal(blockSource(html), '\\frac{a}{b}')
    assert.match(html, /<p>before<\/p>/)
    assert.match(html, /<p>after<\/p>/)
  })

  it('renders a one-line $$…$$ block', () => {
    assert.equal(blockSource(renderMarkdown('$$E = mc^2$$')), 'E = mc^2')
  })

  it('renders \\[ … \\] blocks with own-line delimiters (OpenAI shape)', () => {
    const html = renderMarkdown('\\[\nE = mc^2\n\\]')
    assert.equal(blockSource(html), 'E = mc^2')
  })

  it('renders a one-line \\[ … \\] block', () => {
    assert.equal(blockSource(renderMarkdown('\\[ E = mc^2 \\]')), 'E = mc^2')
  })

  it('keeps multi-line bodies verbatim (matrix rows, blank lines)', () => {
    const html = renderMarkdown('$$\na \\\\\nb\n$$')
    assert.equal(blockSource(html), 'a \\\\\nb')
  })

  it('escapes HTML metacharacters in the source', () => {
    const html = renderMarkdown('$$\na < b & "c"\n$$')
    assert.equal(blockSource(html), 'a &lt; b &amp; &quot;c&quot;')
  })

  it('$$ interrupts a paragraph like a fence opener', () => {
    const html = renderMarkdown('text\n$$\nx\n$$')
    assert.match(html, /<p>text<\/p>/)
    assert.equal(blockSource(html), 'x')
  })

  it('an unclosed $$ block is closed by the end of the document', () => {
    assert.equal(blockSource(renderMarkdown('$$\nx+y')), 'x+y')
  })

  it('a $$ line with content but no closer is prose, not math', () => {
    const html = renderMarkdown('$$ not closed\nmore prose')
    assert.doesNotMatch(html, /math-block/)
    assert.match(html, /\$\$ not closed/)
  })

  it('a line that is only \\[\\] (empty body) stays prose (spec escape examples)', () => {
    const html = renderMarkdown('\\[\\]')
    assert.doesNotMatch(html, /math-block/)
    assert.match(html, /\[\]/)
  })

  it('four-space-indented $$ is indented code, not math', () => {
    const html = renderMarkdown('    $$\n    x\n    $$')
    assert.doesNotMatch(html, /math-block/)
    assert.match(html, /<pre><code>/)
  })

  it('$$ lines inside a fenced code block never open math', () => {
    const html = renderMarkdown('```\n$$\nx\n$$\n```')
    assert.doesNotMatch(html, /math-block/)
  })

  it('scaffolding survives the sink sanitizer unchanged', () => {
    const html = sanitizeRenderedMarkdown(renderMarkdown('$$\na < b\n$$'))
    assert.match(html, /class="math-block math-block--pending"/)
    assert.match(html, /<pre class="math">a &lt; b<\/pre>/)
  })

  it('tokenizes $$ blocks as math_block (open while streaming)', () => {
    assert.deepEqual(
      tokenizeBlocks('$$\nx\n$$\n').map((t) => [t.kind, t.status]),
      [['math_block', 'complete']],
    )
    assert.deepEqual(
      tokenizeBlocks('$$\nx').map((t) => [t.kind, t.status]),
      [['math_block', 'open']],
    )
    // A still-streaming `$$E=mc` is held open until its newline decides.
    assert.deepEqual(
      tokenizeBlocks('$$E=mc').map((t) => [t.kind, t.status]),
      [['math_block', 'open']],
    )
    assert.deepEqual(
      tokenizeBlocks('$$ x\n').map((t) => [t.kind, t.status]),
      [['paragraph', 'complete']],
    )
  })
})

describe('inline math at rest', () => {
  it('renders $…$ spans', () => {
    const html = renderMarkdown('Euler: $e^{i\\pi}+1=0$ wow')
    assert.equal(inlineSource(html), 'e^{i\\pi}+1=0')
  })

  it('renders mid-line $$…$$ spans', () => {
    assert.equal(inlineSource(renderMarkdown('so $$x^2$$ mid')), 'x^2')
  })

  it('renders \\(…\\) spans', () => {
    assert.equal(inlineSource(renderMarkdown('so \\(a_i + b\\) mid')), 'a_i + b')
  })

  it('keeps math content verbatim across emphasis characters', () => {
    const html = renderMarkdown('$a_i * b_j$')
    assert.equal(inlineSource(html), 'a_i * b_j')
    assert.doesNotMatch(html, /<em>/)
  })

  it('restores backslash escapes to their TeX form (\\{ \\$ \\\\)', () => {
    assert.equal(inlineSource(renderMarkdown('x $\\{a\\}$ y')), '\\{a\\}')
    assert.equal(inlineSource(renderMarkdown('$a \\$ b$')), 'a \\$ b')
  })

  it('works inside headings and table cells', () => {
    assert.equal(inlineSource(renderMarkdown('# Result $x^2$')), 'x^2')
    const table = renderMarkdown('| a |\n|---|\n| $x^2$ |')
    assert.equal(inlineSource(table), 'x^2')
  })

  it('does NOT fire on currency ($20 and $30, $5 vs $10)', () => {
    for (const md of ['costs $20 and $30 total', '$5 vs $10', 'between $a and $b']) {
      const html = renderMarkdown(md)
      assert.doesNotMatch(html, /math-inline/, md)
    }
  })

  it('does NOT pair when the closing $ is followed by a digit', () => {
    assert.doesNotMatch(renderMarkdown('$x$5 stays literal'), /math-inline/)
  })

  it('an escaped \\$ never delimits', () => {
    const html = renderMarkdown('a \\$x$ b')
    assert.doesNotMatch(html, /math-inline/)
    assert.match(html, /\$x\$/)
  })

  it('does NOT fire inside code spans or fenced code', () => {
    assert.doesNotMatch(renderMarkdown('run `$x$` now'), /math-inline/)
    assert.doesNotMatch(renderMarkdown('```\n$x$\n```'), /math-inline/)
  })

  it('does NOT fire inside link destinations', () => {
    const html = renderMarkdown('[a](/x?p=$q$r) tail')
    assert.doesNotMatch(html, /math-inline/)
    assert.match(html, /href="\/x\?p=\$q\$r"/)
  })

  it('does fire inside link labels (their own inline scope)', () => {
    const html = renderMarkdown('[see $x^2$](/url)')
    assert.equal(inlineSource(html), 'x^2')
  })

  it('requires a non-blank body and tight delimiters', () => {
    assert.doesNotMatch(renderMarkdown('a $ $ b'), /math-inline/)
    assert.doesNotMatch(renderMarkdown('a $ x$ b'), /math-inline/)
    assert.doesNotMatch(renderMarkdown('a $x $ b'), /math-inline/)
    assert.doesNotMatch(renderMarkdown('empty \\(\\) parens'), /math-inline/)
  })

  it('never crosses a line ending', () => {
    assert.doesNotMatch(renderMarkdown('a $x\ny$ b'), /math-inline/)
  })

  it('three or more dollars never delimit', () => {
    assert.doesNotMatch(renderMarkdown('a $$$x$$$ b'), /math-inline/)
  })

  it('a run of the wrong length is content, not a closer (code-span matching)', () => {
    assert.equal(inlineSource(renderMarkdown('so $$a$b$$ mid')), 'a$b')
  })

  it('emphasis still wraps a complete math span', () => {
    const html = renderMarkdown('*$x$*')
    assert.match(html, /<em><span class="math-inline math-inline--pending">x<\/span><\/em>/)
  })

  it('inline scaffolding survives the sink sanitizer', () => {
    const html = sanitizeRenderedMarkdown(renderMarkdown('so $a<b$ ok'))
    assert.match(html, /<span class="math-inline math-inline--pending">a&lt;b<\/span>/)
  })
})

describe('math hydration (registry + hydratePendingMath)', () => {
  afterEach(() => setMathRenderer(null))

  /** Build a detached DOM subtree from the generator's math scaffolding. */
  function renderToDom(md: string): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = renderMarkdown(md)
    return host
  }

  const MATH_MD = '$$\nE = mc^2\n$$\n\nInline $a+b$ here.'

  it('is a no-op without a registered renderer', async () => {
    setMathRenderer(null)
    assert.equal(getMathRenderer(), null)
    const host = renderToDom(MATH_MD)
    const count = await hydratePendingMath(host)
    assert.equal(count, 0)
    assert.ok(host.querySelector('.math-block--pending'))
    assert.ok(host.querySelector('.math-inline--pending'))
  })

  it('hydrates blocks in display mode and spans in inline mode', async () => {
    const calls: { source: string; display: boolean }[] = []
    const stub: MathRenderer = {
      render: (source, { displayMode }) => {
        calls.push({ source, display: displayMode })
        return Promise.resolve({ html: `<span class="katex">${source.length}</span>` })
      },
    }
    setMathRenderer(stub)

    const host = renderToDom(MATH_MD)
    const count = await hydratePendingMath(host)

    assert.equal(count, 2)
    assert.deepEqual(calls, [
      { source: 'E = mc^2', display: true },
      { source: 'a+b', display: false },
    ])
    const block = host.querySelector('.math-block')
    assert.ok(block?.classList.contains('math-block--rendered'))
    assert.ok(!block?.classList.contains('math-block--pending'))
    assert.ok(!host.querySelector('pre.math'), 'inert source <pre> replaced')
    const span = host.querySelector('.math-inline')
    assert.ok(span?.classList.contains('math-inline--rendered'))
  })

  it('reads entity-decoded source back from the scaffolding', async () => {
    const sources: string[] = []
    setMathRenderer({
      render: (source) => {
        sources.push(source)
        return Promise.resolve({ html: '<span class="katex">ok</span>' })
      },
    })
    const host = renderToDom('$$\na < b & c\n$$')
    await hydratePendingMath(host)
    assert.deepEqual(sources, ['a < b & c'])
  })

  it('marks elements errored (source kept visible) when the backend throws', async () => {
    setMathRenderer({ render: () => Promise.reject(new Error('bad TeX')) })
    const host = renderToDom(MATH_MD)
    const count = await hydratePendingMath(host)
    assert.equal(count, 0)
    const block = host.querySelector('.math-block')
    assert.ok(block?.classList.contains('math-block--error'))
    assert.ok(!block?.classList.contains('math-block--pending'))
    assert.equal(host.querySelector('pre.math')?.textContent, 'E = mc^2', 'escaped source kept')
    assert.ok(host.querySelector('.math-inline--error'))
  })

  it('applies a transformHtml hook (host sanitizer seam)', async () => {
    setMathRenderer({
      render: () => Promise.resolve({ html: '<span class="katex"><script>evil()</script></span>' }),
    })
    const host = renderToDom('$$\nx\n$$')
    await hydratePendingMath(host, {
      transformHtml: (html) => html.replace(/<script>[\s\S]*?<\/script>/g, ''),
    })
    assert.ok(!host.querySelector('script'), 'transformHtml ran before injection')
    assert.ok(host.querySelector('.katex'))
  })

  it('marks the element errored when injection fails (Trusted Types seam)', async () => {
    let renders = 0
    setMathRenderer({
      render: () => {
        renders++
        return Promise.resolve({ html: '<span class="katex">x</span>' })
      },
    })
    const host = renderToDom('$$\nx\n$$')
    const count = await hydratePendingMath(host, {
      transformHtml: () => {
        throw new TypeError('TrustedHTML required')
      },
    })
    assert.equal(count, 0)
    assert.equal(renders, 1)
    const block = host.querySelector('.math-block')
    assert.ok(block?.classList.contains('math-block--error'))
    assert.equal(host.querySelector('pre.math')?.textContent, 'x', 'inert source stays visible')
  })

  it('hydrates a root that is itself the pending element', async () => {
    setMathRenderer({ render: () => Promise.resolve({ html: '<span class="katex">ok</span>' }) })
    const host = renderToDom('$$\nx\n$$')
    const block = host.querySelector<HTMLElement>('.math-block')
    assert.ok(block)
    const count = await hydratePendingMath(block)
    assert.equal(count, 1)
    assert.ok(block.classList.contains('math-block--rendered'))
  })

  it('skips empty sources', async () => {
    let renders = 0
    setMathRenderer({
      render: () => {
        renders++
        return Promise.resolve({ html: '<span></span>' })
      },
    })
    const host = document.createElement('div')
    host.innerHTML = '<div class="math-block math-block--pending"><pre class="math"> </pre></div>'
    const count = await hydratePendingMath(host)
    assert.equal(count, 0)
    assert.equal(renders, 0)
  })
})
