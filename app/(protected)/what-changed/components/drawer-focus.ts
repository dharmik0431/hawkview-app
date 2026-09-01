export const DRAWER_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export function drawerFocusableElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE_SELECTOR))
    .filter((element) =>
      !element.hasAttribute('hidden') &&
      !element.closest('[inert]') &&
      !element.closest('[aria-hidden="true"]'),
    )
}

export function activateDrawerFocus(panel: HTMLElement, preferred?: HTMLElement | null) {
  const document = panel.ownerDocument
  const HTMLElementConstructor = document.defaultView?.HTMLElement
  const previous = HTMLElementConstructor && document.activeElement instanceof HTMLElementConstructor
    ? document.activeElement as HTMLElement
    : null
  const target = preferred ?? drawerFocusableElements(panel)[0] ?? panel
  target.focus()
  return () => {
    if (previous?.isConnected) previous.focus()
  }
}

export function handleDrawerKeyboard(
  event: KeyboardEvent,
  panel: HTMLElement,
  onClose: () => void,
) {
  if (event.key === 'Escape') {
    onClose()
    return
  }
  if (event.key !== 'Tab') return

  const focusable = drawerFocusableElements(panel)
  if (focusable.length === 0) {
    event.preventDefault()
    panel.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = panel.ownerDocument.activeElement
  if (event.shiftKey && (active === first || !panel.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
    event.preventDefault()
    first.focus()
  }
}
