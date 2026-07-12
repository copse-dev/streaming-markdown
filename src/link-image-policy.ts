// Opt-in link/image ORIGIN policy — a turnkey allowlist over which origins a
// rendered `<a href>`/`<img src>` is permitted to point at (issue #83). It
// composes with, and never replaces, the two gates that already ship:
//
//   - the scheme allowlist (`MarkdownConfig.safeHrefSchemes`), which decides which URL
//     *schemes* are inert enough to render (`javascript:`/`data:` are dropped
//     upstream by `safeLinkHref` before an `<a>` is ever built), and
//   - the sink sanitizer (`sanitize.ts`), the narrow tag/attribute allowlist.
//
// This policy adds a third, orthogonal axis: *which host* an already-scheme-safe
// URL may resolve to. It runs inside the per-element sink gate (`gateElement` in
// sanitize.ts), so it fires for every `<a>`/`<img>` the sanitizer keeps —
// covering rendered links, autolinks, and the host raw-image path alike — across
// both sanitizer backends and under Trusted Types, exactly like the sanitizer
// itself.
//
// Off by default: with no policy installed the gate is a no-op and output is
// byte-identical to today (the package invariant).

/**
 * Origin allowlist for rendered links and images. Supply per render via
 * `MarkdownConfig.linkImagePolicy`; `null` (the default) disables it entirely.
 *
 * Prefix matching is performed on the WHATWG-canonical serialization of each URL
 * (see {@link getLinkImagePolicy}), so it is robust against the usual
 * allowlist-bypass tricks — case-folding, `\` vs `/`, embedded credentials
 * (`https://good.com@evil.com`), scheme-relative `//evil.com`, leading/trailing
 * whitespace, and unicode host confusables (folded to punycode). Scheme safety
 * is NOT this policy's job: it stays with the scheme allowlist.
 */
import { activeConfig } from './config.ts'

export interface LinkImagePolicy {
  /**
   * Allowed link destinations. A rendered `<a href>` is kept untouched only when
   * its canonical form starts with one of these (themselves canonicalized);
   * anything else is rewritten to {@link defaultOrigin} (or neutralized when that
   * is empty) and tagged with {@link blockedLinkClass}. An empty array blocks
   * every off-origin link, leaving only same-origin (relative) destinations that
   * resolve under {@link defaultOrigin}.
   */
  allowedLinkPrefixes: readonly string[]
  /**
   * Allowed image sources, matched exactly like {@link allowedLinkPrefixes}. A
   * non-matching `<img src>` is neutralized (the `src` is stripped so nothing
   * loads) and tagged with {@link blockedImageClass}. `data:` images are governed
   * by {@link allowDataImages}, not by this list.
   */
  allowedImagePrefixes: readonly string[]
  /**
   * Absolute origin (e.g. `https://app.example.com`) that relative URLs resolve
   * against and that blocked links are rewritten to. When empty, relative URLs
   * cannot be resolved (and are blocked) and blocked links are neutralized by
   * dropping their `href` rather than rewritten.
   */
  defaultOrigin: string
  /**
   * Whether base64 `data:` image URLs are allowed. Defaults to `true` — the
   * current behavior, where a host that renders images may emit inline data
   * images. Set `false` to strip every `data:` image `src` (tagged blocked).
   */
  allowDataImages?: boolean
  /** Class added to a blocked/rewritten `<a>`. Defaults to `blocked-link`. */
  blockedLinkClass?: string
  /** Class added to a blocked/neutralized `<img>`. Defaults to `blocked-image`. */
  blockedImageClass?: string
}

const DEFAULT_BLOCKED_LINK_CLASS = 'blocked-link'
const DEFAULT_BLOCKED_IMAGE_CLASS = 'blocked-image'

/**
 * The active policy in the form the gate consumes: prefixes pre-canonicalized
 * once at install time (not per element), with defaults resolved.
 */
interface ResolvedPolicy {
  linkPrefixes: readonly string[]
  imagePrefixes: readonly string[]
  defaultOrigin: string
  allowDataImages: boolean
  blockedLinkClass: string
  blockedImageClass: string
}

// Resolving a raw `config.linkImagePolicy` canonicalizes its prefixes; do it once
// per distinct config value (the read runs per link/image element at the sink).
let cachedPolicySource: LinkImagePolicy | null | undefined
let cachedResolved: ResolvedPolicy | null = null
function resolvedPolicy(): ResolvedPolicy | null {
  const source = activeConfig().linkImagePolicy ?? null
  if (source !== cachedPolicySource) {
    cachedPolicySource = source
    cachedResolved =
      source === null
        ? null
        : {
            linkPrefixes: canonicalizePrefixes(source.allowedLinkPrefixes),
            imagePrefixes: canonicalizePrefixes(source.allowedImagePrefixes),
            defaultOrigin: source.defaultOrigin,
            allowDataImages: source.allowDataImages ?? true,
            blockedLinkClass: source.blockedLinkClass ?? DEFAULT_BLOCKED_LINK_CLASS,
            blockedImageClass: source.blockedImageClass ?? DEFAULT_BLOCKED_IMAGE_CLASS,
          }
  }
  return cachedResolved
}

/**
 * The current render's {@link LinkImagePolicy} in resolved form, or `null` when disabled.
 *
 * @experimental Introspection getter that reads the ambient render config; outside
 * a render it returns the defaults. Not part of the stable v1 surface (#147) —
 * scope behaviour via `MarkdownConfig.linkImagePolicy` instead. May move behind a
 * subpath or be removed in a minor release.
 */
