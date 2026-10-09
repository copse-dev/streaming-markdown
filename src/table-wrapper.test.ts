import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, renderMarkdownUnsafe } from './renderer.ts'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from './streaming.ts'
import { sanitizeRenderedMarkdown, type SanitizerBackend } from './sanitize.ts'
import { enforceSanitizerAllowlist } from './sanitize-browser.ts'
import { withConfig, type MarkdownConfig } from './config.ts'
import { buildFormingTableHtml, syncFormingTableDom } from './streaming-table-dom.ts'

// `MarkdownConfig.tableWrapper` (opt-in): every GFM table sits in a scrollable,
// keyboard-focusable region, on all three emit paths, without widening what raw
// HTML can carry through the sink.

const TABLE = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
const OPEN = '<div class="table-wrapper" role="region" aria-label="Table" tabindex="0">'
const TABLE_HTML = '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
const ON: MarkdownConfig = { tableWrapper: true }

// The native Sanitizer's allowlist walk over a jsdom parse — exercises the
// browser backend's attribute filter + gate order (filter, THEN onElement),
// which differs from DOMPurify's (hook, THEN filter).
const nativeWalkBackend: SanitizerBackend = {
  sanitize(html, config) {
    const host = document.createElement('div')
    host.innerHTML = html
    enforceSanitizerAllowlist(host, config)
    return host.innerHTML
  },
}

describe('tableWrapper: at-rest output', () => {
  it('is off by default: no wrapper, byte-identical to an explicit false/null', () => {
    const md = `x\n\n${TABLE}`
    const plain = renderMarkdown(md)
    assert.equal(plain, `<p>x</p>\n${TABLE_HTML}`)
    assert.equal(renderMarkdown(md, { tableWrapper: false }), plain)
    assert.equal(renderMarkdown(md, { tableWrapper: null }), plain)
  })

  it('wraps the table in a labelled, focusable region', () => {
    assert.equal(renderMarkdown(TABLE, ON), `${OPEN}${TABLE_HTML}</div>`)
  })

  it('emits the same wrapper on the unsafe path (for hosts that sanitize themselves)', () => {
    assert.equal(renderMarkdownUnsafe(TABLE, ON), `${OPEN}${TABLE_HTML}</div>`)
  })

  it('wraps a header-only table too', () => {
    assert.equal(
      renderMarkdown('| a |\n| - |\n', ON),
      `${OPEN}<table><thead><tr><th>a</th></tr></thead></table></div>`,
    )
  })

  it('wraps tables nested in lists and blockquotes', () => {
    const html = renderMarkdown(`> ${TABLE.trimEnd().split('\n').join('\n> ')}\n\n- item\n\n  ${TABLE.trimEnd().split('\n').join('\n  ')}\n`, ON)
    const d = document.createElement('div')
    d.innerHTML = html
    assert.equal(d.querySelectorAll('table').length, 2)
    for (const t of d.querySelectorAll('table')) {
      assert.equal(t.parentElement?.getAttribute('class'), 'table-wrapper')
    }
  })

  it('takes a custom class and a localized label, attribute-escaped', () => {
    const html = renderMarkdown(TABLE, {
      tableWrapper: { className: 'Tbl_wrap__x1 extra', label: 'Tableau "<b>" & co' },
    })
    assert.equal(
      html,
      '<div class="Tbl_wrap__x1 extra" role="region" aria-label="Tableau &quot;<b>&quot; &amp; co" tabindex="0">' +
        `${TABLE_HTML}</div>`,
    )
    const d = document.createElement('div')
    d.innerHTML = html
    const wrapper = d.firstElementChild
    assert.equal(wrapper?.getAttribute('aria-label'), 'Tableau "<b>" & co')
    assert.equal(wrapper?.children.length, 1, 'the label never forms markup')
  })

  it('falls back to the default class for an empty className, and to defaults for {}', () => {
    assert.equal(renderMarkdown(TABLE, { tableWrapper: { className: '' } }), `${OPEN}${TABLE_HTML}</div>`)
    assert.equal(renderMarkdown(TABLE, { tableWrapper: {} }), `${OPEN}${TABLE_HTML}</div>`)
  })
})

