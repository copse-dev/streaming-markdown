# Host-UI recipes

Chat-UI chrome that sits *on top* of the rendered markdown — copy buttons on code
blocks, download links, streaming carets — is deliberately **not** shipped by the
core. The package stays host-independent and exposes a documented set of class
hooks (see the class contract in [`ARCHITECTURE.md`](ARCHITECTURE.md)); the host
owns the widgets. That keeps the renderer versionable on its own, but it means a
host has to implement these correctly, and the streaming emitter has one gotcha
that trips up the naïve version.

This is the first of a short "host-UI recipes" series. It covers **copy buttons on
code blocks**; carets and download affordances follow the same pattern and can be
added here later.

- [The one thing you must know: the emitter morphs the DOM](#the-one-thing-you-must-know-the-emitter-morphs-the-dom)
- [Locating code blocks (the class hooks)](#locating-code-blocks-the-class-hooks)
- [Reading clean source, not tokenized markup](#reading-clean-source-not-tokenized-markup)
- [Surviving the highlighter upgrade and mermaid/math hydration](#surviving-the-highlighter-upgrade-and-mermaidmath-hydration)
- [Accessibility and the clipboard](#accessibility-and-the-clipboard)
- [Copy-paste-ready snippet](#copy-paste-ready-snippet)
- [Where the demo shows it](#where-the-demo-shows-it)

## The one thing you must know: the emitter morphs the DOM

The incremental DOM emitter (`StreamingMarkdownRenderer.update`) does **not** append
tokens to the end of the message. On every `update()` it re-renders the committed
"safe prefix" of the document and **reconciles** it against the live DOM with a
minimal patch (`morphInnerHtml` in `src/streaming-dom-morph.ts`). Reconciliation
reuses a node only when it is structurally interchangeable with the freshly parsed
template — and, crucially, it **trims any child the template does not have**:

```js
// src/streaming-dom-morph.ts (morphChildren, simplified)
while (parent.childNodes.length > offset + nextChildren.length) {
  parent.lastChild?.remove()   // ← your appended button lives here, and dies here
}
```

So if you do the obvious thing — find a `<pre>`, `appendChild` a copy button — the
button is a child the renderer's template never produced. The **next** `update()`
that re-morphs that block deletes it. The same is true for a button appended as a
sibling anywhere inside the render sink, or inserted *before* a block (that one is
worse: it misaligns the index walk and gets replaced by the block it displaced).

Two consequences drive every correct pattern below:

1. **Never rely on a node you injected into the render sink persisting.** Treat the
   subtree as owned by the emitter. Either keep your widget **outside** the morphed
   subtree, or **re-attach it idempotently** after each morph.
2. **Never attach the click handler to the button element.** Even the correct
   re-attach recreates buttons, so a handler bound to the element is lost. Bind it
   **once**, via event delegation, to a stable ancestor that the emitter never
   touches.

> The re-attach cost is small in practice: once a code block commits it lands in the
> frozen prefix and is *not* re-morphed on every token (`#21` frozen-tail). It is
> re-morphed on a **full re-render** — most importantly the plain→highlighted upgrade
> (below) — which is exactly the event a `MutationObserver` catches for free.

## Locating code blocks (the class hooks)

Use the emitted classes, not positional DOM assumptions. A **settled** fenced code
block is always:

```html
<pre><code class="hljs lang-typescript">…</code></pre>
```

(from `renderFencedBlock` in `src/render-blocks.ts` →
`` `<pre><code class="${fenceCodeClass(lang)}">…` ``). The `<code>` carries **both**
`hljs` and `lang-<label>`; the `<pre>` has no class. The `lang-<label>` suffix is the
resolved language id (`ts` → `typescript`) or, for an unknown language, the escaped
info string; an empty info string yields `lang-text`.

So the stable selector for "a highlightable code block" is:

```js
sink.querySelectorAll('pre > code.hljs')
```

This deliberately **excludes**:

- **Indented code blocks** — they render as `<pre><code>…</code></pre>` with *no*
  class (`renderIndentedCode`), so they never match `code.hljs`. Add
  `pre > code:only-child` if you want those too.
- **Mermaid** (`<div class="mermaid-diagram"><pre class="mermaid">`) and **math**
  (`<pre class="math">` inside `.math-block--pending`/`--rendered`). These are fence
  *handlers*, not code fences — a copy-source button usually doesn't belong on a
  rendered diagram, and `code.hljs` skips them automatically.

**Forming (still-open) fences.** While a fence is streaming, the open block is
`<pre class="stream-fence-forming"><code class="hljs lang-*">` inside a
`.stream-forming` container (`FORMING_FENCE_PRE_CLASS` in
`src/fence-handlers.ts` / `src/streaming-fence-dom.ts`). It also matches
`pre > code.hljs`. You almost always want the button only on **complete** blocks, so
exclude the forming class:

```js
sink.querySelectorAll('pre:not(.stream-fence-forming) > code.hljs')
```

On commit the emitter swaps `stream-fence-forming` off the same `<pre>` in place
(color-only promotion), so the block starts matching your selector at exactly the
moment it is complete.

## Reading clean source, not tokenized markup

Once highlight.js runs, the `<code>` interior is a tree of `<span class="hljs-…">`
token elements, not a text node. **Do not read `innerHTML`** — you would copy
`<span class="hljs-keyword">const</span>…`, i.e. tokenized markup.

highlight.js only *wraps* the source; it never changes the characters. So the raw
source is recovered exactly by reading **`textContent`**, which flattens every token
span back to plain text:

```js
const source = codeEl.textContent   // clean source, plain OR highlighted
```

`textContent` works identically before and after the upgrade (in the plain fallback
the interior is already a single escaped text node), so your copy handler needs no
special case. Read it from the `<code>` element, not the `<pre>` — that way an
in-`<pre>` button (see the snippet) is never captured in the copied text.

The content is verbatim: interior blank lines and the first line's indentation are
preserved (`#598`). `textContent` typically ends with the code block's single
trailing newline (CommonMark code content includes it); strip it with
`source.replace(/\n$/, '')` if you would rather copy without it.

## Surviving the highlighter upgrade and mermaid/math hydration

The highlighter is lazy and pluggable. Before a backend is registered,
`highlightFenceCode` returns escaped plain text — but `fenceCodeClass` *already*
put the final `hljs lang-*` class on the element. When `setCodeHighlighter` (or
`loadHighlightjs()`) arrives and the host re-renders, only the `<code>` **interior**
swaps from a text node to token spans; **the element and its class are unchanged**.

For the morph that means: `canReuse(<code>)` stays true (same tag, same attributes),
so the emitter recurses into the `<code>` and replaces its *children*. Any button you
parked inside the surrounding `<pre>` is trimmed by the same pass. This is the single
most common way a hand-rolled copy button vanishes: it works during the stream, then
disappears the instant the grammar chunk loads. The re-attach hook handles it — a
`MutationObserver` on the sink fires on the upgrade morph and puts the button back;
delegation means the handler still works on the fresh button.

**Mermaid and math** hydrate *after* sink sanitization by injecting SVG/HTML into
their `--pending` scaffolding (`hydratePendingDiagrams`, `hydratePendingMath`). Those
are in-place upgrades too. Because the recommended selector targets `code.hljs`, your
buttons never land on diagrams/math in the first place, so there is nothing to
survive — but if you decorate them anyway, the same rule applies: re-attach after the
mutation rather than assuming persistence.

## Accessibility and the clipboard

- Render a real `<button type="button">` with an **`aria-label`** ("Copy code"). If
  the visible affordance is an icon, the label is the only thing a screen reader
  announces.
- Communicate the **copied state**: swap the label/visible text to "Copied", and
  announce it. The snippet updates `aria-label` and toggles a `data-copied`
  attribute you can style; revert after ~1.5 s. Keep focus on the button.
- Prefer **`navigator.clipboard.writeText`** — it is async and needs a secure
  context (HTTPS/localhost) and a user gesture, which the click provides. Fall back
  to a hidden `<textarea>` + `document.execCommand('copy')` for insecure contexts or
  older engines, and surface a failure state if both throw.

## Copy-paste-ready snippet

Framework-agnostic, zero-dependency. Call `installCopyButtons(sink)` **once**, right
after you create the element you stream into (the same element you add the
`streaming-markdown` class to). It survives the streaming morph, the plain→highlighted
upgrade, and mermaid/math hydration.

```js
/**
 * Add copy buttons to code blocks rendered by @copse/streaming-markdown.
 * `sink` is the element you stream into (StreamingMarkdownRenderer's target,
 * or the container renderStreamingMarkdown writes to).
 */
export function installCopyButtons(sink) {
  const RESET_MS = 1500

  // 1. Handler is bound ONCE to the stable sink, never to a button — the emitter
  //    recreates buttons, but delegated listeners on the sink are never lost.
  sink.addEventListener('click', async (event) => {
    const btn = event.target.closest('button.sm-copy-btn')
    if (!btn || !sink.contains(btn)) return
    const code = btn.parentElement?.querySelector('code')
    if (!code) return

    // Read the SOURCE, not the tokenized markup: textContent flattens
    // highlight.js token spans back to the raw characters.
    const source = code.textContent ?? ''
    const ok = await copyText(source)

    btn.dataset.copied = ok ? 'true' : 'false'
    btn.setAttribute('aria-label', ok ? 'Copied' : 'Copy failed')
    clearTimeout(btn._t)
    btn._t = setTimeout(() => {
      delete btn.dataset.copied
      btn.setAttribute('aria-label', 'Copy code')
    }, RESET_MS)
  })

  // 2. (Re)attach buttons idempotently. Runs after every morph, so a button the
  //    reconciler trimmed (streaming, or the plain→highlighted upgrade) comes
  //    back. Skips forming fences so the button appears only on complete blocks.
  function decorate() {
    for (const code of sink.querySelectorAll('pre:not(.stream-fence-forming) > code.hljs')) {
      const pre = code.parentElement
      if (pre.querySelector(':scope > button.sm-copy-btn')) continue // idempotent
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'sm-copy-btn'
      btn.setAttribute('aria-label', 'Copy code')
      btn.textContent = 'Copy'
      pre.appendChild(btn) // last child: trimmed cleanly, never misaligns <code>
    }
  }

  // 3. A MutationObserver is the emitter-agnostic hook — it fires on the streaming
  //    morph AND on the one-shot highlighter upgrade, for both emitters. If you
  //    drive StreamingMarkdownRenderer yourself you can instead call decorate()
  //    synchronously after each renderer.update(chunk).
  const mo = new MutationObserver(() => decorate())
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
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
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

Minimal styling (the button lives inside the `<pre>`; position it with `position:
relative` on the ancestor code block):

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

Because the button is a child of `<pre>` and a *sibling* of `<code>`, it is invisible
to `code.textContent`, so it is never part of the copied source.

### Alternative: an overlay outside the sink (zero re-attach flicker)

The re-attach above re-creates a button for one frame on each full re-render, which
can flicker on the highlighter upgrade. If you need it perfectly stable, keep the
button **out of the morphed subtree** entirely: wrap the sink in a
`position: relative` host, and for each `pre > code.hljs` create an absolutely
positioned button as a child of the **host** (a sibling of the sink), aligned over
the code block via `getBoundingClientRect`, updated on scroll/resize. It is more
code, but the emitter can never touch it because it lives outside the element it
owns. The delegation + `textContent` reading rules are identical.

## Where the demo shows it

The live demo ([`docs/index.html`](index.html)) streams a **Code** preset
(`data-preset="code"`) through `StreamingMarkdownRenderer` and flips the highlighter
with the toggle, so it exercises exactly the morph + plain→highlighted upgrade this
recipe targets. It does not ship copy buttons itself (the same host-independence
reason), but its render sinks are the element you would pass to
`installCopyButtons`, and the highlighter toggle is the fastest way to confirm your
button survives the upgrade.
