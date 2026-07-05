// Layer 2 (#21): frozen-prefix + tail-group incremental commit rendering.
//
// The frozen/tail split must stay byte-identical to a fresh whole-prefix render
// at *every* commit across a full streaming history — not just the two-step
// history the convergence fuzz already covers. These tests drive a single
// renderer through every boundary and assert parity at each step, plus cover
// each settling hazard and seam/sweep edge the design enumerates.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadBaselinePassingExamples } from '../tests/commonmark/baseline-examples.ts'
import { renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { StreamingMarkdownRenderer, splitForStreaming } from './streaming.ts'
import { tokenizeBlocks } from './block-tokenizer.ts'
import { FrozenTailRenderer, settledTailStart } from './streaming-frozen-tail.ts'

function completeEl(host: HTMLElement): HTMLElement {
  const el = host.querySelector('.stream-complete')
  assert.ok(el instanceof HTMLElement, 'stream-complete host exists')
  return el
}

describe('frozen-tail full streaming history parity', () => {
  it('committed subtree equals the at-rest render at every fully-committed frame', () => {
    // Drive ONE renderer through every prefix (full frozen history). At each
    // frame where the tokenizer commits the whole prefix (no pending tail, so
    // stream-complete holds only committed frozen+tail nodes), the committed
    // subtree must be byte-identical to a fresh whole-string render — this is
    // the frozen-accumulation invariant across an arbitrarily long history.
    for (const ex of loadBaselinePassingExamples()) {
      const md = ex.markdown
      const host = document.createElement('div')
      const r = new StreamingMarkdownRenderer(host)
      for (let cut = 1; cut <= md.length; cut++) {
        const prefix = md.slice(0, cut)
        r.update(prefix)
        const split = splitForStreaming(prefix)
        if (split.pending !== '') continue
        assert.equal(
          completeEl(host).innerHTML,
          sanitizeRenderedMarkdown(renderMarkdown(split.complete)),
          `example #${String(ex.example)} (${ex.section}) cut=${String(cut)}`,
        )
      }
    }
  })
})

/** Stream `chunks` cumulatively through one renderer; return the committed HTML. */
function streamCommitted(chunks: string[]): { html: string; host: HTMLElement } {
  const host = document.createElement('div')
  const r = new StreamingMarkdownRenderer(host)
  let acc = ''
  for (const chunk of chunks) {
    acc += chunk
    r.update(acc)
  }
  return { html: completeEl(host).innerHTML, host }
}

/** Committed HTML must equal the at-rest render once the input fully commits. */
function assertCommittedAtRest(chunks: string[]): void {
  const full = chunks.join('')
  const { complete, pending } = splitForStreaming(full)
  assert.equal(pending, '', `input fully commits: ${JSON.stringify(full)}`)
  const { html } = streamCommitted(chunks)
  assert.equal(html, sanitizeRenderedMarkdown(renderMarkdown(complete)))
}

describe('frozen-tail keeps the committed prefix out of per-commit work', () => {
  it('a settled block keeps one node instance across many later commits', () => {
    // The core Layer 2 guarantee, tested deterministically (no timing): once a
    // block freezes it is never re-rendered, so its DOM node keeps identity for
    // the rest of the stream. If the committed prefix were re-rendered per
    // commit (the O(n²) this fixes), the node instance would change each time.
    //
    // Streamed char-by-char with inline formatting so the split boundary jitters
    // (an unresolved `**`/backtick retreats the commit point, shrinking
    // `complete`) — the case that used to force a full-morph fallback and churn
    // every frozen node. The first paragraph's node must survive all of it.
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    let full = ''
    for (let i = 0; i < 30; i++) {
      full += `Paragraph ${String(i)} with **bold**, \`code\`, *em* and a [link](https://example.com/${String(i)}).\n\n`
    }
    // Track the first paragraph's node only once it is frozen — i.e. once a
    // later paragraph has committed after it (before that it is the live tail,
    // legitimately re-rendered as it streams).
    const frozenFirstNodes = new Set<Element>()
    for (let cut = 1; cut <= full.length; cut++) {
      r.update(full.slice(0, cut))
      const paragraphs = completeEl(host).querySelectorAll('p')
      const first = paragraphs[0]
      const laterCommitted = paragraphs.length > 1
      if (first && laterCommitted && first.textContent?.startsWith('Paragraph 0 ')) {
        frozenFirstNodes.add(first)
      }
    }
    assert.equal(
      frozenFirstNodes.size,
      1,
      'the frozen first paragraph node is never re-created for the rest of the stream',
    )
  })
})

describe('frozen-tail committed-prefix render work is sub-quadratic (#21 CI guard)', () => {
  // Deterministic, timing-free guard: `renderedChars` counts the HTML the
  // frozen/tail renderer produces per commit. A regression that re-renders the
  // whole committed prefix each commit (the O(n²) #21 removed — e.g. a fallback
  // that fires every frame) makes this grow ~4× per input doubling instead of
  // ~2×. Driving FrozenTailRenderer directly at commit boundaries mirrors what
  // StreamingMarkdownRenderer.update does.
  function proseDoc(paras: number): string {
    return (
      Array.from(
        { length: paras },
        (_, i) =>
          `Paragraph ${String(i)} has **bold**, \`code\`, *em* and a [link](https://example.com/${String(i)}) plus words.`,
      ).join('\n\n') + '\n'
    )
  }

  function renderedCharsFor(doc: string): number {
    const host = document.createElement('div')
    const ft = new FrozenTailRenderer()
    let last = ''
    for (let cut = 1; cut <= doc.length; cut++) {
      const complete = splitForStreaming(doc.slice(0, cut)).complete
      if (complete !== last) {
        ft.update(host, complete, tokenizeBlocks(complete))
        last = complete
      }
    }
    return ft.renderedChars
  }

  it('doubling the input roughly doubles committed-prefix render work, not quadruples it', () => {
    const small = renderedCharsFor(proseDoc(25))
    const large = renderedCharsFor(proseDoc(50))
    const ratio = large / small
    assert.ok(
      ratio < 3,
      `committed-prefix render work grew ${ratio.toFixed(2)}× when input doubled ` +
        `(expected ~2×; ~4× signals a return to O(prefix)-per-commit rendering, #21)`,
    )
  })
})

describe('intra-list tail bounding (#29)', () => {
  /** Byte-parity with the at-rest render at every fully-committed frame. */
  function assertFullHistoryParity(md: string): void {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    for (let cut = 1; cut <= md.length; cut++) {
      const prefix = md.slice(0, cut)
      r.update(prefix)
      const split = splitForStreaming(prefix)
      if (split.pending !== '') continue
      assert.equal(
        completeEl(host).innerHTML,
        sanitizeRenderedMarkdown(renderMarkdown(split.complete)),
        `cut=${String(cut)}`,
      )
    }
  }

  const items = (n: number, mk: (i: number) => string): string =>
    Array.from({ length: n }, (_, i) => mk(i)).join('\n')

  it('holds byte-parity across freeze, seal, and a following ordered list', () => {
    assertFullHistoryParity(
      `${items(12, (i) => `- item ${String(i)} with **bold** and \`code\``)}\n\nAfter.\n\n${items(6, (i) => `${String(i + 1)}. o${String(i)}`)}\n\nEnd.\n\n`,
    )
  })

  it('tight→loose flip after items froze falls back and stays byte-identical', () => {
    assertFullHistoryParity(`${items(8, (i) => `- t${String(i)}`)}\n\n- late loose item\n\nafter\n\n`)
  })

  it('a task item arriving after items froze updates the shared <ul> class', () => {
    assertFullHistoryParity(`${items(6, (i) => `- plain ${String(i)}`)}\n- [x] done late\n- [ ] todo\n\nafter\n\n`)
  })

  it('a marker change mid-run splits the group and stays byte-identical', () => {
    assertFullHistoryParity(
      `${items(6, (i) => `- a${String(i)}`)}\n${items(6, (i) => `* b${String(i)}`)}\n\nafter\n\n`,
    )
  })

  it('a late multi-paragraph item (loose via content) stays byte-identical', () => {
    assertFullHistoryParity(
      `${items(6, (i) => `- c${String(i)}`)}\n- multi\n\n  second para of item\n\nafter\n\n`,
    )
  })

  it('ordered lists keep their start attribute across intra-list freezing', () => {
    assertFullHistoryParity(`${items(8, (i) => `${String(i + 3)}. o${String(i)}`)}\n\nafter\n\n`)
  })

  it('items with nested lists freeze correctly', () => {
    assertFullHistoryParity(
      `${items(6, (i) => `- outer ${String(i)}\n  - nested ${String(i)}`)}\n\nafter\n\n`,
    )
  })

  it('an in-place rewrite while intra-list freezing is active is replaced', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    const alpha = `${items(8, (i) => `- alpha ${String(i)}`)}\n`
    const bravo = `${items(8, (i) => `- bravo ${String(i)}`)}\n`
    for (let cut = 1; cut <= alpha.length; cut++) r.update(alpha.slice(0, cut))
    r.update(bravo)
    assert.equal(
      completeEl(host).innerHTML,
      sanitizeRenderedMarkdown(renderMarkdown(splitForStreaming(bravo).complete)),
    )
  })

  it('a frozen <li> keeps its node instance for the rest of the stream', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    let acc = ''
    const seen = new Set<Element>()
    for (let i = 0; i < 20; i++) {
      acc += `- item ${String(i)} with **bold** text\n`
      r.update(acc)
      const first = completeEl(host).querySelector('li')
      const total = completeEl(host).querySelectorAll('li').length
      if (first && total > 2 && first.textContent?.startsWith('item 0')) seen.add(first)
    }
    assert.equal(seen.size, 1, 'first item li never re-created once frozen')
  })

  it('doubling a pure list roughly doubles committed render work (#29 CI guard)', () => {
    // The list-shaped analogue of the top-level guard: before intra-list
    // freezing this grew ~4×/doubling (the whole group re-rendered per commit).
    function listRenderedChars(itemCount: number): number {
      const doc = `${items(itemCount, (i) => `- item ${String(i)} with **bold** and \`code\``)}\n`
      const host = document.createElement('div')
      const ft = new FrozenTailRenderer()
      let last = ''
      for (let cut = 1; cut <= doc.length; cut++) {
        const complete = splitForStreaming(doc.slice(0, cut)).complete
        if (complete !== last) {
          ft.update(host, complete, tokenizeBlocks(complete))
          last = complete
        }
      }
      return ft.renderedChars
    }
    const small = listRenderedChars(50)
    const large = listRenderedChars(100)
    const ratio = large / small
    assert.ok(
      ratio < 3,
      `list render work grew ${ratio.toFixed(2)}× when items doubled (expected ~2×, ~4× = regression)`,
    )
  })
})

describe('frozen-tail settling hazards', () => {
  it('paragraph → setext retro-conversion (tail never frozen too early)', () => {
    // "Hello\n" commits as an open paragraph in the tail; "===\n" retro-converts
    // the whole thing to an <h1>. Freezing the paragraph would strand a <p>.
    assertCommittedAtRest(['Hello\n', '===\n'])
    const { html } = streamCommitted(['Hello\n', '===\n', '\nafter\n'])
    assert.match(html, /<h1[^>]*>Hello<\/h1>/)
    assert.doesNotMatch(html, /<p>Hello<\/p>/)
  })

  it('a list growing loose is never frozen tight', () => {
    // A tight two-item list becomes loose when a blank-separated item arrives.
    assertCommittedAtRest(['- a\n', '- b\n', '\n', '- c\n', '\npara\n'])
    const { html } = streamCommitted(['- a\n', '- b\n', '\n', '- c\n', '\npara\n'])
    assert.match(html, /<li>\s*<p>a<\/p>\s*<\/li>/, 'list rendered loose (items wrapped in <p>)')
  })

  it('table body rows append across commits', () => {
    assertCommittedAtRest([
      '| A | B |\n',
      '| - | - |\n',
      '| 1 | 2 |\n',
      '| 3 | 4 |\n',
      '\npara\n',
    ])
  })

  it('blank-separated quotes stream as separate blockquotes (spec 242)', () => {
    assertCommittedAtRest(['> a\n', '\n', '> b\n', '\npara\n'])
    const { html } = streamCommitted(['> a\n', '\n', '> b\n', '\npara\n'])
    const quotes = html.match(/<blockquote>/g) ?? []
    assert.equal(quotes.length, 2, 'a blank line ends a blockquote')
  })

  it('trailing indented raw-HTML block follows the raw-HTML policy (gap A)', () => {
    // A top-level indented block that is really raw HTML must render as prose,
    // not <pre><code> — the frozen/tail renderBlocks calls carry htmlFromIndent.
    assertCommittedAtRest(['    <div>hi</div>\n', '\npara\n'])
    const { html } = streamCommitted(['    <div>hi</div>\n', '\npara\n'])
    assert.doesNotMatch(html, /<pre>/, 'indented raw HTML did not become a code block')
  })

  it('lazy paragraph continuation absorbs a would-be-frozen earlier line', () => {
    // `"Foo\n"` can commit as a paragraph, then `"    ***"` extends it into a
    // single paragraph — the earlier line is absorbed, so `frozenEnd` no longer
    // lands on a block boundary and the fast path must fall back (gap: the
    // boundary straddle check). Byte-parity must hold through the absorption.
    assertCommittedAtRest(['Foo\n', '    ***\n', '\nafter\n'])
    const { html } = streamCommitted(['Foo\n', '    ***\n'])
    assert.match(html, /<p>Foo\n {4}\*\*\*<\/p>/)
  })

  it('trailing-open re-tokenization of the committed prefix stays in the tail', () => {
    // `"    a\n\n"` re-tokenizes as an *open* indented_code because the closing
    // terminator lies beyond the commit boundary — must not be frozen.
    const complete = '    a\n\n'
    const tokens = tokenizeBlocks(complete)
    assert.equal(settledTailStart(tokens), 0, 'open trailing indented_code kept wholly in tail')
    assertCommittedAtRest(['    a\n', '\n', '    b\n', '\npara\n'])
  })
})

describe('frozen-tail forward reference (link-ref guard fallback)', () => {
  it('a late [x]: url re-renders the earlier block that used [x]', () => {
    // The reference is used before it is defined; when the definition finally
    // commits, the link-ref guard falls back to a full morph so the earlier
    // paragraph re-renders as a resolved link.
    const chunks = ['See [x] here.\n', '\n', 'filler\n', '\n', '[x]: https://example.com\n']
    assertCommittedAtRest(chunks)
    const { html } = streamCommitted(chunks)
    assert.match(html, /<a href="https:\/\/example\.com"[^>]*>x<\/a>/)
  })
})

describe('tail-scoped pending queries survive pending-kind transitions', () => {
  it('never leaves a stale pending element when the pending kind changes', () => {
    // The pending-sync queries are scoped to the streaming tail (last element
    // child) instead of the whole committed subtree. Stream through paragraph →
    // list → continuation → heading → blockquote pending kinds and assert never
    // more than one block-pending element exists at once (no stale leftovers).
    const docs = [
      'Intro paragraph one.\n\n- item a\n- item b\n  continued text\n\n### Heading\n\n> quote line\n> more\n\nFinal.',
      '1. first\n2. second\n\nplain para\n\n> bq\n\n- x\n- y\n',
    ]
    for (const md of docs) {
      const host = document.createElement('div')
      const r = new StreamingMarkdownRenderer(host)
      for (let cut = 1; cut <= md.length; cut++) {
        r.update(md.slice(0, cut))
        const pendingBlocks = completeEl(host).querySelectorAll('.stream-pending-block').length
        assert.ok(
          pendingBlocks <= 1,
          `at most one block-pending element (cut=${String(cut)}, saw ${String(pendingBlocks)})`,
        )
      }
    }
  })
})

describe('review regressions (#21 PR review)', () => {
  it('an indented pending list item after a paragraph stays visible without list churn', () => {
    // The tail-scoped findOpenListItemHost must never return the pending <li>
    // itself as the nesting host — that detached the pending subtree and left a
    // fresh empty wrapper <ul> behind on every frame.
    const md = '- item\n\npara\n\n  - abcdef ghi'
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    for (let cut = 1; cut <= md.length; cut++) {
      r.update(md.slice(0, cut))
      const emptyLists = completeEl(host).querySelectorAll('ul:empty, ol:empty').length
      assert.ok(emptyLists <= 1, `no empty-list churn (cut=${String(cut)})`)
    }
    const pendingLi = completeEl(host).querySelector('li.stream-pending-block')
    assert.ok(pendingLi?.textContent?.includes('abcdef'), 'pending item text is visible')
    r.update(`${md}\n\n`)
    assert.equal(
      completeEl(host).innerHTML,
      sanitizeRenderedMarkdown(renderMarkdown(`${md}\n\n`)),
      'converges to the at-rest render on commit',
    )
  })

  it('a non-append-only rewrite replaces stale frozen content', () => {
    // Rewriting content in place (message regeneration/edit) keeps block
    // boundaries intact, so only the frozen-source byte check can catch it.
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('# Alpha\n\npara one\n\n')
    r.update('# Bravo\n\npara one\n\n')
    const html = completeEl(host).innerHTML
    assert.match(html, /Bravo/)
    assert.doesNotMatch(html, /Alpha/)
    assert.equal(html, sanitizeRenderedMarkdown(renderMarkdown('# Bravo\n\npara one\n\n')))
  })

  it('an unclosed benign raw inline tag keeps byte-parity with the at-rest render', () => {
    // Whole-string sanitization re-opens an unclosed <b> into every later block
    // (formatting-element reconstruction); freezing such a block must be refused
    // so the stream falls back to the full morph and stays byte-identical.
    const md = 'before <b>bold\n\nafter words\n\nmore trailing\n\n'
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    for (let cut = 1; cut <= md.length; cut++) r.update(md.slice(0, cut))
    assert.equal(completeEl(host).innerHTML, sanitizeRenderedMarkdown(renderMarkdown(md)))
  })

  it('a block keeps its DOM node instance across its own freeze transition', () => {
    // Settling must adopt the existing tail nodes (one combined morph), not
    // parse fresh frozen nodes — otherwise every block is torn down exactly
    // once at its freeze frame (selection/animation/media reset).
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('First paragraph.\n')
    const before = completeEl(host).querySelector('p')
    assert.ok(before, 'paragraph committed while still in the tail')
    r.update('First paragraph.\n\nSecond para')
    assert.equal(completeEl(host).querySelector('p'), before, 'node survives the freeze')
  })
})

describe('frozen-tail seam and sweep edges', () => {
  it('a blank-only / link_ref_def-only frozen delta adds no stray text node (gap B)', () => {
    // The delta between two committed paragraphs is a blank plus a bare ref def:
    // it renders empty and must neither append nodes nor a seam.
    assertCommittedAtRest(['first\n', '\n', '[x]: https://example.com\n', '\n', 'second\n', '\n'])
    const { html } = streamCommitted([
      'first\n',
      '\n',
      '[x]: https://example.com\n',
      '\n',
      'second\n',
      '\n',
    ])
    assert.equal(html, sanitizeRenderedMarkdown(renderMarkdown('first\n\n[x]: https://example.com\n\nsecond\n\n')))
  })

  it('a commit performed while a block-level pending element is attached sweeps it (gap E)', () => {
    // "intro\n\n" commits and freezes the paragraph; "### Sec" is a block-level
    // pending <div> appended to stream-complete; the next commit must remove it.
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    r.update('intro\n\n### Sec')
    const complete = completeEl(host)
    assert.ok(complete.querySelector('.stream-pending-heading'), 'pending heading attached')
    r.update('intro\n\n### Sec\n\nbody\n\n')
    assert.equal(complete.querySelector('.stream-pending-heading'), null, 'stale pending swept on commit')
    assert.equal(
      complete.innerHTML,
      sanitizeRenderedMarkdown(renderMarkdown('intro\n\n### Sec\n\nbody\n\n')),
    )
  })
})
