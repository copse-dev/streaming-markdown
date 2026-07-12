// GFM extended email autolinks (#115): bare `user@host` addresses linkified as
// `mailto:` in ordinary prose. This is a GFM autolink-extension feature — base
// CommonMark and base GFM leave a bare address as plain text — so a consumer
// that targets base behaviour (or simply does not want addresses turned into
// links) can turn it off. The `www.`/URL forms are left on; disabling only the
// email pass matches the pre-extension behaviour where bare URLs still linked.
//
// On by default (GFM superset). Kept as a dependency-free leaf so the inline
// pipeline can read the flag without an import cycle, mirroring math-syntax.ts.

import { activeConfig } from './config.ts'

/**
 * Whether bare email addresses are linkified as `mailto:` for the current render (default on).
 *
 * @experimental Introspection getter that reads the ambient render config; outside
 * a render it returns the defaults. Not part of the stable v1 surface (#147) —
 * scope behaviour via `MarkdownConfig.emailAutolinks` instead. May move behind a
 * subpath or be removed in a minor release.
 */
export function isEmailAutolinksEnabled(): boolean {
  return activeConfig().emailAutolinks ?? true
}
