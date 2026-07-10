/**
 * Host-specific helpers for the Copse workspace app (#112).
 *
 * These are intentionally kept OUT of the main `@copse/streaming-markdown`
 * entry so the core surface stays host-agnostic: the default renderer emits
 * neutral, CommonMark-shaped anchors and never injects a particular host's
 * routing semantics. Hosts that want the pre-0.10 in-app behaviour import from
 * this subpath and opt in explicitly:
 *
 * ```ts
 * import { setLinkDecorator } from '@copse/streaming-markdown'
 * import { appLinkDecorator } from '@copse/streaming-markdown/host/workspace'
 *
 * setLinkDecorator(appLinkDecorator)
 * ```
 *
 * - `appLinkDecorator` — the workspace/browser `LinkDecorator` (adds
 *   `data-workspace-link` / `data-browser-link`, `target="_blank"`, etc.).
 * - `workspaceLinkTargetFromHref` / `isWorkspaceMarkdownLinkHref` /
 *   `WorkspaceLinkTarget` — map a markdown destination to a workspace file
 *   candidate; used by hosts that resolve in-workspace links.
 * - `stripAppLinkAttributes` / `stripAppImageAttributes` /
 *   `stripAppCodeDecorations` — conformance/testing helpers that undo the
 *   app-specific decoration so rendered HTML can be compared to a CommonMark
 *   reference.
 */
export { appLinkDecorator, stripAppImageAttributes, stripAppLinkAttributes } from './inline-links.ts'
export { stripAppCodeDecorations } from './highlight.ts'
export {
  isWorkspaceMarkdownLinkHref,
  workspaceLinkTargetFromHref,
  type WorkspaceLinkTarget,
} from './workspace-link-href.ts'
