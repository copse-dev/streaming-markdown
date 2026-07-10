import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

// Neutral default link output (#124): anchors render as a plain `<a href>` with
// no target/rel/decorator attributes unless a host installs a link decorator.
const anchor = (href: string, label: string) => `<a href="${href}">${label}</a>`

/** Visible streaming HTML: committed blocks + any forming table + live tail. */
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

function streamingDisplayAfterUpdates(markdown: string, cuts: number[]): string {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  for (const cut of cuts) renderer.update(markdown.slice(0, cut))
  return extractStreamingDisplay(host)
}

describe('bare-URL autolink — GFM balanced-paren trailing trim (#107)', () => {
  it('keeps a closing paren that balances an earlier open paren', () => {
    const url = 'https://en.wikipedia.org/wiki/Markdown_(disambiguation)'
    assert.equal(
      renderMarkdownUnsafe(`See ${url} for details.`),
      `<p>See ${anchor(url, url)} for details.</p>`,
    )
  })

  it('still sheds a genuinely trailing paren in a parenthetical', () => {
    assert.equal(
      renderMarkdownUnsafe('(see https://example.com)'),
      `<p>(see ${anchor('https://example.com', 'https://example.com')})</p>`,
    )
  })

  it('strips only the excess unbalanced closing parens', () => {
    // Two closing, one opening → one paren belongs to the URL, one to prose.
    const kept = 'https://example.com/a_(b)'
    assert.equal(
      renderMarkdownUnsafe(`(${kept})`),
      `<p>(${anchor(kept, kept)})</p>`,
    )
  })

  it('trims a trailing underscore as GFM path punctuation (#115 unified trim)', () => {
    // The unified trimAutolinkTail (#115) follows the GFM autolink spec, which
    // lists `_` among the trailing punctuation stripped from an extended
    // autolink (as cmark-gfm / GitHub do). This supersedes the earlier
    // bare-URL-only rule that kept a trailing `_`.
    const linked = 'https://example.com/foo_bar'
    assert.equal(
      renderMarkdownUnsafe('https://example.com/foo_bar_'),
      `<p>${anchor(linked, linked)}_</p>`,
    )
  })

  it('still trims ordinary trailing sentence punctuation', () => {
    assert.equal(
      renderMarkdownUnsafe('Visit https://example.com/path!'),
      `<p>Visit ${anchor('https://example.com/path', 'https://example.com/path')}!</p>`,
    )
  })

  it('streaming reveal converges to the same href as an at-rest render', () => {
    const markdown = 'See https://en.wikipedia.org/wiki/Markdown_(disambiguation) for details.\n'
    const atRest = sanitizeRenderedMarkdown(renderMarkdownUnsafe(markdown))
    for (let cut = 1; cut < markdown.length; cut++) {
      const viaHistory = streamingDisplayAfterUpdates(markdown, [cut, markdown.length])
      assert.equal(viaHistory, streamingDisplayAfterUpdates(markdown, [markdown.length]), `cut=${cut}`)
    }
    assert.equal(streamingDisplayAfterUpdates(markdown, [markdown.length]), atRest)
  })
})
