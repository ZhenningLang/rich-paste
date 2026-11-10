// Glue test: desktop/src/plugin.ts bundled against a mock SDK (paste → hint → convert → middleware).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import domino from '@mixmark-io/domino'
import { setLocale } from '../../desktop/src/i18n.ts'
import { noCount } from './sent-view.ts'

setLocale('zh') // these tests pin the Chinese strings; english.test.ts covers English

const root = fileURLToPath(new URL('../../', import.meta.url))
const mocks = fileURLToPath(new URL('./mocks/', import.meta.url))

async function loadPlugin() {
  const out = await build({
    entryPoints: [`${root}desktop/src/plugin.ts`], bundle: true, write: false, format: 'esm', platform: 'node',
    alias: { '@hermes/plugin-sdk': `${mocks}sdk.ts`, react: `${mocks}react.ts`, 'react/jsx-runtime': `${mocks}jsx-runtime.ts` }
  })
  const url = 'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
  return import(url)
}

const execCommands: string[] = []
;(globalThis as Record<string, unknown>).DOMParser = class { parseFromString(html: string) { return domino.createDocument(html) } }
;(globalThis as Record<string, unknown>).document = Object.assign(new EventTarget(), {
  activeElement: null as unknown,
  visibilityState: 'visible',
  // Records any use of the browser editing command; the plugin must never call it (review 11-10).
  execCommand(command: string) {
    execCommands.push(command)
    return false
  }
})
const doc = (globalThis as any).document
const editor = { isContentEditable: true }

const mod = await loadPlugin()
const plugin = mod.default
const mock = (globalThis as any).__rpMock as { calls: { method: string; args: any[] }[]; composer: { draft: string }; host: any }
const callsOf = (method: string) => mock.calls.filter(c => c.method === method)

/** Desktop's ctx.i18n stand-in: resolves the plugin's registered bundles in `locale`, then English. */
function sdkI18n(locale: string) {
  let bundles: Record<string, Record<string, unknown>> = {}
  const pick = (table: Record<string, unknown> | undefined, key: string, args: unknown[]) => {
    const m = table?.[key]
    return typeof m === 'function' ? (m as (...a: unknown[]) => string)(...args) : typeof m === 'string' ? m : null
  }
  return {
    register: (b: Record<string, Record<string, unknown>>) => { bundles = b; return () => {} },
    t: (key: string, ...args: unknown[]) => pick(bundles[locale], key, args) ?? pick(bundles.en, key, args) ?? key
  }
}

function makeCtx(restResult: unknown, locale = 'zh') {
  const regs: Record<string, any> = {}
  const listeners: Record<string, ((e: unknown) => void)[]> = {}
  // The offer-flow tests below expect the 转为 Markdown button; smart mode has its own tests.
  const store: Record<string, unknown> = { convert_mode: 'never' }
  const rest: unknown[] = []
  const ctx = {
    storage: { get: (k: string, fb: unknown) => (k in store ? store[k] : fb), set: (k: string, v: unknown) => { store[k] = v } },
    rest: async (path: string, opts: unknown) => { if (path !== '/version') rest.push({ path, opts });  // the startup version probe (D7) is not counted
      const r = typeof restResult === 'function' ? (restResult as (p: string, o: unknown) => unknown)(path, opts) : restResult; if (r instanceof Error) throw r; return r },
    register: (c: any) => { regs[c.id] = c; return () => {} },
    registerSettingsPage: (p: any) => { regs.settings = p; return () => {} },
    addEventListener: (_t: unknown, type: string, fn: (e: unknown) => void) => { (listeners[type] ||= []).push(fn); return () => {} },
    setTimeout: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms === 30000 ? 1e9 : ms); t.unref?.(); return () => clearTimeout(t) },
    setInterval: () => () => {},
    os: { revealPath: async () => true, pickOpenPath: async () => '/Users/me/new pick.pdf' },
    files: { requestFolder: async () => ({ ok: true, folder: { path: '/Users/me/picked' } }) },
    i18n: sdkI18n(locale)
  }
  return { ctx, regs, listeners, store, rest }
}

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))