describe('tableWrapper: sink sanitizer', () => {
  for (const [name, backend] of [
    ['DOMPurify', undefined],
    ['native allowlist walk', nativeWalkBackend],
  ] as const) {
    const cfg = (extra: MarkdownConfig = {}): MarkdownConfig => ({
      ...ON,
      ...(backend ? { sanitizerBackend: backend } : {}),
      ...extra,
    })

    it(`${name}: keeps the renderer's wrapper attributes`, () => {
      assert.equal(renderMarkdown(TABLE, cfg()), `${OPEN}${TABLE_HTML}</div>`)
    })

    it(`${name}: still strips role/tabindex from author raw HTML`, () => {
      const html = renderMarkdown(
        '<div role="region" tabindex="0">x</div>\n\n<p>a <span role="button" tabindex="0">b</span></p>\n',
        cfg(),
      )
      assert.doesNotMatch(html, /role=|tabindex=/)
      assert.match(html, /<div>x<\/div>/)
      assert.match(html, /<span>b<\/span>/)
    })

    it(`${name}: a forged wrapper class without a sole table child gets no role/tabindex`, () => {
      const html = renderMarkdown('<div class="table-wrapper" role="region" tabindex="0">x</div>\n', cfg())
      assert.match(html, /<div class="table-wrapper">x<\/div>/)
      assert.doesNotMatch(html, /role=|tabindex=/)
    })

    it(`${name}: the exact wrapper shape around a raw table is normalized, never author-valued`, () => {
      const html = renderMarkdown(
        '<div class="table-wrapper" role="button" tabindex="-1"><table><tr><td>c</td></tr></table></div>\n',
        cfg(),
      )
      const open = /<div class="table-wrapper"[^>]*><table>/.exec(html)?.[0] ?? ''
      assert.match(open, / role="region"/)
      assert.match(open, / aria-label="Table"/)
      assert.match(open, / tabindex="0"/)
      assert.doesNotMatch(open, /button|-1/)
    })

    it(`${name}: the wrapper shape always carries the configured label, not the author's or none`, () => {
      for (const raw of [
        '<div class="table-wrapper"><table><tr><td>c</td></tr></table></div>\n',
        '<div class="table-wrapper" aria-label="Author name"><table><tr><td>c</td></tr></table></div>\n',
      ]) {
        const html = renderMarkdown(raw, cfg({ tableWrapper: { label: 'Localized table' } }))
        assert.match(html, /<div class="table-wrapper"[^>]* aria-label="Localized table"/, raw)
        assert.doesNotMatch(html, /Author name/, raw)
      }
    })

    it(`${name}: a host extension that allowlists role keeps it off the wrapper shape`, () => {
      const html = renderMarkdown(
        '<span role="note" tabindex="0">n</span>\n',
        cfg({ sanitizeExtension: { allowedAttr: ['role'] } }),
      )
      assert.equal(html, '<p><span role="note">n</span></p>')
    })

    it(`${name}: with the option off, the allowlist is unchanged (wrapper shape included)`, () => {
      const off: MarkdownConfig = backend ? { sanitizerBackend: backend } : {}
      const html = renderMarkdown(
        `<div class="table-wrapper" role="region" tabindex="0"><table><tr><td>c</td></tr></table></div>\n`,
        off,
      )
      assert.doesNotMatch(html, /role=|tabindex=/)
    })
  }

  it('sanitizeRenderedMarkdown applies the gate under the active config only', () => {
    const raw = `${OPEN}${TABLE_HTML}</div>`
    assert.equal(withConfig(ON, () => sanitizeRenderedMarkdown(raw)), raw)
    assert.equal(
      sanitizeRenderedMarkdown(raw),
      `<div class="table-wrapper" aria-label="Table">${TABLE_HTML}</div>`,
    )
  })
})

