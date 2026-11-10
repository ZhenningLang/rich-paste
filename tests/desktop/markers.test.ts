// QA7: composer middleware pure function + marker helpers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  applyDraftMarkers, chipsToMarkers, countAttachedMarkers, countScreenshots, refChip, screenshotChip, findMarkers, localImageMarkers, locatePasted, markerFor,
  removeMarkers, replaceRange, screenshotMarker
} from '../../desktop/src/markers.ts'
import { legacyText, noCount } from './sent-view.ts'
import { setLocale } from '../../desktop/src/i18n.ts'

setLocale('zh') // these tests pin the Chinese strings; english.test.ts covers English

const P1 = '/Users/me/.hermes/cache/rich-paste/rich-paste-cache/20261106/a.png'
const P2 = '/Users/me/.hermes/cache/rich-paste/rich-paste-cache/20261106/b.jpg'
const shot = (n: number, path?: string) => ({ id: `img${n}`, kind: 'image', label: `截图${n}.png`, ...(path ? { path } : {}) })

test('screenshot placeholders bind to the image attachments, written as attached:k', () => {
  const draft = { text: `前 ${screenshotMarker(1)} 中 ${screenshotMarker(2)} 后`,
    attachments: [{ id: 'f', kind: 'file', label: 'a.txt', path: '/x/a.txt' }, shot(1, '/tmp/s1.png'), shot(2, '/tmp/s2.png')] }
  const out = applyDraftMarkers(draft)
  assert.equal(legacyText(out, draft), '前 ![截图 1](attached:1) 中 ![截图 2](attached:2) 后', 'k counts image attachments only')
  assert.equal(out.attachments!.length, 3, 'already attached, nothing appended')
})

test('placeholders bind by number order, not text order', () => {
  const draft = { text: `${screenshotMarker(2)} 然后 ${screenshotMarker(1)}`, attachments: [shot(1, '/tmp/s1.png'), shot(2, '/tmp/s2.png')] }
  assert.equal(legacyText(applyDraftMarkers(draft), draft as any), '![截图 2](attached:2) 然后 ![截图 1](attached:1)')
})

test('B:S2: an extra image attachment without a marker leaves placeholders unbound', () => {
  // photo A was added with the + button (no marker), then screenshot B was pasted
  const draft = { text: `看 ${screenshotMarker(1)}`, attachments: [shot(1, '/tmp/photoA.png'), shot(2, '/tmp/shotB.png')] }
  const out = applyDraftMarkers(draft)
  assert.equal(legacyText(out, draft), `看 ![截图 1](未对上的附件)`, 'never bound to photo A')
})

test('B:S2: a removed screenshot card leaves placeholders unbound', () => {
  const draft = { text: `${screenshotMarker(1)} ${screenshotMarker(2)}`, attachments: [shot(2, '/tmp/s2.png')] }
  assert.equal(legacyText(applyDraftMarkers(draft), draft as any), `![截图 1](未对上的附件) ![截图 2](未对上的附件)`)
})

test('remote uploads without a path still bind by order', () => {
  const draft = { text: `看 ${screenshotMarker(1)}`, attachments: [shot(1)] }
  assert.equal(legacyText(applyDraftMarkers(draft), draft as any), '看 ![截图 1](attached:1)')
})

test('local image markers are appended as image attachments once, after the existing ones', () => {
  const draft = { text: `![a](${P1}) 再 ![a again](${P1}) ![b](${P2}) ${screenshotMarker(1)}`, attachments: [shot(1, '/tmp/s1.png')] }
  const out = applyDraftMarkers(draft)
  assert.equal(legacyText(out, draft), '![a](attached:2) 再 [图：a again] ![b](attached:3) ![截图 1](attached:1)', 'the same image again is a plain label')
  assert.deepEqual(out.attachments, [
    { id: `rich-paste:${P1}`, kind: 'image', label: 'a.png', path: P1 },
    { id: `rich-paste:${P2}`, kind: 'image', label: 'b.jpg', path: P2 },
    shot(1, '/tmp/s1.png')
  ], 'image attachments follow the order of their labels')
  assert.equal(draft.attachments.length, 1, 'input not mutated')
})

test('a marker for an image that is already attached binds to it, nothing appended', () => {
  const draft = { text: `![a](${P1})`, attachments: [{ id: 'core', kind: 'image', label: 'a.png', path: P1 }] }
  const out = applyDraftMarkers(draft)
  assert.equal(legacyText(out, draft), '![a](attached:1)')
  assert.equal(out.attachments!.length, 1)
})

test('shared contract fixture: middleware output (tests/contract/upload_rename.json)', () => {
  const fixture = JSON.parse(readFileSync(new URL('../contract/upload_rename.json', import.meta.url), 'utf8'))
  assert.deepEqual(applyDraftMarkers(fixture.input), fixture.expected)
})

