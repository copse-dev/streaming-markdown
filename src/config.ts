// Config-injected renderer API (#145/#137/#147).
//
// This is the replacement for the config-epoch mechanism. Instead of the
// process-wide `set*` functions plus a global epoch counter that streaming
// caches watched for changes, a host passes a `MarkdownConfig` object to the
// entry point (`renderMarkdown(raw, config)`, `new StreamingMarkdownRenderer(
// host, config)`). The config is applied to the module-global slots for the
// duration of one *synchronous* render via the same save-set-restore seam that
// `withRenderPolicies` (#137, ADR 0003) already uses for the security/behavioural
// policy tier — then every touched slot is restored. Two renderers with
// different config therefore coexist in one process with no epoch, no cache
// invalidation, and no bleed: each render reads the slots while they hold its
// own values, and restores them before yielding.
//
// SCOPE: this covers every setting that is read *synchronously* during a
// render/sink pass — the security/behavioural policy tier plus the grammar and
// inline-pipeline tier. The heavy *async backend* tier (sanitizer backend,
// KaTeX/mermaid/highlighter registration) is deliberately NOT here: those
// backends hydrate asynchronously *after* the scoped block returns
// (`hydratePendingMath`/`hydratePendingDiagrams` read the global registries once
// the microtask runs), so they cannot ride a synchronous save/restore. They stay
// on their `set*`/`load*`/`install*` registration seam — see ADR 0003 and each
// backend module. `codeHighlighter` and `rawImageRenderer` *are* here because
// they run inside the synchronous render, not in async hydration.
import { getCodeHighlighter, setCodeHighlighter, type CodeHighlighter } from './highlight.ts'
import {
  getEntityDecoder,
  getUserNamedEntities,
  setEntityDecoder,
  setNamedEntities,
  type EntityDecoder,
} from './entity-decoder.ts'
import {
  getFlankingPunctuationExclusion,
  setFlankingPunctuationExclusion,
} from './inline-emphasis.ts'
import { getBareUrlCjkBoundary, setBareUrlCjkBoundary } from './inline-spans.ts'
import { getInlinePasses, setInlinePasses, type InlinePass } from './inline-passes.ts'
import { getRawImageRenderer, setRawImageRenderer, type RawImageRenderer } from './raw-images.ts'
import { getSanitizerBackend, setSanitizerBackend, type SanitizerBackend } from './sanitize.ts'
import { isEmailAutolinksEnabled, setEmailAutolinks } from './autolink-syntax.ts'
import { getLinkDecorator, setLinkDecorator, type LinkDecorator } from './inline-links.ts'
import type { MathRenderer } from './math.ts'
import type { DiagramRenderer } from './mermaid.ts'
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
 * `trustedTypesPolicy`) with the grammar and inline-pipeline tier below. Every
 * field is optional and inherits the process-wide default when omitted; a field
 * set to `null` scopes that setting back to its built-in default for this render
 * only.
 *
 * A host injects this once — at construction for `StreamingMarkdownRenderer`, or
 * per call for `renderMarkdown` — instead of mutating process-wide state with the
 * `set*` functions. Because the config is a snapshot applied and restored around
 * each synchronous render, two renderers with different config coexist without
 * interfering (the motivation the config-epoch mechanism previously served).
 *
 * The heavy *async backend* tier (KaTeX/mermaid/highlighter/sanitizer backend
 * registration) is not configured here — those hydrate after the synchronous
 * render and stay on their `load*`/`install*`/`set*Backend` registration seam.
 */
