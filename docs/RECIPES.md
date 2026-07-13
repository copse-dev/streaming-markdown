# UI recipes

Widgets and behaviours layered on top of rendered markdown — copy buttons, auto-scroll,
in-pane navigation — aren't part of the library; you add them in your own app using the
emitted class hooks. This covers **copy buttons on code blocks**, **auto-scrolling to the
bottom while streaming**, and **keeping footnote links inside a scroll container**.

## The catch

The DOM emitter reconciles the message subtree on every `update()` and **trims any
child its template didn't produce** (`morphChildren` in `src/streaming-dom-morph.ts`).
A button you `appendChild` into a `<pre>` is deleted on the next morph — during
streaming, and again on the plain→highlighted re-render.

Two rules follow:

1. Don't rely on injected nodes persisting — re-attach them after each morph.
2. Bind the click handler **once** to a stable ancestor (event delegation), never to
   the button, since re-attach recreates it.

## Snippet

Call `installCopyButtons(sink)` once, on the element you stream into.

```js
export function installCopyButtons(sink) {
  // Handler bound once to the sink — survives button re-creation.
  sink.addEventListener('click', async (event) => {
    const btn = event.target.closest('button.sm-copy-btn')
    if (!btn || !sink.contains(btn)) return
    const code = btn.parentElement?.querySelector('code')
    if (!code) return
    // textContent = clean source; innerHTML would copy the highlight.js spans.
    const ok = await copyText(code.textContent ?? '')
    btn.setAttribute('aria-label', ok ? 'Copied' : 'Copy failed')
    btn.dataset.copied = String(ok)
    clearTimeout(btn._t)
    btn._t = setTimeout(() => {
      delete btn.dataset.copied
      btn.setAttribute('aria-label', 'Copy code')
    }, 1500)
  })

  // Re-attach after every morph; idempotent; skips still-forming fences.
  function decorate() {
    for (const code of sink.querySelectorAll('pre:not(.stream-fence-forming) > code.hljs')) {
      const pre = code.parentElement
      if (pre.querySelector(':scope > button.sm-copy-btn')) continue
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'sm-copy-btn'
      btn.textContent = 'Copy'
      btn.setAttribute('aria-label', 'Copy code')
      pre.appendChild(btn)
    }
  }

  // Fires on the streaming morph and the highlighter upgrade, for both emitters.
  // If you drive StreamingMarkdownRenderer yourself, call decorate() after each update().
  const mo = new MutationObserver(decorate)
  mo.observe(sink, { childList: true, subtree: true })
  decorate()
  return () => mo.disconnect()
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}
```

```css
.streaming-markdown pre { position: relative; }
.streaming-markdown pre > button.sm-copy-btn {
  position: absolute;
  top: 0.4rem;
  right: 0.4rem;
  opacity: 0;
  transition: opacity 0.12s;
}
.streaming-markdown pre:hover > button.sm-copy-btn,
.streaming-markdown pre > button.sm-copy-btn:focus-visible { opacity: 1; }
.streaming-markdown pre > button.sm-copy-btn[data-copied="true"]::after { content: " ✓"; }
```

## Reference

**Selector.** A settled fenced block is `<pre><code class="hljs lang-<label>">…`
(`renderFencedBlock`, `src/render-blocks.ts`). Both classes sit on the `<code>`.

```js
sink.querySelectorAll('pre:not(.stream-fence-forming) > code.hljs')
```

- Excludes indented code (`<pre><code>` with no class — add `pre > code:only-child`
  to include it), mermaid (`pre.mermaid`), and math (`pre.math`).
- `stream-fence-forming` marks a still-streaming fence; the class is swapped off in
  place on commit, so a block starts matching the moment it completes.

**Copy source, not markup.** After highlighting, the `<code>` interior is
`<span class="hljs-…">` tokens. `code.textContent` flattens them back to the exact
source and works identically before/after the upgrade. Reading from `<code>` (not
`<pre>`) keeps an in-`<pre>` button out of the copied text. `textContent` keeps the
trailing newline; strip with `.replace(/\n$/, '')` if unwanted.

**Upgrades to survive.** The plain→highlighted re-render and mermaid/math hydration
are in-place morphs. The `MutationObserver` re-attach covers the first; the
`code.hljs` selector never targets diagrams/math, so they need no handling.

**Zero-flicker alternative.** Re-attach recreates the button for one frame on a full
re-render. To avoid it, position the button as a child of a `position: relative`
wrapper *outside* the sink, aligned over the block via `getBoundingClientRect` — the
emitter can't touch it. Same delegation and `textContent` rules apply.

