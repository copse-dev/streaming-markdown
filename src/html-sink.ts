import {
  sanitizeRenderedMarkdown,
  sanitizeRenderedMarkdownInto,
  type SanitizedHtml,
} from './sanitize.ts'
import { bumpConfigEpoch } from './config-epoch.ts'

// The single `innerHTML` chokepoint. Every DOM write of rendered-markdown HTML
// in this package goes through this module (enforced by html-sink.test.ts), so
// sanitization cannot be forgotten at a call site and Trusted Types enforcement
// (CSP `require-trusted-types-for 'script'`) has exactly one seam to satisfy.
//
// Under Trusted Types, assigning a plain string to `innerHTML` throws — the
// value must be a `TrustedHTML` minted by a policy. The sinks below sanitize
// first and then "bless" the sanitized string through a policy:
//
// - by default, a lazily created policy named `streaming-markdown` whose
//   `createHTML` is the identity function. Identity is sound here because the
//   policy never leaves this module and every call site sanitizes before
//   blessing (the same pattern as DOMPurify's internal `dompurify` policy).
//   Hosts whose CSP restricts policy names must allowlist `streaming-markdown`
//   (`Content-Security-Policy: trusted-types streaming-markdown ...`) or
//   inject their own policy below.
// - a host-injected policy registered with {@link setTrustedTypesPolicy}. It
//   receives *already sanitized* markup, so an identity `createHTML` is fine —
//   the injection point exists to satisfy CSP policy-name allowlists, not to
//   replace the sanitizer.
//
// When no `trustedTypes` global exists (non-TT browsers, jsdom/Node), the
// sanitized string is assigned directly — behavior is unchanged.

/**
 * Minimal structural view of a `TrustedHTML` value. Kept structural so the
 * package does not require the DOM Trusted Types lib types; a real
 * `TrustedHTML` satisfies it.
 */
export type TrustedHTMLValue = { toString(): string }

/**
 * Minimal structural view of a Trusted Types policy that can mint HTML — a
 * real `TrustedTypePolicy` created with a `createHTML` rule satisfies it.
 */
export interface TrustedTypesPolicy {
  createHTML(input: string): TrustedHTMLValue
}

interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createHTML: (input: string) => string }): TrustedTypesPolicy
}

let hostPolicy: TrustedTypesPolicy | null = null
// `undefined` = default-policy creation not yet attempted; `null` = attempted
// and unavailable (no `trustedTypes` global, or the policy name is not
// allowlisted by the page's CSP).
let defaultPolicy: TrustedTypesPolicy | null | undefined
// The `trustedTypes` factory the current defaultPolicy was created from.
// Trusted Types forbids re-creating a policy name (absent 'allow-duplicates'),
// so a successfully created default policy must be reused for the lifetime of
// that factory — re-probing after a host set/unset cycle would throw and lose
// the policy. Only a *different* factory identity (tests installing a fresh
// shim) invalidates the cache.
let defaultPolicyFactory: TrustedTypesFactory | undefined

/**
 * Inject the Trusted Types policy used to bless sanitized markdown HTML before
 * it reaches `innerHTML`, or pass `null` to restore the default (a lazily
 * created policy named `streaming-markdown`). Set it once, before the first
 * render, when the page's CSP `trusted-types` directive does not allowlist the
 * default name:
 *
 * ```ts
 * import { setTrustedTypesPolicy } from '@copse/streaming-markdown'
 * setTrustedTypesPolicy(
 *   window.trustedTypes.createPolicy('my-app#markdown', { createHTML: (s) => s }),
 * )
 * ```
 *
 * The policy's `createHTML` always receives markup this package has already
 * passed through {@link sanitizeRenderedMarkdown}, so an identity rule is
 * sound; the hook exists for CSP policy-name control, not to replace the
 * sanitizer.
 */
export function setTrustedTypesPolicy(policy: TrustedTypesPolicy | null): void {
  hostPolicy = policy
  bumpConfigEpoch()
  // Allow a failed probe to retry on the next sink write (tests and hosts that
  // install a `trustedTypes` shim late). A *successfully created* default
  // policy is deliberately NOT discarded: `createPolicy('streaming-markdown')`
  // would throw on the second call under a CSP without 'allow-duplicates', and
  // resolvePolicy's factory-identity check already handles shim swaps.
  if (defaultPolicy === null) defaultPolicy = undefined
}

