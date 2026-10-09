import { escapeHtml } from './escape.ts'
import type { CodeHighlighter } from './highlight.ts'

// PROTOTYPE (#lazy-load): the Shiki backend — a second {@link CodeHighlighter},
// sibling of `highlight-hljs.ts`. It is the ONLY module that references `shiki`,
// and lives behind the `@copse/streaming-markdown/highlighters/shiki` subpath, so
// shiki stays out of any bundle that doesn't reference this entry. `shiki` is an
// OPTIONAL peer dependency, reached only through LITERAL dynamic imports (see
// "Bundler resolution" below), so a host bundler resolves it and splits it into
// lazy chunks fetched on the first {@link loadShiki}.
//
// Two constraints shape this backend:
//
// • **Async seam.** The {@link CodeHighlighter} contract is synchronous
//   string→HTML, but shiki can only initialize asynchronously (engine, grammar
//   and theme modules are dynamic imports). The exported {@link shikiHighlighter}
//   is therefore a stable facade: it renders escaped plain text until
//   {@link loadShiki} resolves, then highlights synchronously against the loaded
//   instance. That is exactly the plain → highlighted upgrade the core already
//   defines for a not-yet-registered backend — `fenceCodeClass` stays stable, so
//   a re-render swaps only the interior of the `<pre><code>` element.
//
// • **Sanitizer compatibility.** Shiki's stock `codeToHtml` emits inline `style`
//   attributes (even its CSS-variables theming does), and the sink sanitizer
//   deliberately strips `style` — widening that allowlist would hand markdown
//   authors arbitrary CSS. Instead this backend renders from `codeToTokensBase`
//   and maps each token's resolved theme color to a *class* (`shiki-<hex>`,
//   plus `shiki-italic`/`shiki-bold`/…), which the existing `class` allowlist
//   already passes. {@link shikiThemeCss} generates the theme's tiny stylesheet
//   (one rule per palette color) for the host to inject once.
//
// • **Light/dark.** With `themes: { light, dark }` every token carries a class
//   per theme — `shiki-<hex>` for light (the single-theme class names, so a
//   light-only stylesheet keeps working), `shiki-dark-<hex>` for dark — from
//   one `codeToTokensWithThemes` pass. The markup is identical in both modes;
//   only {@link shikiThemeCss} decides which class set is live (scoped by
//   `prefers-color-scheme`, or by a host selector), so a host's theme toggle is
//   a stylesheet concern and never re-renders a message.
//
// It uses shiki's fine-grained core (`shiki/core` + the JavaScript regex engine)
// rather than the batteries-included entry, so the lazy chunk carries only the
// registered grammars and theme — no WASM, no full bundled registry.
//
// • **Bundler resolution.** Every specifier is a string literal: `shiki/core`
//   and `shiki/engine/javascript` directly, and grammars/themes through shiki's
//   own lazy maps (`bundledLanguages` from `shiki/langs`, `bundledThemes` from
//   `shiki/themes` — each name → `() => import('<literal>')`). A webpack build
//   can't resolve a non-literal `import(x)` at all ("Critical dependency: the
//   request of a dependency is an expression", then a runtime failure), and a
//   template literal like `` import(`shiki/langs/${name}.mjs`) `` makes it build
//   a context module over the directory instead. With the maps, every bundler
//   emits one lazy chunk per grammar/theme and fetches only the ones named in
//   the options. `shiki` is a devDependency of this package, so the literals
//   always type-check here; no shiki type reaches the emitted `.d.ts` (the
//   module shapes below are structural), so consumers who never import this
//   subpath need neither the peer nor its types.

/** A themed token from shiki's `codeToTokensBase` (structural, no shiki types). */
interface ShikiToken {
  content: string
  color?: string
  fontStyle?: number
}

/** The slice of a resolved shiki theme this backend reads. */
interface ShikiResolvedTheme {
  fg?: string
  settings?: readonly { settings?: { foreground?: string } }[]
}

/** One theme's styling of a token, from `codeToTokensWithThemes` (`TokenStyles`). */
interface ShikiTokenStyles {
  color?: string
  fontStyle?: number
}

/** A token styled by several themes at once (`ThemedTokenWithVariants`). */
interface ShikiTokenWithVariants {
  content: string
  variants: Record<string, ShikiTokenStyles>
}

