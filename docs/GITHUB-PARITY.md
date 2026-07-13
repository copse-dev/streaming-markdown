# GitHub / GFM parity: known intentional divergences

A single durable record of the places where this renderer **intentionally**
renders differently from github.com, validated against GitHub's actual
comment-rendered HTML. These are decisions, not bugs — this page exists so they
aren't re-investigated or "fixed" into regressions (see the doc-drift problem
in #114). Closes the tracking issue #219.

## Divergences (intentional — no action planned)

| Construct | GitHub | smd | Why smd differs |
|---|---|---|---|
| **Multi-delimiter emphasis** (`****foo****`, `foo******bar***baz`) | merged (`<strong>foo</strong>`) | nested (`<strong><strong>foo</strong></strong>`) | GitHub/GFM is frozen at CommonMark **0.29**; smd tracks current CommonMark **0.31**. Visually + semantically identical; only redundant tags differ. Documented in #208. |
| **Single-tilde strikethrough** (`~one~`) | struck (`<del>`) | left literal | Deliberate (#613) — a lone `~` (`20~25`, arithmetic) is never a marker, avoiding false-positive strikes. GitHub accepts one-or-two tildes; smd requires `~~`. |
| **Angle autolink, non-allowlisted scheme** (`<irc://…>`) | brackets stripped → plain text (not a live link) | left literal `&lt;irc://…&gt;` (not a live link) | Scheme **allow-list**, fail-closed (#139). Same security outcome — neither produces a live `irc:` link; only cosmetic (brackets). |
| **Raw HTML blocks / inline** (`<div>`, `<script>`) | escaped via the GFM tagfilter | passed through and sanitized at the sink | Both end up inert; the architectures differ. smd's sink sanitizer is the single trust boundary (see [SECURITY.md](SECURITY.md) and [decision 0002](decisions/0002-raw-html-passthrough-default.md)); `htmlPolicy: 'escape'` / `'escape-all'` restore literalization per render. |

## Parity available via configuration

These render differently from GitHub by default but reach parity (or better)
when the host opts in:

- **Inline/display math** (`$…$`, `$$…$$`) — `MarkdownConfig.mathSyntax` plus
  the KaTeX backend (GitHub renders math in some surfaces only).
- **Emoji shortcodes** (`:tada:`) — the
  `@copse/streaming-markdown/inline/emoji` inline pass.
- **`<details>` collapsibles** — raw HTML passthrough renders them live by
  default.
- **External-link `rel`/`target` attributes** — GitHub adds
  `rel="nofollow noreferrer noopener" target="_blank"`; smd's neutral default
  emits bare `<a href>`. Opt in per render via `MarkdownConfig.linkDecorator` —
  see the recipe in [RECIPES.md](RECIPES.md#external-link-rel--target-attributes)
  (decision recorded in #218).

## Tracked separately (not by-design divergences)

- Footnote id namespacing / accessibility parity — fixed in #221.
- Task-list checkbox conformance — baselines corrected in #209/#223.

## Method

Each row was produced by a validation pass comparing smd output against
GitHub's actual comment-rendered HTML for the same source, not against the
spec text alone. When adding a row, link the issue/PR where the divergence was
decided so the rationale stays discoverable.
