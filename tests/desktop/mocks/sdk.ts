// Minimal stand-in for @hermes/plugin-sdk, enough to drive desktop/src/plugin.ts in Node.
type Listener<T> = (v: T) => void
export function atom<T>(initial: T) {
  let value = initial
  const subs = new Set<Listener<T>>()
  return { get: () => value, set: (v: T) => { value = v; subs.forEach(s => s(v)) }, subscribe: (s: Listener<T>) => { subs.add(s); return () => subs.delete(s) } }
}
export const useValue = <T,>(a: { get: () => T }) => a.get()
export const SETTINGS_PLUGINS_AREA = 'settings.plugins'
export const COMPOSER_AREAS = { top: 'composer.top', underside: 'composer.underside', middleware: 'composer.middleware' }

const calls: { method: string; args: unknown[] }[] = []
const composer = { draft: '' }
export const host = {
  state: { focusedSessionId: atom<string | null>('s1') },
  notify: (n: unknown) => { calls.push({ method: 'notify', args: [n] }) },
  notifyError: (e: unknown, m: string) => { calls.push({ method: 'notifyError', args: [e, m] }) },
  restartGateway: async () => { calls.push({ method: 'restartGateway', args: [] }) },
  composer: {
    getDraft: async (sid: string | null) => { calls.push({ method: 'getDraft', args: [sid] }); return composer.draft },
    setDraft: async (sid: string | null, text: string) => { calls.push({ method: 'setDraft', args: [sid, text] }); composer.draft = text; return true },
    insertText: async (sid: string | null, text: string, opts: unknown) => { calls.push({ method: 'insertText', args: [sid, text, opts] }); composer.draft += text; return true }
  }
}
export const writeClipboardText = async (text: string) => { calls.push({ method: 'writeClipboardText', args: [text] }) }
export const Tip = 'Tip'
export const Button = 'Button'
export const Dialog = 'Dialog'
export const DialogContent = 'DialogContent'
export const DialogTitle = 'DialogTitle'
export const DialogDescription = 'DialogDescription'
export const MessageTextContent = 'MessageTextContent'
export const Input = 'Input'
export const ListRow = 'ListRow'
export const ToggleRow = 'ToggleRow'

// The bundle inlines its own copy of this module; tests reach its state here.
;(globalThis as Record<string, unknown>).__rpMock = { calls, composer, host }
