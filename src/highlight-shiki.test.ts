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
//
// Every load passes NO_TIME_LIMIT. shiki cuts a line short once tokenizing it
// takes over 500ms, and a grammar's first highlight includes the JavaScript
// regex engine compiling its patterns — which on a busy machine overruns the
// budget and returns the whole line as one token, failing assertions about
// token boundaries for reasons unrelated to this backend.
const NO_TIME_LIMIT = { tokenizeTimeLimit: 0 } as const

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
    const backend = await loadShiki(NO_TIME_LIMIT)
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
    const backend = installShiki(NO_TIME_LIMIT)
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
    await loadShiki({ theme: testTheme, langs: ['typescript'], ...NO_TIME_LIMIT })

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

describe('loadShiki option validation and lookup', () => {
  before(() => {
    __resetShikiForTests()
  })

  it('rejects `theme` and `themes` together', async () => {
    // The type forbids it; a JS caller (or a cast) gets a clear rejection
    // instead of one option silently winning.
    const options = { theme: 'github-dark', themes: { light: 'github-light', dark: 'github-dark' } }
    await assert.rejects(loadShiki(options as never), /either `theme` or `themes`/)
    __resetShikiForTests()
  })

  it('rejects an unknown grammar or theme name from the lazy maps', async () => {
    await assert.rejects(loadShiki({ langs: ['not-a-grammar'] }), /unknown shiki language "not-a-grammar"/)
    __resetShikiForTests()
    await assert.rejects(loadShiki({ theme: 'not-a-theme' }), /unknown shiki theme "not-a-theme"/)
    __resetShikiForTests()
    // Own keys only: a prototype property is not a grammar.
    await assert.rejects(loadShiki({ langs: ['constructor'] }), /unknown shiki language "constructor"/)
    __resetShikiForTests()
  })
})

