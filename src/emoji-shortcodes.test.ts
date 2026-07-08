import '../tests/setup-dom-jsdom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import {
  createEmojiInlinePass,
  emojiInlinePass,
  emojiShortcodes,
} from './emoji-shortcodes.ts'
import { pendingHoldIndex } from './inline-emphasis.ts'
import { setInlinePasses } from './inline-passes.ts'
import { renderPendingLine } from './render-pending-line.ts'
import { renderMarkdown } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

// The optional emoji-shortcode pass (#86): `:smile:` → 😄, built on the public
// `setInlinePasses` contract with code-span shielding, escape safety, and a
// streaming hold. The pass and its gemoji table live behind the
// `@copse/streaming-markdown/inline/emoji` subpath, never the core bundle.

afterEach(() => setInlinePasses(null))

describe('emoji shortcode pass', () => {
  it('renders known shortcodes to their gemoji glyphs', () => {
    setInlinePasses([emojiInlinePass])
    const html = renderMarkdown(':smile: and :rocket: and :+1:')
    assert.match(html, /😄/)
    assert.match(html, /🚀/)
    assert.match(html, /👍/)
    assert.doesNotMatch(html, /:smile:|:rocket:|:\+1:/)
  })

  it('leaves unknown shortcodes literal', () => {
    setInlinePasses([emojiInlinePass])
    const html = renderMarkdown('a :notacode: and :also_missing: here')
    assert.match(html, /:notacode:/)
    assert.match(html, /:also_missing:/)
  })

  it('keeps a shortcode inside a code span literal (shielded)', () => {
    setInlinePasses([emojiInlinePass])
    const html = renderMarkdown('`:smile:` but :smile: outside')
    assert.match(html, /<code>:smile:<\/code>/)
    assert.match(html, /😄/)
  })

  it('respects backslash escapes', () => {
    setInlinePasses([emojiInlinePass])
    const html = renderMarkdown('\\:smile: stays literal')
    assert.match(html, /:smile:/)
    assert.doesNotMatch(html, /😄/)
  })

  it('renders emoji inside link labels (before-links stage)', () => {
    setInlinePasses([emojiInlinePass])
    const html = renderMarkdown('[go :rocket:](https://example.com)')
    assert.match(html, /<a[^>]*href="https:\/\/example\.com"[^>]*>go 🚀<\/a>/)
  })

  it('renders emoji inside GFM table cells', () => {
    setInlinePasses([emojiInlinePass])
    const html = renderMarkdown('| mood |\n| --- |\n| :smile: |')
    assert.match(html, /<td>😄<\/td>/)
  })

  it('is not fooled by inherited object keys (prototype safety)', () => {
    setInlinePasses([emojiInlinePass])
    // `:constructor:` / `:tostring:` match the shortcode shape but are not gemoji
    // names; a plain-object lookup would resolve them to Object.prototype members.
    const html = renderMarkdown(':constructor: :tostring: :hasownproperty:')
    assert.match(html, /:constructor:/)
    assert.match(html, /:tostring:/)
    assert.match(html, /:hasownproperty:/)
    assert.doesNotMatch(html, /function|\[object/i)
  })
})

describe('createEmojiInlinePass (host extension)', () => {
  it('maps a custom shortcode table', () => {
    setInlinePasses([createEmojiInlinePass({ shipit: '🚢' })])
    const html = renderMarkdown(':shipit: now, not :smile:')
    assert.match(html, /🚢/)
    // A name outside the custom map (even a real gemoji name) stays literal.
    assert.match(html, /:smile:/)
  })

  it('the default export uses the shipped gemoji table', () => {
    assert.equal(emojiShortcodes['smile'], '😄')
    assert.equal(emojiShortcodes['+1'], '👍')
  })
})

describe('emoji pass is inert when unregistered', () => {
  it('leaves shortcodes byte-identical with no pass registered', () => {
    const source = 'ship :smile: :rocket: :+1: today'
    const withPass = (() => {
      setInlinePasses(null)
      return renderMarkdown(source)
    })()
    setInlinePasses(null)
    assert.match(withPass, /:smile:/)
    assert.match(withPass, /:rocket:/)
    assert.match(withPass, /:\+1:/)
    assert.doesNotMatch(withPass, /😄|🚀|👍/)
  })
})

describe('emoji pass streaming hold', () => {
  it('holds a half-open shortcode in the pending tail', () => {
    setInlinePasses([emojiInlinePass])
    assert.equal(pendingHoldIndex('great :smi'), 'great '.length)
    assert.equal(pendingHoldIndex('great :'), 'great :'.length) // bare colon: not held
    // A completed shortcode holds nothing.
    const done = 'great :smile: work'
    assert.equal(pendingHoldIndex(done), done.length)
    // A bare trailing colon (prose "Steps:") is never truncated.
    const prose = 'Steps:'
    assert.equal(pendingHoldIndex(prose), prose.length)
    // A colon whose run is broken by a non-shortcode char was never an opener.
    const broken = 'ratio :sm ok'
    assert.equal(pendingHoldIndex(broken), broken.length)
  })

  it('renderPendingLine suppresses the half-open tail', () => {
    setInlinePasses([emojiInlinePass])
    const html = renderPendingLine('progress :sm')
    assert.match(html, /progress/)
    assert.doesNotMatch(html, /:sm/)
  })

  it('does not hold inside code spans', () => {
    setInlinePasses([emojiInlinePass])
    const line = 'x `:sm` y'
    assert.equal(pendingHoldIndex(line), line.length)
  })
})

describe('emoji pass streaming convergence', () => {
  it('char-by-char streaming converges to the sanitized at-rest render', () => {
    setInlinePasses([emojiInlinePass])
    const source =
      'Great work :tada: on the :rocket: launch (see `:smile:` and [docs :+1:](https://example.com)).\n\n- item :fire:\n'
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    for (let i = 1; i <= source.length; i++) renderer.update(source.slice(0, i))
    renderer.update(source)
    const expected = document.createElement('div')
    expected.innerHTML = sanitizeRenderedMarkdown(renderMarkdown(source))
    assert.equal(host.querySelector('p')?.innerHTML, expected.querySelector('p')?.innerHTML)
    assert.equal(host.querySelector('ul')?.outerHTML, expected.querySelector('ul')?.outerHTML)
    // The code span is preserved literally through streaming.
    assert.match(host.innerHTML, /<code>:smile:<\/code>/)
  })
})

describe('emoji map bundle isolation', () => {
  // Per LAZY-LOADING.md: the gemoji table must never reach the main-entry bundle.
  // Bundle each entry with esbuild and assert the table is present only when the
  // emoji subpath is imported.
  const src = (name: string) => fileURLToPath(new URL(name, import.meta.url))
  // '🥇' (:1st_place_medal:) is a distinctive glyph that only appears in the map.
  const MAP_MARKER = '\u{1F947}'

  async function bundleContains(entry: string, marker: string): Promise<boolean> {
    const result = await build({
      entryPoints: [src(entry)],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      charset: 'utf8', // keep emoji glyphs literal instead of \u escapes
      logLevel: 'silent',
    })
    return result.outputFiles.some((f) => f.text.includes(marker))
  }

  it('the main entry does not bundle the emoji table', async () => {
    assert.equal(await bundleContains('index.ts', MAP_MARKER), false)
  })

  it('the emoji subpath does bundle the emoji table', async () => {
    assert.equal(await bundleContains('emoji-shortcodes.ts', MAP_MARKER), true)
  })
})