/**
 * @internal Snapshot the host Trusted Types policy slot for a scoped per-render
 * override (see `withRenderPolicies`). Restore with {@link restoreTrustedTypesPolicy}.
 */
export function snapshotTrustedTypesPolicy(): TrustedTypesPolicy | null {
  return hostPolicy
}

/** @internal Restore a snapshot from {@link snapshotTrustedTypesPolicy}. */
export function restoreTrustedTypesPolicy(snapshot: TrustedTypesPolicy | null): void {
  hostPolicy = snapshot
}

function resolvePolicy(): TrustedTypesPolicy | null {
  if (hostPolicy) return hostPolicy
  const trustedTypes = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes
  if (defaultPolicy === undefined || defaultPolicyFactory !== trustedTypes) {
    defaultPolicy = null
    defaultPolicyFactory = trustedTypes
    if (trustedTypes) {
      try {
        defaultPolicy = trustedTypes.createPolicy('streaming-markdown', {
          createHTML: (sanitized) => sanitized,
        })
      } catch {
        // Policy name not allowlisted by the page's CSP. Fall back to plain
        // string assignment; under enforcement the sink itself will then
        // throw, which is the CSP-intended failure mode — the host must
        // allowlist `streaming-markdown` or call setTrustedTypesPolicy().
      }
    }
  }
  return defaultPolicy
}

// Bless an already-sanitized HTML string for `innerHTML` assignment. The
// return type is `string` only to satisfy the DOM lib's sink typing — under
// Trusted Types the runtime value is a TrustedHTML object.
function blessSanitizedHtml(sanitized: string): string {
  const policy = resolvePolicy()
  return policy ? (policy.createHTML(sanitized) as string) : sanitized
}

/**
 * Sanitize `html` and set it as `el`'s content. This is the reference sink for
 * rendered-markdown HTML — custom {@link FenceHandler} `sync` implementations
 * should use it instead of raw `innerHTML` so they inherit both sanitization
 * and Trusted Types support.
 *
 * When the active {@link SanitizerBackend} implements `sanitizeInto`, the
 * sanitized nodes land in `el` directly — one parse, no `innerHTML` write, no
 * Trusted Types policy needed. Otherwise the string path runs: sanitize, bless
 * through the active policy, assign via `innerHTML`. Both paths serialize
 * identically; the string path is always fully supported (backends are not
 * required to provide a node path, and `Element.setHTML` need not exist).
 */
export function setSanitizedHtml(el: Element, html: string): void {
  if (html === '') {
    // `innerHTML = ''` is still a Trusted Types sink; clear with a DOM call so
    // the empty case never needs a policy (identical serialization).
    el.replaceChildren()
    return
  }
  if (sanitizeRenderedMarkdownInto(el, html)) return
  setPresanitizedHtml(el, sanitizeRenderedMarkdown(html))
}

/**
 * Assign markup that has ALREADY been through {@link sanitizeRenderedMarkdown}
 * (possibly wrapped in literal allowlisted tags by the caller) without
 * re-sanitizing. The {@link SanitizedHtml} brand makes that contract
 * compile-time checked: a plain string cannot reach this sink without either
 * the sanitizer or an audited `asSanitizedHtml` assertion — this is what
 * keeps the identity policy above sound. Not exported from the package entry
 * point.
 */
export function setPresanitizedHtml(el: Element, sanitizedHtml: SanitizedHtml | ''): void {
  if (sanitizedHtml === '') {
    el.replaceChildren()
    return
  }
  el.innerHTML = blessSanitizedHtml(sanitizedHtml)
}

/**
 * Assign host-trusted markup that deliberately bypasses the markdown sanitizer
 * — today only mermaid SVG, which the diagram library generates after sink
 * sanitization (see the design invariant in mermaid.ts). A plain string is
 * assigned as-is and will be rejected by a Trusted Types-enforcing page; such
 * hosts must supply a `TrustedHTML` (e.g. from `transformSvg`) minted by their
 * own policy. This package's policy never blesses this markup, since it is not
 * sanitizer output.
 */
export function setHostTrustedHtml(el: Element, html: string | TrustedHTMLValue): void {
  if (html === '') {
    // Same empty-clear as the sanitized sinks: never touch a TT sink for ''.
    el.replaceChildren()
    return
  }
  el.innerHTML = html as string
}
