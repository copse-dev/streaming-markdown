import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from './streaming.ts'

/**
 * #220 — when a footnote definition has committed while later content is still
 * streaming, the trailing footnotes section must stay pinned at the very
 * bottom, with the pending tail rendered ABOVE it. The pending-tail invariant
 * is "last child of `.stream-complete`, or the child immediately before the
 * trailing `section.footnotes`" — these tests pin that ordering for every
 * pending shape, in both emitters, plus the #133/#110 property that moving the
 * tail above the section never re-renders the (frozen) section.
 */

// A committed footnote reference + definition; everything appended after this
// streams while the trailing footnotes section is already committed.
const BASE = 'Intro paragraph[^a]\n\n[^a]: The definition text.\n\n'

const SECTION_OPEN = '<section class="footnotes"'

function streamDom(markdown: string): { renderer: StreamingMarkdownRenderer; complete: HTMLElement } {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  renderer.update(markdown)
  const complete = host.querySelector('.stream-complete') as HTMLElement
  assert.ok(complete, 'stream-complete container must exist')
  return { renderer, complete }
}

/** Assert the section is the LAST element child and the pending element precedes it. */
function assertPendingAboveSection(complete: HTMLElement, pendingSelector: string): void {
  const section = complete.lastElementChild
  assert.ok(
    section !== null && section.tagName === 'SECTION' && section.classList.contains('footnotes'),
    `the footnotes section must be the last child of .stream-complete, got <${complete.lastElementChild?.tagName ?? 'nothing'}>`,
  )
  const pending = complete.querySelector(pendingSelector)
  assert.ok(pending, `a pending element (${pendingSelector}) must exist inside .stream-complete`)
  assert.ok(
    !section.contains(pending),
    'the pending element must not live inside the footnotes section',
  )
}

/** Assert the string emitter placed the pending markup before the section markup. */
function assertStringPendingAboveSection(markdown: string, pendingMarker: string): void {
  const html = renderStreamingMarkdown(markdown).toString()
  const pendingIndex = html.indexOf(pendingMarker)
  const sectionIndex = html.indexOf(SECTION_OPEN)
  assert.ok(pendingIndex !== -1, `string output must contain ${pendingMarker}`)
  assert.ok(sectionIndex !== -1, 'string output must contain the footnotes section')
  assert.ok(
    pendingIndex < sectionIndex,
    `pending markup (at ${String(pendingIndex)}) must precede the section (at ${String(sectionIndex)})`,
  )
  assert.ok(html.endsWith('</section>'), 'the section must end the string output')
}

describe('pending tail renders above the trailing footnotes section (#220)', () => {
  const SHAPES: { name: string; tail: string; selector: string; marker: string }[] = [
    {
      name: 'paragraph',
      tail: 'Still streaming this pending line',
      selector: 'p.stream-pending-block',
      marker: 'stream-pending-paragraph',
    },
    {
      name: 'heading',
      tail: '## Streaming heading tail',
      selector: '.stream-pending-block[data-heading-level]',
      marker: 'data-heading-level',
    },
    {
      name: 'blockquote',
      tail: '> streaming quote line',
      selector: 'blockquote.stream-pending-block',
      marker: '<blockquote class="stream-pending',
    },
    {
      name: 'alert-style blockquote',
      tail: '> [!NOTE] streaming note',
      selector: 'blockquote.stream-pending-block',
      marker: '<blockquote class="stream-pending',
    },
    {
      name: 'list item',
      tail: '- streaming list item',
      selector: 'li.stream-pending-block',
      marker: '<li class="stream-pending',
    },
  ]

  for (const { name, tail, selector, marker } of SHAPES) {
    it(`${name}: DOM emitter orders the pending element before the section`, () => {
      const { complete } = streamDom(`${BASE}${tail}`)
      assertPendingAboveSection(complete, selector)
    })

    it(`${name}: string emitter orders the pending markup before the section`, () => {
      assertStringPendingAboveSection(`${BASE}${tail}`, marker)
    })
  }

  it('paragraph continuation: the continuation span lands in the <p> above the section', () => {
    const doc = `${BASE}committed paragraph line\nstreaming continuation`
    const { complete } = streamDom(doc)
    assertPendingAboveSection(complete, 'p > span.stream-pending-paragraph-continuation')
    assertStringPendingAboveSection(doc, 'stream-pending-paragraph-continuation')
  })

  it('list continuation: the continuation span lands in the open <li> above the section', () => {
    const doc = `${BASE}- committed item\n  streaming continuation`
    const { complete } = streamDom(doc)
    assertPendingAboveSection(complete, 'li > span.stream-pending-list-continuation')
    assertStringPendingAboveSection(doc, 'stream-pending-list-continuation')
  })

  it('table row: the pending row lands in the committed table above the section', () => {
    const doc = `${BASE}| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4`
    const { complete } = streamDom(doc)
    assertPendingAboveSection(complete, 'table tr.stream-pending-row')
    assertStringPendingAboveSection(doc, 'stream-pending-row')
  })

  it('a pending list item creates its wrapper list above the section and clears cleanly', () => {
    const doc = `${BASE}- streaming item`
    const { renderer, complete } = streamDom(doc)
    assertPendingAboveSection(complete, 'ul > li.stream-pending-block')
    // The tail becomes fully held (a lone open bracket link) — the pending
    // <li> and its wrapper <ul> must be swept even though they sit above the
    // section, not at the very end.
    renderer.update(`${BASE}- [`)
    assert.equal(complete.querySelector('li.stream-pending-block'), null)
    assert.equal(
      complete.lastElementChild?.tagName,
      'SECTION',
      'the section stays the last child once the pending list is swept',
    )
  })

  it('the committed section is frozen while the pending tail grows above it (#133)', () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    const tail = 'Pending prose that only ever grows'
    renderer.update(`${BASE}${tail[0] ?? ''}`)
    const complete = host.querySelector('.stream-complete') as HTMLElement
    const section = complete.lastElementChild
    assert.ok(section && section.tagName === 'SECTION', 'section committed on the first frame')
    const sectionHtml = section.innerHTML
    for (let i = 2; i <= tail.length; i++) {
      renderer.update(`${BASE}${tail.slice(0, i)}`)
      assert.equal(complete.lastElementChild, section, `frame ${String(i)}: section node identity`)
      assert.equal(section.innerHTML, sectionHtml, `frame ${String(i)}: section content untouched`)
    }
    // The plain-text pending fast path must still arm with a section trailing:
    // the pending paragraph is the tail content element even though it is no
    // longer the literal last child.
    assert.ok(
      renderer.diagnostics().pendingFastPathHits > 0,
      'inert pending appends take the fast path with a trailing section',
    )
    const pending = complete.querySelector('p.stream-pending-block')
    assert.equal(pending?.textContent, tail)
  })

  it('the settled document converges with the at-rest render at every commit', () => {
    const doc = `${BASE}Final paragraph after the definitions.\n`
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    for (let cut = 1; cut <= doc.length; cut++) renderer.update(doc.slice(0, cut))
    const committed = host.querySelector('.stream-complete')?.innerHTML ?? ''
    const atRest = sanitizeRenderedMarkdown(renderMarkdownUnsafe(doc)).toString()
    assert.equal(committed, atRest)
  })

  it('default output without a pending tail is unchanged (section still last)', () => {
    const settled = `${BASE}`
    assert.equal(
      renderStreamingMarkdown(settled).toString(),
      sanitizeRenderedMarkdown(renderMarkdownUnsafe(settled)).toString(),
    )
  })
})