function find(tree: any, pred: (n: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return null
  if (Array.isArray(tree)) { for (const t of tree) { const f = find(t, pred); if (f) return f } return null }
  if (pred(tree)) return tree
  return find(tree.props?.children, pred) || find(tree.props?.action, pred) || find(tree.props?.description, pred)
}
const byText = (text: string) => (n: any) => n.props?.children === text

function paste(listeners: Record<string, ((e: unknown) => void)[]>, data: Record<string, string>, items: { kind: string; type: string; name?: string }[] = []) {
  const withFiles = items.map(item => ({ ...item, getAsFile: () => (item.kind === 'file' ? { name: item.name ?? '' } : null) }))
  const event = { target: { isContentEditable: true }, clipboardData: { getData: (t: string) => data[t] ?? '', items: withFiles } }
  listeners.paste.forEach(fn => fn(event))
}

const HTML = '<h2>插件市场怎么审核</h2><p>所有插件都要提交到目录。</p><p><img src="https://x.test/a.png" alt="审核流程"></p><p>详见<a href="https://h.test/docs">官方文档</a></p>'
const PLAIN = '插件市场怎么审核\n所有插件都要提交到目录。\n详见官方文档'

test('rich paste: hint → click → markdown replaces the pasted plain text; middleware attaches the image', async () => {
  const { ctx, regs, listeners, rest } = makeCtx({ results: [{ url: 'https://x.test/a.png', path: '/cache/20261106/a.png', error: null }] })
  plugin.register(ctx)
  assert.equal(regs.hint.area, 'composer.underside')
  assert.equal(regs.strip.area, 'composer.top')
  assert.equal(regs['attach-markers'].area, 'composer.middleware')

  assert.equal(regs.hint.render(), null, 'no hint before paste')
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  const offer = regs.hint.render()
  assert.ok(find(offer, byText('转为 Markdown')))
  assert.ok(find(offer, byText('检测到网页内容：1 个标题、1 张图、1 个链接')))

  // plain text paste of a non-rich html does not offer
  const before = regs.hint.render()
  find(before, byText('忽略')).props.onClick()
  assert.equal(regs.hint.render(), null)
  paste(listeners, { 'text/html': '<p>just text</p>', 'text/plain': 'just text' })
  assert.equal(regs.hint.render(), null, 'plain paste shows no hint')

  // convert: the core already inserted the trimmed plain text into the draft
  mock.calls.length = 0
  mock.composer.draft = `我想问：\n${PLAIN}\n谢谢`
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(20)
  assert.equal(rest.length, 1)
  const body = (rest[0] as any).opts.body
  assert.deepEqual(body.urls, ['https://x.test/a.png'])
  assert.deepEqual(body.limits, { max_images: null, max_mb: null })
  assert.equal(regs.hint.render(), null, 'hint gone after click')
  assert.equal(mock.composer.draft,
    '我想问：\n## 插件市场怎么审核\n\n所有插件都要提交到目录。\n\n![审核流程](/cache/20261106/a.png)\n\n详见[官方文档](https://h.test/docs)\n谢谢')
  assert.equal(callsOf('insertText').length, 0, 'replaced in place, no append')
  assert.equal(callsOf('notify').length, 0, 'no failure toast')

  const out = await regs['attach-markers'].data.handler({ text: '## t\n![审核流程](/cache/20261106/a.png)', attachments: [] })
  assert.equal(noCount(out.text), '## t\n\u2063[图：审核流程]\u2063')
  assert.deepEqual(out.attachments, [{ id: 'rich-paste:/cache/20261106/a.png', kind: 'image', label: 'a.png', path: '/cache/20261106/a.png' }])
})

test('dogfood 11-10: Esc dismisses the hint; typing and time do not', async () => {
  const { ctx, regs, listeners } = makeCtx({ results: [] })
  const timers: number[] = []
  const setTimeoutReal = ctx.setTimeout
  ctx.setTimeout = (fn: () => void, ms: number) => { timers.push(ms); return setTimeoutReal(fn, ms) }
  plugin.register(ctx)
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  assert.ok(regs.hint.render())
  listeners.keydown.forEach(fn => fn({ key: 'Escape' }))
  assert.equal(regs.hint.render(), null)
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  for (let i = 0; i < 50; i++) listeners.input.forEach(fn => fn({ target: { isContentEditable: true }, inputType: 'insertText', data: 'a' }))
  assert.ok(regs.hint.render(), 'typing keeps it')
  assert.ok(!timers.includes(30000), 'no 30 s auto-hide')
})

test('dogfood 11-10: the hint goes once the pasted text is gone or the composer is emptied', async () => {
  const { ctx, regs, listeners } = makeCtx({ results: [] })
  plugin.register(ctx)
  const input = () => listeners.input.forEach(fn => fn({ target: { isContentEditable: true }, inputType: 'insertText', data: 'a' }))
  mock.composer.draft = ''
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  input(); await tick(350)
  assert.ok(regs.hint.render(), 'not gone before the paste lands in the draft')
  mock.composer.draft = '前面的话\n' + PLAIN + '\n后面打的字'
  input(); await tick(350)
  assert.ok(regs.hint.render(), 'pasted text still there')
  mock.composer.draft = '前面的话\n后面打的字'
  input(); await tick(350)
  assert.equal(regs.hint.render(), null, 'pasted text deleted')

  mock.composer.draft = PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  input(); await tick(350)
  assert.ok(regs.hint.render())
  mock.composer.draft = ''
  input(); await tick(350)
  assert.equal(regs.hint.render(), null, 'composer emptied')
})

test('dogfood 11-10: after 撤销 the row offers 转为 Markdown again', async () => {
  const { ctx, regs, listeners, store } = makeCtx({ results: [{ url: 'https://x.test/a.png', path: '/c/a.png', error: null }] })
  store.convert_mode = 'always'
  plugin.register(ctx)
  mock.composer.draft = PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  await tick(20)
  await find(regs.hint.render(), byText('撤销')).props.onClick()
  await tick()
  assert.equal(mock.composer.draft, PLAIN)
  const again = find(regs.hint.render(), byText('转为 Markdown'))
  assert.ok(again, 'offer shown after 撤销')
  await again.props.onClick()
  await tick(20)
  assert.match(mock.composer.draft, /^## 插件市场怎么审核/)
  mock.composer.draft = ''
})

test('paste into a non-composer field is ignored', () => {
  const { ctx, regs, listeners } = makeCtx({ results: [] })
  plugin.register(ctx)
  listeners.paste.forEach(fn => fn({ target: { isContentEditable: false }, clipboardData: { getData: (t: string) => (t === 'text/html' ? HTML : PLAIN), items: [] } }))
  assert.equal(regs.hint.render(), null)
})

test('settings page renders the eight settings and the red warning when auto delete is off', async () => {
  const { ctx, regs, store } = makeCtx({ bytes: 5 * 1024 * 1024, files: 3, dir: '/Users/me/.hermes/cache/rich-paste' })
  plugin.register(ctx)
  let page = regs.settings.render()
  for (const label of ['限制每次下载的张数', '限制每张图的大小', '自动删除下载的图片']) {
    assert.ok(find(page, n => n.props?.label === label), label)
  }
  assert.ok(find(page, n => n.props?.title === '粘贴网页时'))
  find(page, byText('智能')).props.onClick()
  assert.equal(store.convert_mode, 'smart')
  page = regs.settings.render()
  assert.equal(find(page, byText('智能')).props['aria-pressed'], true)
  assert.match(find(page, n => n.props?.title === '粘贴网页时').props.description, /图文交错/)
  assert.ok(find(page, n => n.props?.title === '保留天数'))
  assert.ok(find(page, n => n.props?.title === '存放目录'))
  assert.equal(find(page, n => n.props?.title === '每次最多下载'), null, 'number hidden while switch is off')
  find(page, n => n.props?.label === '限制每次下载的张数').props.onChange(true)
  find(page, n => n.props?.label === '自动删除下载的图片').props.onChange(false)
  assert.equal(store.limit_images, true)
  assert.equal(store.cache_auto_delete, false)
  page = regs.settings.render()
  assert.ok(find(page, n => n.props?.title === '每次最多下载'))
  assert.ok(find(page, n => n.props?.role === 'alert'))
  assert.equal(find(page, n => n.props?.title === '保留天数'), null)
  await find(page, byText('选择目录…')).props.onClick()
  await tick()
  assert.equal(store.cache_dir, '/Users/me/picked')
})

test('download failure keeps the URL and toasts; missing plain text falls back to insertText', async () => {
  const { ctx, regs, listeners } = makeCtx({ results: [{ url: 'https://x.test/a.png', path: null, error: 'http_error:403' }] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = '用户已经改过的草稿'
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(20)
  const inserted = callsOf('insertText')
  assert.equal(inserted.length, 1)
  assert.match(inserted[0].args[1], /\[图片下载失败：审核流程\]\(https:\/\/x\.test\/a\.png\)/)
  const toasts = callsOf('notify').map(c => c.args[0].message)
  assert.ok(toasts.includes('第 1 张图下载失败，保留为链接'), toasts.join('|'))
  assert.ok(toasts.includes('没找到刚粘贴的原文，Markdown 加在了末尾'), toasts.join('|'))
})

test('backend unreachable: every image kept as link', async () => {
  const { ctx, regs, listeners } = makeCtx(new Error('404'))
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(20)
  assert.match(mock.composer.draft, /\[图片下载失败：审核流程\]\(https:\/\/x\.test\/a\.png\)/)
})

test('dogfood 11-07: an image over the size limit is a 图片未下载（超出单张大小上限） link with its own toast', async () => {
  const { ctx, regs, listeners } = makeCtx({ results: [{ url: 'https://x.test/a.png', path: null, error: 'too_large' }] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(20)
  assert.match(mock.composer.draft, /\[图片未下载（超出单张大小上限）：审核流程\]\(https:\/\/x\.test\/a\.png\)/)
  const toasts = callsOf('notify').map(c => c.args[0].message)
  assert.ok(toasts.includes('第 1 张超出单张大小上限，保留为链接'), toasts.join('|'))
  assert.ok(!toasts.some(t => t.includes('下载失败')), toasts.join('|'))
  assert.equal(regs['more-images'].render(), null, 'the size limit stays: no 再下载 button')
})

test('old auto_convert switch (now 总是转换): converts without a hint, then offers 撤销 back to the plain draft', async () => {
  const { ctx, regs, listeners, store } = makeCtx({ results: [{ url: 'https://x.test/a.png', path: '/c/a.png', error: null }] })
  delete store.convert_mode
  store.auto_convert = true
  plugin.register(ctx)
  mock.composer.draft = PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  await tick(20)
  assert.match(mock.composer.draft, /^## 插件市场怎么审核/)
  const undo = find(regs.hint.render(), byText('撤销'))
  assert.ok(undo)
  await undo.props.onClick()
  await tick()
  assert.equal(mock.composer.draft, PLAIN)
})

test('review 11-08 (B2): 撤销 puts the pasted text back and keeps what was typed after the conversion', async () => {
  const { ctx, regs, listeners, store } = makeCtx({ results: [{ url: 'https://x.test/a.png', path: '/c/a.png', error: null }] })
  store.convert_mode = 'always'
  plugin.register(ctx)
  mock.composer.draft = '请看：' + PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  await tick(20)
  assert.match(mock.composer.draft, /^请看：## 插件市场怎么审核/)
  mock.composer.draft += '\n新增内容'
  await find(regs.hint.render(), byText('撤销')).props.onClick()
  await tick()
  assert.equal(mock.composer.draft, '请看：' + PLAIN + '\n新增内容')

  // The converted text itself was edited: nothing to put back safely, so the draft stays as it is.
  mock.composer.draft = PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  await tick(20)
  mock.composer.draft = mock.composer.draft.replace('插件市场', '插件商店')
  const edited = mock.composer.draft
  mock.calls.length = 0
  await find(regs.hint.render(), byText('撤销')).props.onClick()
  await tick()
  assert.equal(mock.composer.draft, edited)
  assert.ok(callsOf('notify').some(c => /没有撤销/.test(c.args[0].message)))
  mock.composer.draft = ''
})

test('screenshot paste: the marker goes in through the SDK, never by editing the editor (review 11-10)', async () => {
  const { ctx, listeners } = makeCtx({ results: [] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = '第一段\n第二段'
  doc.activeElement = editor
  paste(listeners, { 'text/plain': '' }, [{ kind: 'file', type: 'image/png' }])
  await tick(20)
  const inserted = callsOf('insertText')
  assert.equal(inserted.length, 1)
  assert.deepEqual(inserted[0].args.slice(1), ['@image:`截图 1`', { mode: 'inline' }])
  assert.equal(execCommands.length, 0, 'document.execCommand is never used')
  doc.activeElement = null
})

test('two screenshots at once become a list paragraph; N follows existing placeholders', async () => {
  const { ctx, listeners } = makeCtx({ results: [] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = `前面 ![截图 1](attached:1) ![网页图](/c/a.png) `
  paste(listeners, { 'text/plain': '' }, [{ kind: 'file', type: 'image/png' }, { kind: 'file', type: 'image/jpeg' }])
  await tick(20)
  const inserted = callsOf('insertText')
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].args[1], '- @image:`截图 2`\n- @image:`截图 3`', 'several at once → a list paragraph (D8)')
  assert.equal(inserted[0].args[2].mode, 'block')
})

test('CONFORM:B3: copied image (blob + html) gets a placeholder, no conversion offered', async () => {
  const { ctx, regs, listeners } = makeCtx({ results: [] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = ''
  paste(listeners, { 'text/html': '<img src="https://x.test/a.png">', 'text/plain': '' }, [{ kind: 'file', type: 'image/png' }])
  await tick(20)
  assert.equal(regs.hint.render(), null)
  assert.equal(callsOf('insertText')[0].args[1], '@image:`截图 1`')
})

test('CONFORM:B3: image-only HTML without a blob offers 转为 Markdown and appends the result', async () => {
  const { ctx, regs, listeners, rest } = makeCtx({ results: [{ url: 'https://x.test/a.png', path: '/c/a.png', error: null }] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = '已有文字'
  paste(listeners, { 'text/html': '<img src="https://x.test/a.png" alt="图">', 'text/plain': '' })
  const offer = regs.hint.render()
  assert.ok(find(offer, byText('检测到网页内容：1 张图')))
  find(offer, byText('转为 Markdown')).props.onClick()
  await tick(20)
  assert.equal(rest.length, 1)
  assert.equal(callsOf('insertText')[0].args[1], '![图](/c/a.png)')
  assert.equal(callsOf('notify')[0].args[0].message, 'Markdown 加在了末尾')
})

test('A:S2: a new-chat conversion is pinned to "new" and dropped if the user switched sessions', async () => {
  let release: (v: unknown) => void = () => {}
  const { ctx, regs, listeners } = makeCtx({ results: [] })
  ;(ctx as any).rest = (path: string) => (path === '/version' ? Promise.resolve({}) : new Promise(r => { release = r }))
  plugin.register(ctx)
  mock.host.state.focusedSessionId.set(null)
  mock.calls.length = 0
  mock.composer.draft = PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(5)
  mock.host.state.focusedSessionId.set('other')
  release({ results: [{ url: 'https://x.test/a.png', path: '/c/a.png', error: null }] })
  await tick(20)
  assert.equal(callsOf('setDraft').length, 0)
  assert.equal(callsOf('insertText').length, 0)
  assert.equal(callsOf('notify')[0].args[0].message, '会话已切换，转换结果没有写入')
  mock.host.state.focusedSessionId.set('s1')
})

test('A:S2: a new-chat conversion that stays on the new draft writes to "new"', async () => {
  const { ctx, regs, listeners } = makeCtx({ results: [{ url: 'https://x.test/a.png', path: '/c/a.png', error: null }] })
  plugin.register(ctx)
  mock.host.state.focusedSessionId.set(null)
  mock.calls.length = 0
  mock.composer.draft = PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(20)
  assert.equal(callsOf('setDraft')[0].args[0], 'new')
  mock.host.state.focusedSessionId.set('s1')
})

test('A:S5: Finder files get readable markers and become file attachments on send; no path → toast', async () => {
  const { ctx, regs, listeners } = makeCtx({ results: [] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = ''
  paste(listeners, { 'text/uri-list': 'file:///Users/me/My%20Docs/a.pdf\r\nfile:///Users/me/b.txt', 'text/plain': 'a.pdf' },
    [{ kind: 'file', type: 'application/pdf' }, { kind: 'file', type: 'text/plain' }])
  await tick(20)
  const text = callsOf('insertText')[0].args[1]
  assert.equal(text, '- @file:`/Users/me/My Docs/a.pdf`\n- @file:/Users/me/b.txt', 'chips as a list (D6/D8)')
  assert.equal(callsOf('insertText')[0].args[2].mode, 'block')
  const sent = await regs['attach-markers'].data.handler({ text: `请看\n${text}`, attachments: [] })
  assert.equal(noCount(sent.text), '请看\n- [附件：a.pdf]\n- [附件：b.txt]', 'no raw absolute path in the sent text')
  assert.deepEqual(sent.attachments, [
    { id: 'rich-paste-file:/Users/me/My Docs/a.pdf', kind: 'file', label: 'a.pdf', path: '/Users/me/My Docs/a.pdf' },
    { id: 'rich-paste-file:/Users/me/b.txt', kind: 'file', label: 'b.txt', path: '/Users/me/b.txt' }
  ])
  const again = await regs['attach-markers'].data.handler({ text: `请看\n${text}`, attachments: [] })
  assert.equal(again.attachments.length, 0, 'attached once, then forgotten')
})

test('top strip lists local image markers and × removes one', async () => {
  const { ctx, regs, listeners } = makeCtx({ results: [] })
  plugin.register(ctx)
  mock.composer.draft = '一 ![a](/c/rich-paste-cache/a.png) 二 ![b](/c/rich-paste-cache/b.webp) ![x](https://x/y.png) ![s](/Users/me/secret.png) ![a2](/c/rich-paste-cache/a.png)'
  listeners.input.forEach(fn => fn({ target: { isContentEditable: true }, inputType: 'insertText', data: 'x' }))  // schedules a draft refresh
  await tick(350)
  const strip = regs.strip.render()
  assert.ok(find(strip, byText('图 1 · a.png')))
  assert.ok(find(strip, byText('图 2 · b.webp')))
  assert.equal(find(strip, byText('图 3 · y.png')), null, 'remote URLs are not local images')
  assert.equal(find(strip, byText('图 3 · secret.png')), null, 'paths the plugin did not download are not listed (D2)')
  await find(strip, n => n.props?.['aria-label'] === '移除图 1').props.onClick()
  await tick(5)
  assert.equal(mock.composer.draft, '一  二 ![b](/c/rich-paste-cache/b.webp) ![x](https://x/y.png) ![s](/Users/me/secret.png) ')
  mock.composer.draft = ''
  listeners.input.forEach(fn => fn({ target: { isContentEditable: true }, inputType: 'insertText', data: 'x' }))
  await tick(350)
  assert.equal(regs.strip.render(), null)
})

test('D3: oversized HTML shows no hint, is not auto-converted, and says so', async () => {
  const { ctx, regs, listeners, store, rest } = makeCtx({ results: [] })
  plugin.register(ctx)
  mock.calls.length = 0
  const big = '<h2>t</h2>' + '<p>x</p>'.repeat(70000)
  paste(listeners, { 'text/html': big, 'text/plain': 'x' })
  assert.equal(regs.hint.render(), null)
  assert.equal(callsOf('notify')[0].args[0].message, '网页内容太大，没有转换')
  store.auto_convert = true
  const { ctx: ctx2, listeners: l2, rest: rest2 } = makeCtx({ results: [] })
  ;(ctx2 as any).storage = ctx.storage
  plugin.register(ctx2)
  paste(l2, { 'text/html': big, 'text/plain': 'x' })
  await tick(20)
  assert.equal(rest.length + rest2.length, 0)
  assert.equal(callsOf('setDraft').length + callsOf('insertText').length, 0)
})

test('D2: middleware attaches downloaded images only; pasted local paths stay text', async () => {
  const { ctx, regs } = makeCtx({ results: [] })
  plugin.register(ctx)
  const out = await regs['attach-markers'].data.handler({ text: '![s](/Users/me/secret.png) ![c](/x/rich-paste-cache/20261106/a.png)', attachments: [] })
  assert.equal(noCount(out.text), '![s](/Users/me/secret.png) \u2063[图：c]\u2063')
  assert.deepEqual(out.attachments.map((a: any) => a.path), ['/x/rich-paste-cache/20261106/a.png'])
})

test('dogfood D5: a Finder folder without a uri-list gets its path from the pasteboard and becomes @folder on send', async () => {
  const { ctx, regs, listeners, rest } = makeCtx({ ok: true, files: [{ path: '/Users/me/Downloads/ssh heavy', is_dir: true }] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = '请看 ssh heavy'
  paste(listeners, { 'text/plain': 'ssh heavy' }, [{ kind: 'file', type: '', name: 'ssh heavy' }])
  await tick(20)
  assert.equal((rest as any[]).at(-1).path, '/clipboard-files')
  assert.equal(callsOf('setDraft')[0].args[1], '请看 @folder:`/Users/me/Downloads/ssh heavy`', 'the name the core pasted becomes a chip')
  const sent = await regs['attach-markers'].data.handler({ text: '请看 @folder:`/Users/me/Downloads/ssh heavy`', attachments: [] })
  assert.equal(noCount(sent.text), '请看 [文件夹：ssh heavy]')
  assert.deepEqual(sent.attachments, [
    { id: 'rich-paste-folder:/Users/me/Downloads/ssh heavy', kind: 'folder', label: 'ssh heavy', path: '/Users/me/Downloads/ssh heavy', refText: '@folder:`/Users/me/Downloads/ssh heavy`' }
  ])
})

test('dogfood D6: a multi-file Finder copy (Chromium names only the first) brings every pasteboard entry', async () => {
  const { ctx, regs, listeners } = makeCtx({ ok: true, files: [
    { path: '/Users/me/a.md', is_dir: false }, { path: '/Users/me/b.md', is_dir: false }, { path: '/Users/me/dir', is_dir: true }] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = ''
  paste(listeners, { 'text/plain': '' }, [{ kind: 'file', type: 'text/markdown', name: 'a.md' }])
  await tick(20)
  assert.equal(callsOf('insertText')[0].args[1], '- @file:/Users/me/a.md\n- @file:/Users/me/b.md\n- @folder:/Users/me/dir')
  const sent = await regs['attach-markers'].data.handler({ text: '看 @file:/Users/me/a.md @file:/Users/me/b.md @folder:/Users/me/dir', attachments: [] })
  assert.equal(noCount(sent.text), '看 [附件：a.md] [附件：b.md] [文件夹：dir]')
  assert.deepEqual(sent.attachments.map((a: any) => [a.kind, a.path]), [['file', '/Users/me/a.md'], ['file', '/Users/me/b.md'], ['folder', '/Users/me/dir']])
})

test('dogfood D6: when the pasteboard does not start with the pasted file, only same-name entries are kept', async () => {
  const { ctx, listeners } = makeCtx({ ok: true, files: [{ path: '/Users/me/other.txt', is_dir: false }, { path: '/Users/me/b.txt', is_dir: false }] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = ''
  paste(listeners, { 'text/plain': 'b.txt' }, [{ kind: 'file', type: 'text/plain', name: 'b.txt' }])
  await tick(20)
  assert.equal(callsOf('insertText')[0].args[1], '@file:/Users/me/b.txt')
})

test('dogfood D6: Finder images — the first is the core attachment, the rest come from the pasteboard; TIFF goes as PNG', async () => {
  const { ctx, regs, listeners, rest } = makeCtx((path: string, opts: any) => {
    if (path === '/clipboard-files') return { ok: true, files: [
      { path: '/Users/me/a.png', is_dir: false }, { path: '/Users/me/b.tiff', is_dir: false },
      { path: '/Users/me/c.pdf', is_dir: false }, { path: '/Users/me/dir', is_dir: true }] }
    if (path === '/to-png') return { path: `/c/rich-paste-cache/20261106/${opts.body.path.endsWith('b.tiff') ? 'kb' : 'kx'}.png`, error: null }
    return {}
  })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = ''
  paste(listeners, { 'text/plain': '' }, [{ kind: 'file', type: 'image/png', name: 'a.png' }])
  await tick(30)
  assert.deepEqual(callsOf('insertText').map((c: any) => c.args[1]), ['- @image:`截图 1`\n- @image:/Users/me/b.tiff\n- @file:/Users/me/c.pdf\n- @folder:/Users/me/dir'])
  const text = '看 @image:`截图 1` @image:/Users/me/b.tiff @file:/Users/me/c.pdf @folder:/Users/me/dir'
  const core = { id: 'img-a', kind: 'image', label: 'a.png', path: '/h/composer-images/a.png' }
  const sent = await regs['attach-markers'].data.handler({ text, attachments: [core] })
  assert.equal(noCount(sent.text), '看 \u2063[截图 1]\u2063 \u2063[图：b.tiff]\u2063 [附件：c.pdf] [文件夹：dir]')
  const images = sent.attachments.filter((a: any) => a.kind === 'image')
  assert.deepEqual(images.map((a: any) => [a.path, a.label]), [['/h/composer-images/a.png', 'a.png'], ['/c/rich-paste-cache/20261106/kb.png', 'b.png']])
  assert.equal((rest as any[]).filter(r => r.path === '/to-png').length, 1, 'only the TIFF is converted')
})

test('dogfood D6: a Raycast TIFF the core attached is sent as PNG; a failed conversion keeps the original', async () => {
  let fail = false
  const { ctx, regs, listeners } = makeCtx((path: string) => {
    if (path === '/clipboard-files') return { ok: true, files: [{ path: '/rc/file-1.tiff', is_dir: false }] }
    if (path === '/to-png') return fail ? new Error('backend off') : { path: '/c/rich-paste-cache/20261106/k1.png', error: null }
    return {}
  })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = ''
  paste(listeners, { 'text/plain': '' }, [{ kind: 'file', type: 'image/tiff', name: 'file-1.tiff' }])
  await tick(30)
  assert.deepEqual(callsOf('insertText').map((c: any) => c.args[1]), ['@image:`截图 1`'], 'no extra chip for the one Raycast file')
  const core = { id: 'img-r', kind: 'image', label: 'file-1.tiff', path: '/rc/file-1.tiff', previewUrl: 'blob:x' }
  const sent = await regs['attach-markers'].data.handler({ text: '@image:`截图 1`', attachments: [core] })
  assert.equal(noCount(sent.text), '\u2063[截图 1]\u2063')
  assert.deepEqual(sent.attachments, [{ id: 'img-r', kind: 'image', label: 'file-1.png', path: '/c/rich-paste-cache/20261106/k1.png' }])
  fail = true
  const kept = await regs['attach-markers'].data.handler({ text: '@image:`截图 1`', attachments: [core] })
  assert.deepEqual(kept.attachments, [core])
})

test('dogfood D5: no path available → a plain-language toast, nothing inserted', async () => {
  for (const result of [{ ok: false, reason: 'unsupported', files: [] }, { ok: true, files: [{ path: '/Users/me/else.pdf', is_dir: false }] }, new Error('backend off')]) {
    const { ctx, listeners } = makeCtx(result)
    plugin.register(ctx)
    mock.calls.length = 0
    mock.composer.draft = ''
    paste(listeners, { 'text/plain': 'a.pdf' }, [{ kind: 'file', type: 'application/pdf', name: 'a.pdf' }])
    await tick(20)
    assert.equal(callsOf('insertText').length, 0, String(result))
    assert.equal(callsOf('notify').at(-1).args[0].message, '没拿到「a.pdf」在电脑上的位置，没有贴进去。可以把它直接拖进输入框。')
  }
})

// ---- dogfood D7: stale-backend tip (no false alarms) and chip restore on paste ----

const flatText = (tree: any): string => {
  if (tree == null || typeof tree === 'boolean') return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(flatText).join('')
  return flatText(tree.props?.children)
}

function backend(version: unknown, cacheStats: unknown) {
  return (path: string) => {
    if (path === '/version') return version
    if (path.startsWith('/cache-stats')) return cacheStats
    return {}
  }
}

test('dogfood D7: an old backend (no /version route, old routes still answer) shows the restart tip; the button restarts', async () => {
  const { ctx, regs } = makeCtx(backend(new Error('404: {"detail":"Not Found"}'), { files: 0, bytes: 0 }))
  plugin.register(ctx)
  mock.calls.length = 0
  await tick(30)
  const tree = regs.tip.render()
  assert.match(flatText(tree), /后端还是旧版本.*重启网关/)
  find(tree, byText('重启网关')).props.onClick()
  await tick(5)
  assert.equal(callsOf('restartGateway').length, 1)
})

test('dogfood D7: the backend reports an older api → restart tip; a newer one → reload-desktop tip', async () => {
  const old = makeCtx(backend({ api: 1 }, { files: 0, bytes: 0 }))
  plugin.register(old.ctx)
  await tick(30)
  assert.match(flatText(old.regs.tip.render()), /重启网关/)
  const newer = makeCtx(backend({ api: 999 }, { files: 0, bytes: 0 }))
  plugin.register(newer.ctx)
  await tick(30)
  assert.match(flatText(newer.regs.tip.render()), /Reload desktop plugins/)
})

test('dogfood D7: no tip without proof — same api, backend down, plugin off, or network errors', async () => {
  for (const [version, stats] of [
    [{ api: 'CURRENT' }, { files: 0, bytes: 0 }],
    [new Error('404: Not Found'), new Error('404: Not Found')],      // plugin backend not mounted at all
    [new Error('404: Not Found'), new Error('500: boom')],
    [new Error('fetch failed'), { files: 0, bytes: 0 }],              // gateway restarting
    [new Error('503: unavailable'), { files: 0, bytes: 0 }],
    [{ nope: true }, { files: 0, bytes: 0 }]
  ] as const) {
    const current = mod.BACKEND_API
    const v = (version as any)?.api === 'CURRENT' ? { api: current } : version
    const { ctx, regs } = makeCtx(backend(v, stats))
    plugin.register(ctx)
    await tick(30)
    assert.equal(regs.tip.render(), null, JSON.stringify(v) + ' / ' + String(stats))
  }
})

test('dogfood D7: a 404 while pasting a file re-checks and says to restart instead of 拿不到位置', async () => {
  const { ctx, listeners } = makeCtx((path: string) => {
    if (path === '/version') return new Error('404: Not Found')
    if (path === '/clipboard-files') return new Error('404: Not Found')
    if (path.startsWith('/cache-stats')) return { files: 0, bytes: 0 }
    return {}
  })
  plugin.register(ctx)
  await tick(30)
  mock.calls.length = 0
  mock.composer.draft = ''
  paste(listeners, { 'text/plain': 'a.pdf' }, [{ kind: 'file', type: 'application/pdf', name: 'a.pdf' }])
  await tick(30)
  assert.match(callsOf('notify').at(-1).args[0].message, /重启网关/)
})

test('dogfood D7: copying chips and pasting them back restores the chips (Desktop copies only their labels as text)', async () => {
  const { ctx, regs, listeners } = makeCtx({ results: [] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = '新的 前 截图 1 后'
  const html = '<meta charset="utf-8"><span>前<span> </span></span><span contenteditable="false" class="ref" data-ref-text="@image:`截图 1`" data-ref-kind="image"><svg></svg>截图 1</span><span><span> </span>后</span>'
  paste(listeners, { 'text/html': html, 'text/plain': '前 截图 1 后' })
  await tick(20)
  assert.equal(callsOf('setDraft')[0].args[1], '新的 前 @image:`截图 1` 后')
  assert.equal(regs.hint.render(), null, 'no 转为 Markdown hint for copied chips')
})

test('one screenshot without a focused composer is appended through the SDK too', async () => {
  const { ctx, listeners } = makeCtx({ results: [] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = '前面 '
  paste(listeners, { 'text/plain': '' }, [{ kind: 'file', type: 'image/png' }])
  await tick(20)
  assert.equal(callsOf('insertText')[0].args[1], '@image:`截图 1`')
})

test('review 11-10: no document click listener, and the plugin CSS targets only its own classes', () => {
  const appended: any[] = []
  doc.head = { append: (el: any) => { appended.push(el); el.remove = () => appended.splice(appended.indexOf(el), 1) } }
  doc.createElement = (tag: string) => ({ tag, textContent: '' })
  try {
    const { ctx, listeners } = makeCtx({})
    plugin.register(ctx)
    assert.equal((listeners.click || []).length, 0)
    const css = appended.map(el => el.textContent).join('\n')
    assert.doesNotMatch(css, /data-ref-|role="textbox"|data-slot/)
    // Selectors = the text before each innermost { } block, with blocks peeled from the inside out.
    let rest = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const selectors: string[] = []
    while (/\{[^{}]*\}/.test(rest)) {
      rest = rest.replace(/([^{}]*)\{[^{}]*\}/g, (_m, sel: string) => { selectors.push(sel); return '' })
    }
    for (const sel of selectors) {
      for (const part of sel.split(',').map(x => x.trim()).filter(Boolean)) {
        assert.match(part, /^(\.rp-|button\.rp-|@|\d+%)/, part)
      }
    }
  } finally {
    delete doc.head
    delete doc.createElement
  }
})

// ---- dogfood D10: audio transcription ----

function sttBackend(status: unknown, transcript: unknown, paths: string[] = ['/Users/me/voice memo.m4a']) {
  const seen: any[] = []
  const fn = (path: string, opts: any) => {
    seen.push({ path, opts })
    if (path === '/clipboard-files') return { ok: true, files: paths.map(p => ({ path: p, is_dir: false })) }
    if (path === '/stt-status') return status
    if (path === '/transcribe') return transcript
    return {}
  }
  return { fn, seen }
}

async function pasteAudio(listeners: any, name = 'voice memo.m4a') {
  paste(listeners, { 'text/plain': '' }, [{ kind: 'file', type: 'audio/x-m4a', name }])
  await tick(30)
}

test('dogfood D10: pasted audio is a file chip with a 转写 offer; cloud STT asks once, then the transcript lands under the chip', async () => {
  const b = sttBackend({ kind: 'cloud', provider: 'xai', language: 'en' }, { transcript: '你好\n第二行', error: null })
  const { ctx, regs, listeners, store } = makeCtx(b.fn)
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = ''
  await pasteAudio(listeners)
  assert.equal(mock.composer.draft, '@file:`/Users/me/voice memo.m4a`')
  let tree = regs.audio.render()
  assert.match(flatText(tree), /检测到音频：「voice memo.m4a」/)
  find(tree, byText('转写')).props.onClick()
  await tick(10)
  tree = regs.audio.render()
  assert.match(flatText(tree), /上传到 xai.*转写语言跟随 Hermes 设置：en/)
  find(tree, byText('继续转写')).props.onClick()
  await tick(20)
  assert.equal(mock.composer.draft, '@file:`/Users/me/voice memo.m4a`\n> 转写：你好\n> 第二行\n')
  assert.equal(regs.audio.render(), null, 'hint and dialog gone')
  assert.equal(store['stt_ok:cloud:xai:'], true)
  const sent = await regs['attach-markers'].data.handler({ text: mock.composer.draft, attachments: [] })
  assert.equal(noCount(sent.text), '[附件：voice memo.m4a]\n> 转写：你好\n> 第二行\n')

  // second time: no dialog
  mock.composer.draft = ''
  await pasteAudio(listeners)
  find(regs.audio.render(), byText('转写')).props.onClick()
  await tick(20)
  assert.match(mock.composer.draft, /> 转写：你好/)
})

test('dogfood 11-08: plugin rows under the composer each take a full line; an audio offer goes once its chip is deleted', async () => {
  const b = sttBackend({ kind: 'local', provider: 'local', needs_download: false, model: 'base', language: null }, { transcript: 'x', error: null })
  const { ctx, regs, listeners } = makeCtx(b.fn)
  const ticks: (() => void)[] = []
  ctx.setInterval = (fn: () => void) => { ticks.push(fn); return () => {} }
  plugin.register(ctx)
  mock.composer.draft = ''
  await pasteAudio(listeners)
  const audioRow = find(regs.audio.render(), (n: any) => typeof n.props?.className === 'string' && n.props.className.includes('items-center'))
  assert.equal(regs.audio.render().props.style?.flexBasis, '100%', 'audio panel on its own line')
  assert.ok(audioRow)
  mock.composer.draft = PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  assert.equal(regs.hint.render().props.style?.flexBasis, '100%', '转为 Markdown row on its own line')

  // The user deletes the audio chip: the next draft refresh drops the offer.
  mock.composer.draft = PLAIN
  ticks.forEach(fn => fn())
  await tick(10)
  assert.equal(flatText(regs.audio.render()).includes('检测到音频'), false)
  mock.composer.draft = ''
})

test('dogfood D10: a local model download is confirmed with its size; 取消 transcribes nothing', async () => {
  const b = sttBackend({ kind: 'local', provider: 'local', needs_download: true, model: 'base', download_mb: 150, language: null }, { transcript: 'x', error: null })
  const { ctx, regs, listeners } = makeCtx(b.fn)
  plugin.register(ctx)
  mock.composer.draft = ''
  await pasteAudio(listeners)
  find(regs.audio.render(), byText('转写')).props.onClick()
  await tick(10)
  const tree = regs.audio.render()
  assert.match(flatText(tree), /下载语音模型「base」（约 150 MB）/)
  find(tree, byText('取消')).props.onClick()
  await tick(10)
  assert.equal(b.seen.filter(r => r.path === '/transcribe').length, 0)
})

test('dogfood D10: a cached local model transcribes without a dialog; no STT / errors / 忽略 keep the plain file chip', async () => {
  const cached = sttBackend({ kind: 'local', provider: 'local', needs_download: false, model: 'base' }, { transcript: '本机', error: null })
  let c = makeCtx(cached.fn)
  plugin.register(c.ctx)
  mock.composer.draft = ''
  await pasteAudio(c.listeners)
  find(c.regs.audio.render(), byText('转写')).props.onClick()
  await tick(20)
  assert.match(mock.composer.draft, /> 转写：本机/)

  const none = sttBackend({ kind: 'none' }, {})
  c = makeCtx(none.fn)
  plugin.register(c.ctx)
  mock.calls.length = 0
  mock.composer.draft = ''
  await pasteAudio(c.listeners)
  find(c.regs.audio.render(), byText('转写')).props.onClick()
  await tick(10)
  assert.match(callsOf('notify').at(-1).args[0].message, /没有可用的语音转写/)
  assert.equal(mock.composer.draft, '@file:`/Users/me/voice memo.m4a`')

  const failing = sttBackend({ kind: 'local', provider: 'local', needs_download: false }, { transcript: null, error: 'failed: no audio stream' })
  c = makeCtx(failing.fn)
  plugin.register(c.ctx)
  mock.calls.length = 0
  mock.composer.draft = ''
  await pasteAudio(c.listeners)
  find(c.regs.audio.render(), byText('转写')).props.onClick()
  await tick(20)
  assert.match(callsOf('notify').at(-1).args[0].message, /转写失败：no audio stream/)

  c = makeCtx(cached.fn)
  plugin.register(c.ctx)
  mock.composer.draft = ''
  await pasteAudio(c.listeners)
  find(c.regs.audio.render(), byText('忽略')).props.onClick()
  assert.equal(c.regs.audio.render(), null)
  assert.equal(mock.composer.draft, '@file:`/Users/me/voice memo.m4a`')
})

test('dogfood D10: a cloud 402 reads as an account problem', async () => {
  const b = sttBackend({ kind: 'local', provider: 'local', needs_download: false }, { transcript: null, error: 'failed: xAI STT API error (HTTP 402): {"error":"You have run out of credits"}' })
  const { ctx, regs, listeners } = makeCtx(b.fn)
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = ''
  await pasteAudio(listeners)
  find(regs.audio.render(), byText('转写')).props.onClick()
  await tick(20)
  assert.match(callsOf('notify').at(-1).args[0].message, /额度用完了（HTTP 402）/)
})

test('dogfood 11-07: a 预览 button for a markdown draft opens the rendered draft only', async () => {
  const { ctx, regs, listeners } = makeCtx({})
  plugin.register(ctx)
  const input = () => listeners.input.forEach(fn => fn({ target: { isContentEditable: true }, inputType: 'insertText', data: 'x' }))
  mock.composer.draft = '今天下午三点开会'
  input()
  await tick(350)
  assert.equal(regs['md-preview'].render(), null, 'plain text: no button')

  mock.composer.draft = '**需求**\n\n- 照片转 3D 打印头雕'
  input()
  await tick(350)
  const tree = regs['md-preview'].render()
  assert.equal(find(tree, byText('仅原文')), null, 'no tabs, only the button')
  assert.equal(regs.split.render(), null, 'no split view until 预览')
  mock.calls.length = 0
  find(tree, byText('预览')).props.onClick()
  await tick(5)
  const split = regs.split.render()
  assert.equal(find(split, (n: any) => n.type === 'pre'), null, 'no raw pane')
  assert.equal(find(split, (n: any) => n.type === 'DialogDescription'), null, 'no description line')
  const title = find(split, (n: any) => n.type === 'DialogTitle')
  assert.equal(title.props.style?.clip, 'rect(0 0 0 0)', 'title kept for screen readers, not shown')
  assert.ok(find(split, (n: any) => n.type === 'MessageTextContent' && n.props.text === '**需求**\n\n- 照片转 3D 打印头雕'), 'rendered')
  assert.equal(callsOf('setDraft').length, 0, 'viewing never writes the draft')

  find(split, byText('关闭')).props.onClick()
  assert.equal(regs.split.render(), null)
  mock.composer.draft = ''
})

test('dogfood 11-07 bug: buttons never submit the composer form (clicking 预览 sent the message)', async () => {
  // composer.top renders inside Desktop's <form>; a <button> without a type is a submit button.
  const src = readFileSync(`${root}desktop/src/plugin.ts`, 'utf8')
  const buttons = src.match(/jsx\(Button, \{/g) ?? []
  const typed = src.match(/jsx\(Button, \{ type: 'button',/g) ?? []
  assert.ok(buttons.length > 0)
  assert.equal(typed.length, buttons.length, 'every Button declares type: button')
  const raw = src.match(/jsx\('button', \{/g) ?? []
  const rawTyped = src.match(/jsx\('button', \{\s*type: 'button'/g) ?? []
  assert.equal(rawTyped.length, raw.length, 'every plain <button> declares type: button')

  const { ctx, regs, listeners } = makeCtx({})
  plugin.register(ctx)
  mock.composer.draft = '**需求**\n\n- 一条'
  listeners.input.forEach(fn => fn({ target: { isContentEditable: true }, inputType: 'insertText', data: 'x' }))
  await tick(350)
  const tree = regs['md-preview'].render()
  assert.equal(find(tree, byText('预览')).props.type, 'button')
  mock.composer.draft = ''
})

test('dogfood 11-07 smart mode: 图文交错 converts by itself, the notice carries no reason or full stop (11-09); a single link only offers', async () => {
  const { ctx, regs, listeners, store } = makeCtx({ results: [{ url: 'https://x.test/a.png', path: '/c/a.png', error: null }] })
  delete store.convert_mode // default: smart
  plugin.register(ctx)
  mock.composer.draft = PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  await tick(20)
  assert.match(mock.composer.draft, /^## 插件市场怎么审核/)
  let row = regs.hint.render()
  assert.ok(find(row, byText('已自动转为 Markdown')))
  await find(row, byText('撤销')).props.onClick()
  await tick()
  assert.equal(mock.composer.draft, PLAIN)

  const linkHtml = '<p>详见 <a href="https://h.test/docs">官方文档</a>，明天再说。</p>'
  mock.composer.draft = '详见官方文档，明天再说。'
  paste(listeners, { 'text/html': linkHtml, 'text/plain': '详见官方文档，明天再说。' })
  await tick(20)
  assert.equal(mock.composer.draft, '详见官方文档，明天再说。', 'not converted by itself')
  row = regs.hint.render()
  assert.ok(find(row, byText('转为 Markdown')), 'offers the button')
  mock.composer.draft = ''
})

test('dogfood 11-08: 预览 keeps everything within the window (no sideways scrolling)', async () => {
  const appended: any[] = []
  doc.head = { append: (el: any) => appended.push(el) }
  doc.createElement = (tag: string) => ({ tag, textContent: '' })
  try {
    const { ctx, regs, listeners } = makeCtx({ results: [] })
    plugin.register(ctx)
    const css = appended[0].textContent as string
    assert.match(css, /\.rp-preview \{ overflow-x: hidden;/)
    assert.match(css, /\.rp-preview \* \{ max-width: 100%;/)
    assert.match(css, /\.rp-preview table \{ display: block; overflow-x: auto; \}/)
    mock.composer.draft = '**需求**\n\n- 一条 ' + 'x'.repeat(400)
    listeners.input.forEach(fn => fn({ target: { isContentEditable: true }, inputType: 'insertText', data: 'x' }))
    await tick(350)
    await find(regs['md-preview'].render(), byText('预览')).props.onClick()
    await tick(5)
    const box = find(regs.split.render(), (n: any) => n.props?.['aria-label'] === '渲染效果')
    assert.match(box.props.className, /\brp-preview\b/)
    // Desktop centres the dialog with left: 50%, so a content-sized dialog stops at half the window
    // and clipped a 72vw body (seen live 11-08): the dialog gets the width, the body fills it.
    const content = find(regs.split.render(), (n: any) => n.type === 'DialogContent')
    assert.equal(content.props.style?.width, 'min(960px, 88vw)')
    assert.equal(box.props.style?.width, '100%')
    find(regs.split.render(), byText('关闭')).props.onClick()
  } finally {
    delete doc.head
    delete doc.createElement
    mock.composer.draft = ''
  }
})

test('dogfood 11-07: busy rows end in animated dots, not a static ellipsis', async () => {
  const appended: any[] = []
  doc.head = { append: (el: any) => appended.push(el) }
  doc.createElement = (tag: string) => ({ tag, textContent: '' })
  try {
    const { ctx, regs, listeners } = makeCtx({ results: [] })
    plugin.register(ctx)
    const css = appended[0].textContent as string
    assert.match(css, /@keyframes rp-dots/)
    assert.match(css, /\.rp-dots::after/)
    assert.match(css, /prefers-reduced-motion/)
    mock.composer.draft = PLAIN
    paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
    find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
    const busy = regs.hint.render()
    assert.ok(find(busy, (n: any) => n.props?.className === 'rp-dots'), 'animated dots while converting')
    assert.equal(find(busy, byText('正在转为 Markdown…')), null, 'no static ellipsis')
    await tick(20)
  } finally {
    delete doc.head
    delete doc.createElement
    mock.composer.draft = ''
  }
})

// ---- dogfood 11-07: progress you can see, and Enter while converting ----
const HTML3 = '<h2>三张图</h2><p>第一段文字比较长一些。</p><img src="https://x.test/1.png" alt="一"><img src="https://x.test/2.png" alt="二"><img src="https://x.test/3.png" alt="三"><p>结尾</p>'
const PLAIN3 = '三张图\n第一段文字比较长一些。\n结尾'

function gatedBackend() {
  const gates: { url: string; open: () => void; body: any }[] = []
  const handler = (path: string, opts: any) => {
    if (path !== '/fetch-images') return {}
    const url = opts.body.urls[0]
    return new Promise(resolve => gates.push({ url, body: opts.body, open: () => resolve({ results: [{ url, path: `/c/rich-paste-cache/${url.slice(-5)}`, error: null }] }) }))
  }
  return { gates, handler }
}
const rowText = (tree: any) => JSON.stringify(tree)

test('dogfood 11-07: images download one by one; the row counts them and a bar runs on top of the composer', async () => {
  const { gates, handler } = gatedBackend()
  const { ctx, regs, listeners } = makeCtx(handler)
  plugin.register(ctx)
  assert.equal(regs['busy-bar'].render(), null, 'no bar when idle')
  mock.composer.draft = PLAIN3
  paste(listeners, { 'text/html': HTML3, 'text/plain': PLAIN3 })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(5)
  assert.equal(gates.length, 3, 'one request per image')
  assert.ok(gates.every(g => g.body.urls.length === 1))
  assert.equal(gates.filter(g => g.body.cleanup.auto_delete !== false).length, 1, 'cache cleanup runs once, not per image')
  assert.match(rowText(regs.hint.render()), /正在下载图片 0\/3/)
  assert.ok(regs['busy-bar'].render(), 'bar while busy')
  gates[0].open()
  await tick(5)
  assert.match(rowText(regs.hint.render()), /正在下载图片 1\/3/)
  gates[1].open(); gates[2].open()
  await tick(20)
  assert.match(mock.composer.draft, /!\[一\]\(\/c\/rich-paste-cache\/1\.png\)/)
  assert.equal(regs['busy-bar'].render(), null, 'bar gone when done')
  mock.composer.draft = ''
})

test('dogfood 11-07: the count limit is applied before downloading; the rest are 图片未下载 links', async () => {
  const { gates, handler } = gatedBackend()
  const { ctx, regs, listeners, store } = makeCtx(handler)
  store.limit_images = true
  store.max_images = 1
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = PLAIN3
  paste(listeners, { 'text/html': HTML3, 'text/plain': PLAIN3 })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(5)
  assert.equal(gates.length, 1, 'only the allowed image is requested')
  assert.match(rowText(regs.hint.render()), /正在下载图片 0\/1/)
  gates[0].open()
  await tick(20)
  assert.match(mock.composer.draft, /\[图片未下载（超出张数上限）：二\]\(https:\/\/x\.test\/2\.png\)/)
  assert.equal(callsOf('notify').filter(c => /上限/.test(c.args[0].message)).length, 0, 'the row says it; no toast')
  let row = regs['more-images'].render()
  assert.match(rowText(row), /第 2、3 张超出张数上限/)
  const more = find(row, byText('再下载 2 张'))
  assert.equal(more.props.type, 'button')

  more.props.onClick()
  await tick(5)
  assert.equal(gates.length, 3, 'the two skipped images are requested now')
  assert.match(rowText(regs['more-images'].render()), /正在下载图片 0\/2/)
  gates[1].open(); gates[2].open()
  await tick(20)
  assert.match(mock.composer.draft, /!\[二\]\(\/c\/rich-paste-cache\/2\.png\)/)
  assert.match(mock.composer.draft, /!\[三\]\(\/c\/rich-paste-cache\/3\.png\)/)
  assert.doesNotMatch(mock.composer.draft, /图片未下载/)
  assert.equal(regs['more-images'].render(), null, 'row gone when done')
  mock.composer.draft = ''
})

test('review 11-10: «no limit» still downloads at most 50 images per paste; the rest wait for 再下载', async () => {
  const urls = Array.from({ length: 53 }, (_, i) => `https://x.test/${i}.png`)
  const html = '<h2>多图</h2>' + urls.map((u, i) => `<p>第 ${i} 段文字</p><img src="${u}" alt="图${i}">`).join('')
  const plain = '多图\n' + urls.map((_u, i) => `第 ${i} 段文字`).join('\n')
  const { ctx, regs, listeners, rest } = makeCtx((path: string, opts: any) =>
    path === '/fetch-images' ? { results: opts.body.urls.map((url: string) => ({ url, path: `/c/rich-paste-cache/${url.split('/').pop()}`, error: null })) } : {})
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = plain
  paste(listeners, { 'text/html': html, 'text/plain': plain })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(60)
  const fetched = (rest as any[]).filter(r => r.path === '/fetch-images').flatMap(r => r.opts.body.urls)
  assert.equal(fetched.length, 50)
  assert.match(rowText(regs['more-images'].render()), /第 51、52、53 张超出张数上限/)
  mock.composer.draft = ''
})

test('review 11-08: 再下载 writes an alt with $ signs as it is (no replacement patterns)', async () => {
  const { gates, handler } = gatedBackend()
  const { ctx, regs, listeners, store } = makeCtx(handler)
  store.limit_images = true
  store.max_images = 1
  plugin.register(ctx)
  const html = '<h2>价格</h2><p>第一段文字比较长一些。</p><img src="https://x.test/1.png" alt="一"><img src="https://x.test/2.png" alt="价格 $' + "'" + ' 尾"><p>结尾</p>'
  const plain = '价格\n第一段文字比较长一些。\n结尾'
  mock.composer.draft = plain
  paste(listeners, { 'text/html': html, 'text/plain': plain })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(5)
  gates[0].open()
  await tick(20)
  find(regs['more-images'].render(), byText('再下载 1 张')).props.onClick()
  await tick(5)
  gates[1].open()
  await tick(20)
  assert.match(mock.composer.draft, /!\[价格 \$' 尾\]\(\/c\/rich-paste-cache\/2\.png\)\n\n结尾$/)
  mock.composer.draft = ''
})

test('dogfood 11-07: sending drops the 再下载 offer', async () => {
  const { gates, handler } = gatedBackend()
  const { ctx, regs, listeners, store } = makeCtx(handler)
  store.limit_images = true
  store.max_images = 1
  plugin.register(ctx)
  mock.composer.draft = PLAIN3
  paste(listeners, { 'text/html': HTML3, 'text/plain': PLAIN3 })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(5)
  gates[0].open()
  await tick(20)
  assert.ok(regs['more-images'].render())
  await regs['attach-markers'].data.handler({ text: mock.composer.draft, attachments: [] })
  assert.equal(regs['more-images'].render(), null)
  mock.composer.draft = ''
})

test('dogfood 11-07: Enter while converting sends the plain text and cancels the conversion; nothing pops back in', async () => {
  const { gates, handler } = gatedBackend()
  const { ctx, regs, listeners } = makeCtx(handler)
  plugin.register(ctx)
  mock.composer.draft = PLAIN3
  paste(listeners, { 'text/html': HTML3, 'text/plain': PLAIN3 })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(5)
  mock.calls.length = 0
  mock.composer.draft = '' // Desktop clears the composer before the middleware runs
  const out = await regs['attach-markers'].data.handler({ text: PLAIN3, attachments: [] })
  assert.equal(noCount(out.text), PLAIN3, 'sent as it was')
  assert.equal(regs.hint.render(), null)
  assert.equal(regs['busy-bar'].render(), null)
  // dogfood 11-10 (real run): Desktop clears every toast right after the middleware returns, so the
  // note must come after that, not from inside the handler.
  assert.ok(!callsOf('notify').some(c => c.args[0].message === '已按原文发送，这次转换取消了'), 'not during the send')
  await tick(700)
  assert.ok(callsOf('notify').some(c => c.args[0].message === '已按原文发送，这次转换取消了'), 'shown after the send')
  gates.forEach(g => g.open())
  await tick(20)
  assert.equal(callsOf('setDraft').length + callsOf('insertText').length, 0, 'the late result is dropped')
  assert.equal(mock.composer.draft, '')
})

test('review 11-08 (B5): sending cancels every conversion still running for that chat, not only the latest', async () => {
  const { gates, handler } = gatedBackend()
  const { ctx, regs, listeners } = makeCtx(handler)
  plugin.register(ctx)
  mock.composer.draft = PLAIN3
  paste(listeners, { 'text/html': HTML3, 'text/plain': PLAIN3 })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(5)
  mock.composer.draft = PLAIN3 + '\n' + PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(5)
  mock.calls.length = 0
  mock.composer.draft = ''
  await regs['attach-markers'].data.handler({ text: PLAIN3 + '\n' + PLAIN, attachments: [] })
  gates.forEach(g => g.open())
  await tick(30)
  assert.equal(callsOf('setDraft').length + callsOf('insertText').length, 0, 'neither result lands in the emptied composer')
  assert.equal(mock.composer.draft, '')
})

test('dogfood 11-07: sending clears a pending 转为 Markdown offer for that chat', async () => {
  const { ctx, regs, listeners } = makeCtx({ results: [] })
  plugin.register(ctx)
  mock.composer.draft = PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  assert.ok(find(regs.hint.render(), byText('转为 Markdown')))
  mock.calls.length = 0
  await regs['attach-markers'].data.handler({ text: PLAIN, attachments: [] })
  assert.equal(regs.hint.render(), null)
  assert.equal(callsOf('notify').length, 0, 'nothing was running: no toast')
  mock.composer.draft = ''
})

test('dogfood 11-07: warnings go away by themselves (Desktop keeps them until closed); errors stay', async () => {
  const { ctx, regs, listeners } = makeCtx({ results: [{ url: 'https://x.test/a.png', path: null, error: 'http_error:404' }] })
  plugin.register(ctx)
  mock.calls.length = 0
  mock.composer.draft = PLAIN
  paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(20)
  const warning = callsOf('notify').find(c => c.args[0].kind === 'warning')
  assert.ok(warning, 'the 下载失败 warning')
  assert.equal(warning.args[0].durationMs, 8000)
  mock.composer.draft = ''
})

test('dogfood 11-07: at send each 截图 N finds its own image by content; a removed one leaves the text', async () => {
  const png = (b: number) => ({ name: 'image.png', type: 'image/png', size: 4, arrayBuffer: async () => new Uint8Array([137, 80, 78, b]).buffer })
  let saves = 0
  const { ctx, regs, listeners } = makeCtx((path: string, opts: any) => {
    if (path === '/save-preview') { saves += 1; return { path: `/c/rich-paste-cache/s${saves}.png`, error: null, sha256: `sha-${saves}` } }
    if (path === '/file-digests') return { digests: Object.fromEntries(opts.body.paths.map((p: string) => [p, p.endsWith('second.png') ? 'sha-2' : 'sha-other'])) }
    return {}
  })
  plugin.register(ctx)
  mock.composer.draft = ''
  for (const b of [1, 2]) {
    listeners.paste.forEach(fn => fn({ target: { isContentEditable: true }, clipboardData: { getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => png(b) }] } }))
    await tick(10)
    mock.composer.draft += b === 1 ? '@image:`截图 1` ' : '@image:`截图 2`'
  }
  mock.calls.length = 0
  // The user removed 截图 1's attachment: only the second image is left.
  const out = await regs['attach-markers'].data.handler({
    text: '先看 @image:`截图 1` 再看 @image:`截图 2`',
    attachments: [{ id: 'x', kind: 'image', path: '/Users/me/Hermes/composer-images/second.png' }]
  })
  assert.equal(noCount(out.text), '先看  再看 \u2063[截图 2]\u2063')
  assert.ok(!callsOf('notify').some(c => /截图 1」的附件已删除/.test(c.args[0].message)), 'not during the send (Desktop clears toasts after it)')
  await tick(700)
  assert.ok(callsOf('notify').some(c => /截图 1」的附件已删除/.test(c.args[0].message)))
})

test('review 11-08: 截图 N is known per chat and per message; an unknown or unreadable image never drops a chip', async () => {
  const png = (b: number) => ({ name: 'image.png', type: 'image/png', size: 4, arrayBuffer: async () => new Uint8Array([137, 80, 78, b]).buffer })
  let failSave = false
  const { ctx, regs, listeners } = makeCtx((path: string, opts: any) => {
    if (path === '/save-preview') {
      if (failSave) return new Error('500: boom')
      const b = opts.body.data_url
      return { path: `/c/rich-paste-cache/${b.length}.png`, error: null, sha256: `sha-${b}` }
    }
    if (path === '/file-digests') return { digests: Object.fromEntries(opts.body.paths.map((p: string) => [p, p.endsWith('cat.png') ? `sha-data:image/png;base64,${Buffer.from([137, 80, 78, 1]).toString('base64')}` : p.endsWith('dog.png') ? `sha-data:image/png;base64,${Buffer.from([137, 80, 78, 2]).toString('base64')}` : null])) }
    return {}
  })
  plugin.register(ctx)
  const pasteShot = async (b: number) => {
    listeners.paste.forEach(fn => fn({ target: { isContentEditable: true }, clipboardData: { getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => png(b) }] } }))
    await tick(10)
  }
  // Chat A: the cat is 截图 1. Chat B: the dog is also 截图 1.
  mock.host.state.focusedSessionId.set('chat-a')
  mock.composer.draft = ''
  await pasteShot(1)
  mock.host.state.focusedSessionId.set('chat-b')
  mock.composer.draft = ''
  await pasteShot(2)
  mock.host.state.focusedSessionId.set('chat-a')
  mock.calls.length = 0
  let out = await regs['attach-markers'].data.handler({ text: '看 @image:`截图 1` 这里', attachments: [{ id: 'a', kind: 'image', path: '/x/composer-images/cat.png' }] })
  assert.equal(noCount(out.text), '看 \u2063[截图 1]\u2063 这里', 'chat A keeps its own cat')
  assert.equal(callsOf('notify').length, 0)

  // Next message in chat A: 截图 1 is a new picture whose preview copy failed; the old cat must not count.
  failSave = true
  mock.composer.draft = ''
  await pasteShot(3)
  out = await regs['attach-markers'].data.handler({ text: '新图 @image:`截图 1` 说明', attachments: [{ id: 'b', kind: 'image', path: '/x/composer-images/bird.png' }] })
  assert.equal(noCount(out.text), '新图 \u2063[截图 1]\u2063 说明')
  failSave = false

  // Chat B: the attachment's digest cannot be read (null): keep the chip by order, do not call it removed.
  mock.host.state.focusedSessionId.set('chat-b')
  mock.calls.length = 0
  out = await regs['attach-markers'].data.handler({ text: '狗 @image:`截图 1`', attachments: [{ id: 'c', kind: 'image', path: '/x/composer-images/unreadable.png' }] })
  assert.equal(noCount(out.text), '狗 \u2063[截图 1]\u2063')
  assert.ok(!callsOf('notify').some(c => /已删除/.test(c.args[0].message)))
  mock.host.state.focusedSessionId.set('s1')
  mock.composer.draft = ''
})

test('dogfood 11-07: without the digest route (old backend) screenshots bind by order as before', async () => {
  const { ctx, regs } = makeCtx((path: string) => (path === '/file-digests' ? new Error('404: Not Found') : {}))
  plugin.register(ctx)
  const out = await regs['attach-markers'].data.handler({ text: '@image:`截图 1`', attachments: [{ id: 'x', kind: 'image', path: '/ci/a.png' }] })
  assert.equal(noCount(out.text), '\u2063[截图 1]\u2063')
})

test('dogfood 11-07: a copied chip reference pasted as plain text turns back into a chip', async () => {
  const { ctx, listeners } = makeCtx({})
  plugin.register(ctx)
  mock.composer.draft = '前面 @image:`截图 1` 后面'
  mock.calls.length = 0
  paste(listeners, { 'text/plain': '@image:`截图 1`' })
  await tick(10)
  const set = callsOf('setDraft')
  assert.equal(set.length, 1, 'rehydrated once')
  assert.equal(set[0].args[1], '前面 @image:`截图 1` 后面')
  mock.calls.length = 0
  paste(listeners, { 'text/plain': '普通文字' })
  await tick(10)
  assert.equal(callsOf('setDraft').length, 0, 'plain text is left alone')
  mock.composer.draft = ''
})

// ---- dogfood 11-07: long pastes (Desktop turns > 3000 chars into a pasted_content .txt) ----
const LONG_BODY = '这是一段很长的文字，用来超过 Desktop 的长粘贴阈值。'.repeat(140)
const HTML_LONG = `<h2>长文</h2><p>${LONG_BODY}</p><img src="https://x.test/1.png" alt="一"><p>结尾</p>`
const PLAIN_LONG = `长文\n${LONG_BODY}\n结尾`
const TXT = '/Users/me/.hermes/composer-pastes/pasted_content_2026-11-08_00-03-01-000_abcdef.txt'
const savedMarkdown: Record<string, string> = {}
function longBackend(extra: (path: string, opts: any) => unknown = () => ({})) {
  return (path: string, opts: any) => {
    if (path === '/save-markdown') {
      const p = `/c/rich-paste-cache/20261108/${String(Object.keys(savedMarkdown).length).padStart(20, '0')}.md`
      savedMarkdown[p] = opts.body.markdown
      return { path: p, error: null }
    }
    if (path === '/read-markdown') return { markdown: savedMarkdown[opts.body.path] ?? null, error: savedMarkdown[opts.body.path] ? null : 'not_found' }
    if (path === '/fetch-images') return { results: [{ url: opts.body.urls[0], path: '/c/rich-paste-cache/1.png', error: null }] }
    if (path === '/paste-files') { const own = extra(path, opts) as any; if (own && own.files) return own }
    if (path === '/paste-files') return { files: Object.fromEntries(opts.body.paths.map((p: string) => [p, p === TXT ? { chars: PLAIN_LONG.length, head: PLAIN_LONG.slice(0, 200) } : null])) }
    return extra(path, opts)
  }
}

test('dogfood 11-07: a long rich paste is converted aside; the draft is untouched (no duplicate)', async () => {
  const { ctx, regs, listeners, store } = makeCtx(longBackend())
  delete store.convert_mode // smart
  plugin.register(ctx)
  assert.ok(PLAIN_LONG.length > 3000)
  mock.calls.length = 0
  mock.composer.draft = '' // Desktop attached the text as a file instead
  paste(listeners, { 'text/html': HTML_LONG, 'text/plain': PLAIN_LONG })
  await tick(30)
  assert.equal(callsOf('setDraft').length + callsOf('insertText').length, 0, 'nothing written into the composer')
  const row = regs['long-paste'].render()
  assert.match(rowText(row), /会按 Markdown 发送/)
  assert.match(rowText(row), /1 张图/)
  assert.ok(find(row, byText('预览')) && find(row, byText('改回纯文字')))
  await find(row, byText('预览')).props.onClick()
  assert.ok(find(regs.split.render(), (n: any) => n.type === 'MessageTextContent' && /^## 长文/.test(n.props.text)))
  find(regs.split.render(), byText('关闭')).props.onClick()

  const out = await regs['attach-markers'].data.handler({
    text: '再深入一点',
    attachments: [{ id: 'p', kind: 'file', label: '粘贴内容', path: TXT }]
  })
  assert.match(noCount(out.text), /^再深入一点\n\n## 长文\n\n这是一段很长的文字/)
  assert.match(noCount(out.text), /\u2063\[图：一\]\u2063/)
  assert.ok(!out.attachments.some((a: any) => a.path === TXT), 'the plain .txt is replaced')
  assert.ok(out.attachments.some((a: any) => a.kind === 'image' && a.path === '/c/rich-paste-cache/1.png'))
  assert.equal(regs['long-paste'].render(), null, 'used up by the send')
})

test('review 11-08: two long pastes with the same opening stay apart; each .txt gets its own Markdown', async () => {
  const plainA = `长文\n${LONG_BODY}\n甲篇结尾`
  const plainB = `长文\n${LONG_BODY}\n乙篇的结尾不一样`
  const TXT_B = TXT.replace('abcdef', 'bbbbbb')
  const { ctx, regs, listeners, store } = makeCtx(longBackend((path: string, opts: any) => {
    if (path === '/paste-files') return { files: Object.fromEntries(opts.body.paths.map((p: string) => [p, p === TXT_B ? { chars: plainB.length, head: plainB.slice(0, 200), tail: plainB.slice(-200) } : null])) }
    return {}
  }))
  delete store.convert_mode
  plugin.register(ctx)
  mock.composer.draft = ''
  paste(listeners, { 'text/html': `<h2>长文</h2><p>${LONG_BODY}</p><img src="https://x.test/1.png" alt="一"><p>甲篇结尾</p>`, 'text/plain': plainA })
  await tick(30)
  paste(listeners, { 'text/html': `<h2>长文</h2><p>${LONG_BODY}</p><img src="https://x.test/1.png" alt="一"><p>乙篇的结尾不一样</p>`, 'text/plain': plainB })
  await tick(30)
  assert.equal((rowText(regs['long-paste'].render()).match(/改回纯文字/g) ?? []).length, 2, 'both kept')
  // The user removed A's attachment; only B's .txt goes.
  const out = await regs['attach-markers'].data.handler({ text: '总结第二篇', attachments: [{ id: 'b', kind: 'file', label: '粘贴内容', path: TXT_B }] })
  assert.match(noCount(out.text), /乙篇的结尾不一样/)
  assert.doesNotMatch(noCount(out.text), /甲篇结尾/)
  assert.ok(!out.attachments.some((a: any) => a.path === TXT_B))
})

test('dogfood 11-07: 改回纯文字 keeps Desktop\'s .txt; a removed attachment adds nothing', async () => {
  const { ctx, regs, listeners, store } = makeCtx(longBackend())
  delete store.convert_mode
  plugin.register(ctx)
  mock.composer.draft = ''
  paste(listeners, { 'text/html': HTML_LONG, 'text/plain': PLAIN_LONG })
  await tick(30)
  find(regs['long-paste'].render(), byText('改回纯文字')).props.onClick()
  assert.equal(regs['long-paste'].render(), null)
  const draft = { text: '总结', attachments: [{ id: 'p', kind: 'file', label: '粘贴内容', path: TXT }] }
  let out = await regs['attach-markers'].data.handler(draft)
  assert.equal(noCount(out.text), '总结')
  assert.deepEqual(out.attachments.map((a: any) => a.path), [TXT])

  paste(listeners, { 'text/html': HTML_LONG, 'text/plain': PLAIN_LONG })
  await tick(30)
  out = await regs['attach-markers'].data.handler({ text: '总结', attachments: [] }) // user removed the .txt
  assert.equal(noCount(out.text), '总结', 'no attachment, no Markdown')
})

test('dogfood 11-07: the 再下载 row hides once its links are gone from the draft', async () => {
  const { gates, handler } = gatedBackend()
  const { ctx, regs, listeners, store } = makeCtx(handler)
  store.limit_images = true
  store.max_images = 1
  plugin.register(ctx)
  mock.composer.draft = PLAIN3
  paste(listeners, { 'text/html': HTML3, 'text/plain': PLAIN3 })
  find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(5)
  gates[0].open()
  await tick(20)
  assert.ok(regs['more-images'].render())
  mock.composer.draft = '用户把整段删了'
  listeners.input.forEach(fn => fn({ target: { isContentEditable: true }, inputType: 'deleteContentBackward' }))
  await tick(350)
  assert.equal(regs['more-images'].render(), null)
  mock.composer.draft = ''
})

test('dogfood 11-07: a long paste survives a plugin reload: the row comes back and the send still swaps the .txt', async () => {
  const first = makeCtx(longBackend())
  delete first.store.convert_mode
  plugin.register(first.ctx)
  mock.composer.draft = ''
  paste(first.listeners, { 'text/html': HTML_LONG, 'text/plain': PLAIN_LONG })
  await tick(30)
  const saved = first.store.long_pastes as any[]
  assert.equal(saved.length, 1)
  assert.ok(saved[0].mdPath, 'the Markdown is on disk')
  assert.equal(saved[0].markdown, undefined, 'storage holds only the index, not the text')

  // Reload: a fresh plugin instance over the same storage.
  const again = makeCtx(longBackend())
  Object.assign(again.store, first.store)
  plugin.register(again.ctx)
  const row = again.regs['long-paste'].render()
  assert.match(rowText(row), /会按 Markdown 发送/)
  await find(row, byText('预览')).props.onClick()
  assert.ok(find(again.regs.split.render(), (n: any) => n.type === 'MessageTextContent' && /^## 长文/.test(n.props.text)))
  find(again.regs.split.render(), byText('关闭')).props.onClick()
  const out = await again.regs['attach-markers'].data.handler({ text: '总结', attachments: [{ id: 'p', kind: 'file', label: '粘贴内容', path: TXT }] })
  assert.match(noCount(out.text), /^总结\n\n## 长文/)
  assert.ok(!out.attachments.some((a: any) => a.path === TXT))
  assert.deepEqual(again.store.long_pastes, [], 'used up and forgotten')
})

test('dogfood 11-07: an old saved long paste (over 7 days) is dropped on load', () => {
  const { ctx, regs, store } = makeCtx(longBackend())
  store.long_pastes = [{ sessionId: 'new', key: 'x', chars: 4000, images: 0, mdPath: '/c/rich-paste-cache/1/00000000000000000009.md', savedAt: Date.now() - 8 * 86400000 }]
  plugin.register(ctx)
  assert.equal(regs['long-paste'].render(), null)
})

test('11-08: 收起 hides the long-paste row (kept over a reload); the send still swaps the .txt', async () => {
  const first = makeCtx(longBackend())
  delete first.store.convert_mode
  plugin.register(first.ctx)
  mock.composer.draft = ''
  paste(first.listeners, { 'text/html': HTML_LONG, 'text/plain': PLAIN_LONG })
  await tick(30)
  const row = first.regs['long-paste'].render()
  assert.equal(find(row, byText('收起')).props.type, 'button')
  find(row, byText('收起')).props.onClick()
  assert.equal(first.regs['long-paste'].render(), null)
  assert.equal((first.store.long_pastes as any[])[0].hidden, true)

  const again = makeCtx(longBackend())
  Object.assign(again.store, first.store)
  plugin.register(again.ctx)
  assert.equal(again.regs['long-paste'].render(), null, 'still hidden after a reload')
  const out = await again.regs['attach-markers'].data.handler({ text: '总结', attachments: [{ id: 'p', kind: 'file', label: '粘贴内容', path: TXT }] })
  assert.match(noCount(out.text), /^总结\n\n## 长文/)
  assert.ok(!out.attachments.some((a: any) => a.path === TXT))
})

test('11-08: the local model picked in settings goes with the status check and the transcription', async () => {
  const seen: any[] = []
  const fn = (path: string, opts: any) => {
    seen.push({ path, opts })
    if (path === '/clipboard-files') return { ok: true, files: [{ path: '/Users/me/voice memo.m4a', is_dir: false }] }
    if (path.startsWith('/stt-status')) return { kind: 'local', provider: 'local', needs_download: true, model: 'small', download_mb: 490, language: null }
    if (path === '/transcribe') return { transcript: '准一点', error: null }
    return {}
  }
  const { ctx, regs, listeners, store } = makeCtx(fn)
  plugin.register(ctx)
  let page = regs.settings.render()
  assert.equal(find(page, byText('跟随 Hermes')).props['aria-pressed'], true)
  find(page, byText('较准')).props.onClick()
  assert.equal(store.stt_model, 'small')
  page = regs.settings.render()
  assert.match(find(page, (n: any) => n.props?.title === '本机转写模型').props.description, /small.*490 MB/)

  mock.composer.draft = ''
  await pasteAudio(listeners)
  find(regs.audio.render(), byText('转写')).props.onClick()
  await tick(10)
  assert.match(flatText(regs.audio.render()), /下载语音模型「small」（约 490 MB）/)
  find(regs.audio.render(), byText('继续转写')).props.onClick()
  await tick(20)
  assert.ok(seen.some(r => r.path === '/stt-status?model=small'), seen.map(r => r.path).join(','))
  assert.equal(seen.find(r => r.path === '/transcribe').opts.body.model, 'small')
  assert.match(mock.composer.draft, /> 转写：准一点/)
  mock.composer.draft = ''
})

test('dogfood 11-10 (取舍): small images (avatars, icons ≤ 96 px) next to real pictures are left out, with one note', async () => {
  const sizes: Record<string, number[]> = { 'https://x.test/1.png': [1120, 600], 'https://x.test/2.png': [64, 64], 'https://x.test/3.png': [72, 96] }
  const { ctx, regs, listeners } = makeCtx((_p: string, opts: any) => {
    const url = opts?.body?.urls?.[0]
    return { results: [{ url, path: `/c/${url.slice(-5)}`, error: null, size: sizes[url] }] }
  })
  plugin.register(ctx)
  mock.composer.draft = PLAIN3
  paste(listeners, { 'text/html': HTML3, 'text/plain': PLAIN3 })
  mock.calls.length = 0
  await find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(30)
  assert.match(mock.composer.draft, /!\[一\]\(\/c\/1\.png\)/)
  assert.doesNotMatch(mock.composer.draft, /2\.png|3\.png|!\[二\]|!\[三\]/)
  assert.ok(callsOf('notify').some(c => /跳过了 2 张小图/.test(c.args[0].message)), JSON.stringify(callsOf('notify').map(c => c.args[0].message)))
  mock.composer.draft = ''
})

test('dogfood 11-10 (取舍): a paste of only small images keeps them all', async () => {
  const { ctx, regs, listeners } = makeCtx((_p: string, opts: any) => {
    const url = opts?.body?.urls?.[0]
    return { results: [{ url, path: `/c/${url.slice(-5)}`, error: null, size: [48, 48] }] }
  })
  plugin.register(ctx)
  mock.composer.draft = PLAIN3
  paste(listeners, { 'text/html': HTML3, 'text/plain': PLAIN3 })
  await find(regs.hint.render(), byText('转为 Markdown')).props.onClick()
  await tick(30)
  assert.match(mock.composer.draft, /1\.png[\s\S]*2\.png[\s\S]*3\.png/)
  mock.composer.draft = ''
})

test('dogfood 11-10: the 转写 offer survives a draft read that still lags behind the chip; deleting the chip later removes it', async () => {
  const b = sttBackend({ kind: 'local', provider: 'local', language: '' }, { transcript: '你好', error: null })
  const { ctx, regs, listeners } = makeCtx(b.fn)
  plugin.register(ctx)
  mock.composer.draft = ''
  const real = mock.host.composer.getDraft
  let stale = 3  // Desktop answered getDraft with the draft from before setDraft/insertText (real run, 01:44)
  mock.host.composer.getDraft = async (sid: string | null) => (stale-- > 0 ? '' : real(sid))
  try {
    await pasteAudio(listeners)
    await tick(30)
    assert.match(flatText(regs.audio.render()), /检测到音频/, 'offer still there after a stale read')
    stale = 0
    listeners.input.forEach(fn => fn({ target: { isContentEditable: true }, inputType: 'insertText', data: 'a' }))
    await tick(350)
    assert.match(flatText(regs.audio.render()), /检测到音频/, 'chip seen in the draft')
    mock.composer.draft = ''
    listeners.input.forEach(fn => fn({ target: { isContentEditable: true }, inputType: 'deleteContentBackward', data: null }))
    await tick(350)
    assert.equal(regs.audio.render(), null, 'chip deleted: offer gone')
  } finally {
    mock.host.composer.getDraft = real
    mock.composer.draft = ''
  }
})

test('dogfood 11-10: a path without spaces — Desktop still writes the chip quoted — keeps the 转写 offer until the chip is deleted', async () => {
  const b = sttBackend({ kind: 'local', provider: 'local', language: '' }, { transcript: '你好', error: null }, ['/Users/me/测试音频-中文朗读.m4a'])
  const { ctx, regs, listeners } = makeCtx(b.fn)
  plugin.register(ctx)
  mock.composer.draft = ''
  await pasteAudio(listeners, '测试音频-中文朗读.m4a')
  mock.composer.draft = '@file:`/Users/me/测试音频-中文朗读.m4a`'  // how Desktop serialises its chip (real run, 01:44)
  const refresh = async () => { listeners.input.forEach(fn => fn({ target: { isContentEditable: true }, inputType: 'insertText', data: 'a' })); await tick(350) }
  await refresh()
  assert.match(flatText(regs.audio.render()), /检测到音频/, 'quoted chip counts as the same chip')
  mock.composer.draft = ''
  await refresh()
  assert.equal(regs.audio.render(), null, 'chip deleted: offer gone')
})

test('dogfood 11-10: closing the preview puts the caret back in the composer (keyboard users landed at the window corner)', async () => {
  const { ctx, regs, listeners } = makeCtx({ results: [] })
  const focused: unknown[] = []
  mock.host.composer.focus = (sid: unknown) => { focused.push(sid) }
  try {
    plugin.register(ctx)
    mock.composer.draft = '**需求**\n\n- 一条'
    listeners.input.forEach(fn => fn({ target: { isContentEditable: true }, inputType: 'insertText', data: 'x' }))
    await tick(350)
    find(regs['md-preview'].render(), byText('预览')).props.onClick()
    await tick(5)
    find(regs.split.render(), byText('关闭')).props.onClick()
    await tick(5)
    assert.deepEqual(focused, ['s1'])
  } finally {
    delete mock.host.composer.focus
    mock.composer.draft = ''
  }
})

test('dogfood 11-10: a row button that closes its own row (忽略, 撤销, 转写) puts the caret back in the composer', async () => {
  const b = sttBackend({ kind: 'local', provider: 'local', language: '' }, { transcript: '你好', error: null })
  const { ctx, regs, listeners, store } = makeCtx(b.fn)
  const focused: unknown[] = []
  mock.host.composer.focus = (sid: unknown) => { focused.push(sid) }
  try {
    plugin.register(ctx)
    mock.composer.draft = PLAIN
    paste(listeners, { 'text/html': HTML, 'text/plain': PLAIN })
    find(regs.hint.render(), byText('忽略')).props.onClick()
    await tick(5)
    assert.equal(focused.length, 1, '忽略 on the web row')

    mock.composer.draft = ''
    await pasteAudio(listeners)
    find(regs.audio.render(), byText('忽略')).props.onClick()
    await tick(5)
    assert.equal(focused.length, 2, '忽略 on the audio row')

    await pasteAudio(listeners)
    find(regs.audio.render(), byText('转写')).props.onClick()
    await tick(40)
    assert.ok(focused.length >= 3, '转写 (row goes busy, then away)')
  } finally {
    delete mock.host.composer.focus
    mock.composer.draft = ''
  }
})

test('dogfood 11-10: every 预览 button is blue text; the restart tip does not name old features', () => {
  const src = readFileSync(new URL('../../desktop/src/plugin.ts', import.meta.url), 'utf8')
  const previews = [...src.matchAll(/jsx\(Button, \{[^]*?children: t\('preview'\)/g)].map(m => m[0].slice(m[0].lastIndexOf('jsx(Button')))
  assert.ok(previews.length >= 2, String(previews.length))
  for (const b of previews) assert.match(b, /variant: 'text'[^]*className: 'rp-link'|className: 'rp-link'[^]*variant: 'text'/, b)
  assert.doesNotMatch(src, /粘贴文件、TIFF 转 PNG 等新功能/)
})
