import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { findChromium } from './tt-browser-harness.ts'
import type * as Viewer from '../src/mermaid-viewer.ts'

declare const DiagramViewer: typeof Viewer
const executablePath = findChromium()
if (!executablePath && process.env['E2E_REQUIRE_BROWSER'])
  throw new Error('Diagram viewer e2e requires Chromium')

it('resets a panned diagram to its bounded initial zoom', {
  skip: executablePath ? false : 'No Chromium installed',
}, async () => {
  const bundle = await build({
    entryPoints: ['src/mermaid-viewer.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'DiagramViewer',
  })
  const browser = await chromium.launch({ executablePath: executablePath! })
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
    await page.setContent('<div id="diagram" style="width:600px;height:350px;margin:40px"><svg width="300" height="150" viewBox="0 0 300 150"><rect x="100" y="50" width="100" height="50" rx="8" fill="#d8eaff"/><text x="150" y="80" text-anchor="middle">Diagram</text></svg></div>')
    await page.addStyleTag({ content: await readFile('styles/diagram-viewer.css', 'utf8') })
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    await page.evaluate(() => {
      const diagram = document.querySelector<HTMLElement>('#diagram')!
      DiagramViewer.attachDiagramViewer(diagram, { minScale: 2, maxScale: 4 })
    })
    const diagram = page.locator('#diagram')
    const reset = page.getByRole('button', { name: 'Reset zoom' })
    assert.equal(await diagram.getAttribute('data-viewer-scale'), '2')
    assert.equal(await reset.isDisabled(), true)
    await page.getByRole('button', { name: 'Zoom in' }).click()
    assert.equal(await diagram.getAttribute('data-viewer-scale'), '2.25')
    await page.mouse.move(300, 220)
    await page.mouse.down()
    await page.mouse.move(340, 240)
    await page.mouse.up()
    await reset.click()
    assert.equal(await diagram.getAttribute('data-viewer-scale'), '2')
    assert.equal(await reset.isDisabled(), true)
    assert.equal(await diagram.locator('svg').evaluate((svg) => svg.style.transform), 'translate(0px, 0px) scale(2)')
    const screenshots = await mkdtemp(join(tmpdir(), 'mermaid-viewer-'))
    const screenshot = join(screenshots, 'bounded-reset.png')
    await page.screenshot({ path: screenshot })
    console.log(`Viewer screenshot: ${screenshot}`)
  } finally {
    await browser.close()
  }
})

it('leaves host controls inside the diagram clickable and reports each view change', {
  skip: executablePath ? false : 'No Chromium installed',
}, async () => {
  const bundle = await build({
    entryPoints: ['src/mermaid-viewer.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'DiagramViewer',
  })
  const browser = await chromium.launch({ executablePath: executablePath! })
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
    await page.setContent('<div id="diagram" style="width:600px;height:350px;margin:40px;position:relative"><svg width="300" height="150" viewBox="0 0 300 150"><rect x="100" y="50" width="100" height="50" rx="8" fill="#d8eaff"/></svg></div>')
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    await page.evaluate(() => {
      const diagram = document.querySelector<HTMLElement>('#diagram')!
      const w = window as unknown as { clicks: string[]; changes: unknown[]; events: unknown[] }
      w.clicks = []
      w.changes = []
      w.events = []
      // Like a host toolbar: a light-DOM button and a custom element whose button sits in an
      // open shadow root, both inside the diagram element, with no opt-out marking.
      const light = document.createElement('button')
      light.textContent = 'Light'
      light.style.cssText = 'position:absolute;top:8px;left:8px'
      light.addEventListener('click', () => w.clicks.push('light'))
      const host = document.createElement('div')
      host.style.cssText = 'position:absolute;top:8px;left:120px'
      const shadowButton = host.attachShadow({ mode: 'open' }).appendChild(document.createElement('button'))
      shadowButton.textContent = 'Shadow'
      shadowButton.addEventListener('click', () => w.clicks.push('shadow'))
      diagram.append(light, host)
      diagram.addEventListener('mermaid-viewer-change', (e) => w.events.push((e as CustomEvent).detail))
      // A bound method, not an arrow: tsx would wrap a named property function in a `__name`
      // helper that does not exist in the page.
      DiagramViewer.attachDiagramViewer(diagram, { controls: false, onChange: w.changes.push.bind(w.changes) })
    })
    const diagram = page.locator('#diagram')
    const transform = () => diagram.locator('svg').evaluate((svg) => svg.style.transform)
    const read = <T>(key: 'clicks' | 'changes' | 'events') =>
      page.evaluate((k) => (window as unknown as Record<string, unknown>)[k], key) as Promise<T>

    const clicked: string[] = []
    for (const name of ['Light', 'Shadow']) {
      const button = page.getByRole('button', { name })
      await button.click()
      clicked.push(name.toLowerCase())
      assert.deepEqual(await read<string[]>('clicks'), clicked, `${name}: the click reached the button`)
      const box = (await button.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + 80, box.y + 60)
      assert.equal(await diagram.getAttribute('data-viewer-panning'), null, `${name}: no pan started`)
      await page.mouse.up()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -100)
      assert.equal(await diagram.getAttribute('data-viewer-scale'), '1', `${name}: wheel did not zoom`)
    }
    // The presses that left the button before release were not clicks.
    assert.deepEqual(await read<string[]>('clicks'), ['light', 'shadow'])
    assert.equal(await transform(), 'translate(0px, 0px) scale(1)')
    assert.deepEqual(await read<unknown[]>('changes'), [])

    // The rest of the diagram still zooms and pans, and each change is reported.
    await page.mouse.move(400, 300)
    await page.mouse.wheel(0, -100)
    await page.waitForFunction(() => document.querySelector('#diagram')!.getAttribute('data-viewer-scale') === '1.25')
    await page.mouse.down()
    await page.mouse.move(420, 310)
    await page.mouse.up()
    await diagram.focus()
    await page.keyboard.press('0')
    const bounds = { minScale: 0.5, maxScale: 3 }
    const views = await read<unknown[]>('changes')
    assert.deepEqual(views, [
      { scale: 1.25, x: 0, y: 0, ...bounds, atInitial: false },
      { scale: 1.25, x: 20, y: 10, ...bounds, atInitial: false },
      { scale: 1, x: 0, y: 0, ...bounds, atInitial: true },
    ])
    assert.deepEqual(await read<unknown[]>('events'), views)
    assert.equal(await transform(), 'translate(0px, 0px) scale(1)')
  } finally {
    await browser.close()
  }
})
