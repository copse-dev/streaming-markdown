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
import { bumpConfigEpoch } from './config-epoch.ts'

export type HtmlPolicy = 'passthrough' | 'escape'

let currentHtmlPolicy: HtmlPolicy = 'passthrough'

/** The active raw-HTML policy (`'passthrough'` unless overridden). */
export function getHtmlPolicy(): HtmlPolicy {
  return currentHtmlPolicy
}

/**
 * Set the process-wide raw-HTML policy and return the previous value, so callers
 * can restore it in a `finally` (the scoped-override pattern the entry points
 * use). Pass a per-render override at the call site instead of this for one-off
 * changes; use this to move the global default.
 */
export function setHtmlPolicy(policy: HtmlPolicy): HtmlPolicy {
  const previous = currentHtmlPolicy
  currentHtmlPolicy = policy
  // The stateful streaming renderer re-renders its committed prefix when the
  // config epoch moves (#145); the per-render scoped seam (withRenderPolicies)
  // neutralizes these transient apply/restore bumps, so only a real default flip
  // is observed.
  bumpConfigEpoch()
  return previous
}
