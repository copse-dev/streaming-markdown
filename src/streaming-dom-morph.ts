// Minimal DOM reconciliation for the committed-markdown subtree.
//
// Streaming re-renders the whole "safe prefix" of committed markdown whenever it
// grows, but assigning `container.innerHTML` tears down and rebuilds every node —
// including already-committed blocks that did not change. That full-subtree
// replacement is what makes pending→committed transitions jump: sibling blocks
// lose node identity, so a host cannot animate the promotion and the browser
// reflows the entire block.
//
// `morphInnerHtml` produces the *same* serialized output as `innerHTML = html`
// (so streaming convergence is unaffected) while preserving the identity of every
// node whose open tag and attributes are unchanged. A node is only reused when it
// is structurally interchangeable with its counterpart, which keeps the
// serialization byte-for-byte identical to a fresh parse.

import { setPresanitizedHtml } from './html-sink.ts'

const TEXT_NODE = 3
const ELEMENT_NODE = 1
const COMMENT_NODE = 8

function attributesEqual(a: Element, b: Element): boolean {
  const aAttrs = a.attributes
  const bAttrs = b.attributes
  if (aAttrs.length !== bAttrs.length) return false
  for (let i = 0; i < aAttrs.length; i++) {
    const aAttr = aAttrs[i]
    const bAttr = bAttrs[i]
    if (!aAttr || !bAttr) return false
    if (aAttr.name !== bAttr.name || aAttr.value !== bAttr.value) return false
  }
  return true
}

/**
 * Reusable iff the node can stand in for `next` without changing serialization:
 * same node type, and for elements the same tag and identical attribute list
 * (names, values, and order). Children are reconciled separately.
 */
function canReuse(node: Node, next: Node): boolean {
  if (node.nodeType !== next.nodeType) return false
  if (node.nodeType === ELEMENT_NODE) {
    return (
      (node as Element).tagName === (next as Element).tagName &&
      attributesEqual(node as Element, next as Element)
    )
  }
  if (node.nodeType === TEXT_NODE) return true
  if (node.nodeType === COMMENT_NODE) return true
  /* c8 ignore start -- unreachable: rendered-markdown subtrees contain only
     element, text, and comment nodes; other node types never appear. */
  return false
  /* c8 ignore stop */
}

/**
 * Reconcile `parent`'s children in place so those from `offset` onward match
 * `template`'s children, reusing existing nodes wherever `canReuse` holds. Nodes
 * before `offset` are left untouched (used to protect a frozen prefix, #21).
 * Nodes taken from `template` are moved into `parent`; `template` is left
 * partially emptied and discarded by the caller.
 */
function morphChildren(parent: Node, template: Node, offset = 0): void {
  const nextChildren = Array.from(template.childNodes)
  for (let i = 0; i < nextChildren.length; i++) {
    const next = nextChildren[i]
    if (!next) continue
    const current = parent.childNodes[offset + i]
    if (!current) {
      parent.appendChild(next)
      continue
    }
    if (canReuse(current, next)) {
      if (current.nodeType === ELEMENT_NODE) {
        morphChildren(current, next)
      } else if (current.nodeType === TEXT_NODE || current.nodeType === COMMENT_NODE) {
        if ((current as CharacterData).data !== (next as CharacterData).data) {
          ;(current as CharacterData).data = (next as CharacterData).data
        }
      }
    } else {
      parent.replaceChild(next, current)
    }
  }
  while (parent.childNodes.length > offset + nextChildren.length) {
    parent.lastChild?.remove()
  }
}

/**
 * Set `container`'s contents to `html`, reusing existing nodes where possible so
 * unchanged blocks keep their identity across the update. The resulting
 * serialization is identical to `container.innerHTML = html`.
 */
export function morphInnerHtml(container: HTMLElement, html: string): void {
  // Reconcile the whole child list. `morphInnerHtmlFrom(_, 0, '')` trims every
  // child (equivalent to `replaceChildren()`), so the empty case needs no
  // special-casing here.
  morphInnerHtmlFrom(container, 0, html)
}

/**
 * Like {@link morphInnerHtml} but reconciles only the children from `startIndex`
 * onward, leaving the first `startIndex` children (a frozen prefix) untouched.
 * The resulting serialization of the `[startIndex, …)` region is identical to
 * having assigned that region via `innerHTML` (#21).
 */
export function morphInnerHtmlFrom(container: HTMLElement, startIndex: number, html: string): void {
  if (html === '') {
    while (container.childNodes.length > startIndex) container.lastChild?.remove()
    return
  }
  // Shallow-clone the container so `html` parses in an identical context to
  // `container.innerHTML = html`, guaranteeing byte-identical serialization.
  // Callers pass sanitized markup; the sink helper only routes the assignment
  // through the Trusted Types policy when one is active.
  const template = container.cloneNode(false) as HTMLElement
  setPresanitizedHtml(template, html)
  morphChildren(container, template, startIndex)
}

/**
 * Reconcile `el`'s children from `offset` onward against `template`'s children,
 * leaving the first `offset` children untouched. Used for intra-list freezing
 * (#29): the frozen `<li>` prefix of a still-growing `<ul>` is never touched,
 * only the items after it are reconciled. Nodes are moved out of `template`.
 */
export function morphElementChildrenFrom(el: Element, template: Element, offset: number): void {
  morphChildren(el, template, offset)
}

/**
 * Make `el`'s attribute list byte-identical (names, values, and order) to
 * `template`'s, without touching children. A shared streaming list element can
 * legitimately change attributes while its frozen items must not be re-rendered
 * — e.g. `<ul>` gaining `class="contains-task-list"` when a later item adds a
 * checkbox (#29).
 */
export function syncAttributes(el: Element, template: Element): void {
  if (attributesEqual(el, template)) return
  while (el.attributes.length > 0) {
    const attr = el.attributes[0]
    if (!attr) break
    el.removeAttribute(attr.name)
  }
  for (let i = 0; i < template.attributes.length; i++) {
    const attr = template.attributes[i]
    if (attr) el.setAttribute(attr.name, attr.value)
  }
}
