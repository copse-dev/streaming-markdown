import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from './streaming.ts'
import { collectFootnoteDefinitions, tokenizeBlocks } from './block-tokenizer.ts'
import { footnoteHoldStart, isPendingFootnoteDefLine } from './footnotes.ts'

describe('GFM footnotes at rest (#72)', () => {
  it('renders a reference and its trailing section with a backref', () => {
    assert.equal(
      renderMarkdownUnsafe('A note[^1].\n\n[^1]: The content.'),
      '<p>A note<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>.</p>\n' +
        '<section class="footnotes"><ol>' +
        '<li id="fn-1"><p>The content. <a href="#fnref-1" class="footnote-backref">↩</a></p></li>' +
        '</ol></section>',
    )
  })

  it('numbers footnotes in first-reference order, not definition order', () => {
    const html = renderMarkdownUnsafe('First[^b] then[^a].\n\n[^a]: second note\n[^b]: first note')
    assert.match(html, /<a href="#fn-b" id="fnref-b">1<\/a>/)
    assert.match(html, /<a href="#fn-a" id="fnref-a">2<\/a>/)
    // Section items follow reference order: b before a.
    assert.match(html, /<li id="fn-b">[\s\S]*<li id="fn-a">/)
  })

  it('shares the number across repeated references with distinct ids', () => {
    const html = renderMarkdownUnsafe('One[^x] and two[^x].\n\n[^x]: shared')
    assert.match(html, /<a href="#fn-x" id="fnref-x">1<\/a>/)
    assert.match(html, /<a href="#fn-x" id="fnref-x-2">1<\/a>/)
    // A single item with a single backref to the first reference.
    assert.equal(html.match(/<li id="fn-x">/g)?.length, 1)
    assert.match(html, /<a href="#fnref-x" class="footnote-backref">↩<\/a>/)
  })

  it('leaves unresolved references literal (like unresolved link refs)', () => {
    const html = renderMarkdownUnsafe('Nothing defines this[^ghost].')
    assert.equal(html, '<p>Nothing defines this[^ghost].</p>')
  })

  it('drops definitions that are never referenced (GitHub behavior)', () => {
    const html = renderMarkdownUnsafe('Plain prose.\n\n[^orphan]: never used')
    assert.equal(html, '<p>Plain prose.</p>')
    assert.doesNotMatch(html, /footnotes/)
  })

  it('matches labels case-insensitively', () => {
    const html = renderMarkdownUnsafe('X[^Note].\n\n[^NOTE]: y')
    assert.match(html, /<a href="#fn-note" id="fnref-note">1<\/a>/)
    assert.match(html, /<li id="fn-note">/)
  })

  it('a definition can interrupt a paragraph (no blank line needed)', () => {
    const html = renderMarkdownUnsafe('text[^1]\n[^1]: note')
    assert.match(html, /<sup class="footnote-ref">/)
    assert.match(html, /<li id="fn-1">/)
    assert.doesNotMatch(html, /\[\^1\]/)
  })

  it('first definition wins for a duplicate label', () => {
    const html = renderMarkdownUnsafe('X[^d].\n\n[^d]: first\n\n[^d]: second')
    assert.match(html, /first/)
    assert.doesNotMatch(html, /second/)
  })

  it('supports indented continuation lines and multi-paragraph content', () => {
    const html = renderMarkdownUnsafe('Ref[^m].\n\n[^m]: para one\n    still para one\n\n    para two')
    assert.match(html, /<p>para one\nstill para one<\/p>/)
    assert.match(html, /<p>para two <a href="#fnref-m" class="footnote-backref">↩<\/a><\/p>/)
  })

  it('supports lazy continuation of the first paragraph', () => {
    const html = renderMarkdownUnsafe('Ref[^l].\n\n[^l]: first\nlazy second')
    assert.match(html, /<p>first\nlazy second <a href="#fnref-l"/)
  })

  it('renders an empty definition as a bare backref item', () => {
    const html = renderMarkdownUnsafe('Ref[^e].\n\n[^e]:')
    assert.match(html, /<li id="fn-e"><p><a href="#fnref-e" class="footnote-backref">↩<\/a><\/p><\/li>/)
  })

  it('appends the backref after non-paragraph content', () => {
    const html = renderMarkdownUnsafe('Ref[^c].\n\n[^c]: intro\n\n        code line')
    assert.match(html, /<pre><code>code line\n<\/code><\/pre>\n<p><a href="#fnref-c"/)
  })

  it('renders inline markdown inside definition content', () => {
    const html = renderMarkdownUnsafe('Ref[^f].\n\n[^f]: has **bold** and `code`')
    assert.match(html, /<strong>bold<\/strong>/)
    assert.match(html, /<code>code<\/code>/)
  })

  it('resolves references inside emphasis, links, headings, and table cells', () => {
    const html = renderMarkdownUnsafe(
      '# Head[^h]\n\n*emph[^h]*\n\n| A |\n| - |\n| cell[^h] |\n\n[^h]: note',
    )
    assert.equal(html.match(/<sup class="footnote-ref">/g)?.length, 3)
    // All three share number 1; ids stay distinct.
    assert.match(html, /id="fnref-h"/)
    assert.match(html, /id="fnref-h-2"/)
    assert.match(html, /id="fnref-h-3"/)
  })

  it('does not trigger inside code spans or fenced code', () => {
    const html = renderMarkdownUnsafe('Span `[^x]` and ref[^x].\n\n```\n[^x]: not a def\n```\n\n[^x]: real')
    assert.match(html, /<code>\[\^x\]<\/code>/)
    // The fence body keeps the literal marker (with highlight.js token spans).
    assert.match(html, /<pre><code[^>]*>\[[\s\S]*\^x[\s\S]*not a def[\s\S]*<\/code><\/pre>/)
    assert.match(html, /<li id="fn-x"><p>real/)
    assert.equal(html.match(/<sup class="footnote-ref">/g)?.length, 1)
  })

  it('leaves a backslash-escaped reference literal', () => {
    const html = renderMarkdownUnsafe('Escaped \\[^x] stays.\n\n[^x]: real')
    assert.doesNotMatch(html, /<sup/)
    assert.match(html, /\[\^x\] stays/)
  })

  it('resolves references inside footnote content (section grows in order)', () => {
    const html = renderMarkdownUnsafe('A[^one]\n\n[^one]: refers[^two]\n[^two]: deep')
    assert.match(html, /<li id="fn-one">[\s\S]*<li id="fn-two">/)
    assert.match(html, /<a href="#fn-two" id="fnref-two">2<\/a>/)
  })

  it('slugifies labels deterministically and disambiguates collisions', () => {
    const html = renderMarkdownUnsafe('A[^a.b] B[^a-b]\n\n[^a.b]: one\n[^a-b]: two')
    assert.match(html, /<li id="fn-a-b"><p>one/)
    assert.match(html, /<li id="fn-a-b-2"><p>two/)
    // Repeat-ref ids never collide with a disambiguated slug's first ref id.
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
    assert.equal(new Set(ids).size, ids.length)
  })

  it('deduplicates a ref id that collides with a disambiguated slug', () => {
    // `[^a.b]` twice emits fnref-a-b and fnref-a-b-2; `[^a-b]` slugs to a-b-2,
    // whose first ref id would also be fnref-a-b-2 — it must skip ahead.
    const html = renderMarkdownUnsafe('A[^a.b] again[^a.b] B[^a-b]\n\n[^a.b]: one\n[^a-b]: two')
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
    assert.equal(new Set(ids).size, ids.length)
    assert.match(html, /id="fnref-a-b-2-2"/)
    // The backref still targets the reference's ACTUAL first id.
    assert.match(html, /<li id="fn-a-b-2"><p>two <a href="#fnref-a-b-2-2"/)
  })

  it('keeps unsafe label characters out of attributes', () => {
    const html = renderMarkdownUnsafe('X[^"onmouseover=x].\n\n[^"onmouseover=x]: y')
    assert.match(html, /<li id="fn-onmouseover-x">/)
    assert.doesNotMatch(html, /id="[^"]*"[^ >]/)
    assert.doesNotMatch(html, /onmouseover=/)
  })

  it('no longer treats [^label]: as a link reference definition', () => {
    // With footnotes in the core grammar, `[^x]` resolves as a footnote — not
    // as a shortcut link through a `[^x]: /url` "link definition".
    const html = renderMarkdownUnsafe('See [^x].\n\n[^x]: /url')
    assert.doesNotMatch(html, /href="\/url"/)
    assert.match(html, /<sup class="footnote-ref">/)
  })

  // The math prose grammar is gated on renderer registration (#78); these two
  // cases exercise math ↔ footnote interaction, so force the grammar on for the
  // render via per-call config.
  it('coexists with inline math: adjacent constructs both render (#70/#72)', () => {
    const html = renderMarkdownUnsafe('Euler[^e] says $e^{i\\pi}=-1$ here.\n\n[^e]: the identity', {
      mathSyntax: true,
    })
    assert.match(html, /<sup class="footnote-ref"><a href="#fn-e" id="fnref-e">1<\/a><\/sup>/)
    assert.match(html, /<span class="math-inline[^"]*">e\^\{i\\pi\}=-1<\/span>/)
    assert.match(html, /<section class="footnotes">/)
  })

  it('math content is opaque source: [^1] inside math never becomes a footnote', () => {
    // Inline math runs before the footnote pass and shields its verbatim
    // content; a display-math block is opaque like a fence, so a `[^1]:` line
    // inside it is neither a definition nor a reference.
    const html = renderMarkdownUnsafe(
      'inline $[^1]$ opaque, real[^1]\n\n$$\n[^1]: not a def\na_i\n$$\n\n[^1]: real',
      { mathSyntax: true },
    )
    assert.match(html, /<span class="math-inline[^"]*">\[\^1\]<\/span>/)
    assert.match(html, /<pre class="math">\[\^1\]: not a def\na_i<\/pre>/)
    // Exactly one real reference and one section item, defined by the last line.
    assert.equal(html.match(/<sup class="footnote-ref">/g)?.length, 1)
    assert.match(html, /<li id="fn-1"><p>real/)
  })
})

describe('collectFootnoteDefinitions (#72)', () => {
  it('collects definitions with block context, first definition wins', () => {
    const source = '[^a]: one\n\n```\n[^b]: fenced, not a def\n```\n\n[^a]: dupe\n[^c]: three\n'
    const defs = collectFootnoteDefinitions(source, tokenizeBlocks(source))
    assert.equal(defs.size, 2)
    assert.equal(defs.get('A')?.content, 'one')
    assert.equal(defs.get('C')?.content, 'three')
  })
})

describe('footnote sanitizer surface (#72)', () => {
  it('footnote output survives sanitizeRenderedMarkdown', () => {
    const sanitized = sanitizeRenderedMarkdown(renderMarkdownUnsafe('A[^n].\n\n[^n]: body'))
    assert.match(sanitized, /<sup class="footnote-ref"><a href="#fn-n" id="fnref-n">1<\/a><\/sup>/)
    assert.match(sanitized, /<section class="footnotes"><ol><li id="fn-n">/)
    assert.match(sanitized, /<a href="#fnref-n" class="footnote-backref">↩<\/a>/)
  })

  it('strips ids outside the renderer-emitted footnote shape', () => {
    const sanitized = sanitizeRenderedMarkdown('<p id="body">x</p><li id="fn-ok">y</li>')
    assert.doesNotMatch(sanitized, /id="body"/)
    assert.match(sanitized, /id="fn-ok"/)
  })
})

describe('footnotes while streaming (#72)', () => {
  it('holds a half-typed [^lab reference instead of flashing it', () => {
    assert.equal(footnoteHoldStart('see [^la', new Array(8).fill(false)), 4)
    assert.equal(footnoteHoldStart('closed [^a] after', new Array(17).fill(false)), 17)
    const html = renderStreamingMarkdown('Some prose [^not')
    assert.doesNotMatch(html, /\[\^/)
    assert.match(html, /Some prose/)
  })

  it('does not hold [^ inside a code span', () => {
    const html = renderStreamingMarkdown('tick `[^raw` more')
    assert.match(html, /\[\^raw/)
  })

  it('holds a pending definition line so it never renders in place', () => {
    for (const pending of ['[^la', '[^label]', '[^label]:', '[^label]: half the con']) {
      assert.ok(isPendingFootnoteDefLine(pending), pending)
    }
    assert.ok(!isPendingFootnoteDefLine('[^label] a ref, not a def'))
    const html = renderStreamingMarkdown('Done.\n\n[^1]: streaming def')
    assert.doesNotMatch(html, /streaming def/)
    assert.doesNotMatch(html, /\[\^/)
  })

  it('string emitter: the section appears once the definition commits', () => {
    const before = renderStreamingMarkdown('X[^1].\n\n[^1]: note')
    assert.doesNotMatch(before, /<section/)
    const after = renderStreamingMarkdown('X[^1].\n\n[^1]: note\n')
    assert.match(after, /<section class="footnotes">/)
    assert.match(after, /<sup class="footnote-ref">/)
  })

  it('DOM emitter: the section streams in and updates as definitions arrive', () => {
    const full = 'One[^a] two[^b].\n\n[^a]: first note\n[^b]: second note\n'
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    let sawSingleItemSection = false
    for (let cut = 1; cut <= full.length; cut++) {
      renderer.update(full.slice(0, cut))
      const items = host.querySelectorAll('.stream-complete section.footnotes li')
      if (items.length === 1) sawSingleItemSection = true
    }
    assert.ok(sawSingleItemSection, 'section rendered incrementally with one item')
    assert.equal(host.querySelectorAll('.stream-complete section.footnotes li').length, 2)
  })

  it('both emitters converge with the at-rest render', () => {
    const full =
      'Intro[^i] with detail[^d].\n\n- item[^i]\n\n[^i]: intro note\n[^d]: detail with **bold**\n'
    const stringFinal = renderStreamingMarkdown(full)
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    for (let cut = 1; cut <= full.length; cut++) renderer.update(full.slice(0, cut))
    const domFinal = host.querySelector('.stream-complete')?.innerHTML ?? ''
    const atRest = sanitizeRenderedMarkdown(renderMarkdownUnsafe(full)).toString()
    assert.equal(domFinal, atRest)
    assert.equal(stringFinal, atRest)
  })

  it('a list item pending after the section never lands inside it', () => {
    // The committed HTML ends with the footnotes <section><ol>…</ol></section>;
    // a pending `1. item` must open a fresh list, not splice into that <ol>.
    const html = renderStreamingMarkdown('X[^1].\n\n[^1]: note\n1. item')
    const section = /<section class="footnotes">.*?<\/section>/.exec(html)?.[0] ?? ''
    assert.doesNotMatch(section, /stream-pending/)
    assert.match(html, /stream-pending-list-item/)
  })
})