test('non-image extensions, URLs and relative paths are not attached', () => {
  const draft = { text: '![x](/tmp/doc.pdf) ![y](https://x.com/a.png) ![z](rel/a.png) ![w](/tmp/noext)' }
  assert.equal(applyDraftMarkers(draft), draft)
})

test('no attachments field: added list starts empty', () => {
  const out = applyDraftMarkers({ text: `![a](${P1})` })
  assert.equal(noCount(out.text), '\u2063[图：a]\u2063')
  assert.deepEqual(out.attachments, [{ id: `rich-paste:${P1}`, kind: 'image', label: 'a.png', path: P1 }])
})

test('D6: plugin chips turn back into markers/labels; foreign chips stay', () => {
  const pending = [{ path: '/Users/me/My Docs/a.pdf', kind: 'file' as const }, { path: '/Users/me/b.txt', kind: 'file' as const }]
  const text = `看 ${refChip('file', '/Users/me/My Docs/a.pdf')} ${screenshotChip(2)} @file:/Users/me/mine.ts`
  assert.equal(text, '看 @file:`/Users/me/My Docs/a.pdf` @image:`截图 2` @file:/Users/me/mine.ts')
  const { draft, used } = chipsToMarkers({ text, attachments: [] }, pending)
  assert.equal(draft.text, '看 [附件：a.pdf] ![截图 2](attached:2) @file:/Users/me/mine.ts')
  assert.deepEqual(draft.attachments, [{ id: 'rich-paste-file:/Users/me/My Docs/a.pdf', kind: 'file', label: 'a.pdf', path: '/Users/me/My Docs/a.pdf' }])
  assert.deepEqual([...used], ['/Users/me/My Docs/a.pdf'])
  const plain = { text: 'no chips', attachments: [] }
  assert.equal(chipsToMarkers(plain, pending).draft, plain)
})

test('D6: screenshot numbering counts chips and old markers', () => {
  assert.equal(countScreenshots('a @image:`截图 3` b ![截图 1](attached:1)'), 3)
  assert.equal(countScreenshots('@image:/x/y.png'), 0)
})

test('targets are percent-encoded and decode back (D2)', () => {
  const path = '/My Cache/rich-paste-cache/a (1).png'
  const m = markerFor('图', path)
  assert.equal(m, '![图](/My%20Cache/rich-paste-cache/a%20%281%29.png)')
  assert.deepEqual(findMarkers(`x ${m}`).map(k => k.target), [path])
  const out = applyDraftMarkers({ text: m })
  assert.equal(noCount(out.text), '\u2063[图]\u2063')
  assert.equal(out.attachments![0].path, path)
})

test('D2: local image paths the plugin did not download stay plain text, never attached', () => {
  const draft = { text: '![x](/Users/me/secret.png) ![y](/etc/passwd.png)', attachments: [] }
  assert.equal(applyDraftMarkers(draft), draft)
  const own = applyDraftMarkers({ text: '![z](/tmp/dl/a.png)' }, p => p === '/tmp/dl/a.png')
  assert.equal(noCount(own.text), '\u2063[图：z]\u2063')
})

test('D2: a URL cannot close the marker early and smuggle in a local path', () => {
  const evil = 'https://x.test/a.png) ![x](/Users/me/.ssh/id.png'
  const m = markerFor('a', evil)
  assert.equal(findMarkers(m).length, 1)
  assert.equal(findMarkers(m)[0].target, evil)
  const draft = { text: m, attachments: [] }
  assert.equal(applyDraftMarkers(draft), draft, 'nothing attached, text unchanged')
})

test('marker helpers: count, list, remove', () => {
  const text = `${screenshotMarker(1)} ![a](${P1}) ![b](${P2}) ![a2](${P1}) ${screenshotMarker(2)}`
  assert.equal(countAttachedMarkers(text), 2)
  assert.deepEqual(localImageMarkers(text), [{ path: P1, alt: 'a' }, { path: P2, alt: 'b' }])
  assert.equal(removeMarkers(text, P1), `${screenshotMarker(1)}  ![b](${P2})  ${screenshotMarker(2)}`)
})

test('locatePasted: exact match after trim', () => {
  const draft = '我说：\n插件市场怎么审核\n所有插件都要提交到目录。\n然后'
  const r = locatePasted(draft, '  插件市场怎么审核\n所有插件都要提交到目录。\n\n')!
  assert.equal(draft.slice(r.start, r.end), '插件市场怎么审核\n所有插件都要提交到目录。')
  assert.equal(replaceRange(draft, r, '## X'), '我说：\n## X\n然后')
})

test('locatePasted: ignores whitespace differences and core @url: chips', () => {
  const plain = '详见 官方文档 https://hermes.example/docs  以及\n\n更多'
  const draft = '前缀 详见 官方文档 @url:`https://hermes.example/docs` 以及\n更多 尾巴'
  const r = locatePasted(draft, plain)!
  assert.equal(draft.slice(r.start, r.end), '详见 官方文档 @url:`https://hermes.example/docs` 以及\n更多')
})