export interface MarkdownConfig extends RenderPolicyOptions {
  /**
   * Force `$…$`-style prose math syntax on (`true`) or off (`false`); `null`
   * defers to math-renderer registration (the default). See math-syntax.ts.
   */
  mathSyntax?: boolean | null
  /**
   * Recognize bare `user@host` addresses as `mailto:` autolinks (GFM extension,
   * on by default). See autolink-syntax.ts.
   */
  emailAutolinks?: boolean
  /**
   * Exclude characters from the emphasis flanking *punctuation* class — the seam
   * markdown-cjk-friendly uses to pair emphasis around full-width punctuation.
   * For the CJK preset, spread `cjkFriendlyConfig` from
   * `@copse/streaming-markdown/cjk` rather than hardcoding the range table here
   * (it stays in that opt-in bundle). See inline-emphasis.ts / cjk.ts.
   */
  flankingPunctuationExclusion?: ((ch: string) => boolean) | null
  /**
   * Flag characters as a bare-autolink boundary — the CJK seam that stops a
   * run-together `https://example.com。次` at the `。`. See the note on
   * {@link flankingPunctuationExclusion} for the CJK preset. See inline-spans.ts.
   */
  bareUrlCjkBoundary?: ((ch: string) => boolean) | null
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
  /**
   * Synchronous syntax highlighter for fenced code; `null` falls back to escaped
   * plain text. This is the *synchronous* highlighter seam — an async highlighter
   * backend still registers via its `load*` entry. See highlight.ts.
   */
  codeHighlighter?: CodeHighlighter | null
  /**
   * Host renderer for raw `<img>` tags found in prose; `null` escapes them (the
   * default). Runs inside the synchronous render. See raw-images.ts.
   */
  rawImageRenderer?: RawImageRenderer | null
  /**
   * The active inline passes (execution order = array order within each stage);
   * `null`/`[]` clears them. See inline-passes.ts.
   */
  inlinePasses?: readonly InlinePass[] | null
  /**
   * Replace the reference HTML-entity decoder wholesale; `null` uses the built-in
   * numeric + HTML4-named decoder. See entity-decoder.ts.
   */
  entityDecoder?: EntityDecoder | null
  /**
   * User-defined named entity references layered over the built-in HTML4 set
   * (only affects the built-in decoder). See entity-decoder.ts.
   */
  namedEntities?: Record<string, string>
  /**
   * Sanitizer backend for the sink (`null` uses the native browser Sanitizer).
   * Scoped per render like the rest of the synchronous tier. See sanitize.ts.
   */
  sanitizerBackend?: SanitizerBackend | null
  /**
   * Math renderer used by {@link StreamingMarkdownRenderer.hydrate} to fill
   * pending math scaffolding. Unlike the synchronous fields, this is read during
   * *async* hydration (after the render returns), so it is carried on the config
   * for `hydrate()` rather than scoped around the synchronous render. Obtain one
   * from `loadKatex()` (`@copse/streaming-markdown/math/katex`). Pair with
   * `mathSyntax: true` to also turn on the prose `$…$` grammar. See math.ts.
   */
  mathRenderer?: MathRenderer | null
  /**
   * Diagram renderer used by {@link StreamingMarkdownRenderer.hydrate} to fill
   * pending mermaid scaffolding. Read during async hydration (see
   * {@link mathRenderer}). Obtain one from `loadMermaid()`
   * (`@copse/streaming-markdown/diagrams/mermaid`). See mermaid.ts.
   */
  diagramRenderer?: DiagramRenderer | null
}

/**
 * Run `fn` with `config` applied to the module-global slots, then restore every
 * touched slot (in reverse) in a `finally`. Returns `fn`'s result. The policy
 * tier is scoped by {@link withRenderPolicies}; the grammar/inline tier here.
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
    if (config.emailAutolinks !== undefined) {
      const previous = isEmailAutolinksEnabled()
      setEmailAutolinks(config.emailAutolinks)
      restores.push(() => {
        setEmailAutolinks(previous)
      })
    }
    if (config.flankingPunctuationExclusion !== undefined) {
      const previous = getFlankingPunctuationExclusion()
      setFlankingPunctuationExclusion(config.flankingPunctuationExclusion)
      restores.push(() => {
        setFlankingPunctuationExclusion(previous)
      })
    }
    if (config.bareUrlCjkBoundary !== undefined) {
      const previous = getBareUrlCjkBoundary()
      setBareUrlCjkBoundary(config.bareUrlCjkBoundary)
      restores.push(() => {
        setBareUrlCjkBoundary(previous)
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
    if (config.codeHighlighter !== undefined) {
      const previous = getCodeHighlighter()
      setCodeHighlighter(config.codeHighlighter)
      restores.push(() => {
        setCodeHighlighter(previous)
      })
    }
    if (config.rawImageRenderer !== undefined) {
      const previous = getRawImageRenderer()
      setRawImageRenderer(config.rawImageRenderer)
      restores.push(() => {
        setRawImageRenderer(previous)
      })
    }
    if (config.inlinePasses !== undefined) {
      const previous = getInlinePasses()
      setInlinePasses(config.inlinePasses)
      restores.push(() => {
        setInlinePasses(previous)
      })
    }
    if (config.entityDecoder !== undefined) {
      const previous = getEntityDecoder()
      setEntityDecoder(config.entityDecoder)
      restores.push(() => {
        setEntityDecoder(previous)
      })
    }
    if (config.namedEntities !== undefined) {
      const previous = getUserNamedEntities()
      setNamedEntities(config.namedEntities)
      restores.push(() => {
        setNamedEntities(previous)
      })
    }
    if (config.sanitizerBackend !== undefined) {
      const previous = getSanitizerBackend()
      setSanitizerBackend(config.sanitizerBackend)
      restores.push(() => {
        setSanitizerBackend(previous)
      })
    }
    // `mathRenderer`/`diagramRenderer` are intentionally NOT scoped here: they are
    // read during async hydration, after this synchronous block returns, so a
    // save/restore around `fn()` would be undone before hydration runs. They ride
    // the config for `StreamingMarkdownRenderer.hydrate()` / the hydrate options.

    if (restores.length === 0) return fn()
    try {
      return fn()
    } finally {
      for (let i = restores.length - 1; i >= 0; i--) restores[i]!()
    }
  })
}
