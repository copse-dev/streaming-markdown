// Config-injected renderer API (SPIKE for #145/#137/#147).
//
// This is the replacement for the config-epoch mechanism. Instead of ~20
// process-wide `set*` functions plus a global epoch counter that streaming
// caches watch for changes, a host passes a `MarkdownConfig` object to the
// entry point (`renderMarkdown(raw, config)`, `new StreamingMarkdownRenderer(
// host, config)`). The config is applied to the module-global slots for the
// duration of one *synchronous* render via the same save-set-restore seam that
// `withRenderPolicies` (#137, ADR 0003) already uses for the security/behavioural
// policy tier — then every touched slot is restored. Two renderers with
// different config therefore coexist in one process with no epoch, no cache
// invalidation, and no bleed: each render reads the slots while they hold its
// own values, and restores them before yielding.
//
// SPIKE SCOPE: this widens the scoped seam from the 5 policy fields to also
// cover the three *grammar* setters that #177's tests exercise — math prose
// syntax, the link decorator, and the fence-handler registry. These are the
// setters whose mid-stream mutation the config-epoch was built to survive, so
// they are the ones worth proving. The heavy backend tier (sanitizer, KaTeX,
// mermaid, highlighter) stays on its existing global registration for now; those
// hydrate *asynchronously* after the scoped block and so can't ride a synchronous
// save/restore (the same reason ADR 0003 left them global). The full sweep —
// removing the setters and folding the remaining fields in — follows once this
// shape is approved.
import { type LinkDecorator, getLinkDecorator, setLinkDecorator } from './inline-links.ts'
import {
  type FenceHandler,
  restoreFenceHandlers,
  setFenceHandler,
  snapshotFenceHandlers,
} from './fence-handlers.ts'
import { getMathSyntax, setMathSyntax } from './math-syntax.ts'
import { type RenderPolicyOptions, withRenderPolicies } from './render-policies.ts'

/**
 * The full per-render configuration for a document or a streaming renderer.
 *
 * Extends {@link RenderPolicyOptions} (the security/behavioural policy tier —
 * `htmlPolicy`, `safeHrefSchemes`, `sanitizeExtension`, `linkImagePolicy`,
 * `trustedTypesPolicy`) with the grammar tier below. Every field is optional and
 * inherits the process-wide default when omitted; a field set to `null` scopes
 * that setting back to its built-in default for this render only.
 *
 * A host injects this once — at construction for `StreamingMarkdownRenderer`, or
 * per call for `renderMarkdown` — instead of mutating process-wide state with the
 * `set*` functions. Because the config is a snapshot applied and restored around
 * each synchronous render, two renderers with different config coexist without
 * interfering (the motivation that the config-epoch mechanism previously served).
 */
export interface MarkdownConfig extends RenderPolicyOptions {
  /**
   * Force `$…$`-style prose math syntax on (`true`) or off (`false`); `null`
   * defers to math-renderer registration (the default). See math-syntax.ts.
   */
  mathSyntax?: boolean | null
  /**
   * Host {@link LinkDecorator} applied to rendered `<a>` output; `null` restores
   * the neutral built-in. See inline-links.ts.
   */
  linkDecorator?: LinkDecorator | null
  /**
   * Fence-handler registrations keyed by info-string language, layered over the
   * built-in `mermaid`/`math` handlers for this render. A value of `null` removes
   * that language's handler for the render. See fence-handlers.ts.
   */
  fenceHandlers?: Record<string, FenceHandler | null>
}

/**
 * Run `fn` with `config` applied to the module-global slots, then restore every
 * touched slot (in reverse) in a `finally`. Returns `fn`'s result. The policy
 * tier is scoped by {@link withRenderPolicies}; the grammar tier is scoped here.
 *
 * The render + sink pass must be synchronous for the isolation to hold — each
 * slot is set before `fn()` and restored after, and nested synchronous renders
 * compose because each level saves and restores its own previous value.
 */
export function withConfig<T>(config: MarkdownConfig, fn: () => T): T {
  return withRenderPolicies(config, () => {
    const restores: Array<() => void> = []

    if (config.mathSyntax !== undefined) {
      const previous = getMathSyntax()
      setMathSyntax(config.mathSyntax)
      restores.push(() => {
        setMathSyntax(previous)
      })
    }
    if (config.linkDecorator !== undefined) {
      const previous = getLinkDecorator()
      setLinkDecorator(config.linkDecorator)
      restores.push(() => {
        setLinkDecorator(previous)
      })
    }
    if (config.fenceHandlers !== undefined) {
      const previous = snapshotFenceHandlers()
      for (const [lang, handler] of Object.entries(config.fenceHandlers)) {
        setFenceHandler(lang, handler)
      }
      restores.push(() => {
        restoreFenceHandlers(previous)
      })
    }

    if (restores.length === 0) return fn()
    try {
      return fn()
    } finally {
      for (let i = restores.length - 1; i >= 0; i--) restores[i]!()
    }
  })
}
