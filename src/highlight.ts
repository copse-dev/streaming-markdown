import { activeConfig } from './config.ts'
import { escapeHtml } from './escape.ts'

// PROTOTYPE (#lazy-load): this module is the *core* of syntax highlighting and
// deliberately imports **no** highlight.js code. highlight.js (core + a dozen
// language grammars) is the single heaviest dependency in the package, and
// because `render-blocks.ts` pulls this module in, it used to land in every
// consumer's bundle — even one that never renders a code fence.
//
// The heavy grammars now live behind a pluggable {@link CodeHighlighter} backend
// (`highlight-hljs.ts`), mirroring the pluggable-sanitizer-backend split. Until a
// backend is supplied (`MarkdownConfig.codeHighlighter`, from the lazy
// `loadHighlightjs()` / `loadShiki()`),
// fenced code renders as escaped plain text with the correct `hljs lang-*` class,
// and upgrades to token spans once the backend arrives. Language *resolution*
// (aliases + the known-language set) stays here because it is cheap string work
// and keeps `fenceCodeClass` stable across the plain → highlighted upgrade, so a
// streaming re-render never has to churn the element's className.

/**
 * Pluggable syntax highlighter. A backend receives already-resolved input from
 * the core: `highlight` is called with a language id the core resolved (see
 * {@link CodeHighlighter.supports}), and `highlightAuto` is called only for an
 * empty fence info string. Both return an HTML token string (highlight.js
 * `.value`-shaped).
 *
 * Pass one via `MarkdownConfig.codeHighlighter` — obtained lazily from
 * `loadHighlightjs()` / `installHighlightjs()` in
 * `@copse/streaming-markdown/highlighters/highlightjs`.
 */
export interface CodeHighlighter {
  /**
   * Highlight `code` as `language`: an id from {@link KNOWN_LANGUAGES}, or a
   * fence id this backend claimed through {@link CodeHighlighter.supports}.
   */
  highlight(code: string, language: string): string
  /** Auto-detect and highlight `code` (used only for an empty fence info string). */
  highlightAuto(code: string): string
  /**
   * Optional: does this backend handle the fence language `language` directly?
   * Called with the fence's lowercased id after the core folds pure synonyms
   * (`ts` → `typescript`, `sh` → `bash`, …). Returning `true` makes the core
   * keep that id — `highlight` receives it and the fence's class is
   * `lang-<id>` — instead of mapping an approximate alias (`tsx` →
   * `typescript`, `jsx` → `javascript`, `html` → `xml`) or rejecting an id
   * outside {@link KNOWN_LANGUAGES} (`java`, `kotlin`, …). Omit it and
   * resolution is exactly the built-in one.
   *
   * The answer feeds the fence's class, so it must be STABLE for a given id
   * for as long as the backend stays configured: a backend that loads
   * asynchronously should answer from what it has been asked to load, not
   * from what has finished loading, or a streaming re-render will churn the
   * `<code>` element's class (`highlight` can still return plain text until the
   * grammar arrives — that interior swap is the intended upgrade).
   */
  supports?(language: string): boolean
}

/**
 * Language ids the core knows how to resolve to. This MUST stay in sync with the
 * grammars the {@link CodeHighlighter} backends register (`highlight-hljs.ts`,
 * `highlight-shiki.ts`) — the core owns it so `fenceCodeClass` resolves
 * `ts → typescript` before the backend has loaded, giving a stable class across
 * the plain → highlighted swap.
 */
export const KNOWN_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript',
  'javascript',
  'bash',
  'shell',
  'json',
  'python',
  'css',
  'xml',
  'markdown',
  'yaml',
  'rust',
  'go',
  'sql',
])

/**
 * Pure synonyms: another spelling of the same language. Folded BEFORE a
 * highlighter is consulted, so `ts` is always `lang-typescript` whatever the
 * backend — the class never depends on which spellings a backend registers.
 */
const LANG_SYNONYMS: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  zsh: 'bash',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  text: 'plaintext',
  plaintext: 'plaintext',
}

/**
 * Approximations: a DIFFERENT language whose nearest {@link KNOWN_LANGUAGES}
 * grammar is close enough to highlight it (`tsx` as TypeScript, `html` as
 * XML). Applied only when the highlighter doesn't claim the id itself via
 * {@link CodeHighlighter.supports}, so a backend with a real `tsx` grammar
 * gets `tsx` (and the fence keeps `lang-tsx`).
 */
const LANG_FALLBACKS: Record<string, string> = {
  tsx: 'typescript',
  jsx: 'javascript',
  html: 'xml',
  htm: 'xml',
}

