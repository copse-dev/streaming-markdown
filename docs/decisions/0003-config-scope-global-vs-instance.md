# 0003 — Configuration scope: global backends, per-render policies

Status: accepted, then superseded in part · Relates to [#137](https://github.com/copse-dev/streaming-markdown/issues/137)

> **Superseded / updated 2026-07-11.** This ADR chose Option C — per-render
> *policy* overrides layered **additively on top of** the process-wide `set*`
> singletons, which stayed as "default movers". That additive layer proved to be
> the wrong end state: keeping ~22 mutable global slots *and* a per-render
> override path meant two sources of truth, the exact multi-tenant/leak hazards
> below in a subtler form, and a larger 1.0 surface. **The `set*` setters have now
> been removed entirely.** A single injected `MarkdownConfig` object is the whole
> configuration mechanism: pass it as the 2nd argument to `renderMarkdown` /
> `renderMarkdownUnsafe` / `renderStreamingMarkdown`, or capture it on
> `new StreamingMarkdownRenderer(host, config)` (applied around every `update()`).
> The synchronous **save-set-restore** seam this ADR designed is retained, but
> simplified past what the ADR imagined: rather than N per-module slots each moved
> and restored, the entire config is **one ambient object**. `withConfig`
> (`config.ts`) swaps that single object for the render and restores it (merging
> over the parent so nested renders inherit); every read site reads its setting
> through `activeConfig()`. The old per-module `set*`/`get*` writers and the
> `withRenderPolicies` helper (`render-policies.ts`) are deleted outright.
>
> This ADR's split of the 22 slots into "per-render policies" and "install-once
> backends" proved prescient in **both** directions:
>
> - The async backends — `mathRenderer` / `diagramRenderer`, read *after* the
>   synchronous render during hydration — genuinely cannot ride a synchronous
>   scope, exactly as argued. They are **not** in the `withConfig` scope; they flow
>   through `hydrate()` / the `hydratePending*` `renderer` option.
> - The "install-once" insight is realized as **`setDefaultConfig(config)`**: a
>   single process-wide default a Node/SSR host or a test harness sets once (its
>   `sanitizerBackend`, a `codeHighlighter`) that every per-render `MarkdownConfig`
>   overrides. It is the *only* remaining mutable-global entry point, and it sets
>   defaults for the one ambient object rather than reintroducing per-knob setters.
>
> Everything else read during the synchronous render — `sanitizeExtension`,
> `fenceHandlers`, `inlinePasses`, `entityDecoder`, `mathSyntax`, and the whole
> policy tier — is a plain `MarkdownConfig` field, no setter.
>
> The analysis below is preserved as the historical record; read "the global
> `set*` remain as default movers" as the intermediate step that the setter
> removal replaced.

Design note for the v1 configuration model. At the time of writing the renderer
exposed ~22 process-wide `set*` singletons. Two consumers in one process (two chat
panes with different link policies, an SSR server rendering for multiple tenants,
or just two test suites) cannot hold different configuration, and the
security-relevant knobs leak across renders. This note picks the model v1 should
commit to — because the shape of the config API is one of the few things a 1.0
freezes that is expensive to revise later. Read alongside the sink model in
[ARCHITECTURE.md](../ARCHITECTURE.md).

## Motivation

Every configuration point is a module-level `let` slot mutated by an exported
`set*` and read by a getter (`setSafeHrefSchemes`, `setSanitizerBackend`,
`setLinkDecorator`, `setMathSyntax`, `setInlinePasses`, …). Exactly **one**,
`htmlPolicy`, can be overridden per call; the rest are process-wide with no
threading. Three concrete problems follow:

- **No multi-tenant isolation.** Two `StreamingMarkdownRenderer` instances on one
  page share every slot. A host that wants pane A to allow `mailto:` links and
  pane B not, or tenant A to widen the sanitizer allowlist for its own artifact
  `<img>` and tenant B not, has no way to express it — the last `set*` wins
  process-wide.
- **Security knobs leak.** The five slots that *are* the trust boundary —
  `setSanitizerBackend`, `setSanitizeExtension`, `setSafeHrefSchemes`,
  `setLinkImagePolicy`, `setTrustedTypesPolicy` — are exactly the ones where a
  cross-render bleed is a security bug rather than a cosmetic one, and four of
  the five have no reset function, so a host must save and restore the previous
  value by hand around every render.
- **Fragile test isolation.** Suites lean on `afterEach(() => setX(null))`; a
  forgotten teardown or a throw before it leaks state into later suites. The same
  fragility a multi-tenant host would hit.

Post-1.0 this cannot be papered over silently: hosts build integrations against
whatever config shape v1 blesses.

## What is actually being conflated

The 22 slots are not one kind of thing. They split cleanly:

- **Backends / registries — heavy, shared, install-once.** `setSanitizerBackend`,
  `setCodeHighlighter`, `setDiagramRenderer`, `setMathRenderer`,
  `setEntityDecoder` / `setNamedEntities`, `setFenceHandler`. These register a
  loaded dependency (KaTeX, DOMPurify, highlight.js, mermaid) or a decode table.
  You load KaTeX **once per page**; a per-instance copy is wasteful and
  surprising. These are genuinely process-global infrastructure, and sharing them
  across tenants is correct — two tenants sharing one sanitizer backend both get
  the same allowlist enforcement.
- **Policies — cheap, per-consumer behavior.** `htmlPolicy`, `mathSyntax`,
  `linkDecorator`, `rawImageRenderer`, `safeHrefSchemes`, `sanitizeExtension`,
  `linkImagePolicy`, `trustedTypesPolicy`, `emailAutolinks`, and the CJK boundary
  pair (`bareUrlCjkBoundary`, `flankingPunctuationExclusion`). These are decisions
  that legitimately differ between two consumers in one process — and every
  security-relevant knob lives here.

The bug is treating both tiers the same. The fix is to make the *policy* tier
per-render while leaving the *backend* tier global.

## Options

**A. Keep everything global (status quo).** Zero churn, but leaves the
multi-tenant and security-bleed problems unsolved and bakes them into the v1
contract. Rejected.

**B. Thread a config/context object through the pipeline.** A `RendererContext`
passed to `renderMarkdown`/`update` and down through the tokenizer and inline
passes, replacing every getter with a field read. Maximally explicit and truly
reentrant. But the policy values are read **deep in per-character / per-delimiter
loops** — `isMathSyntaxEnabled` in the block tokenizer and the inline-math hold
walker, `getHtmlPolicy` over every inline text node, `safeLinkHref` per link, the
CJK predicates per delimiter. Threading a context through every one of those
signatures is a ~40-file change across the hottest paths, with real perf
exposure, for a reentrancy guarantee that a synchronous renderer does not need.
Disproportionate for v1.

**C. Global backends + per-render policy overrides via scoped-override
(recommended).** Keep the backend/registry tier global. Make the policy tier
overridable per render through the options object, applied with the
**save-set-restore** pattern `htmlPolicy` already uses — generalized to one
helper covering all policy slots. The global `set*` remain, now as *default
movers*; an override on `renderMarkdown(md, {...})` or
`new StreamingMarkdownRenderer(el, {...})` wins for that render/instance.

> *Final state (2026-07-11):* the additive "global `set*` remain as default
> movers" half of C did not survive — the setters were removed outright, so the
> injected options object is the *only* mover, and the scoped wrapper was widened
> from the four security slots to the whole synchronous config tier (see the note
> at the top). The synchronous save-set-restore mechanism C designed is exactly
> what shipped.

## Recommendation: C

Generalize the existing `htmlPolicy` seam. Today (renderer.ts:82-90) the entry
point resolves an optional `options.htmlPolicy`, saves the previous slot value,
sets it, renders in a `try`, and restores in `finally`; the deep call stack keeps
reading the global getter and needs no new parameter. Extend this to one
`withRenderPolicies(options, fn)` helper (shipped, then generalized and renamed
to `withConfig` in `config.ts` once the setters were removed and it had to cover
the full config tier) that saves/sets/restores every config slot the caller
overrode, wrapped around the three entry points:

- `renderMarkdown` / `renderMarkdownUnsafe` (renderer.ts),
- `renderStreamingMarkdown` (streaming.ts),
- `StreamingMarkdownRenderer.update` (streaming.ts) — the instance captures its
  overrides in the constructor (as it already does for `htmlPolicy`) and applies
  them on every `update()`.

Add the policy fields to `RenderMarkdownOptions` and `StreamingMarkdownOptions`
(both already carry `htmlPolicy`, so this is the same shape). The sink-time
policies (`sanitizeExtension`, `linkImagePolicy`, `trustedTypesPolicy`) are read
at a single shallow site — the sanitize/bless step inside the same synchronous
entry-point call — so the same scoped wrapper covers them without threading a
parameter to the sink.

**Why C over B.** The scoped-override gives real per-instance isolation:
rendering is synchronous and non-reentrant, so during instance A's `update()` the
global slot holds A's policy for the whole render and is restored before control
returns; instance B never observes it. That is exactly the isolation multi-tenant
needs, at the cost of one `try/finally` per entry point instead of a
pipeline-wide rewrite. B's only extra guarantee — safety under a render that
`await`s mid-pass — is not a property the renderer has or needs.

**The invariant this rests on** (state it, test it): the string-render + sink
pass must stay **synchronous** — no `await` between setting an override and
restoring it. It is today. *Nested* synchronous renders are fine and expected (a
fence handler or inline pass recursively calling `renderMarkdown`): each level
saves and restores its own previous value, so the stack composes — a nested scope
restores to the enclosing scope's value, not the global default (covered by
`render-policies.test.ts`). What would break the guarantee is an async render that
suspends mid-pass; async hydration (`hydratePendingMath`,
`hydratePendingDiagrams`) is safe because it runs *after* the scoped block. **This
is the reasoning that decided the final async split:** the `mathRenderer` and
`diagramRenderer` backends do their work inside that post-render async hydration,
so a synchronous save-set-restore block cannot scope them — there is no
synchronous window that contains their execution. That is why, in the shipped
API, those two backends are **not** `withConfig` fields but flow through
`hydrate()` / the `hydratePending*` `renderer` option, while every backend and
policy read *during* the synchronous render (`sanitizerBackend`, `codeHighlighter`,
`entityDecoder`, `fenceHandlers`, `inlinePasses`, and the policy tier) is scoped
by `withConfig`.