describe('loadShiki light/dark themes', () => {
  // Two minimal custom themes so the class names are known: each has its own
  // default foreground, keyword color and comment style. The dark theme's
  // keyword color is its default foreground, so `=` carries a LIGHT class only
  // — the case a scoped stylesheet must handle without leaking light colors
  // into dark mode.
  const lightTheme = {
    name: 'smd-test-light',
    type: 'light',
    colors: {},
    settings: [
      { settings: { foreground: '#101010' } },
      { scope: 'comment', settings: { foreground: '#00aa00', fontStyle: 'italic' } },
      { scope: 'keyword', settings: { foreground: '#112233' } },
    ],
  }
  const darkTheme = {
    name: 'smd-test-dark',
    type: 'dark',
    colors: {},
    settings: [
      { settings: { foreground: '#eeeeee' } },
      { scope: 'comment', settings: { foreground: '#88ff88', fontStyle: 'bold' } },
      { scope: 'keyword', settings: { foreground: '#eeeeee' } },
      { scope: 'constant.numeric', settings: { foreground: '#ffaa00' } },
    ],
  }

  before(async () => {
    __resetShikiForTests()
    await loadShiki({ themes: { light: lightTheme, dark: darkTheme }, langs: ['typescript'], ...NO_TIME_LIMIT })
  })

  it('emits classes for both themes on each token, from one markup', () => {
    const html = shikiHighlighter.highlight('const x = 1 // hi', 'typescript')
    // Keyword: light color only (the dark color is the dark default foreground).
    assert.match(html, /<span class="shiki-112233">=<\/span>/)
    // Numeric: dark color only (light has no rule for it → its default fg).
    assert.match(html, /<span class="shiki-dark-ffaa00">1<\/span>/)
    // Comment: both colors and each theme's own font style.
    assert.match(html, /<span class="shiki-00aa00 shiki-italic shiki-dark-88ff88 shiki-dark-bold">\/\/ hi<\/span>/)
    // Default in both themes: bare text.
    assert.match(html, /^const x <span/)
    assert.doesNotMatch(html, /style=/)
    // Verbatim text across lines.
    const code = 'const a = 1\n\n  // c'
    assert.equal(shikiHighlighter.highlight(code, 'typescript').replace(/<span[^>]*>|<\/span>/g, ''), code)
  })

  it('output passes the sink sanitizer unmangled', () => {
    const html = renderMarkdownUnsafe('```ts\nconst n = 1 // note\n```', { codeHighlighter: shikiHighlighter })
    assert.equal(sanitizeRenderedMarkdown(html), html)
    assert.match(html, /shiki-dark-/)
  })

  it('shikiThemeCss scopes each theme by prefers-color-scheme by default', () => {
    assert.equal(
      shikiThemeCss(),
      [
        '@media (prefers-color-scheme: light) {',
        '  .shiki-00aa00 { color: #00aa00 }',
        '  .shiki-112233 { color: #112233 }',
        '  .shiki-italic { font-style: italic }',
        '  .shiki-bold { font-weight: bold }',
        '  .shiki-underline { text-decoration: underline }',
        '  .shiki-strikethrough { text-decoration: line-through }',
        '}',
        '@media (prefers-color-scheme: dark) {',
        '  .shiki-dark-88ff88 { color: #88ff88 }',
        '  .shiki-dark-ffaa00 { color: #ffaa00 }',
        '  .shiki-dark-italic { font-style: italic }',
        '  .shiki-dark-bold { font-weight: bold }',
        '  .shiki-dark-underline { text-decoration: underline }',
        '  .shiki-dark-strikethrough { text-decoration: line-through }',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('shikiThemeCss scopes dark under a host selector when given one', () => {
    const css = shikiThemeCss({ darkSelector: '[data-theme="dark"], .dark' })
    assert.match(
      css,
      /^\.shiki-112233:where\(:not\(:is\(\[data-theme="dark"\], \.dark\) \*\)\) \{ color: #112233 \}$/m,
    )
    assert.match(css, /^:where\(\[data-theme="dark"\], \.dark\) \.shiki-dark-ffaa00 \{ color: #ffaa00 \}$/m)
    assert.match(css, /^:where\(\[data-theme="dark"\], \.dark\) \.shiki-dark-bold \{ font-weight: bold \}$/m)
    assert.doesNotMatch(css, /@media/)
  })

  it('the selector-scoped rules pick exactly one theme per subtree in a real DOM', () => {
    // jsdom implements selector matching (not the cascade), which is enough to
    // check the scoping: each class matches its rule only in its own mode.
    const css = shikiThemeCss({ darkSelector: '[data-theme="dark"]' })
    const selectors = css
      .trim()
      .split('\n')
      .map((rule) => rule.slice(0, rule.indexOf(' {')))
    const root = document.createElement('div')
    root.innerHTML =
      '<div><span class="shiki-112233 shiki-dark-ffaa00"></span></div>' +
      '<div data-theme="dark"><span class="shiki-112233 shiki-dark-ffaa00"></span></div>'
    document.body.append(root)
    const matching = (span: Element) => selectors.filter((selector) => span.matches(selector))
    const [lightSpan, darkSpan] = root.querySelectorAll('span')
    assert.deepEqual(matching(lightSpan!), ['.shiki-112233:where(:not(:is([data-theme="dark"]) *))'])
    assert.deepEqual(matching(darkSpan!), [':where([data-theme="dark"]) .shiki-dark-ffaa00'])
    root.remove()
  })

  it('a single theme ignores darkSelector (unscoped rules, as before)', async () => {
    __resetShikiForTests()
    await loadShiki({ theme: lightTheme, langs: ['typescript'], ...NO_TIME_LIMIT })
    assert.equal(shikiThemeCss({ darkSelector: '.dark' }), shikiThemeCss())
    assert.match(shikiThemeCss(), /^\.shiki-112233 \{ color: #112233 \}$/m)
    assert.doesNotMatch(shikiHighlighter.highlight('const x = 1 // hi', 'typescript'), /shiki-dark-/)
  })
})
