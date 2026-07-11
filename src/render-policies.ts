// Per-render policy overrides (#137, ADR 0003).
//
// The renderer's behavioral/security policies are process-wide slots (the
// `set*` functions move the default). This module lets an entry point override
// any subset of them for the duration of one synchronous render/update via the
// save-set-restore seam `htmlPolicy` already used (renderer.ts) — so two
// consumers in one process (two chat panes, a multi-tenant SSR server) can each
// render under their own link/scheme/origin/HTML policy without a global set
// bleeding across them. The deep call stack keeps reading the global getters, so
// no signature is threaded.
//
// Isolation rests on one invariant: the render + sink pass is **synchronous**.
// Each override is set before `fn()` and restored in a `finally`, and nested
// (recursive) synchronous renders compose correctly because each level saves and
// restores its own previous value. Async hydration runs *after* the scoped block
// and reads only the global backend registries, so it is unaffected.
import { configEpoch, restoreConfigEpoch } from './config-epoch.ts'
import { type HtmlPolicy, setHtmlPolicy } from './html-policy.ts'
import { getSafeHrefSchemes, setSafeHrefSchemes } from './inline-links.ts'
import { type SanitizeExtension, setSanitizeExtension } from './sanitize.ts'
import {
  type LinkImagePolicy,
  restoreLinkImagePolicy,
  setLinkImagePolicy,
  snapshotLinkImagePolicy,
} from './link-image-policy.ts'
import {
  restoreTrustedTypesPolicy,
  setTrustedTypesPolicy,
  snapshotTrustedTypesPolicy,
  type TrustedTypesPolicy,
} from './html-sink.ts'

/**
 * Per-render overrides for the behavioral/security policy tier. Every field is
 * optional; an omitted field inherits the process-wide default (the value set by
 * the matching `set*`). A field set to `null` scopes that policy back to its
 * built-in default for this render only. These are additive to the global
 * setters — the setters still move the default; these win for one render.
 *
 * The heavy backend/registry tier (sanitizer backend, syntax highlighter,
 * diagram/math renderers, entity decoder, fence handlers) is deliberately *not*
 * here: those load shared dependencies installed once per process. See ADR 0003.
 */
export interface RenderPolicyOptions {
  /**
   * Raw-HTML handling (#600). `'passthrough'` emits well-formed tags for the
   * sink sanitizer to arbitrate; `'escape'` literalizes them. Omit to inherit.
   */
  htmlPolicy?: HtmlPolicy
  /**
   * Scheme allowlist enforced on link/image destinations — the gate against
   * `javascript:`/`data:` XSS. `null` restores the built-in default set.
   */
  safeHrefSchemes?: Iterable<string> | null
  /** Host sanitizer allowlist extension; `null` uses the core allowlist only. */
  sanitizeExtension?: SanitizeExtension | null
  /** Opt-in link/image origin allowlist; `null` disables it (unrestricted). */
  linkImagePolicy?: LinkImagePolicy | null
  /** Trusted Types policy used to bless sink output; `null` uses the default. */
  trustedTypesPolicy?: TrustedTypesPolicy | null
}

/**
 * Run `fn` with each policy present in `options` scoped to the override, then
 * restore every changed slot (in reverse) in a `finally`. Returns `fn`'s result.
 * When no policy field is set this is a straight `fn()` call with zero overhead.
 */
export function withRenderPolicies<T>(options: RenderPolicyOptions, fn: () => T): T {
  const restores: Array<() => void> = []
  // Scoping a policy calls the same bumping config setters to apply and restore
  // the override — a net-zero change that must not read as a real mid-stream
  // config flip to the stateful renderer's config-epoch guard (#145). Snapshot
  // the epoch and cancel those transient bumps around the whole scoped block.
  const epochSnapshot = configEpoch()

  if (options.htmlPolicy !== undefined) {
    const previous = setHtmlPolicy(options.htmlPolicy)
    restores.push(() => {
      setHtmlPolicy(previous)
    })
  }
  if (options.safeHrefSchemes !== undefined) {
    const previous = getSafeHrefSchemes()
    setSafeHrefSchemes(options.safeHrefSchemes)
    restores.push(() => {
      setSafeHrefSchemes(previous)
    })
  }
  if (options.sanitizeExtension !== undefined) {
    const previous = setSanitizeExtension(options.sanitizeExtension)
    restores.push(() => {
      setSanitizeExtension(previous)
    })
  }
  if (options.linkImagePolicy !== undefined) {
    const previous = snapshotLinkImagePolicy()
    setLinkImagePolicy(options.linkImagePolicy)
    restores.push(() => {
      restoreLinkImagePolicy(previous)
    })
  }
  if (options.trustedTypesPolicy !== undefined) {
    const previous = snapshotTrustedTypesPolicy()
    setTrustedTypesPolicy(options.trustedTypesPolicy)
    restores.push(() => {
      restoreTrustedTypesPolicy(previous)
    })
  }

  if (restores.length === 0) return fn()
  // Cancel the apply bumps so `fn` (which reads the epoch) sees the entry value.
  restoreConfigEpoch(epochSnapshot)
  try {
    return fn()
  } finally {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]!()
    // …and cancel the restore bumps so the next update doesn't over-invalidate.
    restoreConfigEpoch(epochSnapshot)
  }
}
