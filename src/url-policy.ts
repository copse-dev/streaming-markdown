import { activeConfig } from './config.ts'

// PROTOTYPE (#url-policy): one host-controlled gate every URL the renderer is
// about to emit passes through — modelled on the `TrustedURL` type Trusted Types
// dropped in w3c/trusted-types#65.
//
// TrustedURL died for two reasons: enforcing it across the platform's unbounded
// URL sink surface broke too much ("linking to other content is common in the
// web"), and the residual non-XSS risks — off-site navigation, third-party
// subresource loads, stylesheet-based exfiltration — were delegated to CSP's
// `*-src` directives. Neither objection transfers to a markdown renderer:
//
//   - the sink surface here is small and enumerable, because this package emits
//     it. Every URL-bearing position routes through `applyUrlPolicy`, so
//     "the policy sees every URL" is a property the package can actually hold.
//   - a library cannot set the host's CSP, so the delegation target does not
//     exist at this layer. That is exactly why mermaid's post-sink SVG can
//     exfiltrate today (`<img>` inside `<foreignObject>`, `url()` in an injected
//     `<style>`) with an origin policy installed and no effect.
//
// The synthesis the issue points at: the platform concluded it should simply
// hard-block `javascript:` after parsing, rather than ask developers to sanitize
// every `href`. So that stays the FLOOR here — the scheme allowlist
// (`safeLinkHref` / `isAllowedHref`) runs first and a host policy cannot lift it.
// Everything *above* the floor is the developer's, which is what TrustedURL
// offered and what this package has no way to express today.
//
// Off by default: with no policy installed every call is one null check and
// returns the URL unchanged, so output stays byte-identical (the package
// invariant).

/**
 * What the URL is about to be used for. The distinction TrustedURL lacked, and
 * a large part of why it was unusable: a cross-origin destination is ordinary
 * for a link the reader chooses to follow, and an unattended exfiltration
 * channel for a subresource the browser fetches on its own.
 */
export type UrlSink =
  /** A destination the reader must act on: `<a href>`, SVG `<a xlink:href>`. */
  | 'navigation'
  /** Fetched automatically on render: `<img src>`, SVG `<image href>`, `<use>`. */
  | 'image'
  /** A `url()` inside a `<style>` element or a `style` attribute — also automatic. */
  | 'style'

/** Which tier of markup the URL came from. */
export type UrlSource =
  /** The markdown renderer's own output, or raw HTML passed through it. */
  | 'markdown'
  /** Diagram-backend output injected after the sink (mermaid SVG). */
  | 'diagram'
  /** Math-backend output injected after the sink (KaTeX HTML). */
  | 'math'

/** One URL presented to {@link UrlPolicy.createURL} for a decision. */
export interface UrlRequest {
  /** The destination exactly as it appears in the markup, before any rewriting. */
  raw: string
  /**
   * `raw` resolved and canonicalized by the WHATWG URL parser, with any embedded
   * credentials stripped — the string the browser would actually act on — or
   * `null` when it does not resolve to a URL at all.
   *
   * Compare against THIS, not against {@link raw}. Prefix-matching a raw string
   * is where origin allowlists get bypassed: `https://good.com@evil.com` starts
   * with `https://good.com` but navigates to evil.com, and case-folding, `\` for
   * `/`, scheme-relative `//host`, and unicode host confusables all read as
   * something they are not. The parser folds every one of those.
   */
  url: URL | null
  /** What the URL will be used for — see {@link UrlSink}. */
  sink: UrlSink
  /** Which tier of markup produced it — see {@link UrlSource}. */
  source: UrlSource
  /** Lowercased tag name the URL lands on, when known (`a`, `img`, `image`, `use`). */
  element?: string
  /** Attribute name it lands on, when known (`href`, `xlink:href`, `src`). */
  attribute?: string
}

