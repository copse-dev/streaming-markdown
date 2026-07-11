import DOMPurify from 'dompurify'
import type { SanitizerBackend, SanitizerConfig } from './sanitize.ts'

// DOMPurify sanitizer backend. This is the only module that imports `dompurify`,
// so hosts that use the native Sanitizer API (or their own backend) never pull it
// into their bundle. Install it in Node/jsdom or older browsers:
//
//   import { setDefaultConfig } from '@copse/streaming-markdown'
//   import { dompurifyBackend } from '@copse/streaming-markdown/sanitizers/dompurify'
//   setDefaultConfig({ sanitizerBackend: dompurifyBackend })
//
// or per render via `MarkdownConfig.sanitizerBackend`.
//
// The backend deliberately uses a strict tag/attr allowlist (never a FORBID_TAGS
// denylist) and string output (never RETURN_DOM) — see the advisory-posture tests
// in sanitize.test.ts.

// A single global `uponSanitizeElement` hook forwards to the per-call
// `onElement` gate. Sanitization is synchronous and single-threaded, so setting
// the active gate around the `DOMPurify.sanitize` call is safe.
let hookInstalled = false
let activeOnElement: SanitizerConfig['onElement']

function installHook(): void {
  if (hookInstalled) return
  hookInstalled = true
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    activeOnElement?.(node as Element, data.tagName)
  })
}

// Arm the per-call element gate around a DOMPurify run so the hook/teardown
// lifecycle lives in one place for both the string and node paths.
function withGate<T>(config: SanitizerConfig, run: () => T): T {
  installHook()
  activeOnElement = config.onElement
  try {
    return run()
  } finally {
    activeOnElement = undefined
  }
}

export const dompurifyBackend: SanitizerBackend = {
  sanitize(html: string, config: SanitizerConfig): string {
    return withGate(config, () =>
      DOMPurify.sanitize(html, {
        ALLOWED_TAGS: [...config.allowedTags],
        ALLOWED_ATTR: [...config.allowedAttr],
      }),
    )
  },
  // Node path: hand the sanitized fragment's nodes to the target directly, so a
  // sink write costs one parse (DOMPurify's) with no serialize→re-parse round
  // trip — and no `innerHTML` write, which also sidesteps Trusted Types sinks.
  // DOMPurify parses in body context, so content must be body-context-safe
  // (see the sanitizeInto contract in sanitize.ts).
  sanitizeInto(target: Element, html: string, config: SanitizerConfig): void {
    const fragment = withGate(config, () =>
      DOMPurify.sanitize(html, {
        ALLOWED_TAGS: [...config.allowedTags],
        ALLOWED_ATTR: [...config.allowedAttr],
        RETURN_DOM_FRAGMENT: true,
      }),
    )
    /* c8 ignore start -- only reachable in a real browser: when DOMPurify
       cannot parse at all (its internal DOMParser is a Trusted Types sink and
       the page's CSP does not allowlist DOMPurify's own 'dompurify' policy),
       its string path returns '' and its fragment path returns null. Mirror
       the string path's empty result instead of crashing on the null. */
    if (!fragment) {
      target.replaceChildren()
      return
    }
    /* c8 ignore stop */
    const doc = target.ownerDocument
    target.replaceChildren(
      fragment.ownerDocument === doc ? fragment : doc.importNode(fragment, true),
    )
  },
}
