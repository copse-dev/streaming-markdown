import { firstDirectChild, lastDirectChild } from './dom-scan.ts'
import { splitTableRow, TABLE_SEP_RE } from './block-tokenizer.ts'
import { dropTrailingNewline } from './block-patterns.ts'
import { escapeHtml } from './escape.ts'
import { renderStreamingInlinePending } from './render-pending-line.ts'
import { sanitizeRenderedMarkdown, type SanitizedHtml } from './sanitize.ts'
import { setPresanitizedHtml } from './html-sink.ts'
import { createTableWrapperElement, resolveTableWrapper, wrapTableHtml } from './table-wrapper.ts'

const FORMING_TABLE_CLASS = 'stream-table-forming'
const PENDING_ROW_CLASS = 'stream-pending-row'
const SEPARATOR_ROW_CLASS = 'stream-table-separator-pending'

function tableLines(source: string): string[] {
  const trimmed = dropTrailingNewline(source)
  if (trimmed === '') return []
  return trimmed.split('\n')
}

function renderStreamingTableCell(raw: string): SanitizedHtml | '' {
  const visible = renderStreamingInlinePending(raw)
  return visible ? sanitizeRenderedMarkdown(visible) : ''
}

function setStreamingCellContent(cell: HTMLTableCellElement, raw: string): void {
  setPresanitizedHtml(cell, renderStreamingTableCell(raw))
}

function ensureRow(parent: HTMLTableSectionElement, index: number): HTMLTableRowElement {
  return parent.rows[index] ?? parent.insertRow()
}

function syncRowCells(row: HTMLTableRowElement, cells: string[], tag: 'th' | 'td'): void {
  while (row.cells.length < cells.length) {
    row.appendChild(document.createElement(tag))
  }
  while (row.cells.length > cells.length) {
    row.lastElementChild?.remove()
  }
  cells.forEach((raw, i) => {
    const cell = row.cells[i]
    if (cell) setStreamingCellContent(cell, raw)
  })
}

/**
 * Forward-pass DOM updates for a GFM table still streaming (header, separator,
 * and/or in-progress body row). Does not re-render committed markdown.
 */
export function syncFormingTableDom(container: HTMLElement, source: string): void {
  const lines = tableLines(source)
  if (lines.length === 0) {
    container.replaceChildren()
    return
  }

  // With `tableWrapper` on, the forming table lives inside the scroll region
  // from its first paint (the committed render wraps it the same way), so the
  // region never appears around an already-visible table mid-stream.
  const parent = formingTableParent(container)

  // The forming table is only ever created as a direct child — direct scan,
  // no selector engine (this path runs per update while a table streams).
  const existing = firstDirectChild(parent, 'TABLE', FORMING_TABLE_CLASS)
  let table: HTMLTableElement
  if (existing instanceof Element && existing.tagName === 'TABLE') {
    table = existing as HTMLTableElement
  } else {
    parent.replaceChildren()
    table = document.createElement('table')
    table.className = FORMING_TABLE_CLASS
    table.append(document.createElement('thead'), document.createElement('tbody'))
    parent.appendChild(table)
  }

  const thead = table.tHead ?? table.createTHead()
  const tbody = table.tBodies[0] ?? table.createTBody()
  tbody.replaceChildren()

  const headerLine = lines[0]
  if (!headerLine) return
  syncRowCells(ensureRow(thead, 0), splitTableRow(headerLine), 'th')

  const sepLine = lines[1]
  if (!sepLine) return

  if (!TABLE_SEP_RE.test(sepLine)) {
    const sepRow = tbody.insertRow()
    sepRow.className = SEPARATOR_ROW_CLASS
    const colCount = Math.max(thead.rows[0]?.cells.length ?? 1, splitTableRow(sepLine).length, 1)
    syncRowCells(
      sepRow,
      Array.from({ length: colCount }, () => sepLine.trim()),
      'td',
    )
    return
  }

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.includes('|')) continue
    const row = tbody.insertRow()
    if (i === lines.length - 1 && !source.endsWith('\n')) {
      row.className = PENDING_ROW_CLASS
    }
    syncRowCells(row, splitTableRow(line), 'td')
  }
}

/**
 * Where the forming table goes: the container itself, or — with `tableWrapper`
 * on — the wrapper `<div>` that is its first child, reused across updates (and
 * created, replacing whatever the container held, on the first one).
 */
function formingTableParent(container: HTMLElement): HTMLElement {
  const wrapper = resolveTableWrapper()
  if (!wrapper) return container
  // Exact `class` equality (not `classList.contains`) — the sink gate's test
  // too — so a multi-token `className` matches and nothing can throw. Only the
  // forming sync writes this container, so the class alone identifies it.
  const first = container.firstElementChild
  if (first?.getAttribute('class') === wrapper.className) return first as HTMLElement
  const div = createTableWrapperElement(wrapper)
  container.replaceChildren(div)
  return div
}

