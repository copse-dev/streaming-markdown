// OPTIONAL input smoother (#84): steadies the *reveal* of streamed content
// without touching the incremental DOM emitter. It sits between the host's
// chunk arrival and `renderer.update()`, releasing the growing string a few
// characters per frame (via requestAnimationFrame) instead of in the chunky
// token bursts an LLM transport delivers. Because it only throttles the INPUT
// string — and every released value is a prefix of the full text — it composes
// with the existing pending-state machinery and DOM morph rather than fighting
// them: each frame is an ordinary `update(prefix)` the renderer already knows
// how to converge.
//
// It lives behind the `@copse/streaming-markdown/smoothing` subpath and is NOT
// re-exported from the main entry, so a host that never imports it pays zero
// bytes and the default emitter behaviour stays byte-for-byte unchanged.
//
//   import { StreamingMarkdownRenderer } from '@copse/streaming-markdown'
//   import { createInputSmoother } from '@copse/streaming-markdown/smoothing'
//
//   const renderer = new StreamingMarkdownRenderer(host)
//   const smoother = createInputSmoother({ update: (t) => renderer.update(t) })
//
//   for await (const full of stream) smoother.push(full) // full text so far
//   smoother.flush()                                      // stream end: no lag
//
// Design decision (see docs/LAZY-LOADING.md): we smooth the input rather than
// animate the output. CSS entrance animations on newly-added nodes are left to
// the host — they are framework-/theme-specific and risk fighting the DOM morph.

/** Default reveal rate. Fast enough to keep up with most streams, slow enough to smooth bursts. */
const DEFAULT_CHARS_PER_SECOND = 600

/** The `prefers-reduced-motion` query we honour by disabling smoothing. */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** The slice of `MediaQueryList` this module reads (avoids a hard DOM-lib dependency). */
interface MediaQueryLike {
  readonly matches: boolean
}

export interface InputSmootherOptions {
  /**
   * Sink for each released prefix. Typically `(t) => renderer.update(t)`. Called
   * with a growing prefix of the pushed text on every cadence tick, and once
   * more with the full text on {@link InputSmoother.flush}.
   */
  update: (text: string) => void
  /**
   * Reveal rate in characters per second. Defaults to {@link DEFAULT_CHARS_PER_SECOND}.
   * The host's `push` sets the *target*; this knob sets how fast the revealed
   * prefix walks toward it.
   */
  charsPerSecond?: number
  /**
   * Force smoothing off — every `push` passes straight through to `update`,
   * byte-for-byte identical to feeding the string un-smoothed. Also implied when
   * the environment reports reduced motion (see {@link respectReducedMotion}).
   */
  disabled?: boolean
  /**
   * Honour `prefers-reduced-motion: reduce` by disabling smoothing. Defaults to
   * `true`; evaluated once at creation. Set `false` to keep smoothing even when
   * the user asked for reduced motion (rarely wanted).
   */
  respectReducedMotion?: boolean
  // ---- host/environment seams (injectable so node/jsdom tests need no globals) ----
  /**
   * Monotonic clock in milliseconds. Defaults to `performance.now()` when
   * available, else `Date.now()`. Injected by tests to drive a fake clock.
   */
  now?: () => number
  /**
   * Schedule a frame; returns a cancellable handle. Defaults to
   * `requestAnimationFrame` when present, else a `setTimeout(…, 16)` shim so the
   * loop still runs under node/jsdom.
   */
  requestFrame?: (callback: () => void) => number
  /** Cancel a handle from {@link requestFrame}. Defaults to `cancelAnimationFrame`/`clearTimeout`. */
  cancelFrame?: (handle: number) => void
  /**
   * `matchMedia` used to probe reduced motion. Defaults to `globalThis.matchMedia`.
   * When absent (node/jsdom without a shim) reduced motion is treated as unset
   * and smoothing stays enabled.
   */
  matchMedia?: (query: string) => MediaQueryLike
}

/**
 * A running input smoother. Feed it the accumulated text with {@link push}, end
 * the stream with {@link flush}, and tear it down with {@link dispose}.
 */
export interface InputSmoother {
  /**
   * Set the target text (the full message so far). Smoothing walks the revealed
   * prefix toward it a few characters per frame. When smoothing is disabled the
   * text passes through to `update` immediately.
   */
  push(text: string): void
  /**
   * Release the entire pending target now and stop the loop — the correct call
   * on stream end / the final chunk so completion never carries artificial lag.
   * After a flush the sink has seen the full text, so the rendered DOM equals a
   * single un-smoothed `update(fullText)` (convergence).
   */
  flush(): void
  /** Stop the loop and release nothing further. Idempotent; no final `update`. */
  dispose(): void
  /**
   * Whether smoothing is active. `false` when {@link InputSmootherOptions.disabled}
   * was set or reduced motion is honoured — in which case `push` is a pass-through.
   */
  readonly enabled: boolean
}

