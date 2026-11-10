// Playback in the chip preview dialog (dogfood 11-07): the player starts by itself and picks up
// where the same file was last paused. Desktop renders the <audio>/<video> element inside
// MessageTextContent with an async src, so the plugin finds it in the DOM instead of owning it.

import type { StorageLike } from './settings.ts'

export interface PositionStore {
  get: (path: string) => number | undefined
  set: (path: string, seconds: number | null) => void
}

const KEY = 'media_positions'
/** ceiling: positions for the 50 most recently played files; older ones are dropped. */
const MAX_ENTRIES = 50
/** Saving on every timeupdate would hit storage several times a second. */
const SAVE_EVERY_S = 5
/** Resuming in the first or the last second is noise, not a real position. */
const EDGE_S = 1

export function positionStore(storage: StorageLike): PositionStore {
  const read = (): Record<string, number> => {
    const raw = storage.get<unknown>(KEY, {})
    return raw && typeof raw === 'object' ? { ...(raw as Record<string, number>) } : {}
  }
  return {
    get: path => {
      const value = read()[path]
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    },
    set: (path, seconds) => {
      const all = read()
      delete all[path]
      if (seconds !== null) all[path] = seconds // re-insert last: insertion order is recency
      const keys = Object.keys(all)
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[key]
      storage.set(KEY, all)
    }
  }
}

type MediaLike = Pick<HTMLMediaElement, 'readyState' | 'currentTime' | 'duration' | 'ended' | 'play' | 'addEventListener' | 'removeEventListener'>

/** Seek to the saved position, play, and keep the position up to date. Returns a detach function
 *  that also saves the current position (closing the dialog mid-play counts as a pause). */
export function attachPlayback(el: MediaLike, path: string, store: PositionStore): () => void {
  let lastSaved = -Infinity
  let started = false
  const save = () => {
    if (el.ended) return
    const t = el.currentTime
    if (Number.isFinite(t) && t > 0) {
      store.set(path, t)
      lastSaved = t
    }
  }
  const start = () => {
    if (started) return
    started = true
    const saved = store.get(path)
    const duration = Number.isFinite(el.duration) ? el.duration : Infinity
    if (saved !== undefined && saved > EDGE_S && saved < duration - EDGE_S) el.currentTime = saved
    try {
      void Promise.resolve(el.play()).catch(() => {})
    } catch {
      // autoplay blocked: the controls are still there
    }
  }
  const onTime = () => {
    if (Math.abs(el.currentTime - lastSaved) >= SAVE_EVERY_S) save()
  }
  const onEnded = () => store.set(path, null)
  el.addEventListener('loadedmetadata', start)
  el.addEventListener('pause', save)
  el.addEventListener('timeupdate', onTime)
  el.addEventListener('ended', onEnded)
  if (el.readyState >= 1) start()
  return () => {
    save()
    el.removeEventListener('loadedmetadata', start)
    el.removeEventListener('pause', save)
    el.removeEventListener('timeupdate', onTime)
    el.removeEventListener('ended', onEnded)
  }
}

interface ContainerLike {
  querySelector: (selector: string) => Element | null
}

/** Calls `onMedia` for the player inside `container` once it renders (and again if Desktop swaps
 *  the element). Returns a cleanup that detaches the current one. */
export function watchMedia(container: ContainerLike, onMedia: (el: HTMLMediaElement) => () => void): () => void {
  let current: Element | null = null
  let detach: (() => void) | null = null
  const check = () => {
    const el = container.querySelector('audio, video')
    if (el === current) return
    detach?.()
    detach = null
    current = el
    if (el) detach = onMedia(el as HTMLMediaElement)
  }
  check()
  const Observer = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver
  const observer = Observer ? new Observer(check) : null
  observer?.observe(container as unknown as Node, { childList: true, subtree: true })
  return () => {
    observer?.disconnect()
    detach?.()
    detach = null
  }
}
