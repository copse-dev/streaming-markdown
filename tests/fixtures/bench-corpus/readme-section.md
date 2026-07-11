## Installation

```sh
npm install @acme/widget
```

`@acme/widget` ships ESM-first with type definitions and no runtime
dependencies. It targets Node 18+ and every evergreen browser.

## Usage

Import the component and mount it against a container element:

```ts
import { Widget } from '@acme/widget'

const widget = new Widget(document.querySelector('#app'), {
  theme: 'auto',        // 'light' | 'dark' | 'auto'
  density: 'comfortable',
})

widget.on('change', (value) => console.log('changed to', value))
widget.render()
```

### Options

| Option    | Type                          | Default         | Notes                          |
| --------- | ----------------------------- | --------------- | ------------------------------ |
| `theme`   | `'light' \| 'dark' \| 'auto'` | `'auto'`        | Follows `prefers-color-scheme` |
| `density` | `'compact' \| 'comfortable'`  | `'comfortable'` | Row height and padding         |
| `locale`  | `string`                      | `navigator.language` | BCP-47 tag                |

## Why another widget library?

Most widgets couple *rendering* to *state*, so they re-render the world on every
keystroke. `@acme/widget` keeps a **committed tree** and reconciles only the
changed subtree — the same incremental strategy a good streaming renderer uses.

- **Fast** — O(delta) updates, not O(tree).
- **Accessible** — ships ARIA roles and full keyboard support out of the box.
- **Themeable** — CSS custom properties only; no runtime style injection.

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).
