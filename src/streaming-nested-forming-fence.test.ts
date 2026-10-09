import '../tests/setup-dom-jsdom.ts'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { tokenizeBlocks } from './block-tokenizer.ts'
import { FORMING_FENCE_PRE_CLASS } from './fence-handlers.ts'
import { mountIsolatedDiagrams } from './mermaid-isolated.ts'
import { renderMarkdown, renderMarkdownUnsafe } from './renderer.ts'
import { asSanitizedHtml } from './sanitize.ts'
import { morphInnerHtml } from './streaming-dom-morph.ts'
import {
  renderStreamingMarkdown,
  StreamingMarkdownRenderer,
  type StreamingMarkdownOptions,
} from './streaming.ts'
import { committedTailContinues, splitForStreaming } from './streaming-split.ts'

// A fenced code block nested in a list item or a blockquote is committed with
// its container (the open item / quote commits line by line), so it never
// reaches the top-level `.stream-forming` host. While it is still open it must
// carry the same forming marker a top-level forming fence does (hosts gate
// Copy/Download on it; the isolated Mermaid adapter skips forming diagrams), and
// lose it, class-only, once its closing fence commits.

const FORMING = `.${FORMING_FENCE_PRE_CLASS}`

function parse(html: string): HTMLElement {
  const d = document.createElement('div')
  d.innerHTML = html
  return d
}

function stream(
  r: StreamingMarkdownRenderer,
  prefix: string,
  more: string,
  each?: (i: number) => void,
): void {
  for (let i = 1; i <= more.length; i++) {
    r.update(prefix + more.slice(0, i))
    each?.(prefix.length + i)
  }
}

/** Forming elements nested inside committed containers (never the top-level host). */
function nestedForming(root: Element): Element[] {
  return [...root.querySelectorAll(`li ${FORMING}, blockquote ${FORMING}`)]
}

function completeEl(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>('.stream-complete')!
}

interface Case {
  name: string
  /** Committed prefix whose last nested fence is still open. */
  open: string
  /** What is appended next. */
  next: string
  /** Whether the nested fence is still open after `next`. */
  stillOpen: boolean
  /** `next` is the fence's own closing line (closing must be class-only). */
  closesInPlace?: boolean
  /** Selector for the fence's rendered root (default `pre`). */
  root?: string
  options?: StreamingMarkdownOptions
}

const CASES: Case[] = [
  {
    name: 'ordered list item (content column 3), closer one column past it',
    open: '1. Do this:\n\n    ```sql\n    SELECT 1;\n',
    next: '    ```\n',
    stillOpen: false,
    closesInPlace: true,
  },
  { name: 'blockquote', open: '> ```js\n> code\n', next: '> ```\n', stillOpen: false, closesInPlace: true },
  {
    name: 'list inside a blockquote',
    open: '> - x\n>   ```js\n>   y\n',
    next: '>   ```\n',
    stillOpen: false,
    closesInPlace: true,
  },
  {
    name: 'blockquote inside a list item',
    open: '- x\n  > ```js\n  > y\n',
    next: '  > ```\n',
    stillOpen: false,
    closesInPlace: true,
  },
  {
    name: 'second-level list item',
    open: '- a\n  - b\n    ```js\n    y\n',
    next: '    ```\n',
    stillOpen: false,
    closesInPlace: true,
  },
  {
    name: 'closer indented 3 columns past the content column still closes',
    open: '- a\n\n  ```js\n  x\n',
    next: '     ```\n',
    stillOpen: false,
    closesInPlace: true,
  },
  {
    name: 'closer indented 4 columns past the content column is content',
    open: '- a\n\n  ```js\n  x\n',
    next: '      ```\n',
    stillOpen: true,
  },
  {
    name: 'closer shorter than the opener is content',
    open: '- a\n  ````js\n  x\n',
    next: '  ```\n',
    stillOpen: true,
  },
  {
    name: 'closer of the other fence character is content',
    open: '- a\n  ~~~\n  x\n',
    next: '  ```\n',
    stillOpen: true,
  },
  {
    name: 'a blank line inside the open fence keeps it open',
    open: '- a\n  ```js\n  x\n',
    next: '\n',
    stillOpen: true,
  },
  {
    name: 'a fence at column 0 ends the list item (and opens a top-level fence)',
    open: '- a\n\n  ```js\n  x\n',
    next: '```\n',
    stillOpen: false,
  },
  {
    name: 'the next list item ends the previous item and its fence',
    open: '- a\n  ```js\n  x\n',
    next: '- b\n',
    stillOpen: false,
  },
  {
    name: 'an unmarked line ends the quote (no lazy continuation into a fence)',
    open: '> ```js\n> x\n',
    next: 'after\n',
    stillOpen: false,
  },
  {
    name: 'mermaid fence handler: forming scaffolding while open',
    open: '- Diagram:\n\n  ```mermaid\n  graph TD\n  A-->B\n',
    next: '  ```\n',
    stillOpen: false,
    closesInPlace: true,
    root: '.mermaid-diagram',
  },
  {
    name: '```math fence handler',
    open: '> ```math\n> x^2\n',
    next: '> ```\n',
    stillOpen: false,
    closesInPlace: true,
    root: '.math-block',
  },
  {
    name: '$$ display math',
    open: '- a\n\n  $$\n  x^2\n',
    next: '  $$\n',
    stillOpen: false,
    closesInPlace: true,
    root: '.math-block',
    options: { mathSyntax: true },
  },
]

