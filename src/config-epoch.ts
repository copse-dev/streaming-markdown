/**
 * Global config-epoch counter (#145).
 *
 * The stateful streaming renderer caches work across `update()` calls: the
 * incremental tokenizer validates its token cache by byte-prefix only
 * (`incremental-scan.ts`), and the frozen-tail renderer guards frozen DOM by
 * `frozenSource` bytes (`streaming-frozen-tail.ts`). But **tokenization** depends
 * on `isMathSyntaxEnabled()` and **rendering** depends on `getHtmlPolicy()`,
 * decorators, fence/code/diagram/math handlers, the sanitizer backend, and the
 * other process-wide config slots. Flipping any of those mid-stream (between
 * `update()` calls) leaves frozen nodes and cached tokens permanently divergent
 * from a fresh render — a fail-*unsafe* cache poisoning.
 *
 * The docs say "set config once, before the first render", but nothing enforced
 * it. This counter makes it fail *safe*: every config setter bumps the epoch, and
 * `StreamingMarkdownRenderer.update()` drops its caches and re-renders the whole
 * committed prefix when the epoch it last rendered under no longer matches. Worst
 * case is one redundant full re-render (byte-identical to a fresh render) — never
 * stale output.
 *
 * It is deliberately global (matching the config it tracks). Under a future
 * fully instance/per-render config model (#137) no setter fires mid-stream, so
 * the epoch never advances and this becomes a no-op — forward-compatible.
 */
let epoch = 0

/** Advance the config epoch. Called by every process-wide config setter. */
export function bumpConfigEpoch(): void {
  epoch++
}

/** The current config epoch. Captured by the stateful renderer to detect flips. */
export function configEpoch(): number {
  return epoch
}

/**
 * Force the epoch back to a snapshot. **Only** for the synchronous per-render
 * policy seam (`withRenderPolicies`): scoping a security policy for one render
 * calls the same bumping setters to apply and restore the override, which is a
 * net-zero config change and must not read as a real mid-stream flip. Wrapping
 * that seam with `configEpoch()` at entry and `restoreConfigEpoch(snapshot)` after
 * cancels those transient bumps. Safe because the render + sink pass is
 * synchronous (see render-policies.ts) — no real setter runs concurrently.
 */
export function restoreConfigEpoch(snapshot: number): void {
  epoch = snapshot
}
