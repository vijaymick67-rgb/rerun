// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConfirmDialog from './ConfirmDialog'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container = null
let root = null

async function mount(props) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<ConfirmDialog {...props} />) })
}

beforeEach(() => {
  document.body.style.overflow = ''
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
  document.body.style.overflow = ''
})

function baseProps(overrides = {}) {
  return {
    open: true,
    title: 'Sign out?',
    message: "You'll need to sign back in.",
    confirmLabel: 'Sign out',
    cancelLabel: 'Cancel',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
}

describe('ConfirmDialog', () => {
  it('renders nothing when closed', async () => {
    await mount(baseProps({ open: false }))
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('exposes an accessible title and description', async () => {
    await mount(baseProps())
    const dialog = container.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const titleId = dialog.getAttribute('aria-labelledby')
    const descId = dialog.getAttribute('aria-describedby')
    expect(document.getElementById(titleId).textContent).toBe('Sign out?')
    expect(document.getElementById(descId).textContent).toBe("You'll need to sign back in.")
  })

  it('omits aria-describedby when there is no message', async () => {
    await mount(baseProps({ message: undefined }))
    const dialog = container.querySelector('[role="alertdialog"]')
    expect(dialog.hasAttribute('aria-describedby')).toBe(false)
  })

  it('sends initial focus to the Cancel button', async () => {
    await mount(baseProps())
    await act(async () => { await Promise.resolve() })
    const cancelButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')
    expect(document.activeElement).toBe(cancelButton)
  })

  it('locks and restores background scroll while open', async () => {
    expect(document.body.style.overflow).toBe('')
    await mount(baseProps())
    expect(document.body.style.overflow).toBe('hidden')
    await act(async () => { root.unmount() })
    root = null
    expect(document.body.style.overflow).toBe('')
  })

  it('calls onCancel on Escape', async () => {
    const onCancel = vi.fn()
    await mount(baseProps({ onCancel }))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('calls onCancel on backdrop click but not on panel click', async () => {
    const onCancel = vi.fn()
    await mount(baseProps({ onCancel }))
    const panel = container.querySelector('[role="alertdialog"]')
    await act(async () => { panel.click() })
    expect(onCancel).not.toHaveBeenCalled()

    const backdrop = container.firstChild
    await act(async () => { backdrop.click() })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('calls onConfirm when the confirm button is pressed', async () => {
    const onConfirm = vi.fn()
    await mount(baseProps({ onConfirm }))
    const confirmButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Sign out')
    await act(async () => { confirmButton.click() })
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('traps Tab focus within the dialog', async () => {
    await mount(baseProps())
    const buttons = [...container.querySelectorAll('button')]
    const [cancelButton, confirmButton] = buttons
    confirmButton.focus()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect(document.activeElement).toBe(cancelButton)

    cancelButton.focus()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    })
    expect(document.activeElement).toBe(confirmButton)
  })

  it('applies the destructive tone class only when danger is set', async () => {
    await mount(baseProps({ danger: true }))
    const confirmButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Sign out')
    expect(confirmButton.className).toContain('confirm-dialog-confirm--danger')
  })

  it('uses the neutral primary tone (not destructive) when danger is false', async () => {
    await mount(baseProps({ danger: false }))
    const confirmButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Sign out')
    expect(confirmButton.className).not.toContain('confirm-dialog-confirm--danger')
    expect(confirmButton.className).toContain('confirm-dialog-confirm')
  })

  it('keeps every interactive control at least 44px tall (min-h-11)', async () => {
    await mount(baseProps())
    for (const button of container.querySelectorAll('button')) {
      expect(button.className).toContain('min-h-11')
    }
  })
})
