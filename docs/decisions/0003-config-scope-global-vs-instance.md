# 0003 — Configuration scope: global backends, per-render policies

Status: proposed · Relates to [#137](https://github.com/copse-dev/streaming-markdown/issues/137)

Design note for the v1 configuration model. The renderer today exposes ~22
process-wide `set*` singletons. Two consumers in one process (two chat panes
with different link policies, an SSR server rendering for multiple tenants, or
just two test suites) cannot hold different configuration, and the
security-relevant knobs leak across renders. This note picks the model v1 should
commit to — because the shape of the config API is one of the few things a 1.0
freezes that is expensive to revise later. Read alongside the singleton
rationale in [html-policy.ts](../../src/html-policy.ts) and the sink model in
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

## Recommendation: C

Generalize the existing `htmlPolicy` seam. Today (renderer.ts:82-90) the entry
point resolves an optional `options.htmlPolicy`, saves the previous slot value,
sets it, renders in a `try`, and restores in `finally`; the deep call stack keeps
reading the global getter and needs no new parameter. Extend this to one
`withRenderPolicies(options, fn)` helper that saves/sets/restores every policy
slot the caller overrode, wrapped around the three entry points:

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
pass must stay **synchronous and non-reentrant**. It is today. Async hydration
(`hydratePendingMath`, `hydratePendingDiagrams`) runs *after* the scoped block and
reads only the global *backend* tier, so it is unaffected. A future async inline
pass would break the guarantee — so the scoped wrapper should assert depth-1
non-reentrancy in dev.

This also resolves the mid-stream config-flip hazard (#145): an instance that
pins its policies is immune to a global `set*` flipped after construction; an
instance that relies on the global default is covered by the config-epoch
invalidation that #145 adds. The two fixes compose.

## Security argument

The five trust-boundary slots — `setSanitizerBackend`, `setSanitizeExtension`,
`setSafeHrefSchemes`, `setLinkImagePolicy`, `setTrustedTypesPolicy` — are handled
deliberately:

- `setSanitizerBackend` stays **global**. Two tenants sharing one backend both get
  the same allowlist enforcement; sharing is safe, and the backend loads a heavy
  dependency you want once. What differs per tenant is not the backend but the
  *allowlist extension* and *origin policy* layered on top —
- `setSanitizeExtension`, `setLinkImagePolicy`, `setSafeHrefSchemes`,
  `setTrustedTypesPolicy` move to the **per-render** tier. These are precisely the
  knobs a multi-tenant host must vary, and under C each render is gated by its own
  values with no bleed. Crucially, the origin policy and scheme allowlist become
  *impossible to leak across tenants by construction*, rather than relying on the
  host to remember a manual save/restore.

The sink remains the sole arbiter and its allowlist is not widened; C changes
*who can scope* a policy, not what the policy can permit.

## Back-compat & migration

C is **additive, not breaking**. The global `set*` keep working and keep their
meaning (they move the default); every new option is optional and inherits the
global when omitted, exactly as `htmlPolicy` does. So although v1 is the right
moment to establish the config *shape*, none of this forces a breaking change at
1.0 or later — the per-render overrides can even land incrementally behind the
same options bag.

Suggested phasing:

1. **Security tier first** — thread `sanitizeExtension`, `linkImagePolicy`,
   `safeHrefSchemes`, `trustedTypesPolicy` as per-render options via
   `withRenderPolicies`. This closes the multi-tenant security footgun before
   hosts adopt the global-only pattern, and is the highest-value slice.
2. **Behavioral tier** — `mathSyntax`, `linkDecorator`, `rawImageRenderer`,
   `emailAutolinks`, CJK boundaries.
3. **Ergonomics** — a `reset*` (or a single `resetConfig()`) for every slot to
   de-fragilize tests, and document the backend tier as explicitly
   install-once/process-wide so the split is legible.

`setInlinePasses` and `setFenceHandler` are the ambiguous middle — a registry
(backend-like) that also carries per-consumer behavior. Default them to the
backend tier (global) for v1; promote to per-render only if a concrete
multi-tenant need appears, since that stays additive.

## Open question for the decision

C is the recommendation. The decision to confirm is whether v1 ships **phase 1
(the security tier) at minimum** — the position of this note — versus deferring
all of it as a documented post-1.0 additive follow-up (acceptable only because C
is non-breaking), versus committing to the fuller instance/context model of
option B despite its cost. Everything downstream (which options to add, the
`withRenderPolicies` helper, the reset surface) follows from that call.
