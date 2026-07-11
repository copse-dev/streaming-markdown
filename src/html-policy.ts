/**
 * Raw-HTML rendering policy (#600).
 *
 * `'passthrough'` (the default) emits well-formed raw HTML tags verbatim and
 * defers entirely to the sink sanitizer (`sanitize.ts`) as the sole arbiter:
 * allowlisted tags render as elements, everything else is stripped/unwrapped.
 * `'escape'` reproduces the historical behavior — every tag outside the benign
 * attribute-less inline allowlist is escaped into literal prose.
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
export type HtmlPolicy = 'passthrough' | 'escape'

import { activeConfig } from './config.ts'

/** The active raw-HTML policy for the current render (`'passthrough'` by default). */
export function getHtmlPolicy(): HtmlPolicy {
  return activeConfig().htmlPolicy ?? 'passthrough'
}
