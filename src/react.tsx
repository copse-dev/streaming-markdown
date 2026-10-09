/**
 * First-party React wrapper (#156) — the `@copse/streaming-markdown/react` subpath.
 *
 * Two components, mirroring the two rendering paths of the agnostic core:
 *
 *   - {@link Markdown}          — at-rest render of a complete document
 *                                 (`renderMarkdown`), SSR-safe.
 *   - {@link StreamingMarkdown} — the incremental DOM path
 *                                 (`StreamingMarkdownRenderer.update()`, then
 *                                 `finish()` once `final` is set), driving the
 *                                 emitter directly rather than re-rendering
 *                                 React per streamed token.
 *
 * React is a **peer** dependency: this module is the only one that imports it, it
 * lives behind its own subpath, and the agnostic core never pulls it in. A host
 * that never imports `/react` pays zero React bytes.
 *
 * ## Config is per-instance
 *
 * There are no global setters. A `config: MarkdownConfig` prop scopes every
 * synchronous setting (html/scheme policy, `linkDecorator`, `fenceHandlers`,
 * grammar toggles, …) to that one component instance — two `<Markdown>` /
 * `<StreamingMarkdown>` with different `config` coexist without interfering.
 * `StreamingMarkdownRenderer` captures its config at construction, so the
 * streaming component **re-creates** its renderer when the `config` prop identity
 * changes; pass a stable/memoized object to avoid needless re-creation.
 *
 * ## Sinks
 *
 * Every DOM write goes through the sanitized paths (`renderMarkdown`,
 * `setSanitizedHtml`, and the renderer's own internal sink) — never a raw
 * `innerHTML`. Under Trusted Types, supply a policy via `config.trustedTypesPolicy`.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ElementType, HTMLAttributes, ReactElement, Ref } from 'react'
import { renderMarkdown } from './renderer.ts'
import { setSanitizedHtml } from './html-sink.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'
import type { MarkdownConfig } from './config.ts'

// `useLayoutEffect` warns when run during server rendering (there is no layout to
// read). Fall back to `useEffect` on the server, where neither effect fires — the
// server render emits static markup and the client takes over on mount.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/** Container props shared by both components — standard div attributes plus `as`. */
export interface MarkdownContainerProps
  extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'dangerouslySetInnerHTML'> {
  /** Element/component to render the container as. Defaults to `'div'`. */
  as?: ElementType
}

/**
 * Props for {@link Markdown}. Supply the source text as `markdown` (preferred) or
 * as a single string child, plus an optional per-instance {@link MarkdownConfig}
 * and any standard container attributes.
 */
export type MarkdownProps = MarkdownContainerProps & {
  config?: MarkdownConfig
  /**
   * Called after each render has been written to the host element, e.g. to hydrate math or
   * `mountIsolatedDiagrams(host, …)`. Every source or config change rewrites the host, so work done
   * here is redone for the new content. Optional.
   */
  onRender?: (host: HTMLElement) => void
} & ({ markdown: string; children?: never } | { markdown?: never; children: string })

/**
 * Render a **complete** markdown document at rest.
 *
 * SSR-safe: on the server (and the client's hydration pass) the sanitized HTML is
 * emitted via `dangerouslySetInnerHTML`, so there is real server markup and
 * hydration matches. After mount, a layout effect takes ownership of the DOM node
 * and drives every subsequent update through `setSanitizedHtml` — the
 * `dangerouslySetInnerHTML` value is frozen to the first render so React never
 * clobbers the node with an unsanitized write.
 *
 * `renderMarkdown` needs a sanitizer backend; in the browser the native Sanitizer
 * is the zero-dependency default, and a Node/SSR host installs one once via
 * `setDefaultConfig({ sanitizerBackend })` (or passes `config.sanitizerBackend`).
 */