/** Default clock: high-resolution when available, else wall clock. */
function defaultNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance
  return typeof perf?.now === 'function' ? perf.now() : Date.now()
}

/** Default frame scheduler: rAF in a browser, a ~60fps timeout shim elsewhere. */
function defaultRequestFrame(callback: () => void): number {
  const raf = (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number })
    .requestAnimationFrame
  if (typeof raf === 'function') return raf(() => callback())
  return setTimeout(callback, 16) as unknown as number
}

/** Default frame canceller, mirroring {@link defaultRequestFrame}. */
function defaultCancelFrame(handle: number): void {
  const caf = (globalThis as { cancelAnimationFrame?: (h: number) => void }).cancelAnimationFrame
  if (typeof caf === 'function') caf(handle)
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
}

/** Probe `prefers-reduced-motion: reduce`; `false` when `matchMedia` is unavailable. */
function prefersReducedMotion(
  matchMedia: ((query: string) => MediaQueryLike) | undefined,
): boolean {
  const mm =
    matchMedia ??
    (globalThis as { matchMedia?: (query: string) => MediaQueryLike }).matchMedia
  if (typeof mm !== 'function') return false
  return mm(REDUCED_MOTION_QUERY).matches
}

/**
 * A UTF-16-safe reveal boundary at or below `count`: never split a surrogate
 * pair (which would emit a lone surrogate mid-frame). Convergence is unaffected
 * — `flush` always releases the whole target — this only keeps intermediate
 * frames well-formed.
 */
function safeBoundary(text: string, count: number): number {
  if (count <= 0) return 0
  if (count >= text.length) return text.length
  const code = text.charCodeAt(count - 1)
  // High surrogate at the boundary means its low half is `text[count]`; step
  // back one so the pair is released together on the next frame.
  if (code >= 0xd800 && code <= 0xdbff) return count - 1
  return count
}

/**
 * Create an input smoother that releases pushed text to `update` at a steady
 * character cadence. See {@link InputSmootherOptions} and {@link InputSmoother}.
 */
export function createInputSmoother(options: InputSmootherOptions): InputSmoother {
  const {
    update,
    charsPerSecond = DEFAULT_CHARS_PER_SECOND,
    disabled = false,
    respectReducedMotion = true,
    now = defaultNow,
    requestFrame = defaultRequestFrame,
    cancelFrame = defaultCancelFrame,
    matchMedia,
  } = options

  const enabled =
    !disabled && !(respectReducedMotion && prefersReducedMotion(matchMedia))

  let target = ''
  // Revealed length as a float so sub-character-per-frame budgets accumulate
  // across frames instead of rounding to zero every tick.
  let revealed = 0
  let lastTick = 0
  let handle: number | null = null
  let disposed = false

  /** Release the current revealed prefix to the sink. */
  function emit(): void {
    update(target.slice(0, safeBoundary(target, Math.floor(revealed))))
  }

  /** One cadence frame: advance the budget by elapsed·rate, emit, reschedule if unfinished. */
  function frame(): void {
    handle = null
    if (disposed) return
    const nowMs = now()
    const elapsedSec = Math.max(0, nowMs - lastTick) / 1000
    lastTick = nowMs
    revealed = Math.min(target.length, revealed + elapsedSec * charsPerSecond)
    emit()
    if (revealed < target.length) schedule()
  }

  /** Schedule the next frame (no-op if one is pending, the loop is done, or disposed). */
  function schedule(): void {
    if (disposed || handle !== null || revealed >= target.length) return
    handle = requestFrame(frame)
  }

  function cancel(): void {
    if (handle !== null) {
      cancelFrame(handle)
      handle = null
    }
  }

  function push(text: string): void {
    if (disposed) return
    target = text
    // A shorter target (rare — accumulated text normally only grows) must not
    // leave `revealed` past its end.
    if (revealed > target.length) revealed = target.length
    if (!enabled) {
      revealed = target.length
      update(target)
      return
    }
    // Seed timing only when (re)starting from idle, so a gap between bursts
    // doesn't inflate the next dt into a giant jump — while a running loop keeps
    // its own `lastTick` and doesn't lose in-flight elapsed time.
    if (handle === null) lastTick = now()
    schedule()
  }

  function flush(): void {
    if (disposed) return
    cancel()
    revealed = target.length
    update(target)
  }

  function dispose(): void {
    disposed = true
    cancel()
  }

  return {
    push,
    flush,
    dispose,
    get enabled() {
      return enabled
    },
  }
}
