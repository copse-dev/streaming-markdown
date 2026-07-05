// Structural guard for issue #11: the incremental DOM emitter must make each
// pending→committed transition MINIMAL — it patches the committing block (or its
// stable committed ancestor) in place rather than tearing down and rebuilding the
// whole `.stream-complete` subtree. Sibling committed blocks must keep their node
// identity across a commit so a host can animate the promotion instead of
// reflowing every block.
//
// Proof strategy: capture live node references BEFORE a transition, feed the next
// chunk, then assert the same node instances survive (identity `===`), and that
// only the expected nodes were added/removed.
//
// Known-instant exceptions (documented, not asserted as reused):
//   - The promoting block itself changes tag (pending `<div class="stream-pending
//     -heading">` → committed `<h3>`; forming `<pre class="stream-fence-forming">`
//     / `<table class="stream-table-forming">` living in the separate
//     `.stream-forming` host → committed `<pre>` / `<table>` in `.stream-complete`).
//     A tag/parent change necessarily mints a new node; what matters is that the
//     surrounding committed subtree is preserved, which these tests assert.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { morphInnerHtml } from './streaming-dom-morph.ts'

function completeEl(host: HTMLElement): HTMLElement {
  const el = host.querySelector('.stream-complete')
  assert.ok(el instanceof HTMLElement, '.stream-complete host exists')
  return el
}

describe('streaming pending→committed transitions are minimal DOM patches', () => {
  it('heading promotion keeps committed sibling nodes (no full-subtree replace)', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)

    r.update('Committed intro.\n\n### Section')
    const complete = completeEl(host)
    const introBefore = complete.querySelector('p')
    const pending = complete.querySelector('.stream-pending-heading')
    assert.ok(introBefore, 'intro paragraph is committed')
    assert.equal(pending?.tagName, 'DIV', 'heading renders as a pending <div> before commit')

    // The heading line commits: `.stream-pending-heading` div → real <h3>.
    r.update('Committed intro.\n\n### Section\n\n')

    const introAfter = complete.querySelector('p')
    assert.equal(introAfter, introBefore, 'committed sibling <p> survives with the same node instance')
    assert.ok(complete.contains(introBefore), 'sibling stayed attached (subtree was patched, not rebuilt)')
    const heading = complete.querySelector('h3')
    assert.ok(heading, 'pending heading promoted to <h3>')
    assert.equal(heading?.textContent, 'Section')
    assert.equal(complete.querySelector('.stream-pending-heading'), null, 'pending chrome removed on commit')
  })

  it('first table row commit keeps the sibling and reuses the committed table node', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)

    // Header + separator committed, first body row still forming.
    r.update('Committed intro.\n\n| A | B |\n| - | - |\n| 1 | 2')
    const complete = completeEl(host)
    const introBefore = complete.querySelector('p')
    assert.ok(introBefore, 'intro paragraph is committed')

    // First body row commits.
    r.update('Committed intro.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n')
    assert.equal(complete.querySelector('p'), introBefore, 'sibling <p> survives the first-row commit')
    const table = complete.querySelector('table')
    const firstRow = table?.querySelector('tbody tr')
    assert.ok(table, 'table committed')
    assert.equal(firstRow?.textContent, '12', 'first body row is committed')

    // A second row commits: the table + already-committed row must be reused,
    // with only the new <tr> appended — not a rebuilt table.
    r.update('Committed intro.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n')
    assert.equal(complete.querySelector('table'), table, 'committed table node reused across row commits')
    const rows = table?.querySelectorAll('tbody tr')
    assert.equal(rows?.length, 2, 'both rows present')
    assert.equal(rows?.[0], firstRow, 'already-committed row keeps identity; only the new row was added')
    assert.equal(complete.querySelector('p'), introBefore, 'sibling <p> still the same node')
  })

  it('fenced-code close keeps the sibling and the closed fence gains hljs classes', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)

    // Fence still open (lives in the separate .stream-forming host).
    r.update('Committed intro.\n\n```js\nconst a = 1')
    const complete = completeEl(host)
    const introBefore = complete.querySelector('p')
    assert.ok(introBefore, 'intro paragraph is committed')
    assert.equal(complete.querySelector('pre'), null, 'open fence is not yet in .stream-complete')

    // Fence closes and commits, gaining highlight.js classes.
    r.update('Committed intro.\n\n```js\nconst a = 1\n```\n\n')
    assert.equal(complete.querySelector('p'), introBefore, 'sibling <p> survives the fence close')
    const code = complete.querySelector('pre > code')
    assert.ok(code, 'closed fence committed as <pre><code>')
    assert.match(code?.className ?? '', /hljs/, 'committed fence carries hljs classes')

    // A later commit must reuse the committed fence node (only the new block added).
    const pre = complete.querySelector('pre')
    r.update('Committed intro.\n\n```js\nconst a = 1\n```\n\nTail.\n\n')
    assert.equal(complete.querySelector('pre'), pre, 'committed fence <pre> reused across a later commit')
    assert.equal(complete.querySelector('p'), introBefore, 'sibling <p> still the same node')
  })

  it('list marker reveal keeps sibling list items and reuses the committed <ul>', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)

    // First item committed, second item still forming as a pending <li>.
    r.update('- first\n- second')
    const complete = completeEl(host)
    const list = complete.querySelector('ul')
    const firstItem = list?.querySelector('li')
    assert.ok(list, 'list committed')
    assert.equal(firstItem?.textContent, 'first', 'first item committed')

    // Second item commits (marker revealed as a real list row).
    r.update('- first\n- second\n')
    assert.equal(complete.querySelector('ul'), list, 'committed <ul> reused across the item commit')
    const items = list?.querySelectorAll('li')
    assert.equal(items?.length, 2, 'both items present')
    assert.equal(items?.[0], firstItem, 'already-committed <li> keeps identity; only the new item added')
  })
})