/**
 * Host policy consulted for every URL this package emits. Supply per render via
 * `MarkdownConfig.urlPolicy`; `null` (the default) disables it entirely and
 * every URL is emitted unchanged.
 *
 * `createURL` returns the URL to use — which need not be the one it was given —
 * or `null` to block it. Returning a value rather than a boolean is the point of
 * the TrustedURL shape: a host can proxy a subresource through its own fetcher,
 * or keep the origin and drop the query, which is where an exfiltrated payload
 * almost always rides.
 *
 * ```ts
 * renderMarkdown(md, {
 *   urlPolicy: {
 *     baseOrigin: 'https://app.example.com',
 *     createURL: ({ url, sink }) =>
 *       sink === 'navigation'
 *         ? (url?.href ?? null)                                    // links: anywhere
 *         : url?.origin === 'https://app.example.com' ? url.href : null, // fetches: same-origin
 *   },
 * })
 * ```
 *
 * **Synchronous.** The render pass is synchronous, so `createURL` cannot await a
 * remote allowlist. Resolve that data before rendering.
 *
 * **Not a scheme gate.** `javascript:`/`data:`/`vbscript:` are rejected by the
 * scheme allowlist before a policy ever sees them, and a policy cannot admit
 * them by returning them — keep scheme decisions in `safeHrefSchemes`.
 */
export interface UrlPolicy {
  createURL(request: UrlRequest): string | null
  /**
   * Absolute origin (e.g. `https://app.example.com`) that relative destinations
   * are resolved against to produce {@link UrlRequest.url}. Defaults to the
   * document's base URI in a DOM, and when neither is available a relative
   * destination arrives with `url: null` (the policy still decides).
   */
  baseOrigin?: string
}

/**
 * Resolve and canonicalize for comparison: run the WHATWG parser (optionally
 * against `base`) and drop any embedded credentials. Returns `null` when the
 * value is not a resolvable URL.
 */
function canonicalizeUrl(raw: string, base: string | undefined): URL | null {
  let url: URL
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base)
  } catch {
    return null
  }
  if (url.username || url.password) {
    url.username = ''
    url.password = ''
  }
  return url
}

/** The document's base URI when there is a DOM, so relative refs resolve by default. */
function ambientBase(): string | undefined {
  return typeof document === 'undefined' ? undefined : document.baseURI
}

/**
 * Present one URL to the active {@link UrlPolicy} and return what should be
 * emitted, or `null` when the policy blocks it. A no-op returning `raw` when no
 * policy is installed.
 *
 * Same-document fragment references (`#footnote-1`, `url(#arrowhead)`) are
 * returned unchecked: they cannot leave the document, they are not a channel,
 * and mermaid emits a handful per diagram for its marker definitions — blocking
 * them removes every arrowhead in the output.
 */
/**
 * Default URL schemes permitted on a link/image destination. Anything carrying
 * a scheme outside the active set — `javascript:`, `data:`, `vbscript:`,
 * `file:`, and every unknown scheme — is rejected. An allowlist fails *closed*:
 * a new dangerous scheme is blocked by default, unlike a denylist that only
 * knows the three it was told about. Relative/absolute paths, fragments, and
 * query-only destinations carry no scheme and are always allowed.
 */
export const DEFAULT_SAFE_HREF_SCHEMES: readonly string[] = [
  'http',
  'https',
  'mailto',
  'tel',
  'sms',
  'ftp',
  'ftps',
]

const HREF_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

const DEFAULT_SAFE_HREF_SCHEMES_SET: ReadonlySet<string> = new Set(DEFAULT_SAFE_HREF_SCHEMES)

// `config.safeHrefSchemes` is an arbitrary iterable of possibly-mixed-case scheme
// names; resolve it to a lowercased Set once per distinct config value (the read
// runs per link/image destination).
let cachedSchemesSource: Iterable<string> | null | undefined
let cachedSchemes: ReadonlySet<string> = DEFAULT_SAFE_HREF_SCHEMES_SET
function activeSafeHrefSchemes(): ReadonlySet<string> {
  const source = activeConfig().safeHrefSchemes
  if (source == null) return DEFAULT_SAFE_HREF_SCHEMES_SET
  if (source !== cachedSchemesSource) {
    cachedSchemesSource = source
    cachedSchemes = new Set(Array.from(source, (scheme) => scheme.toLowerCase()))
  }
  return cachedSchemes
}