## Clipboard notes

`navigator.clipboard.writeText` needs a secure context (HTTPS/localhost) and a user
gesture (the click). The snippet falls back to a hidden `<textarea>` +
`execCommand('copy')` for insecure contexts and older engines.

---

# Auto-scroll to the bottom while streaming

Keep the newest line in view as content grows, without fighting a reader who scrolls up.

## The catch

The document grows on every `update()`. Three things bite:

1. **Ease vs. pin.** Animating toward `scrollHeight` lags a target that moves every frame
   and reads as judder. Assign `scrollTop = scrollHeight` directly — the stream reveals
   sub-line increments, so a direct pin looks continuous.
2. **`scroll-behavior: smooth`.** A page-level smooth rule can make some engines animate
   the programmatic pin (so it never catches up). Set the scroll pane to
   `scroll-behavior: auto`.
3. **Respect the user.** Once they scroll up to read, stop pinning; resume only when they
   return to the bottom. Track a `stick` flag off the pane's own scroll events.
4. **Native scroll anchoring.** Engines adjust `scrollTop` on layout growth to hold an
   in-view node steady — with a per-frame JS pin that is two writers per frame and reads
   as shimmer. Set `overflow-anchor: none` on panes you scroll yourself.

## Snippet

```js
export function installAutoScroll(pane) {
  let stick = true;
  // A user scroll that leaves the bottom releases the pin; returning re-arms it.
  pane.addEventListener('scroll', () => {
    stick = pane.scrollHeight - pane.clientHeight - pane.scrollTop < 4;
  });
  // Call after each update() (or from a MutationObserver on the sink).
  return function follow() {
    if (stick) pane.scrollTop = pane.scrollHeight;
  };
}
```

```css
/* Instant pin even under page-level smooth scrolling; no anchoring fights. */
.chat-pane { overflow-y: auto; scroll-behavior: auto; overflow-anchor: none; }
```

The `< 4` px threshold absorbs sub-pixel rounding; widen it if your line-height is large.
Keep the `stick` override even in a showcase: the in-pane footnote navigation recipe below
scrolls the pane on click, and an unconditional pin snaps it straight back.

## CSS scroll-snap variant (zero scroll JS)

The pin can be pure CSS: make the pane a snap container and snap to a 1px sentinel kept
as its **last child** — the engine itself re-pins after every layout growth, and
`proximity` releases the pin when the reader scrolls away and re-arms when they return
(the `stick` flag for free):

```css
.chat-pane { scroll-snap-type: y proximity; scroll-behavior: auto; overflow-anchor: none; }
.chat-pane .snap-anchor { scroll-snap-align: end; height: 1px; }
```

The sentinel must stay the last child — re-append it after any wholesale `innerHTML`
replace. Two caveats: re-snap-on-growth timing is less uniform across engines than the
JS pin, so check your target browsers; and a snapped-to-bottom pane keeps a committed
footnotes section in view while streaming, so pair it with the footnotes recipe below.
The docs demo and playground use this variant.

---

# Keep footnote links inside a scroll container

GFM footnotes emit `<sup class="footnote-ref"><a href="#fn-…">` references and
`<a href="#fnref-…" class="footnote-backref">` backrefs. Inside a fixed-height message
pane, the default `#id` jump is wrong.

## The catch

A bare fragment jump scrolls **every** scrollable ancestor to reveal the target — including
the page (animated by any `html { scroll-behavior: smooth }`) — and stamps the URL hash. In
a chat pane that yanks the whole page and leaves a stale `#fn-…` in the address bar.

## Snippet

Intercept clicks on the footnote anchors, scroll only the pane they live in, and leave the
page and hash untouched. One delegated listener; survives re-renders.

