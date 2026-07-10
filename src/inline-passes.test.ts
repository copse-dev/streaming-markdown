import '../tests/setup-dom-jsdom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml } from './escape.ts'
import { pendingHoldIndex } from './inline-emphasis.ts'
import { getInlinePasses, type InlinePass, setInlinePasses } from './inline-passes.ts'
import { renderPendingLine } from './render-pending-line.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

// The inline-pass registry (#53): custom inline syntax (citations, highlights)
// injected into the inline pipeline with code-span shielding, escape-safe HTML
// emission, and streaming-hold support.

/** Pandoc-style citation keys: `[@doe2020]` → a <span class="citation">. */
const citationPass: InlinePass = {
  name: 'citations',
  stage: 'before-links',
  apply: (text, ctx) =>
    text.replace(/\[@([\w.-]+)\]/g, (_m, key: string) =>
      ctx.emit(`<span class="citation">@${escapeHtml(key)}</span>`),
    ),
  holdStart(line, mask) {
    // Hold from a trailing `[@…` that has not closed with `]` yet.
    const open = line.lastIndexOf('[@')
    if (open === -1 || mask[open]) return line.length
    if (line.indexOf(']', open) !== -1) return line.length
    return open
  },
}

/** `==text==` → <mark> (a benign, sanitizer-allowlisted tag). */
const highlightPass: InlinePass = {
  name: 'highlight',
  apply: (text, ctx) =>
    text.replace(/==([^=\n]+)==/g, (_m, inner: string) => ctx.emit(`<mark>${inner}</mark>`)),
  holdStart(line, mask) {
    // Pair `==` runs left to right; hold from an unmatched opener, or from a
    // lone trailing `=` that could still grow into one.
    let open = -1
    let i = 0
    while (i < line.length - 1) {
      if (line[i] === '=' && line[i + 1] === '=' && !mask[i] && !mask[i + 1]) {
        open = open === -1 ? i : -1
        i += 2
        continue
      }
      i++
    }
    let cut = line.length
    if (open !== -1) cut = open
    if (line.endsWith('=') && !mask[line.length - 1] && line[line.length - 2] !== '=') {
      cut = Math.min(cut, line.length - 1)
    }
    return cut
  },
}

afterEach(() => setInlinePasses(null))

describe('inline pass registry', () => {
  it('defaults to no passes and supports wholesale set/reset', () => {
    assert.equal(getInlinePasses().length, 0)
    setInlinePasses([citationPass, highlightPass])
    assert.equal(getInlinePasses().length, 2)
    assert.deepEqual(
      getInlinePasses('before-links').map((p) => p.name),
      ['citations', 'highlight'],
    )
    assert.equal(getInlinePasses('after-links').length, 0)
    setInlinePasses(null)
    assert.equal(getInlinePasses().length, 0)
  })

  it('is inert when no passes are registered', () => {
    const html = renderMarkdownUnsafe('See [@doe2020] and ==this== text.')
    assert.match(html, /\[@doe2020\]/)
    assert.match(html, /==this==/)
  })
})

describe('before-links passes', () => {
  it('renders citations through ctx.emit, surviving the escape step', () => {
    setInlinePasses([citationPass])
    const html = renderMarkdownUnsafe('See [@doe2020] for details.')
    assert.match(html, /<span class="citation">@doe2020<\/span>/)
    assert.doesNotMatch(html, /\[@doe2020\]/)
  })

  it('wins over markdown link-label parsing (Pandoc ordering)', () => {
    setInlinePasses([citationPass])
    const html = renderMarkdownUnsafe('[@doe2020] vs [a real link](https://example.com)')
    assert.match(html, /<span class="citation">@doe2020<\/span>/)
    assert.match(html, /<a[^>]*href="https:\/\/example\.com"[^>]*>a real link<\/a>/)
  })

  it('respects backslash escapes and code-span shielding', () => {
    setInlinePasses([citationPass, highlightPass])
    const escaped = renderMarkdownUnsafe('literal \\[@doe2020]')
    assert.doesNotMatch(escaped, /citation/)
    assert.match(escaped, /\[@doe2020\]/)

    const code = renderMarkdownUnsafe('`[@doe2020] ==x==` and [@real2021]')
    assert.match(code, /<code>\[@doe2020\] ==x==<\/code>/)
    assert.match(code, /<span class="citation">@real2021<\/span>/)
  })

  it('emitted <mark> passes the sanitizer sink', () => {
    setInlinePasses([highlightPass])
    const html = sanitizeRenderedMarkdown(renderMarkdownUnsafe('a ==bright== idea'))
    assert.match(html, /<mark>bright<\/mark>/)
  })

  it('applies inside GFM table cells', () => {
    setInlinePasses([citationPass])
    const html = renderMarkdownUnsafe('| ref |\n| --- |\n| [@doe2020] |')
    assert.match(html, /<td><span class="citation">@doe2020<\/span><\/td>/)
  })
})

