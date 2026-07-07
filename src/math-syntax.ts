// The math prose-syntax gate (#78). Recognizing `$…$` / `$$…$$` / `\(…\)` /
// `\[…\]` in ordinary prose is a real grammar change — `set $PATH$ properly`
// has plausible non-math readings — so it must not be always-on: the package's
// invariant is that output is byte-identical until a host registers something.
// The gate therefore follows the math-renderer registry: `setMathRenderer`
// with a backend turns prose math ON (the `math_block` construct, the inline
// pass, and their streaming holds); `setMathRenderer(null)` restores the
// pre-math grammar. `setMathSyntax` is the explicit override for the two
// exceptions — scaffolding-only hosts that hydrate elsewhere (`true`), and
// hosts that want KaTeX for ```math fences but no prose delimiters (`false`).
//
// The ```math FENCE handler is deliberately NOT gated: like mermaid, an
// explicitly labeled fence is unambiguous author intent, and fences are opaque
// to the tokenizer so its scaffolding changes emission only.
//
// This module is a dependency-free leaf so the block tokenizer, the inline
// pipeline, and the hold walker can all read the flag without import cycles.

let syntaxOverride: boolean | null = null
let rendererRegistered = false

/**
 * Force math prose syntax on (`true`), off (`false`), or defer to math-renderer
 * registration (`null`, the default). Set it once, before the first render — the
 * flag is read by the shared tokenizer/pipeline, so a mid-stream flip only
 * affects regions (re)rendered afterwards; recreate the streaming renderer (or
 * re-render at rest) for a clean switch.
 */
export function setMathSyntax(enabled: boolean | null): void {
  syntaxOverride = enabled
}

/** The current explicit override (`null` when deferring to renderer registration). */
export function getMathSyntax(): boolean | null {
  return syntaxOverride
}

/**
 * @internal Wired by `setMathRenderer` (math.ts): with no explicit override,
 * registering a backend is what activates the prose syntax — so `loadKatex()` /
 * `installKatex()` remain the one-call story for chat hosts.
 */
export function setMathSyntaxRendererRegistered(registered: boolean): void {
  rendererRegistered = registered
}

/** Whether `$…$`-style prose math is currently recognized (see module note). */
export function isMathSyntaxEnabled(): boolean {
  return syntaxOverride ?? rendererRegistered
}
