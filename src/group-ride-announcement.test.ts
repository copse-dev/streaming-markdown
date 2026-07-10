/**
 * Regression: a real-world group-ride announcement (chat/LLM-style prose).
 * Exercises features that show up together in casual event write-ups but rarely
 * in the same fixture:
 *   - emoji-suffixed ATX headings (`# Après Cycle 🍻`)
 *   - two inline links in one paragraph, one with balanced brackets in its text
 *     (`[[Map]](url)` → an anchor whose visible text is literally `[Map]`)
 *   - a lone `~` in `~7:30pm` that must stay literal, never GFM strikethrough
 *   - `**bold**`, apostrophes, and slashes/parens in prose
 * Verifies the whole document at rest, then that streaming never flashes raw
 * heading/emphasis/link syntax as it arrives.
 */
import '../tests/setup-dom-jsdom.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { renderStreamingMarkdown } from './streaming.ts'

const FIXTURE_PATH = resolve(
  process.cwd(),
  'tests/fixtures/group-ride-announcement.md',
)
const RIDE = readFileSync(FIXTURE_PATH, 'utf8')

function textOf(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent
}

describe('group ride announcement (at rest)', () => {
  const html = renderMarkdownUnsafe(RIDE)

  it('loads the pinned fixture', () => {
    assert.ok(RIDE.includes('Totally Tapped Tuesdays'))
    assert.ok(RIDE.includes('[[Map]]'))
  })

  it('renders all four emoji headings as <h1> with the emoji preserved', () => {
    assert.match(html, /<h1>Location \/ Time 📍<\/h1>/)
    assert.match(html, /<h1>Pacing ⚡️<\/h1>/)
    assert.match(html, /<h1>Après Cycle 🍻<\/h1>/)
    assert.match(html, /<h1>Notes<\/h1>/)
    // No raw ATX markers leak into the rendered text.
    assert.doesNotMatch(textOf(html), /(^|\n)#\s/)
  })

  it('renders bold and inline units without touching the digits/slashes', () => {
    assert.match(html, /<strong>Inbetweeners<\/strong>/)
    assert.match(html, /28-31km\/h \(17\.4-19\.25mph\) but no drop\./)
    assert.doesNotMatch(textOf(html), /\*\*/)
  })

  it('resolves both links in the Après paragraph, incl. the [[Map]] bracket text', () => {
    assert.match(
      html,
      /<a href="https:\/\/totallybrewed\.com"[^>]*>Totally Tapped<\/a>/,
    )
    // `[[Map]](url)` — the link text is the balanced-bracket span `[Map]`,
    // so the anchor's visible text is literally "[Map]".
    assert.match(
      html,
      /<a href="https:\/\/maps\.app\.goo\.gl\/d96iZPxoZC3HerSVA"[^>]*>\[Map\]<\/a>/,
    )
    assert.match(
      html,
      /<a href="https:\/\/maps\.app\.goo\.gl\/gvaAx1G4ErxGZzsRA"[^>]*>opposite Greenfingers<\/a>/,
    )
    assert.match(
      html,
      /<a href="https:\/\/beeston\.cc\/groupriding\/"[^>]*>group riding etiquette<\/a>/,
    )
  })

  it('keeps a lone tilde in ~7:30pm literal (not GFM strikethrough)', () => {
    assert.doesNotMatch(html, /<del>/)
    assert.match(textOf(html), /~7:30pm/)
  })
})

describe('group ride announcement (streaming)', () => {
  it('never flashes raw heading, emphasis, or strikethrough syntax across cuts', () => {
    const stride = 7
    for (let cut = 1; cut <= RIDE.length; cut += stride) {
      const html = renderStreamingMarkdown(RIDE.slice(0, cut))
      // Committed heading elements must never carry the raw `#` markers.
      for (const m of html.matchAll(/<h[1-6]>([^<]*)<\/h[1-6]>/g)) {
        assert.doesNotMatch(m[1] ?? '', /^#/, `raw hash in committed heading at cut=${cut}`)
      }
      // A completed <strong>/<em> must never contain its own literal markers,
      // and the lone tilde must never resolve to <del> at any prefix.
      for (const m of html.matchAll(/<(strong|em)>([^<]*)<\/\1>/g)) {
        assert.doesNotMatch(m[2] ?? '', /\*\*|__/, `raw emphasis marker at cut=${cut}`)
      }
      assert.doesNotMatch(html, /<del>/, `unexpected strikethrough at cut=${cut}`)
    }
  })

  it('shows each heading title (with emoji) before its trailing newline commits', () => {
    for (const title of ['Location / Time 📍', 'Après Cycle 🍻']) {
      const upto = RIDE.indexOf(title) + title.length
      const html = renderStreamingMarkdown(RIDE.slice(0, upto))
      assert.match(textOf(html), new RegExp(title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
      assert.doesNotMatch(textOf(html), /#\s*(Location|Après)/)
    }
  })

  it('converges to the at-rest rendering once fully streamed', () => {
    assert.equal(
      textOf(renderStreamingMarkdown(RIDE)),
      textOf(renderMarkdownUnsafe(RIDE)),
    )
  })
})