export function getLinkImagePolicy(): LinkImagePolicy | null {
  const policy = resolvedPolicy()
  if (!policy) return null
  return {
    allowedLinkPrefixes: [...policy.linkPrefixes],
    allowedImagePrefixes: [...policy.imagePrefixes],
    defaultOrigin: policy.defaultOrigin,
    allowDataImages: policy.allowDataImages,
    blockedLinkClass: policy.blockedLinkClass,
    blockedImageClass: policy.blockedImageClass,
  }
}

/**
 * Canonicalize a URL for prefix comparison: resolve it (optionally against
 * `base`) with the WHATWG URL parser, drop any embedded credentials, and return
 * the canonical serialization. This is the ground truth of *where the browser
 * navigates* — the parser lowercases the scheme and host, folds unicode hosts to
 * punycode, rewrites `\` to `/` for special schemes, strips ignorable
 * whitespace/controls, and resolves scheme-relative (`//host`) and relative
 * references — so a prefix test on the result cannot be fooled by any of those.
 * Returns `null` when the input is not a resolvable URL.
 */
function canonicalize(value: string, base?: string): string | null {
  let url: URL
  try {
    url = base === undefined ? new URL(value) : new URL(value, base)
  } catch {
    return null
  }
  // Credentials are the one part of `href` an allowlist prefix must not see:
  // `https://good.com@evil.com` navigates to evil.com, yet its raw `href` starts
  // with `https://good.com`. Strip them so the compared origin is the real one.
  if (url.username || url.password) {
    url.username = ''
    url.password = ''
  }
  return url.href
}

/** Pre-canonicalize the configured prefixes once; drop any that are not URLs. */
function canonicalizePrefixes(prefixes: readonly string[]): readonly string[] {
  const out: string[] = []
  for (const prefix of prefixes) {
    const canonical = canonicalize(prefix)
    if (canonical !== null) out.push(canonical)
  }
  return out
}

/** Whether a candidate URL's canonical form falls under one of the allowed prefixes. */
function isUnderAllowedPrefix(canonical: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => canonical.startsWith(prefix))
}

interface ResolvedHref {
  /** Canonical (credential-free) serialization the browser would navigate to. */
  canonical: string
  /** True when the raw value carried no scheme and was resolved against `defaultOrigin`. */
  wasRelative: boolean
}

/**
 * Resolve a raw attribute value to its canonical destination. An absolute URL
 * keeps its own origin; a scheme-less/scheme-relative reference is resolved
 * against `defaultOrigin`. Returns `null` when it resolves to nothing (a relative
 * reference with no/invalid `defaultOrigin`), which the caller treats as blocked.
 */
function resolveHref(raw: string, defaultOrigin: string): ResolvedHref | null {
  const absolute = canonicalize(raw)
  if (absolute !== null) return { canonical: absolute, wasRelative: false }
  if (defaultOrigin === '') return null
  const resolved = canonicalize(raw, defaultOrigin)
  if (resolved === null) return null
  return { canonical: resolved, wasRelative: true }
}

/** Append `className` to an element's class list without clobbering existing classes. */
function addBlockedClass(node: Element, className: string): void {
  node.classList.add(className)
}

function enforceLink(node: Element, policy: ResolvedPolicy): void {
  const href = node.getAttribute('href')
  if (href === null) return
  const resolved = resolveHref(href, policy.defaultOrigin)
  if (resolved !== null && isUnderAllowedPrefix(resolved.canonical, policy.linkPrefixes)) {
    // Allowed. An absolute URL passes untouched (byte-identical); a relative one
    // is rewritten to its resolved absolute form — that resolution is the whole
    // point of `defaultOrigin`.
    if (resolved.wasRelative) node.setAttribute('href', resolved.canonical)
    return
  }
  // Blocked: rewrite to the safe default origin, or neutralize the link when no
  // default origin is configured. Either way it is tagged for host styling.
  if (policy.defaultOrigin === '') node.removeAttribute('href')
  else node.setAttribute('href', policy.defaultOrigin)
  addBlockedClass(node, policy.blockedLinkClass)
}

function enforceImage(node: Element, policy: ResolvedPolicy): void {
  const src = node.getAttribute('src')
  // No `src` yet (e.g. a host placeholder hydrated after the sink) — nothing to
  // vet. Such images are the host's responsibility to hydrate safely.
  if (src === null || src === '') return
  const resolved = resolveHref(src, policy.defaultOrigin)
  // `data:` images are governed solely by `allowDataImages`, not the prefix list.
  const isDataImage = resolved !== null && !resolved.wasRelative && isDataUrl(resolved.canonical)
  const allowed = isDataImage
    ? policy.allowDataImages
    : resolved !== null && isUnderAllowedPrefix(resolved.canonical, policy.imagePrefixes)
  if (allowed) {
    if (resolved !== null && resolved.wasRelative) node.setAttribute('src', resolved.canonical)
    return
  }
  // Blocked: strip the `src` so nothing loads, keeping the element (and its alt
  // text) in place, and tag it for host styling.
  node.removeAttribute('src')
  addBlockedClass(node, policy.blockedImageClass)
}

/** A canonical URL is a base64/inline data image when its scheme is `data:`. */
function isDataUrl(canonical: string): boolean {
  return canonical.slice(0, 5).toLowerCase() === 'data:'
}

/**
 * Sink-boundary enforcement of the active {@link LinkImagePolicy}, invoked from
 * the per-element sanitizer gate for every kept element. A no-op (a single null
 * check) when no policy is installed, so the default path stays free.
 */
export function applyLinkImagePolicy(node: Element, tagName: string): void {
  const policy = resolvedPolicy()
  if (!policy) return
  if (tagName === 'a') enforceLink(node, policy)
  else if (tagName === 'img') enforceImage(node, policy)
}
