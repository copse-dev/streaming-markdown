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