describe('tableWrapper: streaming', () => {
  const DOC = 'intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n\nafter\n'

  it('DOM emitter: the forming table is wrapped from its first paint', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host, ON)
    r.update('intro\n\n| a')
    const forming = host.querySelector('.stream-forming')
    const wrapper = forming?.firstElementChild
    assert.equal(wrapper?.outerHTML.startsWith(OPEN), true)
    assert.equal(wrapper?.firstElementChild?.className, 'stream-table-forming')
    const table = wrapper?.firstElementChild
    r.update('intro\n\n| a | b |\n| --')
    assert.equal(forming?.firstElementChild, wrapper, 'forming wrapper reused')
    assert.equal(wrapper?.firstElementChild, table, 'forming table reused inside it')
  })

  it('DOM emitter: row by row, the committed wrapper and table keep identity and end equal to at-rest', () => {
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host, ON)
    const commitAt = DOC.indexOf('| --- | --- |\n') + '| --- | --- |\n'.length
    let wrapper: Element | null = null
    let table: Element | null = null
    for (let i = 1; i <= DOC.length; i++) {
      r.update(DOC.slice(0, i))
      if (i < commitAt) continue
      const t = host.querySelector('.stream-complete table')
      assert.ok(t, `table committed at cut ${String(i)}`)
      const w = t.parentElement
      assert.equal(w?.getAttribute('class'), 'table-wrapper')
      assert.equal(w?.getAttribute('role'), 'region')
      assert.equal(w?.getAttribute('tabindex'), '0')
      if (wrapper) {
        assert.equal(w, wrapper, `wrapper re-created at cut ${String(i)}`)
        assert.equal(t, table, `table re-parented/re-created at cut ${String(i)}`)
      }
      wrapper = w
      table = t
      const pending = t.querySelector('tr.stream-pending-row')
      if (pending) assert.equal(pending.closest('table'), t, 'pending row inside the wrapped table')
    }
    assert.equal(host.querySelector('.stream-complete')?.innerHTML, renderMarkdown(DOC, ON))
  })

  it('string emitter: every frame shows the table inside the wrapper and ends equal to at-rest', () => {
    for (let i = DOC.indexOf('|') + 1; i <= DOC.length; i++) {
      const html = renderStreamingMarkdown(DOC.slice(0, i), ON)
      const d = document.createElement('div')
      d.innerHTML = html
      const tables = d.querySelectorAll('table')
      assert.equal(tables.length, 1, `cut ${String(i)}: ${html}`)
      const t = tables[0]
      assert.equal(t?.parentElement?.outerHTML.startsWith(OPEN), true, `cut ${String(i)}: ${html}`)
      for (const row of d.querySelectorAll('tr')) assert.equal(row.closest('table'), t)
    }
    assert.equal(renderStreamingMarkdown(DOC, ON), renderMarkdown(DOC, ON))
  })

  it('forming helpers wrap in the string and DOM forms identically', () => {
    const src = '| a | b |\n| --- | --- |\n| 1 |'
    const el = document.createElement('div')
    withConfig(ON, () => syncFormingTableDom(el, src))
    const html = withConfig(ON, () => buildFormingTableHtml(src))
    assert.equal(el.innerHTML, html)
    assert.equal(buildFormingTableHtml(src).startsWith('<table'), true, 'unwrapped when off')
  })

  it('DOM forming sync replaces stale container content with the wrapper', () => {
    const el = document.createElement('div')
    el.innerHTML = '<pre>stale</pre>'
    withConfig(ON, () => syncFormingTableDom(el, '| a |'))
    assert.equal(el.children.length, 1)
    assert.equal(el.firstElementChild?.getAttribute('class'), 'table-wrapper')
  })
})

describe('tableWrapper: pending row splice (string emitter)', () => {
  it('stays inside the wrapper when tableWrapper is on', () => {
    assert.equal(
      renderStreamingMarkdown('| a |\n| - |\n| 1', ON),
      `${OPEN}<table><thead><tr><th>a</th></tr></thead><tbody>` +
        '<tr class="stream-pending-row"><td>1</td></tr></tbody></table></div>',
    )
  })
})