/** The slice of the shiki highlighter API this backend uses (avoids a hard type dependency). */
interface ShikiHighlighterLike {
  codeToTokensBase(
    code: string,
    options: { lang: string; theme: string; tokenizeTimeLimit?: number },
  ): ShikiToken[][]
  codeToTokensWithThemes(
    code: string,
    options: { lang: string; themes: Record<string, string>; tokenizeTimeLimit?: number },
  ): ShikiTokenWithVariants[][]
  getLoadedLanguages(): string[]
  getTheme(name: string): ShikiResolvedTheme
}

/** A lazy module thunk, the value type of shiki's `bundledLanguages` / `bundledThemes`. */
type ShikiLazyModule = () => Promise<unknown>

/**
 * A pre-resolved shiki theme registration object (a TextMate theme with a
 * `name`), for hosts that ship a custom theme instead of naming a bundled one.
 */
export interface ShikiThemeRegistration {
  name: string
  [key: string]: unknown
}

/** A bundled shiki theme name, or a pre-resolved {@link ShikiThemeRegistration}. */
export type ShikiThemeInput = string | ShikiThemeRegistration

/**
 * A light/dark theme pair (the `themes` option). Both are loaded; every token
 * carries a class for each, and {@link shikiThemeCss} scopes which set applies.
 */
export interface ShikiThemePair {
  light: ShikiThemeInput
  dark: ShikiThemeInput
}

interface ShikiCommonOptions {
  /**
   * Grammar names (or aliases) to register, each a key of shiki's
   * `bundledLanguages` map (`shiki/langs`). Default: grammars covering the core
   * `KNOWN_LANGUAGES` set. Grammars outside that set still need a matching id
   * in the core to ever be asked for. An unknown name rejects the load.
   */
  langs?: readonly string[]
  /**
   * Per-line tokenizing budget in ms, passed to shiki as `tokenizeTimeLimit`.
   * A line that exceeds it is cut short: shiki emits the rest of the line as
   * one token in the color reached so far. The FIRST highlight with a grammar
   * also pays the JavaScript regex engine's lazy compilation of that grammar's
   * patterns, which on a slow or busy device can exceed shiki's default (500)
   * and leave that render's fence mostly one color until it re-renders.
   * `0` disables the limit. Default: shiki's.
   */
  tokenizeTimeLimit?: number
}

/**
 * Options for {@link loadShiki} / {@link installShiki}: `langs`, plus EITHER a
 * single `theme` OR a light/dark `themes` pair (never both).
 */
export type ShikiOptions = ShikiCommonOptions &
  (
    | {
        /**
         * Theme: a bundled shiki theme name (a key of `bundledThemes` from
         * `shiki/themes`) or a pre-resolved {@link ShikiThemeRegistration}.
         * Default: `'github-dark'`.
         */
        theme?: ShikiThemeInput
        themes?: never
      }
    | {
        /**
         * A light and a dark theme. Tokens get `shiki-<hex>` classes for the
         * light theme and `shiki-dark-<hex>` for the dark one; see
         * {@link shikiThemeCss} for how the active set is chosen.
         */
        themes: ShikiThemePair
        theme?: never
      }
  )

const DEFAULT_THEME = 'github-dark'

// The grammar modules that cover `KNOWN_LANGUAGES` in `highlight.ts` — keep the
// two in sync (same contract as the hljs grammar list). `shellscript` registers
// the `bash` and `shell` aliases, covering both core ids with one grammar.
const DEFAULT_GRAMMARS: readonly string[] = [
  'typescript',
  'javascript',
  'shellscript',
  'json',
  'python',
  'css',
  'xml',
  'markdown',
  'yaml',
  'rust',
  'go',
  'sql',
]

// Only hex colors become class names (`shiki-f97583`): the token color lands in
// a `class="…"` context, so any other form (`red`, `var(--x)`) is skipped —
// the token then renders bare rather than trusting theme text in markup. Real
// shiki themes use hex throughout. Lowercased on both the token and the
// stylesheet side, since shiki reports `#F97583` in tokens but `#f97583` in
// resolved theme settings.
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/

function normalizeHexColor(color: string | undefined): string | null {
  if (!color) return null
  const normalized = color.toLowerCase()
  return HEX_COLOR_RE.test(normalized) ? normalized : null
}

