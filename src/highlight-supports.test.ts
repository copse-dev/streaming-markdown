import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fenceCodeClass, type CodeHighlighter } from './highlight.ts'
import { withConfig } from './config.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

// `CodeHighlighter.supports` lets a backend claim fence languages beyond the
// core's KNOWN_LANGUAGES (and keep approximated ids like `tsx` as written).
// Stub backends echo the id they are asked for, so each case shows both the
// `lang-*` class and the language the backend received.
describe('CodeHighlighter.supports (backend-claimed languages)', () => {
  /** A stub backend that claims `ids` and echoes the language it was asked for. */
  function claiming(ids: readonly string[]): CodeHighlighter {
    const claimed = new Set(ids)
    return {
      highlight: (code, language) => `[${language}]${code}`,
      highlightAuto: (code) => `[auto]${code}`,
      supports: (language) => claimed.has(language),
    }
  }

  it('without supports, resolution is unchanged (aliases, KNOWN_LANGUAGES only)', () => {
    const plain: CodeHighlighter = { highlight: (c, l) => `[${l}]${c}`, highlightAuto: (c) => c }
    const render = (md: string) => renderMarkdownUnsafe(md, { codeHighlighter: plain })
    assert.match(render('```tsx\nx\n```'), /<code class="hljs lang-typescript">\[typescript\]x/)
    assert.match(render('```html\nx\n```'), /<code class="hljs lang-xml">\[xml\]x/)
    assert.match(render('```java\nx\n```'), /<code class="hljs lang-java">x/)
  })

  it('a claimed id outside KNOWN_LANGUAGES reaches the backend and keeps its class', () => {
    const html = renderMarkdownUnsafe('```Java\nclass A {}\n```', { codeHighlighter: claiming(['java']) })
    assert.match(html, /<code class="hljs lang-java">\[java\]class A \{\}/)
  })

  it('a claimed approximated id (tsx, jsx, html) is kept instead of the fallback', () => {
    const codeHighlighter = claiming(['tsx', 'html'])
    assert.match(
      renderMarkdownUnsafe('```tsx\nconst a = 1\n```', { codeHighlighter }),
      /<code class="hljs lang-tsx">\[tsx\]const a = 1/,
    )
    assert.match(renderMarkdownUnsafe('```html\nx\n```', { codeHighlighter }), /lang-html">\[html\]x/)
    // Not claimed: the approximation still applies.
    assert.match(renderMarkdownUnsafe('```jsx\nx\n```', { codeHighlighter }), /lang-javascript">\[javascript\]x/)
  })

  it('synonyms are folded before the backend is asked, so their class never varies', () => {
    const asked: string[] = []
    const codeHighlighter: CodeHighlighter = {
      highlight: (c, l) => `[${l}]${c}`,
      highlightAuto: (c) => c,
      supports: (language) => {
        asked.push(language)
        return true
      },
    }
    assert.match(renderMarkdownUnsafe('```ts\nx\n```', { codeHighlighter }), /lang-typescript">\[typescript\]x/)
    assert.match(renderMarkdownUnsafe('```sh\nx\n```', { codeHighlighter }), /lang-bash">\[bash\]x/)
    assert.ok(!asked.includes('ts') && !asked.includes('sh'), 'the raw synonym is never offered')
  })

  it('plaintext and empty info strings never consult supports', () => {
    const codeHighlighter = claiming(['text', 'plaintext', ''])
    assert.match(renderMarkdownUnsafe('```text\nx\n```', { codeHighlighter }), /lang-text">x\n</)
    assert.match(renderMarkdownUnsafe('```\nx\n```', { codeHighlighter }), /lang-text">\[auto\]x/)
  })

  it('fenceCodeClass reads the configured highlighter (and escapes a claimed id)', () => {
    assert.equal(withConfig({ codeHighlighter: claiming(['c++']) }, () => fenceCodeClass('C++')), 'hljs lang-c++')
    assert.equal(withConfig({ codeHighlighter: claiming(['a"b']) }, () => fenceCodeClass('a"b')), 'hljs lang-a&quot;b')
    // Outside a render (no highlighter): built-in resolution.
    assert.equal(fenceCodeClass('tsx'), 'hljs lang-typescript')
  })

  it('an info string naming an Object.prototype key resolves as an unknown id', () => {
    assert.equal(fenceCodeClass('constructor'), 'hljs lang-constructor')
    assert.equal(fenceCodeClass('__proto__'), 'hljs lang-__proto__')
  })
})