export function Markdown(props: MarkdownProps): ReactElement {
  const { markdown, children, config, as, onRender, ...rest } = props as MarkdownContainerProps & {
    markdown?: string
    children?: string
    config?: MarkdownConfig
    onRender?: (host: HTMLElement) => void
  }
  const source = markdown ?? children ?? ''
  const ref = useRef<HTMLElement | null>(null)

  // Freeze the first render's HTML: React's `dangerouslySetInnerHTML` value must
  // stay constant across renders so that, once the layout effect owns the node, a
  // changing `__html` never triggers React to overwrite it with a raw (bypassing
  // `setSanitizedHtml`) innerHTML write. Updates flow through the effect instead.
  const initialHtml = useRef<string | null>(null)
  if (initialHtml.current === null) {
    initialHtml.current = renderMarkdown(source, config)
  }

  const onRenderRef = useRef(onRender)
  onRenderRef.current = onRender

  useIsomorphicLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setSanitizedHtml(el, renderMarkdown(source, config))
    onRenderRef.current?.(el)
  }, [source, config])

  const Tag = as ?? 'div'
  return (
    <Tag
      ref={ref as Ref<HTMLElement>}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: initialHtml.current }}
      {...rest}
    />
  )
}

/** Props for {@link StreamingMarkdown}. */
export type StreamingMarkdownProps = MarkdownContainerProps & {
  /** The full message text so far. Grows as tokens stream in. */
  markdown: string
  /** Per-instance config, captured when the underlying renderer is constructed. */
  config?: MarkdownConfig
  /**
   * Set once `markdown` is the complete text (the stream has ended). The
   * component then calls `renderer.finish(markdown)` instead of `update()`, so
   * whatever the renderer was still holding back — a trailing `~~run`, the
   * last table row or list item, an unclosed code fence — renders as the
   * at-rest document would. Setting it back to `false` (or changing `markdown`
   * while it is `false`) resumes streaming. Defaults to `false`.
   */
  final?: boolean
  /**
   * Called after each `update()` / `finish()` with the renderer and its host element, so a host
   * can drive `renderer.hydrate()` (math/diagram backends) or `mountIsolatedDiagrams(host, …)` on its own
   * schedule. Runs in the component's own layout effect, so `host` is always attached. Optional.
   */
  onUpdate?: (renderer: StreamingMarkdownRenderer, host: HTMLElement) => void
}

/**
 * Render markdown **while it is still streaming**.
 *
 * Owns a single {@link StreamingMarkdownRenderer} bound to the host element across
 * renders and calls `renderer.update(markdown)` whenever the `markdown` prop
 * changes (`renderer.finish(markdown)` once the `final` prop is set) — the
 * incremental DOM emitter converges the existing subtree, so this is NOT a
 * re-render-per-token. Because `StreamingMarkdownRenderer` captures its
 * config at construction, the renderer is re-created when the `config` prop
 * identity changes (pass a stable object to avoid churn).
 *
 * The host element renders empty on the server; the client mount constructs the
 * renderer and populates it. Streaming is inherently client-side, so there is no
 * server/client hydration mismatch (an empty `<div>` on both sides).
 */
export function StreamingMarkdown(props: StreamingMarkdownProps): ReactElement {
  const { markdown, config, final = false, as, onUpdate, ...rest } = props
  const hostRef = useRef<HTMLElement | null>(null)
  const rendererRef = useRef<StreamingMarkdownRenderer | null>(null)
  // Keep the latest `onUpdate` reachable from the config effect without making it
  // a dependency (a new callback identity per render must not re-create the renderer).
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  // Construct the renderer on mount and re-construct when `config` identity
  // changes — config is captured at construction, so a new config needs a new
  // renderer. `markdown` is intentionally NOT a dependency here: the effect below
  // drives incremental updates; this one seeds the initial content with whatever
  // `markdown` is current when it (re)runs.
  useIsomorphicLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const renderer = new StreamingMarkdownRenderer(host, config)
    rendererRef.current = renderer
    if (final) renderer.finish(markdown)
    else renderer.update(markdown)
    onUpdateRef.current?.(renderer, host)
    return () => {
      rendererRef.current = null
      host.replaceChildren()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  // Drive incremental updates as the streamed text grows/changes.
  useIsomorphicLayoutEffect(() => {
    const renderer = rendererRef.current
    const host = hostRef.current
    if (!renderer || !host) return
    if (final) renderer.finish(markdown)
    else renderer.update(markdown)
    onUpdateRef.current?.(renderer, host)
  }, [markdown, final])

  const Tag = as ?? 'div'
  return <Tag ref={hostRef as Ref<HTMLElement>} {...rest} />
}