// shiki's FontStyle bitmask: Italic=1, Bold=2, Underline=4, Strikethrough=8.
// The class names are suffixes after a theme's class prefix (`shiki-italic`,
// `shiki-dark-italic`) — none is a hex string, so they can't collide with a
// color class.
const FONT_STYLE_CLASSES: readonly (readonly [number, string, string])[] = [
  [1, 'italic', 'font-style: italic'],
  [2, 'bold', 'font-weight: bold'],
  [4, 'underline', 'text-decoration: underline'],
  [8, 'strikethrough', 'text-decoration: line-through'],
]

// Class prefixes per theme slot. The single theme and the light half of a pair
// share `shiki-`, so markup and stylesheets written for the single-theme
// backend keep their meaning; `dark` is not a hex string, so `shiki-dark-…`
// never collides with a light color class.
const LIGHT_PREFIX = 'shiki-'
const DARK_PREFIX = 'shiki-dark-'

/** One loaded theme and the class prefix its tokens are emitted under. */
interface ThemeSlot {
  name: string
  prefix: string
  /** The theme's default foreground (lowercased) — tokens in it get no color class. */
  defaultFg: string | null
}

interface LoadedState {
  highlighter: ShikiHighlighterLike
  /** The single theme, or the light half of a `themes` pair. */
  primary: ThemeSlot
  /** The dark half of a `themes` pair; `null` in single-theme mode. */
  dark: ThemeSlot | null
  /** Registered language ids + aliases, the guard against KNOWN_LANGUAGES drift. */
  loadedLanguages: ReadonlySet<string>
  /** `{ tokenizeTimeLimit }` when the option was given, else `{}` (shiki's default). */
  limit: { tokenizeTimeLimit?: number }
}

let loaded: LoadedState | null = null
let loadPromise: Promise<CodeHighlighter> | null = null

/**
 * @internal Test seam: drop the loaded shiki instance and the cached load so a
 * suite can exercise the pre-load facade and reload with different options.
 */
export function __resetShikiForTests(): void {
  loaded = null
  loadPromise = null
}

/** Append one theme's classes for a token: its color (unless default) and font styles. */
function pushThemeClasses(classes: string[], styles: ShikiTokenStyles | undefined, slot: ThemeSlot): void {
  const color = normalizeHexColor(styles?.color)
  if (color && color !== slot.defaultFg) classes.push(`${slot.prefix}${color.slice(1)}`)
  const fontStyle = styles?.fontStyle ?? 0
  for (const [bit, suffix] of FONT_STYLE_CLASSES) {
    if (fontStyle & bit) classes.push(`${slot.prefix}${suffix}`)
  }
}

/**
 * Render tokenized lines as escaped text in class-only spans. Both shiki
 * tokenizers split on newlines and their token contents concatenate back to
 * the input exactly, so joining with '\n' preserves the code verbatim
 * (matching the hljs `.value` contract highlightFenceCode depends on).
 */
function renderLines<T extends { content: string }>(
  lines: readonly (readonly T[])[],
  pushClasses: (classes: string[], token: T) => void,
): string {
  return lines
    .map((line) =>
      line
        .map((token) => {
          const classes: string[] = []
          pushClasses(classes, token)
          const text = escapeHtml(token.content)
          // Default-foreground tokens (plain text, whitespace) are emitted bare:
          // the interior stays lean and the host's code-block text color shows
          // through.
          return classes.length === 0 ? text : `<span class="${classes.join(' ')}">${text}</span>`
        })
        .join(''),
    )
    .join('\n')
}

function renderSingleTheme(state: LoadedState, code: string, language: string): string {
  const { primary } = state
  const lines = state.highlighter.codeToTokensBase(code, {
    lang: language,
    theme: primary.name,
    ...state.limit,
  })
  return renderLines(lines, (classes, token) => pushThemeClasses(classes, token, primary))
}

function renderThemePair(state: LoadedState, dark: ThemeSlot, code: string, language: string): string {
  // One pass over both themes: shiki merges the two token streams, splitting a
  // token wherever either theme changes style, so each span can carry both
  // themes' classes — the same markup serves light and dark.
  const { primary } = state
  const lines = state.highlighter.codeToTokensWithThemes(code, {
    lang: language,
    themes: { light: primary.name, dark: dark.name },
    ...state.limit,
  })
  return renderLines(lines, (classes, token) => {
    pushThemeClasses(classes, token.variants['light'], primary)
    pushThemeClasses(classes, token.variants['dark'], dark)
  })
}

/**
 * Shiki-backed {@link CodeHighlighter}. A stable facade over the async-loading
 * library: before {@link loadShiki} resolves it returns escaped plain text
 * (byte-identical to the core's no-backend fallback), after it highlights
 * synchronously against the loaded instance. Register it via
 * {@link installShiki}, or let {@link loadShiki} do so once loading completes.
 */