describe('morphInnerHtml (minimal-patch primitive)', () => {
  it('reuses unchanged nodes and serializes identically to innerHTML assignment', () => {
    const el = document.createElement('div')
    morphInnerHtml(el, '<p>one</p>\n<p>two</p>')
    const first = el.children[0]
    const second = el.children[1]

    morphInnerHtml(el, '<p>one</p>\n<p>two</p>\n<h3>three</h3>')
    assert.equal(el.children[0], first, 'unchanged leading node reused')
    assert.equal(el.children[1], second, 'unchanged middle node reused')

    const fresh = document.createElement('div')
    fresh.innerHTML = '<p>one</p>\n<p>two</p>\n<h3>three</h3>'
    assert.equal(el.innerHTML, fresh.innerHTML, 'serialization identical to innerHTML = html')
  })

  it('replaces a node whose tag changes while keeping its siblings', () => {
    const el = document.createElement('div')
    morphInnerHtml(el, '<p>keep</p>\n<div class="stream-pending-heading">x</div>')
    const keep = el.children[0]

    morphInnerHtml(el, '<p>keep</p>\n<h3>x</h3>')
    assert.equal(el.children[0], keep, 'sibling preserved when the neighbour changes tag')
    assert.equal(el.children[1]?.tagName, 'H3', 'changed node replaced with the new tag')
  })

  it('replaces a node whose attributes change so serialization stays correct', () => {
    const el = document.createElement('div')
    morphInnerHtml(el, '<ol><li>a</li></ol>')
    morphInnerHtml(el, '<ol start="2"><li>a</li></ol>')
    assert.equal(el.innerHTML, '<ol start="2"><li>a</li></ol>', 'attribute change reflected exactly')
  })

  it('clears content when given empty html', () => {
    const el = document.createElement('div')
    morphInnerHtml(el, '<p>x</p>')
    morphInnerHtml(el, '')
    assert.equal(el.innerHTML, '', 'empty html empties the container')
  })
})