describe('nested forming fence marker', () => {
  for (const c of CASES) {
    const root = c.root ?? 'pre'
    const opts = c.options ?? {}

    it(`${c.name}: string emitter`, () => {
      const open = parse(String(renderStreamingMarkdown(c.open, opts)))
      const forming = nestedForming(open)
      assert.equal(forming.length, 1, `one nested forming fence in ${open.innerHTML}`)
      assert.ok(forming[0]!.matches(root), `forming root is ${root}: ${open.innerHTML}`)
      // Every partial line of `next` and its committed end agree with the outcome
      // once the line decides it (a closer is only a closer once it commits).
      const after = parse(String(renderStreamingMarkdown(c.open + c.next, opts)))
      assert.equal(nestedForming(after).length, c.stillOpen ? 1 : 0, after.innerHTML)
    })

    it(`${c.name}: DOM emitter${c.closesInPlace ? ', class-only promotion' : ''}`, () => {
      const host = document.createElement('div')
      const r = new StreamingMarkdownRenderer(host, opts)
      stream(r, '', c.open)
      const forming = nestedForming(completeEl(host))
      assert.equal(forming.length, 1, `one nested forming fence in ${host.innerHTML}`)
      const node = forming[0]!
      assert.ok(node.matches(root), `forming root is ${root}: ${host.innerHTML}`)

      stream(r, c.open, c.next)
      assert.equal(nestedForming(completeEl(host)).length, c.stillOpen ? 1 : 0, host.innerHTML)
      if (c.closesInPlace) {
        assert.ok(host.contains(node), 'the forming root keeps its identity when it closes')
        assert.ok(!node.classList.contains(FORMING_FENCE_PRE_CLASS))
      }
    })

    it(`${c.name}: the emitters agree at every cut`, () => {
      const doc = c.open + c.next
      const host = document.createElement('div')
      const r = new StreamingMarkdownRenderer(host, opts)
      stream(r, '', doc, (i) => {
        const prefix = doc.slice(0, i)
        const str = parse(String(renderStreamingMarkdown(prefix, opts)))
        // The marker decision (not the pending-tail preview shapes, which the
        // emitters format independently) must match frame by frame.
        assert.equal(
          nestedForming(completeEl(host)).length,
          nestedForming(str).length,
          `cut ${i}: ${JSON.stringify(prefix)}`,
        )
        // A frame with nothing pending is the committed render alone: byte-equal.
        if (prefix.endsWith('\n') && host.querySelector<HTMLElement>('.stream-forming')!.hidden) {
          assert.equal(completeEl(host).innerHTML, str.innerHTML, `cut ${i}`)
        }
      })
    })
  }

  it('never marks a fence at rest', () => {
    for (const c of CASES) {
      const opts = c.options ?? {}
      assert.ok(!String(renderMarkdown(c.open, opts)).includes(FORMING_FENCE_PRE_CLASS))
      assert.ok(!renderMarkdownUnsafe(c.open, opts).includes(FORMING_FENCE_PRE_CLASS))
    }
  })

  it('marks only the trailing open fence, not an earlier one closed by its container', () => {
    const doc = '- a\n  ```js\n  x\n- b\n\n  ```py\n  y\n'
    const host = document.createElement('div')
    stream(new StreamingMarkdownRenderer(host), '', doc)
    for (const html of [String(renderStreamingMarkdown(doc)), completeEl(host).innerHTML]) {
      const forming = nestedForming(parse(html))
      assert.equal(forming.length, 1, html)
      assert.ok(forming[0]!.querySelector('code.lang-python'), html)
    }
  })

  it('drops the marker as soon as a held column-0 fence ends the container', () => {
    // The top-level fence holds `complete` where it was, so only the content
    // tokens show that the list item (and its fence) ended. The DOM emitter must
    // re-run its commit for that flip even though `complete` did not change.
    const open = '- a\n\n  ```js\n  x\n'
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    stream(r, '', open)
    const pre = nestedForming(completeEl(host))[0]!
    // (A lone '`' is still a lazy continuation of the item as far as the block
    // tokenizer is concerned; the third backtick makes it a fence opener.)
    r.update(open + '```')
    assert.equal(nestedForming(completeEl(host)).length, 0, host.innerHTML)
    assert.ok(host.contains(pre) && !pre.classList.contains(FORMING_FENCE_PRE_CLASS))
  })
})

