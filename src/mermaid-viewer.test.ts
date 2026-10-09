import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { attachDiagramViewer, DIAGRAM_VIEWER_CHANGE_EVENT, DIAGRAM_VIEWER_CLASS, type DiagramView } from './mermaid-viewer.ts'

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

  for (const bounds of [
    { minScale: 2, maxScale: 4, initialScale: 2, delta: 1 },
    { minScale: 0.25, maxScale: 0.75, initialScale: 0.75, delta: -0.25 },
    { minScale: 2, maxScale: 2, initialScale: 2, delta: 1 },
  ]) {
    it(`initializes and resets within ${bounds.minScale}–${bounds.maxScale}`, () => {
      const { diagram, frame } = diagramWithFrame()
      const viewer = attachDiagramViewer(diagram, bounds)
      const reset = diagram.querySelector<HTMLButtonElement>('.mermaid-viewer__button--reset')!
      assert.equal(viewer.scale, bounds.initialScale)
      assert.equal(reset.disabled, true)
      viewer.zoomBy(bounds.delta)
      viewer.panBy(20, 30)
      assert.equal(reset.disabled, false)
      reset.click()
      assert.equal(viewer.scale, bounds.initialScale)
      assert.equal(frame.style.transform, `translate(0px, 0px) scale(${bounds.initialScale})`)
      assert.equal(reset.disabled, true)
      viewer.panBy(10, 10)
      diagram.dispatchEvent(new window.KeyboardEvent('keydown', { key: '0', bubbles: true }))
      assert.equal(frame.style.transform, `translate(0px, 0px) scale(${bounds.initialScale})`)
      viewer.dispose()
      diagram.remove()
    })
  }

  it('rejects invalid bounds before changing the diagram', () => {
    for (const bounds of [
      { minScale: 0 }, { minScale: -1 }, { minScale: NaN }, { minScale: Infinity },
      { maxScale: 0 }, { maxScale: -1 }, { maxScale: NaN }, { maxScale: Infinity },
      { minScale: 4, maxScale: 2 },
    ]) {
      const { diagram } = diagramWithFrame()
      const before = diagram.outerHTML
      assert.throws(() => attachDiagramViewer(diagram, bounds), RangeError)
      assert.equal(diagram.outerHTML, before)
      diagram.remove()
    }
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

  it('reports every change once, through onChange and a bubbling event, and nothing else', () => {
    const { diagram, frame } = diagramWithFrame()
    const seen: DiagramView[] = []
    const events: DiagramView[] = []
    const onEvent = (event: Event) => events.push((event as CustomEvent<DiagramView>).detail)
    document.body.addEventListener(DIAGRAM_VIEWER_CHANGE_EVENT, onEvent)
    const viewer = attachDiagramViewer(diagram, { maxScale: 1.25, onChange: (view) => seen.push(view) })
    assert.equal(seen.length, 0, 'nothing on attach')
    assert.deepEqual(viewer.view, { scale: 1, x: 0, y: 0, minScale: 0.5, maxScale: 1.25, atInitial: true })

    const zoomIn = diagram.querySelector<HTMLButtonElement>('.mermaid-viewer__button--zoomIn')!
    zoomIn.click()
    zoomIn.click() // already at the maximum
    diagram.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    diagram.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
    diagram.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 10 }))
    diagram.dispatchEvent(pointer('pointermove', { clientX: 10, clientY: 10 })) // not moved yet
    diagram.dispatchEvent(pointer('pointermove', { clientX: 15, clientY: 12 }))
    diagram.dispatchEvent(pointer('pointerup', { clientX: 15, clientY: 12 }))
    diagram.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    viewer.panBy(0, 0)
    viewer.panBy(-5, 0)
    viewer.zoomBy(0.25)
    viewer.reset()
    viewer.reset()
    assert.deepEqual(
      seen.map(({ scale, x, y, atInitial }) => [scale, x, y, atInitial]),
      [
        [1.25, 0, 0, false], // button
        [1, 0, 0, true], // wheel back down
        [1, 5, 2, false], // drag
        [1, 5, 42, false], // key
        [1, 0, 42, false], // panBy
        [1.25, 0, 42, false], // zoomBy
        [1, 0, 0, true], // reset
      ],
    )
    assert.deepEqual(events, seen)
    assert.equal(seen[0]!.minScale, 0.5)
    assert.equal(seen[0]!.maxScale, 1.25)
    assert.deepEqual(viewer.view, seen.at(-1))

    viewer.panBy(1, 1)
    viewer.dispose()
    const count = seen.length
    viewer.zoomBy(0.25)
    viewer.panBy(10, 10)
    viewer.reset()
    assert.equal(seen.length, count, 'nothing after dispose')
    assert.equal(events.length, count)
    assert.equal(frame.style.transform, '', 'the handle no longer touches the diagram')
    document.body.removeEventListener(DIAGRAM_VIEWER_CHANGE_EVENT, onEvent)
    diagram.remove()
  })

  it('leaves presses, wheel and keys on host controls inside the diagram to those controls', () => {
    const { diagram, frame } = diagramWithFrame()
    const button = document.createElement('button')
    const link = Object.assign(document.createElement('a'), { href: '#x', textContent: 'link' })
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', '')
    const marked = document.createElement('div')
    marked.dataset['viewerIgnore'] = ''
    const markedChild = marked.appendChild(document.createElement('span'))
    const host = document.createElement('div')
    const shadowButton = host.attachShadow({ mode: 'open' }).appendChild(document.createElement('button'))
    const roleButton = host.shadowRoot!.appendChild(document.createElement('span'))
    roleButton.setAttribute('role', 'button')
    // Not interactive: still the viewer's.
    const plain = document.createElement('span')
    const notEditable = document.createElement('div')
    notEditable.setAttribute('contenteditable', 'false')
    diagram.append(button, link, editable, marked, host, plain, notEditable)
    const viewer = attachDiagramViewer(diagram, { controls: false })

    for (const el of [button, link, editable, markedChild, shadowButton, roleButton]) {
      el.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100, bubbles: true, composed: true, cancelable: true }))
      el.dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 0, composed: true }))
      assert.ok(!('viewerPanning' in diagram.dataset), `no drag from ${el.outerHTML}`)
      diagram.dispatchEvent(pointer('pointermove', { clientX: 50, clientY: 50 }))
      diagram.dispatchEvent(pointer('pointerup', { clientX: 50, clientY: 50 }))
      el.dispatchEvent(new window.KeyboardEvent('keydown', { key: '+', bubbles: true, composed: true }))
    }
    assert.equal(frame.style.transform, 'translate(0px, 0px) scale(1)')

    for (const el of [plain, notEditable]) {
      el.dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 0 }))
      assert.ok('viewerPanning' in diagram.dataset)
      diagram.dispatchEvent(pointer('pointerup', { clientX: 0, clientY: 0 }))
    }
    plain.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    assert.equal(viewer.scale, 1.25)
    viewer.dispose()
    diagram.remove()
  })

  it('stays active inside an editable or clickable ancestor', () => {
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    editor.setAttribute('role', 'button')
    const { diagram, frame } = diagramWithFrame()
    editor.append(diagram)
    document.body.append(editor)
    const viewer = attachDiagramViewer(diagram)
    diagram.dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 0 }))
    diagram.dispatchEvent(pointer('pointermove', { clientX: 7, clientY: 8 }))
    diagram.dispatchEvent(pointer('pointerup', { clientX: 7, clientY: 8 }))
    assert.equal(frame.style.transform, 'translate(7px, 8px) scale(1)')
    viewer.dispose()
    editor.remove()
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
