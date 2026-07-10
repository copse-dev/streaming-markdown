import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from './streaming.ts'

describe('GitHub alerts (#72)', () => {
  it('renders each of the five alert types with GitHub-compatible classes', () => {
    const cases: [string, string][] = [
      ['NOTE', 'Note'],
      ['TIP', 'Tip'],
      ['IMPORTANT', 'Important'],
      ['WARNING', 'Warning'],
      ['CAUTION', 'Caution'],
    ]
    for (const [marker, title] of cases) {
      assert.equal(
        renderMarkdownUnsafe(`> [!${marker}]\n> Body text.`),
        `<blockquote class="markdown-alert markdown-alert-${marker.toLowerCase()}">` +
          `<p class="markdown-alert-title">${title}</p>\n<p>Body text.</p></blockquote>`,
      )
    }
  })

  it('matches the marker case-insensitively', () => {
    assert.match(renderMarkdownUnsafe('> [!note]\n> x'), /markdown-alert-note/)
    assert.match(renderMarkdownUnsafe('> [!Tip]\n> x'), /markdown-alert-tip/)
    assert.match(renderMarkdownUnsafe('> [!wArNiNg]\n> x'), /markdown-alert-warning/)
  })

  it('renders a marker-only quote as an alert with just the title', () => {
    assert.equal(
      renderMarkdownUnsafe('> [!CAUTION]'),
      '<blockquote class="markdown-alert markdown-alert-caution">' +
        '<p class="markdown-alert-title">Caution</p></blockquote>',
    )
  })

  it('falls through to a plain blockquote for unknown markers (GitHub behavior)', () => {
    const html = renderMarkdownUnsafe('> [!FOO]\n> body')
    assert.doesNotMatch(html, /markdown-alert/)
    assert.match(html, /<blockquote><p>\[!FOO\]\nbody<\/p><\/blockquote>/)
  })

  it('requires the marker to be the entire first line', () => {
    assert.doesNotMatch(renderMarkdownUnsafe('> [!NOTE] inline extra\n> body'), /markdown-alert/)
    assert.doesNotMatch(renderMarkdownUnsafe('> before [!NOTE]\n> body'), /markdown-alert/)
    // The marker mid-quote (not the first line) does not classify either.
    assert.doesNotMatch(renderMarkdownUnsafe('> body\n> [!NOTE]'), /markdown-alert/)
  })

  it('keeps nested block content (lists, code) inside the alert', () => {
    const html = renderMarkdownUnsafe('> [!TIP]\n> Steps:\n> - one\n> - two\n> ```\n> code\n> ```')
    assert.match(html, /^<blockquote class="markdown-alert markdown-alert-tip">/)
    assert.match(html, /<p class="markdown-alert-title">Tip<\/p>/)
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/)
    // The test setup registers highlight.js, so the fence body carries token spans.
    assert.match(html, /<pre><code[^>]*>[\s\S]*code[\s\S]*<\/code><\/pre>/)
  })

  it('renders inline markdown in alert content', () => {
    const html = renderMarkdownUnsafe('> [!IMPORTANT]\n> Read **this** and `that`.')
    assert.match(html, /<strong>this<\/strong>/)
    assert.match(html, /<code>that<\/code>/)
  })

  it('treats a lazy continuation after the marker line as alert content', () => {
    const html = renderMarkdownUnsafe('> [!NOTE]\nlazy line')
    assert.match(html, /markdown-alert-note/)
    assert.match(html, /<p>lazy line<\/p>/)
  })

  it('classifies alerts independently for adjacent quote groups', () => {
    const html = renderMarkdownUnsafe('> [!NOTE]\n> a\n\n> plain\n\n> [!WARNING]\n> b')
    assert.match(html, /markdown-alert-note/)
    assert.match(html, /markdown-alert-warning/)
    assert.match(html, /<blockquote><p>plain<\/p><\/blockquote>/)
  })

  it('recognizes an alert nested inside a list item', () => {
    const html = renderMarkdownUnsafe('- item\n  > [!NOTE]\n  > nested')
    assert.match(html, /<li>item\n<blockquote class="markdown-alert markdown-alert-note">/)
  })
})

describe('alert sanitizer surface (#72)', () => {
  it('alert output survives sanitizeRenderedMarkdown unchanged', () => {
    const html = renderMarkdownUnsafe('> [!WARNING]\n> Careful with `rm`.')
    const sanitized = sanitizeRenderedMarkdown(html)
    assert.match(sanitized, /<blockquote class="markdown-alert markdown-alert-warning">/)
    assert.match(sanitized, /<p class="markdown-alert-title">Warning<\/p>/)
    assert.match(sanitized, /<code>rm<\/code>/)
  })
})

describe('alerts while streaming (#72)', () => {
  it('never flashes a literal [! marker at any prefix (string emitter)', () => {
    const full = '> [!NOTE]\n> Useful info here.\n\nafter\n'
    for (let cut = 1; cut <= full.length; cut++) {
      const html = renderStreamingMarkdown(full.slice(0, cut))
      assert.doesNotMatch(
        html,
        /\[!/,
        `literal marker at prefix ${JSON.stringify(full.slice(0, cut))}`,
      )
    }
  })

  it('classifies the pending quote as soon as the marker line is complete', () => {
    // Marker complete but the line not yet newline-terminated: the pending
    // blockquote already carries the alert classes and title paragraph.
    const html = renderStreamingMarkdown('> [!NOTE]')
    assert.match(html, /<blockquote class="[^"]*stream-pending-blockquote[^"]*markdown-alert markdown-alert-note[^"]*">/)
    assert.match(html, /<p class="markdown-alert-title">Note<\/p>/)
  })

  it('keeps the committed alert classified while its content streams', () => {
    const html = renderStreamingMarkdown('> [!NOTE]\n> Usef')
    assert.match(html, /<blockquote class="markdown-alert markdown-alert-note">/)
    assert.match(html, /<p>Usef<\/p>/)
  })

  it('leaves an unknown marker literal once complete (fallthrough)', () => {
    // `[!FOO]` is not a known type: the pending quote renders it literally,
    // exactly as the committed render will.
    const html = renderStreamingMarkdown('> [!FOO] nope')
    assert.doesNotMatch(html, /markdown-alert/)
    assert.match(html, /\[!FOO\] nope/)
  })

  it('DOM emitter classifies the pending marker line and converges', () => {
    const full = '> [!TIP]\n> Try `--help` first.\n\ndone\n'
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    let sawPendingAlert = false
    for (let cut = 1; cut <= full.length; cut++) {
      renderer.update(full.slice(0, cut))
      assert.doesNotMatch(host.innerHTML, /\[!/, `literal marker at cut ${String(cut)}`)
      if (host.querySelector('.stream-pending-blockquote.markdown-alert-tip')) {
        sawPendingAlert = true
      }
    }
    assert.ok(sawPendingAlert, 'pending quote was classified before commit')
    const complete = host.querySelector('.stream-complete')
    assert.ok(complete)
    assert.equal(
      complete.innerHTML,
      sanitizeRenderedMarkdown(renderMarkdownUnsafe(full)).toString(),
    )
  })

  it('DOM emitter promotes pending alert to committed without literal flash', () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    renderer.update('> [!CAUTION]')
    const pending = host.querySelector('blockquote.markdown-alert-caution')
    assert.ok(pending, 'pending element classified')
    renderer.update('> [!CAUTION]\n')
    const committed = host.querySelector('.stream-complete blockquote.markdown-alert-caution')
    assert.ok(committed, 'committed element classified')
    assert.equal(committed.querySelector('p')?.className, 'markdown-alert-title')
  })
})
