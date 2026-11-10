// Smart conversion (dogfood 11-07): which pastes convert by themselves, which only offer the button.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import domino from '@mixmark-io/domino'

import { pasteDecision, pasteShape } from '../../desktop/src/convert.ts'
import { setLocale } from '../../desktop/src/i18n.ts'

setLocale('zh') // these tests pin the Chinese strings; english.test.ts covers English

const decide = (html: string, mode: 'smart' | 'always' | 'never' = 'smart') =>
  pasteDecision(pasteShape(domino.createDocument(html), html), mode)

const IMG = 'https://x.test/a.png'

test('smart: text with pictures in between converts by itself (图文交错)', () => {
  const d = decide(`<p>第一天早上去了湖边，水面很平，远处有雪山。</p><img src="${IMG}"><p>中午在小镇上遇到一只很乖的狗。</p>`)
  assert.deepEqual(d, { action: 'auto', reason: 'interleave' })
})

test('smart: a real table converts by itself; a spreadsheet copy or a one-cell table only offers', () => {
  const table = '<table><tr><th>问题</th><th>处理</th></tr><tr><td>CI 红了</td><td>看日志</td></tr></table>'
  assert.deepEqual(decide(table), { action: 'auto', reason: 'table' })
  const excel = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><body>${table}</body></html>`
  assert.equal(decide(excel).action, 'offer')
  const sheets = `<google-sheets-html-origin>${table}</google-sheets-html-origin>`
  assert.equal(decide(sheets).action, 'offer')
  assert.equal(decide('<table><tr><td>42</td></tr></table>').action, 'offer')
})

test('smart: a structured document (two kinds of structure, or two headings) converts by itself', () => {
  assert.deepEqual(decide('<h2>提交前检查</h2><ul><li>跑校验</li><li>写依赖</li></ul>'), { action: 'auto', reason: 'structure' })
  assert.deepEqual(decide('<h2>一</h2><p>甲</p><h2>二</h2><p>乙</p>'), { action: 'auto', reason: 'structure' })
  assert.deepEqual(decide('<h3>用法</h3><pre>npm test</pre>'), { action: 'auto', reason: 'structure' })
})

test('smart: light formatting only offers the button', () => {
  for (const html of [
    '<p>详见 <a href="https://h.test/docs">官方文档</a>，明天再说。</p>',
    '<ul><li>一</li><li>二</li></ul>',
    '<h2>只有一个标题</h2><p>和一段话</p>',
    '<pre>const a = 1</pre>',
    `<img src="${IMG}">`,
    `<p>图：</p><img src="${IMG}">`,
    '<div><span style="font-weight: 700;">机会</span></div><div>说明 <b>重点</b></div>'
  ]) assert.equal(decide(html).action, 'offer', html)
})

test('nothing to convert stays as it is, in every mode', () => {
  for (const mode of ['smart', 'always', 'never'] as const) {
    assert.equal(decide('<p>今天下午三点开会，记得带数据表。</p>', mode).action, 'none', mode)
  }
})

test('always converts anything with structure; never only offers', () => {
  const link = '<p>详见 <a href="https://h.test/docs">官方文档</a></p>'
  assert.equal(decide(link, 'always').action, 'auto')
  const mixed = `<p>第一天早上去了湖边，水面很平，远处有雪山。</p><img src="${IMG}"><p>中午在小镇上遇到一只很乖的狗。</p>`
  assert.equal(decide(mixed, 'never').action, 'offer')
})