/** Update the in-progress body row on a committed table (forward-pass cells). */
export function syncPendingTableRowDom(table: HTMLTableElement, pendingRow: string): void {
  const cells = splitTableRow(pendingRow)
  const headerCols = table.tHead?.rows[0]?.cells.length
  const colCount = headerCols ?? Math.max(cells.length, 1)
  let tbody = table.tBodies[0]
  if (!tbody) {
    tbody = table.createTBody()
  }

  let row: HTMLTableRowElement | null = findPendingRow(table)
  if (!(row instanceof Element) || row.tagName !== 'TR') {
    row = tbody.insertRow()
    row.className = PENDING_ROW_CLASS
  }

  syncRowCells(
    row,
    Array.from({ length: colCount }, (_, i) => cells[i] ?? ''),
    'td',
  )
}

export function clearFormingTableDom(container: HTMLElement): void {
  container.replaceChildren()
}

/**
 * The pending body row, if any — appended at the end of a `<tbody>` by
 * `syncPendingTableRowDom`, so a backwards direct-child scan finds it without
 * the selector engine (this runs per update while a table row streams).
 */
function findPendingRow(table: HTMLTableElement): HTMLTableRowElement | null {
  for (const tbody of table.tBodies) {
    const row = lastDirectChild(tbody, 'TR', PENDING_ROW_CLASS)
    if (row) return row as HTMLTableRowElement
  }
  return null
}

export function removePendingTableRow(table: HTMLTableElement): void {
  findPendingRow(table)?.remove()
}

/** Append an in-progress body row to the last committed table in rendered HTML. */
export function appendPendingTableRowHtml(rendered: string, pendingRow: string): string {
  const cells = splitTableRow(pendingRow)
  const headerMatch = rendered.match(/<thead>[\s\S]*?<\/thead>/g)
  const lastHeader = headerMatch?.at(-1) ?? ''
  const headerCols = (lastHeader.match(/<th[\s>]/g) ?? []).length
  const colCount = headerCols > 0 ? headerCols : Math.max(cells.length, 1)

  const rowHtml = Array.from({ length: colCount }, (_, i) => {
    const inner = renderStreamingTableCell(cells[i] ?? '')
    return `<td>${inner}</td>`
  }).join('')
  const pendingRowHtml = `<tr class="${PENDING_ROW_CLASS}">${rowHtml}</tr>`

  // The row belongs to the TRAILING table (`pendingLineBelongsInTable` gates on
  // it), so anchor on the last `</table>` rather than the last `</tbody>`: a
  // header-only trailing table has no `<tbody>` yet (spec 205), and the last
  // `</tbody>` would then be an EARLIER table's. That case gets the `<tbody>`
  // the DOM emitter's `syncPendingTableRowDom` creates, instead of a stray `<tr>`
  // after the table. Anchoring on `</table>` is also what keeps the splice
  // inside the table when `tableWrapper` adds a trailing `</div>`.
  const closeIndex = rendered.lastIndexOf('</table>')
  if (closeIndex === -1) return `${rendered}${pendingRowHtml}`
  const before = rendered.slice(0, closeIndex)
  // Reopen the trailing `</tbody>` (8 chars), or open one for a header-only table.
  const head = before.endsWith('</tbody>') ? before.slice(0, -8) : `${before}<tbody>`
  return `${head}${pendingRowHtml}</tbody>${rendered.slice(closeIndex)}`
}

export function buildFormingTableHtml(source: string): string {
  const lines = tableLines(source)
  if (lines.length === 0) return ''

  const headerLine = lines[0]
  if (!headerLine) return ''
  const headerCells = splitTableRow(headerLine)
    .map((c) => `<th>${renderStreamingTableCell(c)}</th>`)
    .join('')

  const parts = [
    `<table class="${FORMING_TABLE_CLASS}"><thead><tr>${headerCells}</tr></thead><tbody>`,
  ]

  const sepLine = lines[1]
  if (sepLine && !TABLE_SEP_RE.test(sepLine)) {
    parts.push(`<tr class="${SEPARATOR_ROW_CLASS}"><td>${escapeHtml(sepLine.trim())}</td></tr>`)
  } else if (sepLine && TABLE_SEP_RE.test(sepLine)) {
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i]
      if (!line?.includes('|')) continue
      const cells = splitTableRow(line)
        .map((c) => `<td>${renderStreamingTableCell(c)}</td>`)
        .join('')
      const rowClass =
        i === lines.length - 1 && !source.endsWith('\n') ? ` class="${PENDING_ROW_CLASS}"` : ''
      parts.push(`<tr${rowClass}>${cells}</tr>`)
    }
  }

  parts.push('</tbody></table>')
  return wrapTableHtml(parts.join(''))
}
