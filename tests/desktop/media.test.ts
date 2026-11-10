// Playback in the chip preview (dogfood 11-07): starts on open, resumes where it was paused.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachPlayback, positionStore, watchMedia } from '../../desktop/src/media.ts'

class FakeMedia extends EventTarget {
  readyState = 0
  currentTime = 0
  duration = 120
  ended = false
  plays = 0
  play() { this.plays += 1; return Promise.resolve() }
  fire(type: string) { this.dispatchEvent(new Event(type)) }
}

function memStorage() {
  const data: Record<string, unknown> = {}
  return { data, get: (k: string, fb: unknown) => (k in data ? data[k] : fb), set: (k: string, v: unknown) => { data[k] = v } }
}

test('first open: plays from the start once metadata is in', () => {
  const store = positionStore(memStorage())
  const el = new FakeMedia()
  attachPlayback(el as any, '/a.m4a', store)
  assert.equal(el.plays, 0, 'waits for metadata')
  el.readyState = 1
  el.fire('loadedmetadata')
  assert.equal(el.plays, 1)
  assert.equal(el.currentTime, 0)
})

test('pause remembers the position; the next open resumes there and plays', () => {
  const storage = memStorage()
  const store = positionStore(storage)
  const first = new FakeMedia()
  first.readyState = 1
  attachPlayback(first as any, '/a.m4a', store)
  first.currentTime = 42.5
  first.fire('pause')
  assert.equal(store.get('/a.m4a'), 42.5)

  const again = new FakeMedia()
  again.readyState = 1
  attachPlayback(again as any, '/a.m4a', positionStore(storage))
  assert.equal(again.currentTime, 42.5)
  assert.equal(again.plays, 1)
})

test('closing the dialog while playing keeps the position; ended clears it', () => {
  const store = positionStore(memStorage())
  const el = new FakeMedia()
  el.readyState = 1
  const detach = attachPlayback(el as any, '/v.mp4', store)
  el.currentTime = 30
  detach()
  assert.equal(store.get('/v.mp4'), 30)

  const el2 = new FakeMedia()
  el2.readyState = 1
  attachPlayback(el2 as any, '/v.mp4', store)
  el2.ended = true
  el2.currentTime = 120
  el2.fire('ended')
  assert.equal(store.get('/v.mp4'), undefined)
})

test('a position in the last second or the first second is not worth resuming', () => {
  const store = positionStore(memStorage())
  store.set('/near-end.m4a', 119.5)
  store.set('/near-start.m4a', 0.4)
  for (const path of ['/near-end.m4a', '/near-start.m4a']) {
    const el = new FakeMedia()
    el.readyState = 1
    attachPlayback(el as any, path, store)
    assert.equal(el.currentTime, 0, path)
    assert.equal(el.plays, 1)
  }
})

test('the store keeps the 50 most recent files only', () => {
  const storage = memStorage()
  const store = positionStore(storage)
  for (let i = 0; i < 55; i += 1) store.set(`/f${i}.mp3`, 10)
  assert.equal(store.get('/f0.mp3'), undefined)
  assert.equal(store.get('/f54.mp3'), 10)
  assert.equal(Object.keys(storage.data.media_positions as object).length, 50)
})

test('a blocked autoplay does not throw', async () => {
  const store = positionStore(memStorage())
  const el = new FakeMedia()
  el.readyState = 1
  el.play = () => Promise.reject(new Error('NotAllowedError'))
  attachPlayback(el as any, '/a.m4a', store)
  await new Promise(r => setTimeout(r, 0))
})

test('watchMedia attaches to a player that is already there and detaches on cleanup', () => {
  const el = new FakeMedia()
  const container = { querySelector: (s: string) => (s === 'audio, video' ? el : null) }
  let attached = 0
  let detached = 0
  const stop = watchMedia(container as any, () => { attached += 1; return () => { detached += 1 } })
  assert.equal(attached, 1)
  stop()
  assert.equal(detached, 1)
})
