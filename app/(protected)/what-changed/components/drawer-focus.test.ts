import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import {
  activateDrawerFocus,
  drawerFocusableElements,
  handleDrawerKeyboard,
} from './drawer-focus.ts'

test('drawer is absent from closed tab order and contains focus while open', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <button id="opener">Open details</button>
    <aside id="drawer" aria-hidden="true" inert tabindex="-1">
      <button id="close">Close</button>
      <a id="action" href="#review">Review</a>
    </aside>
    <button id="after">After drawer</button>
  </body>`)
  const document = dom.window.document
  const opener = document.querySelector<HTMLElement>('#opener')!
  const panel = document.querySelector<HTMLElement>('#drawer')!
  const close = document.querySelector<HTMLElement>('#close')!
  const action = document.querySelector<HTMLElement>('#action')!
  const after = document.querySelector<HTMLElement>('#after')!

  assert.deepEqual(drawerFocusableElements(document.body).map((element) => element.id), ['opener', 'after'])

  panel.removeAttribute('inert')
  panel.setAttribute('aria-hidden', 'false')
  opener.focus()
  const restoreFocus = activateDrawerFocus(panel, close)
  assert.equal(document.activeElement, close)

  action.focus()
  const forward = new dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
  handleDrawerKeyboard(forward, panel, () => assert.fail('Tab must not close the drawer'))
  assert.equal(forward.defaultPrevented, true)
  assert.equal(document.activeElement, close)

  close.focus()
  const backward = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })
  handleDrawerKeyboard(backward, panel, () => assert.fail('Shift+Tab must not close the drawer'))
  assert.equal(backward.defaultPrevented, true)
  assert.equal(document.activeElement, action)

  let closed = false
  handleDrawerKeyboard(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }), panel, () => { closed = true })
  assert.equal(closed, true)
  restoreFocus()
  assert.equal(document.activeElement, opener)
  assert.equal(after.id, 'after')
  dom.window.close()
})
