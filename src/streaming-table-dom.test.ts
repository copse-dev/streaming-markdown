import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFormingTableHtml,
  clearFormingTableDom,
  removePendingTableRow,
  syncFormingTableDom,
  syncPendingTableRowDom,
} from './streaming-table-dom.ts'

// Direct coverage of the forming-table DOM/string emitters — the incremental
// paths the streaming renderer uses while a GFM table is still arriving.

function container(): HTMLElement {
  return document.createElement('div')
}

describe('syncFormingTableDom', () => {
  it('clears the container when there are no table lines', () => {
    const el = container()
    el.innerHTML = '<table><tbody></tbody></table>'
    syncFormingTableDom(el, '')
    assert.equal(el.childNodes.length, 0)
  })

  it('renders header + separator + streaming body rows, flagging the last as pending', () => {
    const el = container()
    // No trailing newline → the final row is still streaming (pending).
    syncFormingTableDom(el, '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')

    const table = el.querySelector('table.stream-table-forming')
    assert.ok(table)
    const headers = [...el.querySelectorAll('thead th')].map((c) => c.textContent)
    assert.deepEqual(headers, ['a', 'b'])
    const bodyRows = el.querySelectorAll('tbody tr')
    assert.equal(bodyRows.length, 2)
    assert.equal(bodyRows[0]?.className, '')
    assert.equal(bodyRows[1]?.className, 'stream-pending-row')
  })

  it('reveals forming inline code inside a streaming cell', () => {
    const el = container()
    syncFormingTableDom(el, '| a | b |\n| --- | --- |\n| run `npm | ready |')
    const code = el.querySelector('tbody code.stream-forming-inline-code')
    assert.equal(code?.textContent, 'npm')
    assert.doesNotMatch(el.textContent ?? '', /`npm/)
  })

  it('reuses the existing forming table and shrinks the header when columns drop', () => {
    const el = container()
    syncFormingTableDom(el, '| a | b | c |')
    const table = el.querySelector('table.stream-table-forming')
    assert.equal(el.querySelectorAll('thead th').length, 3)

    // A subsequent update with fewer columns must reuse the table and drop the
    // surplus header cell (exercises the shrink branch of syncRowCells).
    syncFormingTableDom(el, '| a | b |')
    assert.equal(el.querySelector('table.stream-table-forming'), table, 'table reused')
    assert.equal(el.querySelectorAll('thead th').length, 2)
  })

  it('renders a pending separator row when the second line is not yet a valid separator', () => {
    const el = container()
    syncFormingTableDom(el, '| a | b |\n| z |')
    assert.ok(el.querySelector('tr.stream-table-separator-pending'))
  })
})

describe('buildFormingTableHtml (string path)', () => {
  it('returns empty string with no table lines', () => {
    assert.equal(buildFormingTableHtml(''), '')
  })

  it('renders header, separator-pending row when separator is incomplete', () => {
    const html = buildFormingTableHtml('| a | b |\n| z |')
    assert.match(html, /stream-table-separator-pending/)
  })

  it('renders body rows once the separator is valid, flagging the last pending', () => {
    const html = buildFormingTableHtml('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
    assert.match(html, /<thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead>/)
    assert.match(html, /<tr><td>1<\/td><td>2<\/td><\/tr>/)
    assert.match(html, /<tr class="stream-pending-row"><td>3<\/td><td>4<\/td><\/tr>/)
  })

  it('renders forming inline code in the string table path', () => {
    const html = buildFormingTableHtml('| a | b |\n| --- | --- |\n| run `npm | ready |')
    assert.match(html, /run <code class="stream-forming-inline-code">npm<\/code>/)
    assert.doesNotMatch(html, /`npm/)
  })

  it('marks no row pending when the source ends with a newline', () => {
    const html = buildFormingTableHtml('| a | b |\n| --- | --- |\n| 1 | 2 |\n')
    assert.doesNotMatch(html, /stream-pending-row/)
  })
})

describe('syncPendingTableRowDom / removePendingTableRow', () => {
  function committedTable(): HTMLTableElement {
    const table = document.createElement('table')
    const thead = table.createTHead()
    const hr = thead.insertRow()
    hr.insertCell().textContent = 'a'
    hr.insertCell().textContent = 'b'
    return table // deliberately no <tbody> yet
  }

  it('creates a tbody and a pending row, then reuses that row on the next update', () => {
    const table = committedTable()
    syncPendingTableRowDom(table, '| 1 | 2')
    const tbody = table.tBodies[0]
    assert.ok(tbody, 'tbody created')
    const pending = table.querySelectorAll<HTMLTableRowElement>('tr.stream-pending-row')
    assert.equal(pending.length, 1)
    assert.deepEqual([...pending[0]!.cells].map((c) => c.textContent), ['1', '2'])

    // Second update reuses the same pending row (no duplicate).
    syncPendingTableRowDom(table, '| 12 | 34')
    const pending2 = table.querySelectorAll<HTMLTableRowElement>('tr.stream-pending-row')
    assert.equal(pending2.length, 1)
    assert.equal(pending2[0], pending[0], 'pending row reused')
    assert.deepEqual([...pending2[0]!.cells].map((c) => c.textContent), ['12', '34'])
  })

  it('removePendingTableRow drops the in-progress row', () => {
    const table = committedTable()
    syncPendingTableRowDom(table, '| 1 | 2')
    assert.ok(table.querySelector('tr.stream-pending-row'))
    removePendingTableRow(table)
    assert.equal(table.querySelector('tr.stream-pending-row'), null)
  })
})

describe('clearFormingTableDom', () => {
  it('empties the container', () => {
    const el = container()
    el.innerHTML = '<table class="stream-table-forming"></table>'
    clearFormingTableDom(el)
    assert.equal(el.childNodes.length, 0)
  })
})
