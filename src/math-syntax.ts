// The math prose-syntax gate (#78). Recognizing `$…$` / `$$…$$` / `\(…\)` /
// `\[…\]` in ordinary prose is a real grammar change — `set $PATH$ properly`
// has plausible non-math readings — so it must not be always-on: the package's
// invariant is that output is byte-identical until a host opts in. The gate is
// therefore explicit: `MarkdownConfig.mathSyntax: true` turns prose math ON (the
// `math_block` construct, the inline pass, and their streaming holds); omitted or
// `false` keeps the pre-math grammar. A host that wants KaTeX for ```math fences
// but no prose delimiters simply leaves `mathSyntax` off (the fence is always on).
//
// The ```math FENCE handler is deliberately NOT gated: like mermaid, an
// explicitly labeled fence is unambiguous author intent, and fences are opaque
// to the tokenizer so its scaffolding changes emission only.
//
// This module is a dependency-free leaf so the block tokenizer, the inline
// pipeline, and the hold walker can all read the flag without import cycles.

let syntaxOverride: boolean | null = null

/**
 * @internal Writer behind `MarkdownConfig.mathSyntax`. Forces math prose syntax
 * on (`true`), off (`false`), or off-by-default (`null`). Not part of the public
 * API — hosts pass `{ mathSyntax }` to a render entry point, which scopes this
 * slot via `withConfig`; this exists so that scoping has something to write.
 */
export function setMathSyntax(enabled: boolean | null): void {
  syntaxOverride = enabled
}

/** The current explicit override (`null` when math prose syntax is off). */
export function getMathSyntax(): boolean | null {
  return syntaxOverride
}

/** Whether `$…$`-style prose math is currently recognized (see module note). */
export function isMathSyntaxEnabled(): boolean {
  return syntaxOverride ?? false
}
