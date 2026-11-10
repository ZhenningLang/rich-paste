// 11-10: English is the default; Chinese follows Desktop's language.
import assert from 'node:assert/strict'
import { noCount } from './sent-view.ts'
import { test } from 'node:test'

import { describeSummary, missedImageLabel } from '../../desktop/src/convert.ts'
import { bindI18n, en, setLocale, t, zh } from '../../desktop/src/i18n.ts'
import { applyDraftMarkers, chipsToMarkers, fileLabel, screenshotChip, screenshotMarker, screenshotNumber } from '../../desktop/src/markers.ts'

setLocale('en')

const sample = (table: Record<string, unknown>, key: string) => {
  const m = table[key]
  if (typeof m !== 'function') return String(m)
  const f = m as (...a: unknown[]) => string
  try { return f(1, 'x', 'y') } catch { return f([1, 2], 'x', 'y') }
}

test('both languages have the same keys, and the English strings carry no Chinese', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of Object.keys(en)) assert.doesNotMatch(sample(en, key), /[一-鿿]/, key)
  for (const key of Object.keys(en)) assert.ok(!key.includes('.'), `${key}: the SDK reads dots as nesting`)
})

test('the paste summary and missed-image links read in English', () => {
  assert.equal(describeSummary({ headings: 1, images: 2, links: 0, lists: 0, tables: 1, pres: 0, bolds: 0 } as any),
    'Web content: 1 heading, 2 images, 1 table')
  assert.equal(missedImageLabel('size'), 'image not downloaded (over the size limit)')
  assert.equal(fileLabel('/a/b.pdf'), '[File: b.pdf]')
})

test('screenshots are «Screenshot N» in English; both languages parse back', () => {
  assert.equal(screenshotChip(2), '@image:`Screenshot 2`')
  assert.equal(screenshotNumber('Screenshot 3'), 3)
  assert.equal(screenshotNumber('截图 4'), 4)
  assert.equal(screenshotNumber('Screenshots 4'), null)
})

test('the sent message reads [Screenshot 1] and [Image: alt] in English', () => {
  const draft = {
    text: `see ${screenshotMarker(1)} then ![chart](/c/rich-paste-cache/20261110/a.png)`,
    attachments: [{ id: 's1', kind: 'image', path: '/tmp/s1.png' }]
  }
  assert.equal(noCount(applyDraftMarkers(draft).text).replaceAll('\u2063', ''), 'see [Screenshot 1] then [Image: chart]')
  const lost = applyDraftMarkers({ text: `see ${screenshotMarker(1)}`, attachments: [] })
  assert.equal(noCount(lost.text), 'see [Screenshot 1: attachment not found]')
})

test('a chip written in Chinese before a language switch still goes out bound (labelled in the current language)', () => {
  const { draft } = chipsToMarkers({ text: '@image:`截图 1`', attachments: [{ id: 'a', kind: 'image', path: '/ci/a.png' }] } as any, [], () => undefined)
  assert.equal(noCount(applyDraftMarkers(draft as any).text), '\u2063[Screenshot 1]\u2063')
})

test('bindI18n hands both bundles to Desktop and uses its translator; no door keeps the local one', () => {
  let registered: Record<string, unknown> | null = null
  bindI18n(undefined)
  assert.equal(t('undo'), 'Undo')
  bindI18n({ register: b => { registered = b }, t: (key: string) => `desktop:${key}` })
  assert.deepEqual(Object.keys(registered!).sort(), ['en', 'zh', 'zh-hant'])
  assert.equal(t('undo'), 'desktop:undo')
  setLocale('en')
})
