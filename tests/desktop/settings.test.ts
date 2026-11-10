// QA6: settings normalisation and defaults (U-BEH-8).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULTS, fetchParams, normalizeCount, normalizeSettings, readSettings } from '../../desktop/src/settings.ts'
import { setLocale } from '../../desktop/src/i18n.ts'

setLocale('zh') // these tests pin the Chinese strings; english.test.ts covers English

test('defaults match the spec', () => {
  assert.deepEqual({ ...DEFAULTS }, {
    convert_mode: 'smart', limit_images: false, max_images: 10, limit_image_size: false,
    max_image_mb: 10, cache_auto_delete: true, cache_days: 7, cache_dir: '', stt_model: ''
  })
  assert.deepEqual(normalizeSettings(undefined), { ...DEFAULTS })
  assert.deepEqual(normalizeSettings(null), { ...DEFAULTS })
})

test('numbers < 1, non-numbers and empty fall back to defaults', () => {
  for (const bad of [0, -5, 0.5, '', '  ', 'abc', NaN, Infinity, null, undefined, true, {}, []]) {
    const s = normalizeSettings({ max_images: bad, max_image_mb: bad, cache_days: bad })
    assert.equal(s.max_images, 10, `max_images ${String(bad)}`)
    assert.equal(s.max_image_mb, 10, `max_image_mb ${String(bad)}`)
    assert.equal(s.cache_days, 7, `cache_days ${String(bad)}`)
  }
})

test('valid numbers are kept (numeric strings accepted, fractions floored)', () => {
  const s = normalizeSettings({ max_images: '3', max_image_mb: 2.7, cache_days: 30 })
  assert.equal(s.max_images, 3)
  assert.equal(s.max_image_mb, 2)
  assert.equal(s.cache_days, 30)
  assert.equal(normalizeCount(1, 9), 1)
})

test('booleans must be booleans; cache_dir trimmed string', () => {
  const s = normalizeSettings({ convert_mode: 'yes', limit_images: true, cache_auto_delete: 0, cache_dir: '  /tmp/x ' })
  assert.equal(s.convert_mode, 'smart')
  assert.equal(s.limit_images, true)
  assert.equal(s.cache_auto_delete, true)
  assert.equal(s.cache_dir, '/tmp/x')
  assert.equal(normalizeSettings({ cache_dir: 42 }).cache_dir, '')
})

test('readSettings goes through ctx.storage-like get()', () => {
  const store: Record<string, unknown> = { convert_mode: 'never', cache_days: '0' }
  const s = readSettings({ get: <T>(k: string, fb: T) => (k in store ? store[k] as T : fb), set: () => {} })
  assert.equal(s.convert_mode, 'never')
  assert.equal(s.cache_days, 7)
})

test('fetchParams: switch off means unlimited', () => {
  assert.deepEqual(fetchParams({ ...DEFAULTS }), {
    limits: { max_images: null, max_mb: null }, cache_dir: '', cleanup: { auto_delete: true, days: 7 }
  })
  const on = fetchParams({ ...DEFAULTS, limit_images: true, max_images: 3, limit_image_size: true, max_image_mb: 5, cache_auto_delete: false })
  assert.deepEqual(on.limits, { max_images: 3, max_mb: 5 })
  assert.equal(on.cleanup.auto_delete, false)
})

test('dogfood 11-07: the old 自动转换 switch carries over (on → always, off or unset → smart)', () => {
  const read = (store: Record<string, unknown>) =>
    readSettings({ get: <T>(k: string, fb: T) => (k in store ? store[k] as T : fb), set: () => {} }).convert_mode
  assert.equal(read({ auto_convert: true }), 'always')
  assert.equal(read({ auto_convert: false }), 'smart')
  assert.equal(read({}), 'smart')
  assert.equal(read({ auto_convert: true, convert_mode: 'never' }), 'never', 'a chosen mode wins')
})

test('11-08: stt_model keeps only the offered local models; anything else follows Hermes', () => {
  for (const m of ['', 'base', 'small', 'turbo']) assert.equal(normalizeSettings({ stt_model: m }).stt_model, m)
  for (const bad of ['large-v3', 'whisper-1', 'evil', 3, null, true]) assert.equal(normalizeSettings({ stt_model: bad }).stt_model, '')
})