```js
export function installFootnoteNav(root = document) {
  function scrollingAncestor(el) {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return null;
  }
  root.addEventListener('click', (e) => {
    const a = e.target.closest('sup.footnote-ref a[href^="#"], a.footnote-backref[href^="#"]');
    if (!a) return;
    const pane = scrollingAncestor(a);
    if (!pane) return; // not in a scroll pane — let the browser handle it
    const target = pane.querySelector(`#${CSS.escape(decodeURIComponent(a.getAttribute('href').slice(1)))}`);
    if (!target) return;
    e.preventDefault();
    const top = pane.scrollTop + (target.getBoundingClientRect().top - pane.getBoundingClientRect().top) - 12;
    pane.scrollTo({ top, behavior: 'smooth' });
  });
}
```

The `- 12` leaves breathing room above the target. `behavior: 'smooth'` overrides the pane's
own `scroll-behavior`, so this stays smooth even when the pane is set to `auto` for the
auto-scroll pin above. Works for refs (jump down to the definition) and backrefs (jump back
up to the reference) alike, and for any scroll pane since it walks up to the nearest one.

# External-link `rel` / `target` attributes

The built-in link output is neutral (#112): a rendered `<a>` carries only
`href` (and `title`). When the markdown is **untrusted model/agent output**,
external links in it are attacker-influenceable, so you likely want what
GitHub emits on user content — `rel="nofollow ugc noopener noreferrer"` and
`target="_blank"` on external links. That is a host policy, so it rides the
`linkDecorator` seam rather than changing the default (decision in #218).

## Snippet

A decorator **replaces** the neutral default, so re-emit `title` yourself:

```ts
import { renderMarkdown, escapeHtml, type MarkdownConfig } from '@copse/streaming-markdown'

const untrustedLinkDecorator = ({ href, title }) => {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
  const external = /^https?:\/\//i.test(href)
  return external
    ? `${titleAttr} rel="nofollow ugc noopener noreferrer" target="_blank"`
    : titleAttr
}

const config: MarkdownConfig = { linkDecorator: untrustedLinkDecorator }
renderMarkdown(markdown, config)
```

The same `config` works for `renderStreamingMarkdown` and
`new StreamingMarkdownRenderer(host, config)`. Scheme safety is separate and
always on — dangerous schemes are already rejected by the allowlist before the
decorator runs; layer `MarkdownConfig.linkImagePolicy` on top to restrict
which *origins* links may point at (see EXTENDING.md).

# Keep the footnotes section out of the way while streaming

A footnote *definition* commits the trailing `<section class="footnotes">` the
moment it lands — mid-reply for real LLM output. The renderer pins the section
below the streaming tail (#220), which is the correct final-document order,
but if your auto-scroll pins the pane to the **container bottom**, the section
is what sits in view, juddering, while the actual text streams above it.

The renderer can't defer the section itself: it only ever sees a growing
string, so it has no end-of-stream signal, and keying on "no pending tail"
would flicker the section in and out at every blank line between blocks. Both
fixes below live in the host, which knows more than the renderer does.

## Hide the section while the stream is live (what the demo uses)

Hide the section under a class toggled **once per stream** — on at the first
token, off at close — so it appears exactly once, settled. This is the natural
partner of the CSS scroll-snap pin above (a snapped-to-bottom pane would
otherwise keep the section in view):

```css
.is-streaming section.footnotes { display: none; }
```

Two things to handle: don't derive the toggle from render state (e.g. "no
pending element right now") — that flickers at every blank line between
blocks; and guard in-pane footnote-link clicks while hidden (the target has no
box to scroll to — check `target.getClientRects().length`). At settle, after
dropping the class, one smooth scroll to the bottom brings the revealed
section into view — skip it when the reader has scrolled away.

## Or: anchor a JS follow above the section

If you have no reliable stream lifecycle to key the hide on, follow the newest
**content** instead of the container bottom: while a trailing footnotes
section exists, scroll so the pane ends at the section's top. The section
stays rendered — just below the fold, like any content the reader hasn't
scrolled to yet — the streaming tail stays in view, nothing hides or pops in,
and **no end-of-stream signal is needed**:

```js
function followTarget(el) {
  const section = el.querySelector('section.footnotes')
  if (section) {
    const top = section.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    return Math.max(0, top - el.clientHeight)
  }
  return Math.max(0, el.scrollHeight - el.clientHeight)
}
// per update (combined with the auto-scroll recipe's `stick` flag, measured
// against followTarget rather than scrollHeight):
//   if (stick) host.scrollTop = followTarget(host)
// when the stream ends (only if still stuck):
//   host.scrollTo({ top: host.scrollHeight, behavior: 'smooth' })
```

This composes with the auto-scroll recipe's JS pin — same `stick` override,
same `overflow-anchor: none`, just a section-aware target — and with the
in-pane footnote-navigation recipe: a mid-stream click on a ref scrolls down
into the below-the-fold section, the `stick` flag releases, and the reader can
jump back with the backref. Cache the section lookup if you call it per frame
— it is a stable, frozen node once committed.

Footnote *references* keep upgrading to numbered links live under both
patterns; only the section's presentation differs — hidden until settle, or
rendered just below the fold.
