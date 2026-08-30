import assert from 'node:assert/strict'
import test from 'node:test'

import {
  handleDialogKeyboardBoundary,
  restoreDialogFocus,
} from './modal-tenant-onboarding.ts'

class FocusTarget {
  readonly name: string
  private readonly focusLog: string[]

  constructor(name: string, focusLog: string[]) {
    this.name = name
    this.focusLog = focusLog
  }

  focus() {
    this.focusLog.push(this.name)
  }

  getAttribute() {
    return null
  }
}

function keyboardEvent(key: string, shiftKey = false) {
  let prevented = false
  return {
    event: {
      key,
      shiftKey,
      preventDefault: () => { prevented = true },
    },
    prevented: () => prevented,
  }
}

test('dialog keyboard boundary handles initial focus and normal cycling', () => {
  const focusLog: string[] = []
  const first = new FocusTarget('first', focusLog)
  const middle = new FocusTarget('middle', focusLog)
  const last = new FocusTarget('last', focusLog)
  const title = new FocusTarget('title', focusLog)
  const outside = new FocusTarget('outside', focusLog)
  const dialog = {
    querySelectorAll: () => [first, middle, last],
  }
  const closed: string[] = []

  const initialBack = keyboardEvent('Tab', true)
  handleDialogKeyboardBoundary({
    event: initialBack.event,
    dialog,
    activeElement: title,
    closeDisabled: false,
    onClose: () => closed.push('close'),
  })
  assert.equal(initialBack.prevented(), true)
  assert.deepEqual(focusLog, ['last'])

  focusLog.length = 0
  const initialForward = keyboardEvent('Tab')
  handleDialogKeyboardBoundary({
    event: initialForward.event,
    dialog,
    activeElement: title,
    closeDisabled: false,
    onClose: () => closed.push('close'),
  })
  assert.equal(initialForward.prevented(), true)
  assert.deepEqual(focusLog, ['first'])

  focusLog.length = 0
  const outsideForward = keyboardEvent('Tab')
  handleDialogKeyboardBoundary({
    event: outsideForward.event,
    dialog,
    activeElement: outside,
    closeDisabled: false,
    onClose: () => closed.push('close'),
  })
  assert.equal(outsideForward.prevented(), true)
  assert.deepEqual(focusLog, ['first'])

  focusLog.length = 0
  const ordinaryForward = keyboardEvent('Tab')
  handleDialogKeyboardBoundary({
    event: ordinaryForward.event,
    dialog,
    activeElement: middle,
    closeDisabled: false,
    onClose: () => closed.push('close'),
  })
  assert.equal(ordinaryForward.prevented(), false)
  assert.deepEqual(focusLog, [])

  const wrapForward = keyboardEvent('Tab')
  handleDialogKeyboardBoundary({
    event: wrapForward.event,
    dialog,
    activeElement: last,
    closeDisabled: false,
    onClose: () => closed.push('close'),
  })
  assert.equal(wrapForward.prevented(), true)
  assert.deepEqual(focusLog, ['first'])

  focusLog.length = 0
  const wrapBack = keyboardEvent('Tab', true)
  handleDialogKeyboardBoundary({
    event: wrapBack.event,
    dialog,
    activeElement: first,
    closeDisabled: false,
    onClose: () => closed.push('close'),
  })
  assert.equal(wrapBack.prevented(), true)
  assert.deepEqual(focusLog, ['last'])
  assert.deepEqual(closed, [])
})

test('Escape closes when allowed and focus restoration targets the opener', () => {
  const focusLog: string[] = []
  const opener = new FocusTarget('opener', focusLog)
  let closeCount = 0
  const escape = keyboardEvent('Escape')

  handleDialogKeyboardBoundary({
    event: escape.event,
    dialog: null,
    activeElement: null,
    closeDisabled: false,
    onClose: () => { closeCount += 1 },
  })
  restoreDialogFocus(opener)

  assert.equal(escape.prevented(), true)
  assert.equal(closeCount, 1)
  assert.deepEqual(focusLog, ['opener'])

  const blockedEscape = keyboardEvent('Escape')
  handleDialogKeyboardBoundary({
    event: blockedEscape.event,
    dialog: null,
    activeElement: null,
    closeDisabled: true,
    onClose: () => { closeCount += 1 },
  })
  assert.equal(blockedEscape.prevented(), false)
  assert.equal(closeCount, 1)
})