test('locatePasted: not found / empty → null', () => {
  assert.equal(locatePasted('完全不同', '找不到'), null)
  assert.equal(locatePasted('abc', '   '), null)
  assert.equal(locatePasted('', 'x'), null)
})

test('marker scan terminates on adversarial input', () => {
  const evil = '!['.repeat(20000) + ']('.repeat(20000) + `![a](${P1})`
  assert.deepEqual(findMarkers(evil).map(m => m.target), [P1])
  assert.equal(locatePasted('@'.repeat(50000), '@@@x'), null)
})

test('dogfood 11-07: a screenshot chip can be pinned to one attachment, or dropped', () => {
  const draft = {
    text: '看 @image:`截图 1` 和 @image:`截图 2` 完',
    attachments: [{ id: 'a', kind: 'image', path: '/ci/b.png' }]
  }
  const pin = (n: number) => (n === 2 ? 'rp-image:0' : null) // 截图 1's attachment was removed
  const { draft: unchipped, dropped } = chipsToMarkers(draft as any, [], pin)
  assert.deepEqual(dropped, [1])
  assert.equal(unchipped.text, '看  和 ![截图 2](rp-image:0) 完')
  const out = applyDraftMarkers(unchipped as any)
  assert.equal(legacyText(out, unchipped as any), '看  和 ![截图 2](attached:1) 完')
  assert.equal(out.attachments.length, 1, 'no extra attachment')
})

test('dogfood 11-07: an unknown screenshot (no digest) keeps the order-based placeholder', () => {
  const draft = { text: '@image:`截图 1`', attachments: [{ id: 'a', kind: 'image', path: '/ci/a.png' }] }
  const { draft: unchipped } = chipsToMarkers(draft as any, [], () => undefined)
  assert.equal(unchipped.text, '![截图 1](attached:1)')
  assert.equal(legacyText(applyDraftMarkers(unchipped as any), unchipped as any), '![截图 1](attached:1)')
})

test('dogfood 11-07: a pin to a missing attachment index is unbound, never another image', () => {
  const draft = { text: '![截图 1](rp-image:3)', attachments: [{ id: 'a', kind: 'image', path: '/ci/a.png' }] }
  assert.equal(legacyText(applyDraftMarkers(draft as any), draft as any), `![截图 1](未对上的附件)`)
})

test('11-10: the sent message reads [截图 2], images follow the labels, stray marks from a copied bubble are dropped', () => {
  const draft = { text: `先看 ${screenshotMarker(2)} 再看 ${screenshotMarker(1)} 旧的 \u2063[截图 9]\u2063`, attachments: [shot(1, '/tmp/s1.png'), shot(2, '/tmp/s2.png')] }
  const out = applyDraftMarkers(draft)
  assert.equal(noCount(out.text), '先看 \u2063[截图 2]\u2063 再看 \u2063[截图 1]\u2063 旧的 [截图 9]')
  assert.deepEqual(out.attachments!.map(a => a!.id), ['img2', 'img1'])
  assert.equal(noCount(out.text).replaceAll('\u2063', ''), '先看 [截图 2] 再看 [截图 1] 旧的 [截图 9]', 'what the bubble shows')
})

test('11-10: an unbound screenshot reads as a label, never as markdown', () => {
  const draft = { text: `看 ${screenshotMarker(1)}`, attachments: [] }
  assert.equal(noCount(applyDraftMarkers(draft).text), '看 [截图 1：未对上的附件]')
})

test('review 11-10: the sent text ends with how many images went out; a copied bubble brings none back', async () => {
  const { countOf } = await import('./sent-view.ts')
  const draft = { text: `看 ${screenshotMarker(1)} 和 ![a](${P1})`, attachments: [shot(1, '/tmp/s1.png')] }
  const out = applyDraftMarkers(draft)
  assert.equal(countOf(out.text), 2, 'the screenshot and the appended web image')
  const copied = applyDraftMarkers({ text: out.text, attachments: [] })
  assert.equal(countOf(copied.text), null)
  assert.ok(!/[\u{E0000}-\u{E007F}⁣]/u.test(copied.text), JSON.stringify(copied.text))
  assert.equal(countOf(applyDraftMarkers({ text: 'no labels', attachments: [shot(1, '/tmp/s1.png')] }).text), null, 'no label, no token')
})

test('review 11-10: an alt that merely starts with 图 still gets the 图： prefix', () => {
  const own = (p: string) => p.startsWith('/c/')
  assert.equal(noCount(applyDraftMarkers({ text: '![图书馆外景](/c/a.png)' }, own).text), '⁣[图：图书馆外景]⁣')
  assert.equal(noCount(applyDraftMarkers({ text: '![图](/c/a.png)' }, own).text), '⁣[图]⁣')
})