describe('committedTailContinues', () => {
  const at = (content: string): boolean => {
    const split = splitForStreaming(content)
    return committedTailContinues(split.complete, split.blocks)
  }
  it('is false with nothing committed', () => {
    assert.equal(committedTailContinues('', tokenizeBlocks('')), false)
    assert.equal(at('- a'), false)
  })
  it('is true while the trailing block runs into the held tail, or nothing is held', () => {
    assert.equal(at('- a\n  ```\n  x\n'), true)
    assert.equal(at('- a\n  ```\n  x\n  y'), true)
    assert.equal(at('- a\n  ```\n  x\n\n'), true)
    assert.equal(at('> ```\n> x\n> y'), true)
  })
  it('is false once the held tail starts a new block', () => {
    assert.equal(at('- a\n\n  ```\n  x\n```'), false)
    assert.equal(at('- a\n  ```\n  x\n- b'), false)
    assert.equal(at('> ```\n> x\n\n```js\ny'), false)
  })
})

describe('nested forming fence across frozen-tail commit paths', () => {
  const formingIn = (host: HTMLElement) => nestedForming(completeEl(host)).length

  // Hosts often feed whole lines or larger chunks, so the content that ends the
  // container can arrive in the same update that commits it (no intermediate
  // pending frame flips `formingTail` first). Each case is run both ways.
  const feeds: [string, (r: StreamingMarkdownRenderer, before: string, after: string) => void][] = [
    ['char by char', (r, before, after) => stream(r, before, after)],
    ['in one chunk', (r, before, after) => r.update(before + after)],
  ]

  for (const [feed, more] of feeds) {
    it(`a list that settles after its fence was forming does not freeze the marker (${feed})`, () => {
      // The list group was the tail while its fence was forming; when the
      // paragraph after it arrives the list settles into the frozen prefix. The
      // tail memo must not adopt the forming render as the frozen one.
      const before = '- a\n  ```js\n  x\n\n'
      const doc = before + 'after\n\nmore text\n\n# heading\n'
      const host = document.createElement('div')
      const r = new StreamingMarkdownRenderer(host)
      stream(r, '', before)
      assert.equal(formingIn(host), 1, host.innerHTML)
      // `after\n` alone: the list becomes exactly the newly-settled delta, the
      // shape the memoized-span adoption takes.
      more(r, before, 'after\n')
      assert.equal(formingIn(host), 0, host.innerHTML)
      stream(r, before + 'after\n', doc.slice(before.length + 'after\n'.length))
      assert.equal(formingIn(host), 0, host.innerHTML)
      assert.equal(completeEl(host).innerHTML, String(renderMarkdown(doc)))
    })

    it(`intra-list freezing re-renders the item that stops forming (${feed})`, () => {
      const before = '- one\n- two\n- three\n- four\n  ```js\n  x\n'
      const doc = before + '- five\n- six\n'
      const host = document.createElement('div')
      const r = new StreamingMarkdownRenderer(host)
      stream(r, '', before)
      assert.equal(formingIn(host), 1, host.innerHTML)
      more(r, before, doc.slice(before.length))
      assert.equal(formingIn(host), 0, host.innerHTML)
      assert.equal(completeEl(host).innerHTML, String(renderMarkdown(doc)))
    })

    it(`the footnote fast path does not keep a stale marker (${feed})`, () => {
      // With a definition already committed, later definitions take the
      // append-only footnote fast path, which re-renders only body parts citing
      // a new label. A definition at column 0 also ends the open list item, so
      // the list part must not keep its forming render.
      const before = 'Text[^1].\n\n[^1]: first\n\n- a\n  ```js\n  x\n'
      const doc = before + '[^2]: second\n'
      const host = document.createElement('div')
      const r = new StreamingMarkdownRenderer(host)
      stream(r, '', before)
      assert.equal(formingIn(host), 1, host.innerHTML)
      more(r, before, doc.slice(before.length))
      assert.equal(formingIn(host), 0, host.innerHTML)
      assert.equal(completeEl(host).innerHTML, String(renderMarkdown(doc)))
    })
  }
})

