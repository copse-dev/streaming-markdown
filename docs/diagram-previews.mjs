// Demo presentation only: the markdown emitters continue to own the source <pre>.
// Render detached, then attach a complete sanitized preview without changing its box.
export function createDiagramPreviews({ hydrate, renderer, transformSvg }) {
  const states = new WeakMap();
  function update(root) {
    if (!root) return;
    let state = states.get(root);
    if (!state) states.set(root, state = { cache: new Map(), version: 0 });
    const version = ++state.version;
    const active = new Set();
    const containers = [...root.querySelectorAll('.mermaid-diagram')];
    containers.forEach((container, index) => {
      if (container.closest('.stream-fence-forming, .stream-pending, .stream-forming')) return;
      const pre = container.querySelector('pre.mermaid');
      const source = pre?.textContent ?? '';
      if (!source.trim()) return;
      const key = index + ':' + source;
      active.add(key);
      let entry = state.cache.get(key);
      if (!entry) {
        const detached = document.createElement('div');
        detached.className = 'mermaid-diagram mermaid-diagram--pending';
        const copy = document.createElement('pre');
        copy.className = 'mermaid';
        copy.textContent = source;
        detached.append(copy);
        entry = { result: null, expanded: false, output: null, button: null };
        state.cache.set(key, entry);
        const current = entry;
        current.promise = Promise.resolve().then(() => hydrate(detached, {
          renderer, transformSvg,
        })).then(() => {
          current.result = detached.querySelector('svg') ?? false;
        }).catch(() => { current.result = false; });
      }
      const apply = () => {
        // A later update/reset may have replaced the container or changed its source.
        if (state.version !== version || !root.contains(container) ||
            pre.textContent !== source || container.querySelector('.diagram-preview-output')) return;
        if (entry.result === false) {
          container.classList.add('diagram-preview-error');
          return;
        }
        if (!entry.result) return;
        if (!entry.output) {
          entry.output = document.createElement('div');
          entry.output.className = 'diagram-preview-output';
          entry.output.append(entry.result);
          entry.button = document.createElement('button');
          entry.button.type = 'button';
          entry.button.className = 'diagram-preview-toggle';
          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          icon.setAttribute('viewBox', '0 0 24 24');
          icon.setAttribute('aria-hidden', 'true');
          icon.setAttribute('focusable', 'false');
          const path = document.createElementNS(icon.namespaceURI, 'path');
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', 'currentColor');
          path.setAttribute('stroke-width', '1.75');
          path.setAttribute('stroke-linecap', 'round');
          path.setAttribute('stroke-linejoin', 'round');
          icon.append(path);
          entry.button.append(icon);
          entry.button.addEventListener('click', () => {
            entry.expanded = !entry.expanded;
            syncExpansion(entry.button.closest('.mermaid-diagram'), entry);
          });
        }
        // Full string updates and reference backpatches may replace the wrapper.
        // Move the existing preview back rather than recreate its SVG and controls.
        container.append(entry.output, entry.button);
        syncExpansion(container, entry);
        container.classList.add('diagram-preview-ready');
      };
      if (entry.result !== null) apply();
      else void entry.promise.then(apply);
    });
    // Keep all diagrams in the current document, plus a small replay history.
    // Evicting live entries would re-render long string-pane documents every tick.
    for (const key of state.cache.keys()) {
      if (state.cache.size <= Math.max(32, active.size)) break;
      if (!active.has(key)) state.cache.delete(key);
    }
  }
  return { update };
}

function syncExpansion(container, entry) {
  container.classList.toggle('diagram-preview-expanded', entry.expanded);
  const label = entry.expanded ? 'Collapse diagram' : 'Expand diagram';
  entry.button.setAttribute('aria-label', label);
  entry.button.title = label;
  entry.button.querySelector('path').setAttribute('d', entry.expanded
    ? 'M4 14h6v6 M10 14l-7 7 M20 10h-6V4 M14 10l7-7'
    : 'M15 3h6v6 M21 3l-7 7 M9 21H3v-6 M3 21l7-7');
  entry.button.setAttribute('aria-expanded', String(entry.expanded));
}

// Compare the underlying Markdown output, independently of async preview timing.
export function removeDiagramPreviews(root) {
  root.querySelectorAll('.diagram-preview-output, .diagram-preview-toggle').forEach(el => el.remove());
  root.querySelectorAll('.mermaid-diagram').forEach(el => {
    el.classList.remove('diagram-preview-ready', 'diagram-preview-error', 'diagram-preview-expanded');
  });
}
