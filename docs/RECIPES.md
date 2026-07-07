# Host-UI recipes

Widgets layered on top of rendered markdown (copy buttons, download links, carets)
are not shipped by the core — the host owns them, using the emitted class hooks.
This covers **copy buttons on code blocks**.

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
