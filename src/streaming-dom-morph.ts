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
  return false
}

/**
 * Reconcile `parent`'s children in place so they match `template`'s children,
 * reusing existing nodes wherever `canReuse` holds. Nodes taken from `template`
 * are moved into `parent`; `template` is left partially emptied and discarded by
 * the caller.
 */
function morphChildren(parent: Node, template: Node): void {
  const nextChildren = Array.from(template.childNodes)
  for (let i = 0; i < nextChildren.length; i++) {
    const next = nextChildren[i]
    if (!next) continue
    const current = parent.childNodes[i]
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
  while (parent.childNodes.length > nextChildren.length) {
    parent.lastChild?.remove()
  }
}

/**
 * Set `container`'s contents to `html`, reusing existing nodes where possible so
 * unchanged blocks keep their identity across the update. The resulting
 * serialization is identical to `container.innerHTML = html`.
 */
export function morphInnerHtml(container: HTMLElement, html: string): void {
  if (html === '') {
    container.replaceChildren()
    return
  }
  // Shallow-clone the container so `html` parses in an identical context to
  // `container.innerHTML = html`, guaranteeing byte-identical serialization.
  const template = container.cloneNode(false) as HTMLElement
  template.innerHTML = html
  morphChildren(container, template)
}
