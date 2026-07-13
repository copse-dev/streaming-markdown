/**
 * Raw-HTML rendering policy (#600).
 *
 * `'passthrough'` (the default) emits well-formed raw HTML tags verbatim and
 * defers entirely to the sink sanitizer (`sanitize.ts`) as the sole arbiter:
 * allowlisted tags render as elements, everything else is stripped/unwrapped.
 * `'escape'` reproduces the historical behavior — every tag outside the benign
 * attribute-less inline allowlist is escaped into literal prose.
 * `'escape-all'` literalizes every raw tag except the void `<br>`/`<br/>`:
 * markdown text can never form an element at all, which also retires the raw
 * tag-balance machinery for the render — no unbalanced-tag freeze guards, no
 * re-root frames, no fallback cliffs (docs/decisions/0004). It matches how
 * renderers without raw-HTML support (smd) treat tags, and is the natural
 * posture for pure-LLM chat output.
 *
 * The choice is a process-wide slot rather than a threaded parameter, mirroring
 * the other module-scoped singletons the renderer already relies on (the
 * footnote context, the inline-pass registry, the sanitizer backend, the math
 * syntax toggle). Entry points (`renderMarkdown`, the streaming emitters)
 * resolve an optional per-call `htmlPolicy` and set/restore this slot around
 * their work, so a nested/streaming render inherits the active policy and the
 * deep inline call stack (`escapeHtmlTextNodes`, `pendingHoldIndex`) reads it
 * without new parameters.
 */
export type HtmlPolicy = 'passthrough' | 'escape' | 'escape-all'

import { activeConfig } from './config.ts'

/**
 * The active raw-HTML policy for the current render (`'passthrough'` by default).
 *
 * @internal Introspection getter that reads the ambient render config; outside
 * a render it returns the defaults. Not part of the stable v1 surface (#147) —
 * scope behaviour via `MarkdownConfig.htmlPolicy` instead. Not exported from the package entry since 1.0.
 */
export function getHtmlPolicy(): HtmlPolicy {
  return activeConfig().htmlPolicy ?? 'passthrough'
}