This also resolved the mid-stream config-flip hazard (#145): an instance pins its
config at construction and re-applies it around every `update()`, so there is no
mutable global left to flip after construction — the setter removal closes the
hazard outright.

## Security argument

The five trust-boundary slots — `sanitizerBackend`, `sanitizeExtension`,
`safeHrefSchemes`, `linkImagePolicy`, `trustedTypesPolicy` — are handled
deliberately:

- `sanitizerBackend` — this ADR originally kept it **global** (two tenants sharing
  one backend both get the same allowlist enforcement, and the backend loads a
  heavy dependency you want once). In the final state it is a per-render
  `MarkdownConfig` field like the rest, because it is read *synchronously* during
  the render and so is fully covered by the `withConfig` save-set-restore — sharing
  is still the common case (omit the field and every render uses the same default
  backend), but a multi-tenant host can now vary it per render with no bleed.
- `sanitizeExtension`, `linkImagePolicy`, `safeHrefSchemes`, `trustedTypesPolicy`
  are the **per-render** trust knobs a multi-tenant host must vary, and each render
  is gated by its own values with no bleed. Crucially, the origin policy and scheme
  allowlist are *impossible to leak across tenants by construction*, rather than
  relying on the host to remember a manual save/restore.

The sink remains the sole arbiter and its allowlist is not widened; the config
model changes *who can scope* a policy, not what the policy can permit.

## Back-compat & migration

C was designed as **additive, not breaking**, and shipped that way first: the
per-render overrides landed behind the same options bag while the global `set*`
kept working as default movers.

The phasing it followed, and where it ended up:

1. **Security tier first** — `sanitizeExtension`, `linkImagePolicy`,
   `safeHrefSchemes`, `trustedTypesPolicy` as per-render options via
   `withRenderPolicies`. This closed the multi-tenant security footgun first.
2. **Behavioral tier** — `mathSyntax`, `linkDecorator`, `rawImageRenderer`,
   `emailAutolinks`, CJK boundaries.
3. **Full config tier + setter removal (2026-07-11, the breaking step).** With
   every slot expressible per render, keeping the mutable `set*` globals in
   parallel was pure liability — two sources of truth for the same value. They
   were removed; `withRenderPolicies` was generalized to `withConfig` covering the
   whole synchronous tier; `fenceHandlers`, `inlinePasses`, `codeHighlighter`,
   `sanitizerBackend`, and `entityDecoder` / `namedEntities` — the "ambiguous
   middle" registries this ADR was unsure whether to promote — all became
   `MarkdownConfig` fields too. `mathRenderer` / `diagramRenderer` stayed out of
   the sync scope (they run in async hydration; see the Security argument) and
   flow via `hydrate()` / `hydratePending*` options. No `reset*` ergonomics were
   needed — with no global to reset, test isolation is free.

This last step is a **breaking change** (hosts on the `set*` API migrate to the
config object — see the mapping in the top note and [`EXTENDING.md`](../EXTENDING.md)),
which is why it was taken deliberately rather than left as an open-ended additive
layer.

## Decision

C's **synchronous save-set-restore mechanism** is adopted and is what shipped —
first as `withRenderPolicies` over the security tier, then generalized to
`withConfig` over the whole synchronous config tier. Its *additive* half (keeping
the `set*` globals as default movers) was **not** kept: once every slot was
expressible per render, the setters were removed and the injected `MarkdownConfig`
object became the single configuration mechanism (2026-07-11). The only slots that
remain outside the per-render scope are the genuinely async `mathRenderer` /
`diagramRenderer`, which run in post-render hydration and flow via `hydrate()` /
`hydratePending*` options. Option B (the fuller instance/context model) is not
pursued: its pipeline-wide threading of the hot inline paths is disproportionate
to the reentrancy guarantee a synchronous renderer needs — the config captured on
the instance and re-applied around each `update()` gives the same isolation.