describe('after-links passes', () => {
  it('runs over text with links already rendered', () => {
    setInlinePasses([
      {
        name: 'todo-flag',
        stage: 'after-links',
        apply: (text, ctx) => text.replace(/\bTODO\b/g, () => ctx.emit('<mark>TODO</mark>')),
      },
    ])
    const html = renderMarkdownUnsafe('TODO check [docs](https://example.com)')
    assert.match(html, /<mark>TODO<\/mark>/)
    assert.match(html, /<a[^>]*href="https:\/\/example\.com"/)
  })
})

describe('placeholder-token safety', () => {
  it('attacker-typed placeholder characters cannot address emitted HTML', () => {
    setInlinePasses([citationPass])
    // The pass emits token id 0 for the citation; the literal U+E100/U+E101
    // characters in the input are stripped before any pass runs, so the typed
    // token degrades to a plain "0" instead of resolving to the emitted span.
    const html = renderMarkdownUnsafe('[@a] then \uE1000\uE101')
    const citations = html.match(/<span class="citation">/g) ?? []
    assert.equal(citations.length, 1)
    assert.match(html, /then 0/)
  })
})

describe('streaming hold', () => {
  it('holds a half-open citation and highlight in the pending tail', () => {
    setInlinePasses([citationPass, highlightPass])
    assert.equal(pendingHoldIndex('see [@doe'), 4)
    assert.equal(pendingHoldIndex('an ==unfinished'), 3)
    // A trailing '=' only holds when it is the line's last character.
    assert.equal(pendingHoldIndex('a =maybe'), 'a =maybe'.length)
    const complete = 'done [@doe2020] and ==x== fine'
    assert.equal(pendingHoldIndex(complete), complete.length)
  })

  it('renderPendingLine suppresses the held tail', () => {
    setInlinePasses([citationPass])
    const html = renderPendingLine('progress on [@partial')
    assert.match(html, /progress on/)
    assert.doesNotMatch(html, /\[@partial/)
  })

  it('does not hold inside code spans', () => {
    setInlinePasses([citationPass])
    const line = 'x `[@key` y'
    assert.equal(pendingHoldIndex(line), line.length)
  })
})

describe('streaming convergence', () => {
  it('char-by-char streaming converges to the sanitized at-rest render', () => {
    setInlinePasses([citationPass, highlightPass])
    const source =
      'Findings from [@doe2020] were ==significant== (see `[@raw]` and [link](https://example.com)).\n\n- item with [@smith2021]\n'
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    for (let i = 1; i <= source.length; i++) {
      renderer.update(source.slice(0, i))
    }
    renderer.update(source)
    const expected = document.createElement('div')
    expected.innerHTML = sanitizeRenderedMarkdown(renderMarkdownUnsafe(source))
    assert.equal(host.innerHTML.includes('<span class="citation">@doe2020</span>'), true)
    assert.equal(
      host.querySelector('p')?.innerHTML,
      expected.querySelector('p')?.innerHTML,
    )
    assert.equal(
      host.querySelector('ul')?.outerHTML,
      expected.querySelector('ul')?.outerHTML,
    )
  })
})
