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
//   const smoother = createInputSmoother({
//     update: (t) => renderer.update(t),
//     cadence: 'adaptive', // follow the stream's own rate
//   })
//
//   for await (const full of stream) smoother.push(full) // full text so far
//   smoother.finish(() => renderFinal())                 // stream end: drain, then settle
//
// Design decision (see docs/LAZY-LOADING.md): we smooth the input rather than
// animate the output. CSS entrance animations on newly-added nodes are left to
// the host — they are framework-/theme-specific and risk fighting the DOM morph.

/** Default reveal rate. Fast enough to keep up with most streams, slow enough to smooth bursts. */
const DEFAULT_CHARS_PER_SECOND = 600

/** Adaptive cadence: default distance, in time, between arrived and revealed text. */
const DEFAULT_LAG_MS = 120
/** Adaptive cadence: time constant of the velocity filter — how fast the reveal changes speed. */
const VELOCITY_SMOOTHING_MS = 180
/** Adaptive cadence: floor so the tail of a pause never crawls out one character at a time. */
const MIN_CHARS_PER_MS = 0.06
/**
 * Adaptive cadence: a frame gap longer than this means the page was hidden or
 * stalled; animating the whole backlog afterwards would only replay text the
 * reader could already have been reading, so the reveal catches up at once.
 */
const MAX_FRAME_GAP_MS = 250
/** {@link InputSmoother.finish}: drain what is left over this lag, whatever the cadence. */
const DRAIN_LAG_MS = 60
/** How far {@link revealBoundary} may push a cut past markdown punctuation and whitespace. */
const MAX_BOUNDARY_EXTENSION = 32

/** The `prefers-reduced-motion` query we honour by disabling smoothing. */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** The slice of `MediaQueryList` this module reads (avoids a hard DOM-lib dependency). */
interface MediaQueryLike {
  readonly matches: boolean
}