/** Own-key lookup, so an info string like `constructor` can't hit `Object.prototype`. */
function lookup(table: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/**
 * Resolve a fence info string to the language id handed to the highlighter
 * (and shown as `lang-<id>`), or `null` (plain/auto). Order: fold synonyms;
 * keep the id if the highlighter claims it; else apply an approximation and
 * accept only {@link KNOWN_LANGUAGES}.
 */
function resolveLanguage(lang: string, highlighter: CodeHighlighter | null | undefined): string | null {
  const key = lang.trim().toLowerCase()
  if (!key) return null
  const canonical = lookup(LANG_SYNONYMS, key) ?? key
  if (canonical === 'plaintext') return null
  if (highlighter?.supports?.(canonical)) return canonical
  const resolved = lookup(LANG_FALLBACKS, canonical) ?? canonical
  return KNOWN_LANGUAGES.has(resolved) ? resolved : null
}

/**
 * The {@link CodeHighlighter} configured for the current render (`null` when none,
 * i.e. escaped-plain-text fallback). Set it per render via
 * `MarkdownConfig.codeHighlighter` — obtain a backend from its `load*` entry
 * (`@copse/streaming-markdown/highlighters/highlightjs` or `.../shiki`).
 *
 * @internal Introspection getter that reads the ambient render config; outside
 * a render it returns the defaults. Not part of the stable v1 surface (#147) —
 * scope behaviour via `MarkdownConfig.codeHighlighter` instead. Not exported from the package entry since 1.0.
 */
export function getCodeHighlighter(): CodeHighlighter | null {
  return activeConfig().codeHighlighter ?? null
}

/**
 * Highlight fenced code for HTML injection. With no backend registered, falls
 * back to escaped plain text (safe, and the pre-highlight state a streaming UI
 * shows while the grammar chunk loads); with a backend, delegates to it. The code
 * is rendered verbatim — leading/trailing blank lines and the first line's
 * indentation are preserved (#598); only the block-final newline is dropped for
 * display (the fence parser already omits it).
 */
export function highlightFenceCode(code: string, lang: string): string {
  if (code === '') return ''
  // Blank-only fences (only newlines/spaces) are preserved exactly rather than
  // fed to the highlighter, which would otherwise collapse or mis-detect them.
  if (code.trim() === '') return escapeHtml(code)

  const highlighter = activeConfig().codeHighlighter
  const language = resolveLanguage(lang, highlighter)

  // No backend yet: plain-text fallback. The `hljs lang-*` class is still applied
  // by `fenceCodeClass`, so a config with a highlighter + re-render upgrades the
  // interior to token spans without changing the surrounding element.
  if (!highlighter) return escapeHtml(code)

  if (language) return highlighter.highlight(code, language)
  if (!lang.trim()) return highlighter.highlightAuto(code)
  return escapeHtml(code)
}

/**
 * The `<code>` class for a fence: `hljs lang-<id>`, where `<id>` is the
 * resolved language (see `resolveLanguage`: synonyms folded, an id the
 * configured highlighter `supports` kept as written, else the
 * {@link KNOWN_LANGUAGES} id), or the lowercased info string when nothing
 * resolves, or `text` for an empty one. Hosts read it as the language label.
 */
export function fenceCodeClass(lang: string): string {
  const language = resolveLanguage(lang, activeConfig().codeHighlighter)
  const label = language ?? (lang.trim() ? lang.trim().toLowerCase() : 'text')
  // The info string is entity-decoded, so an unrecognized language falls back to
  // attacker-controlled text. Escape it before it lands in a `class="…"` context
  // in the string emitter (the DOM path assigns `.className`, which can't break
  // out). Recognized languages are already safe hljs ids, but escaping is a no-op
  // for them.
  return `hljs lang-${escapeHtml(label)}`
}

/**
 * Undo app-specific fenced-code decoration for CommonMark conformance
 * comparison (the code analogue of `stripAppLinkAttributes`): drop
 * highlight.js token spans, map `hljs lang-x` to the spec's `language-x`
 * (dropping the class entirely for the empty-info `lang-text` fallback), and
 * restore the block-final newline the app trims for display. Structural
 * differences in the code text itself still register as failures.
 */
export function stripAppCodeDecorations(html: string): string {
  return html.replace(
    /<code class="hljs lang-([^"]*)">([\s\S]*?)<\/code>/g,
    (_m, lang: string, body: string) => {
      const text = body.replace(/<span[^>]*>|<\/span>/g, '')
      const classAttr = lang === 'text' ? '' : ` class="language-${lang}"`
      const content = text === '' || text.endsWith('\n') ? text : `${text}\n`
      return `<code${classAttr}>${content}</code>`
    },
  )
}
