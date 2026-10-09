import { activeConfig } from './config.ts'
import { escapeHtml } from './escape.ts'
import type { SanitizerConfig } from './sanitize.ts'

// Opt-in scroll container around every GFM table (`MarkdownConfig.tableWrapper`).
//
// A wide table — many columns, or one unbreakable token such as a URL in a cell —
// overflows the message column, and a bare `<table>` gives the host nothing to
// scroll it in. The host cannot add a wrapper after the fact: the streaming
// emitter owns that DOM and morphs it on every update, so a host-moved `<table>`
// fights the morph and the frozen-tail memo. So the renderer emits the wrapper
// itself, on every path that produces a table (at-rest `renderTable`, the string
// emitter's forming table, the DOM emitter's forming table), from the first
// paint, so the table is never re-parented while it streams.
//
// The wrapper is the accessible keyboard-scrollable region pattern (WCAG 2.1.1,
// axe `scrollable-region-focusable`): `role="region"` + an accessible name +
// `tabindex="0"`. `role` and `tabindex` are NOT on the core sink allowlist, and
// this option must not change that for author-controlled markdown: raw HTML in a
// message must not gain the ability to mint focus stops or landmark roles just
// because a host turned the wrapper on. See {@link withTableWrapperGate}.

/** Options for `MarkdownConfig.tableWrapper`. */
export interface TableWrapperOptions {
  /**
   * Value of the wrapper's `class` attribute (default `'table-wrapper'`). Use it
   * to hook a host stylesheet or a CSS-modules class. Emitted verbatim
   * (attribute-escaped) and matched exactly by the sink gate, so pass the same
   * string for every render you style together.
   */
  className?: string
  /**
   * Accessible name of the scroll region — its `aria-label` (default
   * `'Table'`). Hosts with a localized UI pass their translated string; it is
   * attribute-escaped.
   */
  label?: string
}

/** The fully-defaulted wrapper settings for the current render. @internal */
export interface ResolvedTableWrapper {
  className: string
  label: string
}

/**
 * The wrapper settings for the current render, or `null` when the option is off
 * (the default — output is then byte-identical to a build without the feature).
 * @internal
 */
export function resolveTableWrapper(): ResolvedTableWrapper | null {
  const value = activeConfig().tableWrapper
  if (!value) return null
  const options: TableWrapperOptions = value === true ? {} : value
  return { className: options.className || 'table-wrapper', label: options.label ?? 'Table' }
}

/**
 * `tableHtml` inside the wrapper when the option is on, else unchanged. The
 * class and label are attribute-escaped. Attribute order matches
 * {@link createTableWrapperElement} so the string and DOM emitters' forming
 * tables serialize identically. @internal
 */
export function wrapTableHtml(tableHtml: string): string {
  const wrapper = resolveTableWrapper()
  if (!wrapper) return tableHtml
  return (
    `<div class="${escapeHtml(wrapper.className)}" role="region" ` +
    `aria-label="${escapeHtml(wrapper.label)}" tabindex="0">${tableHtml}</div>`
  )
}

/** DOM twin of {@link wrapTableHtml}'s open tag, for the incremental emitter. @internal */
export function createTableWrapperElement(wrapper: ResolvedTableWrapper): HTMLDivElement {
  const div = document.createElement('div')
  div.setAttribute('class', wrapper.className)
  div.setAttribute('role', 'region')
  div.setAttribute('aria-label', wrapper.label)
  div.setAttribute('tabindex', '0')
  return div
}

/**
 * Layer the wrapper's sink gate over `config` while the option is on (else
 * return it unchanged — the allowlist is then exactly the core one).
 *
 * The wrapper needs `role` and `tabindex`, which are not on the core allowlist.
 * The backends have to keep both names for the renderer's own wrapper to
 * survive — DOMPurify filters attributes AFTER its element hook, so a value the
 * gate set on an unlisted name would be dropped again — so the gate narrows them
 * straight back:
 *
 * - On a wrapper-shaped element — a `<div>` whose `class` is exactly the
 *   configured value and whose only element child is a `<table>` — it *sets*
 *   `role="region"` and `tabindex="0"`, overwriting any other value, so the
 *   shape can only ever mean "this table scrolls".
 * - On every other element it removes them — the names the host's own
 *   `sanitizeExtension.allowedAttr` did not already admit, so a host that allows
 *   `role` for its own markup keeps it.
 *
 * The renderer's wrapper and raw HTML that reproduces that exact shape around a
 * raw `<table>` are deliberately indistinguishable: both end up as the labelled
 * scroll region the host opted into for tables, which is no more than the author
 * gets by writing a markdown table. What raw HTML cannot do is put
 * `role`/`tabindex` anywhere else — the same posture as with the option off, and
 * the same shape-gate model as the footnote `id` gate in sanitize.ts. A
 * per-render nonce marker would tell the two apart, but would make
 * `renderMarkdownUnsafe` output nondeterministic. @internal
 */
export function withTableWrapperGate(
  config: SanitizerConfig,
  hostAttr: readonly string[] = [],
): SanitizerConfig {
  const wrapper = resolveTableWrapper()
  if (!wrapper) return config
  const strip = ['role', 'tabindex'].filter((name) => !hostAttr.includes(name))
  const gate = config.onElement
  return {
    ...config,
    allowedAttr: [...config.allowedAttr, ...strip],
    onElement(node, tagName) {
      if (
        tagName === 'div' &&
        node.getAttribute('class') === wrapper.className &&
        node.childElementCount === 1 &&
        node.firstElementChild?.tagName === 'TABLE'
      ) {
        node.setAttribute('role', 'region')
        node.setAttribute('tabindex', '0')
      } else {
        // Optional call: the DOMPurify hook also fires for text/comment nodes.
        for (const name of strip) node.removeAttribute?.(name)
      }
      gate?.(node, tagName)
    },
  }
}