describe('isolated Mermaid adapter and a nested forming fence', () => {
  const channels: MessageChannel[] = []
  const OriginalChannel = globalThis.MessageChannel
  const savedObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
  beforeEach(() => {
    channels.length = 0
    globalThis.MessageChannel = class extends OriginalChannel {
      constructor() {
        super()
        channels.push(this)
      }
    }
    Object.defineProperty(globalThis, 'MutationObserver', {
      value: window.MutationObserver,
      configurable: true,
    })
  })
  afterEach(() => {
    globalThis.MessageChannel = OriginalChannel
    for (const channel of channels) {
      channel.port1.close()
      channel.port2.close()
    }
    if (savedObserver) Object.defineProperty(globalThis, 'MutationObserver', savedObserver)
    else Reflect.deleteProperty(globalThis, 'MutationObserver')
  })

  it('mounts a nested diagram only once its fence has closed', () => {
    // Before the forming marker reached nested fences, this mounted a frame as
    // soon as the opener line committed (an empty diagram, then re-morphed
    // under the frame on every later line).
    const doc = '1. Draw it:\n\n   ```mermaid\n   graph TD\n   A-->B\n   ```\n\n2. Done.\n'
    const closeAt = doc.indexOf('   ```\n\n2.') + '   ```\n'.length
    const host = document.createElement('div')
    document.body.append(host)
    stream(new StreamingMarkdownRenderer(host), '', doc, (i) => {
      mountIsolatedDiagrams(host, { url: '/frame.html' })
      const frames = host.querySelectorAll('iframe').length
      if (i < closeAt) assert.equal(frames, 0, `mounted before the fence closed (at ${i})`)
    })
    assert.equal(host.querySelectorAll('iframe').length, 1, 'mounted once closed')
    host.remove()
  })
})

describe('morph: forming promotion is class-only', () => {
  const morph = (from: string, to: string) => {
    const el = document.createElement('div')
    el.innerHTML = from
    const before = el.firstElementChild
    morphInnerHtml(el, asSanitizedHtml(to))
    const fresh = document.createElement('div')
    fresh.innerHTML = to
    assert.equal(el.innerHTML, fresh.innerHTML, 'serializes like a fresh parse')
    return el.firstElementChild === before
  }
  it('keeps the element when only the forming class drops', () => {
    assert.ok(morph('<pre class="stream-fence-forming"><code>x</code></pre>', '<pre><code>x</code></pre>'))
    assert.ok(
      morph(
        '<div class="mermaid-diagram mermaid-diagram--pending stream-fence-forming"><pre class="mermaid">a</pre></div>',
        '<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">a</pre></div>',
      ),
    )
  })
  it('replaces the element on any other attribute change, or the reverse direction', () => {
    assert.ok(!morph('<pre class="stream-fence-forming"><code>x</code></pre>', '<pre class="other"><code>x</code></pre>'))
    assert.ok(!morph('<pre><code>x</code></pre>', '<pre class="stream-fence-forming"><code>x</code></pre>'))
    assert.ok(!morph('<pre class="stream-fence-forming" data-a="1"><code>x</code></pre>', '<pre data-a="2"><code>x</code></pre>'))
    assert.ok(!morph('<pre class="stream-fence-forming-x"><code>x</code></pre>', '<pre><code>x</code></pre>'))
  })
})
