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

import { activeConfig } from './config.ts'

/**
 * The current render's explicit `mathSyntax` config (`null`/absent when off).
 *
 * @experimental Introspection getter that reads the ambient render config; outside
 * a render it returns the defaults. Not part of the stable v1 surface (#147) —
 * scope behaviour via `MarkdownConfig.mathSyntax` instead. May move behind a
 * subpath or be removed in a minor release.
 */
export function getMathSyntax(): boolean | null {
  return activeConfig().mathSyntax ?? null
}

/** Whether `$…$`-style prose math is recognized for the current render. */
export function isMathSyntaxEnabled(): boolean {
  return activeConfig().mathSyntax ?? false
}