export interface InputSmootherOptions {
  /**
   * Sink for each released prefix. Typically `(t) => renderer.update(t)`. Called
   * with a growing prefix of the pushed text on every cadence tick that reveals
   * more, and once more with the full text on {@link InputSmoother.flush}.
   */
  update: (text: string) => void
  /**
   * How the revealed prefix walks toward the pushed text:
   *
   * - `'fixed'` (default) — a constant {@link charsPerSecond}. Predictable, but
   *   a stream slower than the rate is still revealed in bursts (each chunk
   *   drains in a frame or two, then the reveal waits), and one faster than the
   *   rate falls ever further behind.
   * - `'adaptive'` — the reveal speed tracks the stream's own arrival rate,
   *   running about {@link lagMs} behind it. The speed is low-pass filtered, so
   *   a steady stream reveals steadily, a burst speeds the reveal up over a few
   *   frames instead of in one jump, and the lag stays bounded however fast the
   *   model is. Recommended for LLM output.
   */
  cadence?: 'fixed' | 'adaptive'
  /**
   * Reveal rate in characters per second for the `'fixed'` cadence. Defaults to
   * {@link DEFAULT_CHARS_PER_SECOND}. The host's `push` sets the *target*; this
   * knob sets how fast the revealed prefix walks toward it. Ignored by the
   * `'adaptive'` cadence.
   */
  charsPerSecond?: number
  /**
   * Target lag, in milliseconds, between the pushed text and the revealed text
   * for the `'adaptive'` cadence. Defaults to {@link DEFAULT_LAG_MS}. Larger
   * values smooth burstier transports at the cost of latency.
   */
  lagMs?: number
  /**
   * Text already on screen when the smoother is created — a message re-rendered
   * mid-stream, say. Reveal starts from its end instead of replaying it, and it
   * is not passed to `update`.
   */
  initial?: string
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
   * loop still runs under node/jsdom. A scheduler that runs the callback
   * synchronously (some test shims do) cannot pace anything: the smoother then
   * releases text as soon as it is pushed.
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
 * the stream with {@link finish} (or {@link flush}), and tear it down with
 * {@link dispose}.
 */
export interface InputSmoother {
  /**
   * Set the target text (the full message so far). Smoothing walks the revealed
   * prefix toward it a few characters per frame. When smoothing is disabled the
   * text passes through to `update` immediately. A push after {@link finish}
   * means the stream resumed: the pending `onSettled` is dropped.
   */
  push(text: string): void
  /**
   * End the stream smoothly: reveal what is left over a short drain (~60ms of
   * lag, whatever the cadence), then call `onSettled` once — synchronously when
   * nothing is left to reveal, smoothing is off, or the page is hidden. Use it
   * to swap in a final render without the tail of the answer arriving in one
   * jump. After it settles the sink has seen the full text (convergence).
   */
  finish(onSettled?: () => void): void
  /**
   * Release the entire pending target now and stop the loop — no lag at all.
   * Settles a pending {@link finish}. After a flush the sink has seen the full
   * text, so the rendered DOM equals a single un-smoothed `update(fullText)`
   * (convergence).
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

/** A hidden page runs no animation frames, so a drain there would never finish. */
function documentHidden(): boolean {
  const doc = (globalThis as { document?: { visibilityState?: string } }).document
  return doc?.visibilityState === 'hidden'
}

// Characters that open, close, or introduce markdown syntax. A reveal that
// stops right after one of them shows the raw character for a frame before
// the renderer can tell what it becomes: a closing fence's first two
// backticks, a table separator's pipes, a `1.` before its list item, the
// brackets of `[text]` before `(url)` arrives.
const SYNTAX_CHARS = new Set('`*_~[]()|#>!-+=.:<\\0123456789')

/**
 * Whitespace is undecided too: a trailing newline or indent can briefly open an
 * empty line, and `## `, `- `, `> ` are only settled by what follows them.
 */
function endsUndecided(text: string, end: number): boolean {
  const last = text[end - 1]
  return last !== undefined && (SYNTAX_CHARS.has(last) || /\s/.test(last))
}

/**
 * Where a reveal of `count` UTF-16 code units may end. The cut moves forward
 * past markdown punctuation and whitespace (see SYNTAX_CHARS), up to a small
 * bound, so a frame ends right after a word character; then it steps back off
 * a lone high surrogate so a pair is never split. Convergence is unaffected —
 * the final release is always the whole target — this only keeps intermediate
 * frames well-formed.
 */
function revealBoundary(text: string, count: number): number {
  if (count <= 0) return 0
  if (count >= text.length) return text.length
  let end = count
  const limit = Math.min(text.length, count + MAX_BOUNDARY_EXTENSION)
  while (end < limit && endsUndecided(text, end)) end++
  if (end >= text.length) return text.length
  const code = text.charCodeAt(end - 1)
  // High surrogate at the boundary means its low half is `text[end]`; step
  // back one so the pair is released together on a later frame.
  if (code >= 0xd800 && code <= 0xdbff) return end - 1
  return end
}

/**
 * Create an input smoother that releases pushed text to `update` at a steady
 * cadence. See {@link InputSmootherOptions} and {@link InputSmoother}.
 */
export function createInputSmoother(options: InputSmootherOptions): InputSmoother {
  const {
    update,
    cadence = 'fixed',
    charsPerSecond = DEFAULT_CHARS_PER_SECOND,
    lagMs = DEFAULT_LAG_MS,
    initial = '',
    disabled = false,
    respectReducedMotion = true,
    now = defaultNow,
    requestFrame = defaultRequestFrame,
    cancelFrame = defaultCancelFrame,
    matchMedia,
  } = options

  const enabled =
    !disabled && !(respectReducedMotion && prefersReducedMotion(matchMedia))

  let target = initial
  // Revealed length as a float so sub-character-per-frame budgets accumulate
  // across frames instead of rounding to zero every tick.
  let revealed = initial.length
  // The last prefix handed to `update`, so an unchanged frame costs nothing.
  let emitted = initial
  // Adaptive cadence: the filtered reveal speed, in characters per millisecond.
  let velocity = 0
  let lastTick = 0
  let handle: number | null = null
  let disposed = false
  let settle: (() => void) | null = null
  // Set while `requestFrame` is running, to catch a scheduler that calls back
  // synchronously; once seen, the smoother stops scheduling and releases text
  // as it arrives.
  let requesting = false
  let synchronousFrames = false

  /** Release `text` to the sink unless it is already what the sink last saw. */
  function emit(text: string): void {
    if (text === emitted) return
    emitted = text
    update(text)
  }

  /** Call a pending {@link InputSmoother.finish} callback, once. */
  function settleNow(): void {
    const done = settle
    settle = null
    done?.()
  }

  /** Reveal speed for this frame, in characters per millisecond. */
  function rate(dtMs: number, backlog: number): number {
    let perMs: number
    if (cadence === 'adaptive') {
      const desired = Math.max(backlog / lagMs, MIN_CHARS_PER_MS)
      velocity += (desired - velocity) * (1 - Math.exp(-dtMs / VELOCITY_SMOOTHING_MS))
      perMs = velocity
    } else {
      perMs = charsPerSecond / 1000
    }
    // Draining for a finish must not wait on the cadence (or the filter).
    if (settle) perMs = Math.max(perMs, backlog / DRAIN_LAG_MS, MIN_CHARS_PER_MS)
    return perMs
  }

  /** One cadence frame: advance the budget, emit, reschedule if unfinished. */
  function frame(): void {
    handle = null
    if (disposed) return
    if (requesting) synchronousFrames = true
    const nowMs = now()
    const dtMs = Math.max(0, nowMs - lastTick)
    lastTick = nowMs
    const backlog = target.length - revealed
    const catchUp =
      synchronousFrames || (cadence === 'adaptive' && dtMs > MAX_FRAME_GAP_MS)
    if (catchUp) revealed = target.length
    else if (backlog > 0) revealed = Math.min(target.length, revealed + rate(dtMs, backlog) * dtMs)
    const end = revealBoundary(target, Math.floor(revealed))
    // A cut pushed forward past punctuation spends that budget now.
    revealed = Math.max(revealed, end)
    emit(target.slice(0, end))
    if (end < target.length) schedule()
    else settleNow()
  }

  /** Schedule the next frame (no-op if one is pending, the loop is done, or disposed). */
  function schedule(): void {
    if (disposed || handle !== null || synchronousFrames) return
    requesting = true
    const requested = requestFrame(frame)
    requesting = false
    // A synchronous scheduler has already run (and finished) the frame.
    if (!synchronousFrames) handle = requested
  }

  function cancel(): void {
    if (handle !== null) {
      cancelFrame(handle)
      handle = null
    }
  }

  /** Reveal the whole target now, stop the loop, and settle a pending finish. */
  function releaseAll(): void {
    cancel()
    revealed = target.length
    emit(target)
    settleNow()
  }

  function push(text: string): void {
    if (disposed) return
    settle = null
    target = text
    // A shorter target (rare — accumulated text normally only grows) must not
    // leave `revealed` past its end.
    if (revealed > target.length) revealed = target.length
    if (!enabled || synchronousFrames) {
      // Pass-through: every push reaches the sink, exactly as un-smoothed.
      revealed = target.length
      emitted = target
      update(target)
      return
    }
    // Seed timing only when (re)starting from idle, so a gap between bursts
    // doesn't inflate the next dt into a giant jump — while a running loop keeps
    // its own `lastTick` and doesn't lose in-flight elapsed time.
    if (handle === null) lastTick = now()
    schedule()
  }

  function finish(onSettled?: () => void): void {
    if (disposed) return
    settle = onSettled ?? null
    if (!enabled || synchronousFrames || emitted === target || documentHidden()) {
      releaseAll()
      return
    }
    if (handle === null) lastTick = now()
    schedule()
  }

  function flush(): void {
    if (disposed) return
    cancel()
    revealed = target.length
    emitted = target
    update(target)
    settleNow()
  }

  function dispose(): void {
    disposed = true
    settle = null
    cancel()
  }

  return {
    push,
    finish,
    flush,
    dispose,
    get enabled() {
      return enabled
    },
  }
}