/**
 * The scheme allowlist currently enforced by {@link safeLinkHref}.
 *
 * @internal Introspection getter that reads the ambient render config; outside
 * a render it returns {@link DEFAULT_SAFE_HREF_SCHEMES}. Not part of the stable v1
 * surface (#147) — scope behaviour via `MarkdownConfig.safeHrefSchemes` instead
 * (the default constant stays stable). Not exported from the package entry since 1.0.
 */
export function getSafeHrefSchemes(): string[] {
  return [...activeSafeHrefSchemes()]
}

/**
 * True when `href` is a relative destination or carries an allowlisted scheme.
 * Exported so angle autolinks share the exact allowlist markdown links use
 * (#139) — autolink destinations are verbatim (no escapes to decode first).
 */
export function isAllowedHref(href: string): boolean {
  const scheme = HREF_SCHEME_RE.exec(href)?.[1]
  return scheme === undefined || activeSafeHrefSchemes().has(scheme.toLowerCase())
}

// The emphasis pass probes for link boundaries by rendering a candidate link and
// keeping only its end offset (`linkOrImageEndAt`). That markup is discarded, so
// presenting its URLs to the host would double every call, over-report in a
// policy that counts or logs, and let a host decision change how emphasis pairs.
// Suppressed during a probe; nested renders inside one are probes too.
let probing = false

/** Run `fn` with the policy suppressed — for markup that is parsed and thrown away. @internal */
export function withUrlPolicySuppressed<T>(fn: () => T): T {
  const previous = probing
  probing = true
  try {
    return fn()
  } finally {
    probing = previous
  }
}

export function applyUrlPolicy(
  raw: string,
  sink: UrlSink,
  source: UrlSource,
  element?: string,
  attribute?: string,
): string | null {
  if (probing) return raw
  const policy = activeConfig().urlPolicy
  if (!policy) return raw
  if (raw.startsWith('#')) return raw
  const decided = policy.createURL({
    raw,
    url: canonicalizeUrl(raw, policy.baseOrigin ?? ambientBase()),
    sink,
    source,
    ...(element === undefined ? {} : { element }),
    ...(attribute === undefined ? {} : { attribute }),
  })
  // The floor applies to the policy's answer, not just its question: a host
  // cannot hand back `javascript:` (or any scheme outside `safeHrefSchemes`) and
  // have it emitted. Without this the guarantee holds only on the sanitized path,
  // where the sink happens to catch it — not for `renderMarkdownUnsafe`, and not
  // for post-sink diagram markup, which never reaches the sink at all.
  if (decided !== null && !isAllowedHref(decided)) return null
  return decided
}

/** Whether a {@link UrlPolicy} is installed for the current render. */
export function hasUrlPolicy(): boolean {
  return activeConfig().urlPolicy != null
}

/**
 * Marker the inline emitters stamp on an `<a>`/`<img>` whose destination the
 * policy has already decided, and that the sink gate consumes and removes.
 *
 * Without it the gate cannot tell a renderer-emitted link from one that arrived
 * as raw HTML passthrough — they serialize identically — and would present every
 * markdown URL to `createURL` a second time. That is harmless for a policy that
 * only allows or blocks, and wrong for one that rewrites: a host proxying
 * subresources would get `proxy?u=proxy?u=…`. The attribute exists only while a
 * policy is installed and never survives the sink, so output is unchanged when
 * the feature is off.
 */
export const URL_POLICY_MARKER_ATTR = 'data-smd-url-checked'

/** The marker as an attribute fragment for the string emitters, or `''` when no policy is active. */
export function urlPolicyMarkerAttr(): string {
  return hasUrlPolicy() ? ` ${URL_POLICY_MARKER_ATTR}=""` : ''
}