export const shikiHighlighter: CodeHighlighter = {
  highlight(code: string, language: string): string {
    const state = loaded
    // Not loaded yet (the async seam), or a drift between KNOWN_LANGUAGES and
    // the registered grammars: escaped plain text. Unlike hljs there is no
    // auto-detect rescue — shiki has none.
    if (!state || !state.loadedLanguages.has(language)) return escapeHtml(code)
    return state.dark
      ? renderThemePair(state, state.dark, code, language)
      : renderSingleTheme(state, code, language)
  },
  highlightAuto(code: string): string {
    // shiki has no language auto-detection, so an empty fence info string stays
    // escaped plain text (hljs guesses here — a documented behavioural mismatch).
    return escapeHtml(code)
  },
}

/**
 * Look `name` up in one of shiki's lazy maps and start its import. Own keys
 * only, so a name like `constructor` can't reach `Object.prototype`. An unknown
 * name rejects the whole load (as a missing module file did before the maps).
 */
function importFromMap(map: Record<string, ShikiLazyModule>, name: string, kind: string): Promise<unknown> {
  const load = Object.hasOwn(map, name) ? map[name] : undefined
  if (!load) {
    return Promise.reject(new Error(`@copse/streaming-markdown: unknown shiki ${kind} "${name}"`))
  }
  return load()
}

function themeName(theme: ShikiThemeInput): string {
  return typeof theme === 'string' ? theme : theme.name
}

async function createLoadedState(options?: ShikiOptions): Promise<LoadedState> {
  if (options?.theme !== undefined && options.themes !== undefined) {
    throw new TypeError('@copse/streaming-markdown: pass either `theme` or `themes` to loadShiki, not both')
  }
  const pair = options?.themes
  const primaryTheme = pair ? pair.light : (options?.theme ?? DEFAULT_THEME)
  const themes: readonly ShikiThemeInput[] = pair ? [pair.light, pair.dark] : [primaryTheme]
  const grammars = options?.langs ?? DEFAULT_GRAMMARS
  // The theme map is only needed for a bundled theme NAME; a host that passes
  // registration objects skips fetching it.
  const needsThemeMap = themes.some((theme) => typeof theme === 'string')
  const [coreModule, engineModule, langsModule, themesModule] = (await Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
    import('shiki/langs'),
    needsThemeMap ? import('shiki/themes') : null,
  ])) as unknown as [
    { createHighlighterCore(options: Record<string, unknown>): Promise<unknown> },
    { createJavaScriptRegexEngine(): unknown },
    { bundledLanguages: Record<string, ShikiLazyModule> },
    { bundledThemes: Record<string, ShikiLazyModule> } | null,
  ]
  const highlighter = (await coreModule.createHighlighterCore({
    themes: themes.map((theme) =>
      typeof theme === 'string' && themesModule
        ? importFromMap(themesModule.bundledThemes, theme, 'theme')
        : theme,
    ),
    langs: grammars.map((name) => importFromMap(langsModule.bundledLanguages, name, 'language')),
    // The JavaScript regex engine: no oniguruma WASM in the chunk, and all the
    // default grammars above are supported by it.
    engine: engineModule.createJavaScriptRegexEngine(),
  })) as ShikiHighlighterLike
  const slot = (theme: ShikiThemeInput, prefix: string): ThemeSlot => {
    const name = themeName(theme)
    return { name, prefix, defaultFg: normalizeHexColor(highlighter.getTheme(name).fg) }
  }
  return {
    highlighter,
    primary: slot(primaryTheme, LIGHT_PREFIX),
    dark: pair ? slot(pair.dark, DARK_PREFIX) : null,
    loadedLanguages: new Set(highlighter.getLoadedLanguages()),
    limit: options?.tokenizeTimeLimit === undefined ? {} : { tokenizeTimeLimit: options.tokenizeTimeLimit },
  }
}

/**
 * Lazy convenience: import shiki (core + engine + grammars + theme, each a
 * code-split chunk when reached via a dynamic `import('…/highlighters/shiki')`),
 * then register {@link shikiHighlighter}. The first call's options win; later
 * calls reuse the already-loaded instance (idempotent registration, mirroring
 * `loadHighlightjs`). Rejects when the optional `shiki` peer isn't installed.
 */
