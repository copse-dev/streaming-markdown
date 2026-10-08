import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { attachDiagramViewer, DIAGRAM_VIEWER_CLASS } from './mermaid-viewer.ts'

function diagramWithFrame(): { diagram: HTMLElement; frame: HTMLIFrameElement } {
  const diagram = document.createElement('div')
  diagram.className = 'mermaid-diagram mermaid-diagram--isolated'
  const frame = document.createElement('iframe')
  diagram.append(frame)
  document.body.append(diagram)
  return { diagram, frame }
}

const pointer = (type: string, init: PointerEventInit): PointerEvent =>
  new window.PointerEvent(type, { bubbles: true, button: 0, isPrimary: true, pointerId: 1, ...init })

describe('attachDiagramViewer', () => {
  it('adds labelled controls before the frame without moving it, and zooms within bounds', () => {
    const { diagram, frame } = diagramWithFrame()
    const removed: Node[] = []
    const observer = new window.MutationObserver((records) =>
      records.forEach((record) => removed.push(...record.removedNodes)),
    )
    observer.observe(diagram, { childList: true })
    const viewer = attachDiagramViewer(diagram, {
      labels: { zoomIn: 'Agrandir', zoomOut: 'Réduire', reset: 'Réinitialiser', toolbar: 'Contrôles' },
      maxScale: 1.5,
    })
    const toolbar = diagram.querySelector<HTMLElement>(`.${DIAGRAM_VIEWER_CLASS}__toolbar`)!
    assert.equal(toolbar.nextElementSibling, frame)
    assert.equal(toolbar.getAttribute('role'), 'toolbar')
    assert.equal(toolbar.getAttribute('aria-label'), 'Contrôles')
    const labels = [...toolbar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    // jsdom has no Fullscreen API, so no full-screen button.
    assert.deepEqual(labels, ['Réduire', 'Agrandir', 'Réinitialiser'])
    assert.ok(diagram.classList.contains(DIAGRAM_VIEWER_CLASS))
    assert.equal(diagram.tabIndex, 0)
    assert.equal(frame.style.pointerEvents, 'none')
    const [zoomOut, zoomIn, reset] = [...toolbar.querySelectorAll('button')]
    assert.equal(reset!.disabled, true)
    zoomIn!.click()
    zoomIn!.click()
    zoomIn!.click()
    assert.equal(viewer.scale, 1.5)
    assert.equal(zoomIn!.disabled, true)
    assert.equal(frame.style.transform, 'translate(0px, 0px) scale(1.5)')
    for (let i = 0; i < 10; i++) zoomOut!.click()
    assert.equal(viewer.scale, 0.5)
    assert.equal(zoomOut!.disabled, true)
    reset!.click()
    assert.equal(viewer.scale, 1)
    assert.equal(reset!.disabled, true)
    observer.disconnect()
    assert.ok(!removed.includes(frame), 'the frame was never detached')
    viewer.dispose()
    diagram.remove()
  })

  it('zooms with the wheel, pans by dragging and with the keyboard, ignoring the toolbar', () => {
    const { diagram, frame } = diagramWithFrame()
    const viewer = attachDiagramViewer(diagram)
    diagram.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    assert.equal(viewer.scale, 1.25)
    diagram.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
    assert.equal(viewer.scale, 1)
    const toolbar = diagram.querySelector(`.${DIAGRAM_VIEWER_CLASS}__toolbar`)!
    toolbar.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    assert.equal(viewer.scale, 1)

    diagram.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 10 }))
    assert.ok('viewerPanning' in diagram.dataset)
    diagram.dispatchEvent(pointer('pointermove', { clientX: 90, clientY: 50 }))
    diagram.dispatchEvent(pointer('pointerup', { clientX: 90, clientY: 50 }))
    assert.equal(frame.style.transform, 'translate(80px, 40px) scale(1)')
    assert.ok(!('viewerPanning' in diagram.dataset))
    // A press on a control is not a drag.
    toolbar.dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 0 }))
    diagram.dispatchEvent(pointer('pointermove', { clientX: 500, clientY: 500 }))
    assert.equal(frame.style.transform, 'translate(80px, 40px) scale(1)')

    const key = (k: string) =>
      diagram.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    key('+')
    key('ArrowLeft')
    assert.equal(frame.style.transform, 'translate(120px, 40px) scale(1.25)')
    key('0')
    assert.equal(frame.style.transform, 'translate(0px, 0px) scale(1)')
    viewer.dispose()
    diagram.remove()
  })

  it('works without built-in controls or wheel zoom, and dispose restores the diagram', () => {
    const { diagram, frame } = diagramWithFrame()
    diagram.setAttribute('tabindex', '-1')
    frame.style.pointerEvents = 'auto'
    const viewer = attachDiagramViewer(diagram, { controls: false, wheel: false })
    assert.equal(diagram.querySelector('button'), null)
    diagram.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    assert.equal(viewer.scale, 1)
    viewer.zoomBy(0.5)
    viewer.panBy(5, 6)
    assert.equal(frame.style.transform, 'translate(5px, 6px) scale(1.5)')
    viewer.dispose()
    viewer.dispose()
    assert.ok(!diagram.classList.contains(DIAGRAM_VIEWER_CLASS))
    assert.equal(diagram.getAttribute('tabindex'), '-1')
    assert.equal(frame.style.transform, '')
    assert.equal(frame.style.pointerEvents, 'auto')
    assert.equal(diagram.style.overflow, '')
    assert.throws(() => attachDiagramViewer(document.createElement('div')), /no rendered diagram/)
    diagram.remove()
  })

  it('offers full screen where the Fullscreen API is available', () => {
    const { diagram } = diagramWithFrame()
    let requested = false
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true })
    diagram.requestFullscreen = async () => {
      requested = true
    }
    try {
      const viewer = attachDiagramViewer(diagram, { labels: { fullscreen: 'Plein écran' } })
      const button = diagram.querySelector<HTMLButtonElement>('[aria-label="Plein écran"]')!
      button.click()
      assert.equal(requested, true)
      viewer.dispose()
    } finally {
      Reflect.deleteProperty(document, 'fullscreenEnabled')
      diagram.remove()
    }
  })
})
