import '../tests/setup-dom-jsdom.ts'
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { fenceCodeClass } from './highlight.ts'
import {
  __resetShikiForTests,
  installShiki,
  loadShiki,
  shikiHighlighter,
  shikiThemeCss,
} from './highlight-shiki.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'

// The shiki analogue of highlight-lazy.test.ts, run against the REAL shiki
// package (it is DOM-free, so unlike mermaid it works under Node). The jsdom
// setup above is imported only for the sanitizer; it also installs the hljs
// backend as the process default, so each phase below supplies the shiki
// highlighter through per-render config instead.

describe('lazy highlighting via the shiki backend', () => {
  before(() => {
    __resetShikiForTests()
  })

  it('renders escaped plain text with a stable class before the library loads', () => {
    // The facade can be supplied synchronously (eager form); until the async
    // load resolves it behaves exactly like the core's no-backend fallback.
    const html = renderMarkdownUnsafe('```ts\nconst x = 1 < 2\n```', {
      codeHighlighter: shikiHighlighter,
    })
    // Class resolution stays in the core (ts → typescript), identical before
    // and after load — no className churn on upgrade.
    assert.match(html, /<pre><code class="hljs lang-typescript">/)
    assert.doesNotMatch(html, /<span/)
    assert.match(html, /const x = 1 &lt; 2/)
    // No theme is known yet either.
    assert.equal(shikiThemeCss(), '')
  })

  it('upgrades to color-class token spans after loadShiki resolves', async () => {
    const backend = await loadShiki()
    assert.equal(backend, shikiHighlighter)

    const html = renderMarkdownUnsafe('```ts\nconst x = 1 < 2\n```', { codeHighlighter: backend })
    assert.match(html, /<pre><code class="hljs lang-typescript">/)
    // Tokens carry theme-palette classes, not inline styles (which the sink
    // sanitizer would strip).
    assert.match(html, /<span class="shiki-[0-9a-f]{3,8}">const<\/span>/)
    assert.doesNotMatch(html, /style=/)
    // The `<` from the source is still escaped.
    assert.match(html, /&lt;/)
    assert.doesNotMatch(html, /x = 1 < 2/)
  })

  it('keeps the class identical across the plain → highlighted upgrade', async () => {
    const beforeLoad = fenceCodeClass('ts')

    await loadShiki() // already loaded — reuses the instance
    const afterLoad = fenceCodeClass('ts')

    assert.equal(beforeLoad, afterLoad, 'class is core-resolved, stable across backend load')
    assert.equal(beforeLoad, 'hljs lang-typescript')
  })

  it('loadShiki is idempotent and returns the same backend', async () => {
    const first = await loadShiki()
    const second = await loadShiki()
    assert.equal(first, second)
    assert.equal(first, shikiHighlighter)
  })

  it('output passes the sink sanitizer unmangled', async () => {
    const highlighter = await loadShiki()
    const html = renderMarkdownUnsafe('```ts\nconst n = 1 // note\n```', { codeHighlighter: highlighter })
    // Token markup is inside the allowlist (spans + class only), so the
    // sanitizer is a byte-for-byte no-op on it.
    assert.equal(sanitizeRenderedMarkdown(html), html)
    assert.match(html, /<span class="shiki-[0-9a-f]{3,8}">/)

    // With quotes in the code the sanitizer's serializer relaxes `&quot;` back
    // to `"` in text (valid HTML, same for plain fences) — the token markup
    // itself still survives intact.
    const quoted = sanitizeRenderedMarkdown(
      renderMarkdownUnsafe('```ts\nconst s = "a<b&c"\n```', { codeHighlighter: highlighter }),
    )
    assert.match(quoted, /<span class="shiki-[0-9a-f]{3,8}">"a&lt;b&amp;c"<\/span>/)
  })

  it('covers the bash and shell core ids through the shellscript grammar', async () => {
    await loadShiki()
    assert.match(shikiHighlighter.highlight('echo hi', 'bash'), /<span class="shiki-/)
    assert.match(shikiHighlighter.highlight('echo hi', 'shell'), /<span class="shiki-/)
  })

  it('an unknown language stays escaped plain text', async () => {
    const highlighter = await loadShiki()
    // Through the core (never reaches the backend)…
    const html = renderMarkdownUnsafe('```weirdlang\n<script>\n```', { codeHighlighter: highlighter })
    assert.match(html, /<code class="hljs lang-weirdlang">&lt;script&gt;/)
    // …and via the drift guard for a core-known id whose grammar isn't loaded.
    assert.equal(shikiHighlighter.highlight('<script>', 'notloaded'), '&lt;script&gt;')
  })

  it('an empty fence info string stays plain — shiki has no auto-detect', async () => {
    const highlighter = await loadShiki()
    assert.equal(shikiHighlighter.highlightAuto('const x = 1'), 'const x = 1')
    const html = renderMarkdownUnsafe('```\nconst x = 1\n```', { codeHighlighter: highlighter })
    assert.match(html, /<pre><code class="hljs lang-text">const x = 1\n<\/code><\/pre>/)
  })

  it('shikiThemeCss provides a rule for every emitted color class', async () => {
    await loadShiki()
    const css = shikiThemeCss()
    const html = shikiHighlighter.highlight('export function f(n: number) { return `${n}` }', 'typescript')
    const emitted = new Set(html.match(/shiki-[0-9a-f]{3,8}/g))
    assert.ok(emitted.size > 0, 'sample emits at least one color class')
    for (const className of emitted) {
      assert.match(css, new RegExp(`^\\.${className} \\{ color: #[0-9a-f]{3,8} \\}$`, 'm'))
    }
    assert.match(css, /^\.shiki-italic \{ font-style: italic \}$/m)
    assert.match(css, /^\.shiki-bold \{ font-weight: bold \}$/m)
  })

  it('preserves the code verbatim across lines and blank lines', async () => {
    await loadShiki()
    const code = 'const a = 1\n\n  if (a) {\n  }'
    const html = shikiHighlighter.highlight(code, 'typescript')
    const text = html.replace(/<span[^>]*>|<\/span>/g, '')
    assert.equal(text, 'const a = 1\n\n  if (a) {\n  }')
  })
})

describe('installShiki (sync facade, background load)', () => {
  before(() => {
    __resetShikiForTests()
  })

  it('returns the facade immediately and upgrades once loading completes', async () => {
    const backend = installShiki()
    assert.equal(backend, shikiHighlighter)
    // Synchronously after install the library isn't loaded yet: plain text.
    assert.equal(shikiHighlighter.highlight('const x = 1', 'typescript'), 'const x = 1')

    // loadShiki reuses installShiki's in-flight load (first call wins).
    await loadShiki()
    assert.match(shikiHighlighter.highlight('const x = 1', 'typescript'), /<span class="shiki-/)
  })
})

describe('loadShiki options (custom theme and grammar set)', () => {
  // A minimal custom theme exercising the non-default paths: a non-hex color
  // (never trusted into a class name), font styles, and a settings entry with
  // no foreground.
  const testTheme = {
    name: 'smd-test-theme',
    type: 'dark',
    colors: {},
    settings: [
      { settings: { foreground: '#AABBCC' } }, // default fg (uppercase on purpose)
      { scope: 'comment', settings: { foreground: 'red', fontStyle: 'italic bold' } },
      { scope: 'keyword', settings: { foreground: '#112233' } },
      { scope: 'string', settings: { fontStyle: 'underline' } },
    ],
  }

  before(() => {
    __resetShikiForTests()
  })

  it('loads a theme registration object and a narrowed grammar list', async () => {
    await loadShiki({ theme: testTheme, langs: ['typescript'] })

    // Keyword color from the custom theme (`=` is keyword.operator in the TS
    // grammar), lowercased into the class name.
    const html = shikiHighlighter.highlight('const x = 1 // hi', 'typescript')
    assert.match(html, /<span class="shiki-112233">=<\/span>/)
    // The non-hex `red` comment color yields no color class — only font styles.
    assert.match(html, /<span class="shiki-italic shiki-bold">\/\/ hi<\/span>/)
    // Default-foreground tokens are emitted bare (no span at all).
    assert.match(html, /^const x <span/)

    // Grammars outside the narrowed list fall back to plain text.
    assert.equal(shikiHighlighter.highlight('func main() {}', 'go'), 'func main() {}')

    const css = shikiThemeCss()
    assert.match(css, /^\.shiki-112233 \{ color: #112233 \}$/m)
    assert.doesNotMatch(css, /aabbcc/, 'no rule for the default foreground')
    assert.match(css, /^\.shiki-underline \{ text-decoration: underline \}$/m)
  })
})