export function loadShiki(options?: ShikiOptions): Promise<CodeHighlighter> {
  loadPromise ??= createLoadedState(options).then((state) => {
    loaded = state
    return shikiHighlighter
  })
  return loadPromise
}

/**
 * Return the shiki {@link CodeHighlighter} synchronously and start loading the
 * library in the background. Pass the result via `MarkdownConfig.codeHighlighter`:
 * fences render as escaped plain text (with the stable core-resolved `hljs lang-*`
 * class) until the load completes, and a re-render then upgrades them in place.
 * `await loadShiki()` instead to observe load completion or failure — this
 * fire-and-forget form surfaces a missing peer as an unhandled rejection, the
 * async analogue of a failing static `highlight.js` import.
 */
export function installShiki(options?: ShikiOptions): CodeHighlighter {
  void loadShiki(options)
  return shikiHighlighter
}

/** Options for {@link shikiThemeCss}. Only meaningful with a `themes` pair. */
export interface ShikiThemeCssOptions {
  /**
   * A selector for an ANCESTOR that switches code to the dark theme — e.g.
   * `'[data-theme="dark"]'` or `'.dark'`. When set, the dark rules apply under
   * it and the light rules everywhere else, regardless of the OS preference.
   * When omitted, the two halves are scoped by `prefers-color-scheme`.
   */
  darkSelector?: string
}

/** A `[class name, declaration]` pair, scoped by the caller. */
type ThemeRule = readonly [className: string, declaration: string]

/** One theme's palette and font-style rules, unscoped. */
function themeRules(state: LoadedState, slot: ThemeSlot): ThemeRule[] {
  const colors = new Set<string>()
  for (const setting of state.highlighter.getTheme(slot.name).settings ?? []) {
    const color = normalizeHexColor(setting.settings?.foreground)
    if (color && color !== slot.defaultFg) colors.add(color)
  }
  const rules = [...colors]
    .sort()
    .map((color): ThemeRule => [`${slot.prefix}${color.slice(1)}`, `color: ${color}`])
  for (const [, suffix, declaration] of FONT_STYLE_CLASSES) {
    rules.push([`${slot.prefix}${suffix}`, declaration])
  }
  return rules
}

/**
 * The stylesheet for the loaded theme(s): one `color` rule per palette
 * foreground (`.shiki-<hex>`) plus the four font-style classes. Inject it once,
 * any way your app ships CSS — it is host-injected style, not sanitized
 * markdown, so it never passes through the sink sanitizer. Returns `''` until
 * {@link loadShiki} has resolved (the theme palette isn't known before then).
 * Tokens in a theme's default foreground get no color class, so the code
 * block's base text color stays under the host stylesheet's control.
 *
 * With a `themes` pair the light rules (`.shiki-<hex>`, `.shiki-italic`, …) and
 * the dark rules (`.shiki-dark-<hex>`, `.shiki-dark-italic`, …) are each scoped
 * so exactly one set applies: by `@media (prefers-color-scheme: …)` by default,
 * or — with `darkSelector` — dark under a matching ancestor and light
 * elsewhere. Every rule keeps the single-theme specificity of one class
 * (`:where()` adds none), so host overrides work the same in both modes.
 */
export function shikiThemeCss(options?: ShikiThemeCssOptions): string {
  const state = loaded
  if (!state) return ''
  const light = themeRules(state, state.primary)
  if (!state.dark) {
    return `${light.map(([cls, decl]) => `.${cls} { ${decl} }`).join('\n')}\n`
  }
  const dark = themeRules(state, state.dark)
  const darkSelector = options?.darkSelector
  if (darkSelector) {
    // `:is()` keeps a selector LIST (`.dark, [data-theme=dark]`) intact inside
    // the descendant combinator; the outer `:where()` zeroes its specificity.
    const lightRules = light.map(([cls, decl]) => `.${cls}:where(:not(:is(${darkSelector}) *)) { ${decl} }`)
    const darkRules = dark.map(([cls, decl]) => `:where(${darkSelector}) .${cls} { ${decl} }`)
    return `${[...lightRules, ...darkRules].join('\n')}\n`
  }
  const block = (scheme: string, rules: readonly ThemeRule[]): string =>
    `@media (prefers-color-scheme: ${scheme}) {\n${rules.map(([cls, decl]) => `  .${cls} { ${decl} }`).join('\n')}\n}`
  return `${block('light', light)}\n${block('dark', dark)}\n`
}
