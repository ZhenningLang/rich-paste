// rich-paste desktop half. Built by esbuild into desktop/plugin.js (npm run build).
//
// Passive by design (U-CTR-1): the paste listener only reads clipboardData. It
// never calls preventDefault / stopPropagation. It edits the draft when the user
// clicks 「转为 Markdown」, or by itself when the paste decision says so (smart mode,
// dogfood 11-07: pictures inside text, tables, structured documents; always 撤销-able).

import { atom, Button, COMPOSER_AREAS, Tip, writeClipboardText, Dialog, DialogContent, DialogTitle, host, Input, ListRow, MessageTextContent, SETTINGS_PLUGINS_AREA, ToggleRow, useValue } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

import { bindI18n, t } from './i18n.ts'
import { attachPlayback, positionStore, watchMedia } from './media.ts'
import { convertHtml, describeSummary, fillImages, isTooLarge, missedImageLabel, pasteDecision, pasteShape, smallImages, type SkipReason } from './convert.ts'
import {
  applyDraftMarkers, AUDIO_EXT_RE, basename, hasChip, chipsToMarkers, insertAfterChip, CONVERTIBLE_EXT_RE, countScreenshots, isImageFile, isPluginCachePath, localImageMarkers,
  locatePasted, refChip, removeMarkers, replaceNth, replaceRange, screenshotChip, VIDEO_EXT_RE, type Draft, type DraftAttachment, type PendingRef,
  hasRefChips, linkFor, looksLikeMarkdown, markerFor, screenshotChipNumbers, screenshotNumber, type ShotTarget
} from './markers.ts'
import {
  DEFAULTS, fetchParams, normalizeSettings, readSettings, STT_MODELS, type NumberKey, type RichPasteSettings, type StorageLike
} from './settings.ts'

const PLUGIN_ID = 'rich-paste'
const STRIP_REFRESH_MS = 1500
const INPUT_REFRESH_MS = 300
/** Long enough for Desktop's submit to clear its toasts first (dogfood 11-10, real run). */
const SEND_NOTE_DELAY_MS = 500
const FETCH_TIMEOUT_MS = 180_000
/** Images downloaded at the same time; each is its own request so progress can be counted. */
const FETCH_CONCURRENCY = 3
/** Desktop stores a paste longer than this as composer-pastes/pasted_content_*.txt instead of
 *  putting it in the composer (apps/desktop/src/app/chat/composer/large-paste.ts:11). */
const DESKTOP_LONG_PASTE_CHARS = 3_000
const PASTE_FILE_RE = /[\\/]composer-pastes[\\/]pasted_content_[\w-]+\.txt$/
const LONG_PASTES_KEY = 'long_pastes'
/** Saved long pastes older than this are dropped on load (the cache keeps images 7 days by default). */
const LONG_PASTE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const LONG_KEY_CHARS = 400

/** Control and zero-width characters Desktop may strip before writing the paste file. */
const strip = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f\ufeff]/g, '')
const longKey = (plain: string) => strip(plain).slice(0, LONG_KEY_CHARS)
/** End of the pasted plain text: with the opening and length it tells apart pastes that start alike (review 11-08). */
const LONG_TAIL_CHARS = 200
const longTail = (plain: string) => strip(plain).slice(-LONG_TAIL_CHARS)
/** For comparing with the .txt: the backend reads it with universal newlines, so `\r` never survives there. */
const norm = (text: string) => strip(text).replace(/\r/g, '')
/** One long paste's identity within a chat. Entries saved before 11-08 have no tail. */
const longId = (l: { key: string; tail?: string; chars: number }) => `${l.key}\u0000${l.tail ?? ''}\u0000${l.chars}`

/** The saved long-paste index, minus anything malformed or expired. */
function loadLongPastes(storage: { get: <T>(key: string, fallback: T) => T }): never[] | any[] {
  const raw = storage.get<unknown>(LONG_PASTES_KEY, [])
  if (!Array.isArray(raw)) return []
  const now = Date.now()
  return raw.filter(l => l && typeof l === 'object' && typeof l.sessionId === 'string' && typeof l.key === 'string'
    && typeof l.mdPath === 'string' && typeof l.savedAt === 'number' && now - l.savedAt < LONG_PASTE_TTL_MS)
}
/** Digests of a few attachment files at send; past this the send goes on with order-based binding. */
const DIGEST_TIMEOUT_MS = 5_000

/** Run `task` over `items` with at most `limit` in flight. */
async function inPool<T>(items: T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
/** Must equal dashboard/plugin_api.py API_VERSION (tests/desktop/sdk-surface checks). */
export const BACKEND_API = 11
/** Images downloaded on their own per paste, whatever the setting (rp_cache.MAX_IMAGES_PER_REQUEST). */
export const MAX_IMAGES_PER_PASTE = 50
const is404 = (err: unknown) => /^404\b/.test(String((err as { message?: unknown })?.message ?? err))

type SessionId = string | null

interface Hint {
  mode: 'offer' | 'busy' | 'converted'
  /** Pinned composer address: a session id or `'new'`. */
  sessionId: string
  html: string
  plain: string
  summary: string
  /** Plain text past Desktop's long-paste limit: Desktop made it a .txt, so the Markdown waits for send. */
  long?: boolean
  /** Images downloaded so far while busy (dogfood 11-07: visible progress). */
  progress?: { done: number; total: number }
  /** Why it converted by itself (smart mode), shown next to 撤销. */
  reason?: string
  /** What an auto conversion swapped, for 撤销: the Markdown it wrote and the text it replaced
   *  (review 11-08: 撤销 swaps only that back, so text typed afterwards stays). */
  swap?: { markdown: string; original: string }
}

interface FetchResult {
  url: string
  path: string | null
  error: string | null
  /** [width, height] in pixels; backends before 11-10 do not send it. */
  size?: number[]
}

interface CacheStats {
  bytes: number
  files: number
  dir: string
}

// Plugin context surface used here (structural; the SDK owns the real type).
interface Ctx {
  storage: StorageLike
  rest: <T>(path: string, opts?: { method?: string; body?: unknown; timeoutMs?: number }) => Promise<T>
  register: (c: Record<string, unknown>) => () => void
  /** Optional: hosts older than the settings-page helper only have `register` (SDK docs). */
  registerSettingsPage?: (page: Record<string, unknown>) => () => void
  addEventListener: (target: EventTarget, type: string, listener: (e: Event) => void, options?: AddEventListenerOptions | boolean) => () => void
  setTimeout: (fn: () => void, ms: number) => () => void
  setInterval: (fn: () => void, ms: number) => () => void
  os: {
    revealPath: (path: string) => Promise<boolean>
    pickOpenPath?: (options?: { defaultPath?: string; title?: string; filters?: { extensions: string[]; name: string }[] }) => Promise<null | string>
  }
  files?: { requestFolder?: () => Promise<{ ok: boolean; folder: { path: string } | null }> }
  onDispose?: (fn: () => void) => void
  /** Plugin locale bundles (Desktop's language); older hosts have none and get English. */
  i18n?: Parameters<typeof bindI18n>[0]
}

/** Ref chips whose click the plugin handles (D9); session and url chips belong to Desktop. */
const CHIP_CURSOR_CSS = ['image', 'file', 'folder']
  .map(kind => `[role="textbox"] [data-ref-kind="${kind}"][data-ref-text]`)
  .join(',\n') + ' { cursor: pointer; }'

/** Busy rows end in dots cycling . → .. → ... (dogfood 11-07); a static … read as stuck.
 *  Fixed width so the text does not jump; reduced motion shows a still "...". */
const BUSY_DOTS_CSS = `
.rp-dots { display: inline-block; width: 1.5em; text-align: left; }
.rp-dots::after { content: '.'; animation: rp-dots 1.2s steps(1, end) infinite; }
@keyframes rp-dots { 0% { content: '.'; } 33% { content: '..'; } 66% { content: '...'; } }
@media (prefers-reduced-motion: reduce) { .rp-dots::after { content: '...'; animation: none; } }
.rp-busy-bar { position: relative; height: 3px; margin: 0 2px; border-radius: 2px; overflow: hidden;
  background: color-mix(in srgb, var(--ui-accent) 18%, transparent); }
.rp-busy-fill { height: 100%; border-radius: 2px; background: var(--ui-accent); transition: width 0.3s ease-out; }
.rp-busy-sweep { width: 30%; animation: rp-busy-sweep 1.1s ease-in-out infinite; }
button.rp-copy-title { font: inherit; color: inherit; background: none; border: 0; padding: 0;
  text-decoration: underline dotted transparent; text-underline-offset: 4px; transition: color 0.15s, text-decoration-color 0.15s; }
button.rp-link { color: var(--ui-accent); }
button.rp-link:hover { text-decoration: underline; text-underline-offset: 3px; }
button.rp-copy-title:hover, button.rp-copy-title:focus-visible { color: var(--ui-accent); text-decoration-color: currentColor; }
@keyframes rp-busy-sweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(340%); } }
@media (prefers-reduced-motion: reduce) { .rp-busy-sweep { animation: none; width: 100%; opacity: 0.5; } }`

/** 预览 (dogfood 11-08, a real Wikipedia paste needed sideways scrolling): nothing inside the
 *  preview may be wider than the window; a wide table scrolls on its own, long words wrap. */
const PREVIEW_CSS = `
.rp-preview { overflow-x: hidden; overflow-wrap: anywhere; }
.rp-preview * { max-width: 100%; min-width: 0; box-sizing: border-box; }
.rp-preview img, .rp-preview video { height: auto; }
/* Desktop places a message image inside a fixed frame and zeroes the image's margin only inside an
   assistant message. In the preview Typography's 2em image margin stayed, pushing the image out of its
   frame: first onto the next paragraph, then (as a blank line) above it (dogfood 11-09). */
.rp-preview [data-slot="aui_markdown-image"] img { margin: 0 !important; }
/* A first-shown image gets a 4:3 frame that does not resize when it loads (no layout shift in the chat),
   so a wider image left a blank band under it (dogfood 11-10). The preview frame hugs the image instead. */
.rp-preview [data-slot="aui_markdown-image"] { aspect-ratio: auto !important; }
.rp-preview [data-slot="aui_zoomable-image"] { position: relative !important; height: auto !important; }
.rp-preview [data-slot="aui_markdown-image"] img { max-height: var(--image-preview-height) !important; }
/* The image's hover download button has no use in a read-only preview. */
.rp-preview [data-slot="aui_zoomable-image"] > button + button { display: none !important; }
.rp-preview pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.rp-preview table { display: block; overflow-x: auto; }
.rp-preview a, .rp-preview code { overflow-wrap: anywhere; word-break: break-word; }
`
const PLUGIN_CSS = CHIP_CURSOR_CSS + '\n' + BUSY_DOTS_CSS + '\n' + PREVIEW_CSS

/** 「正在…」 followed by the animated dots. */
const busyText = (text: string, after = '') =>
  jsxs('span', { children: [text, jsx('span', { className: 'rp-dots', 'aria-hidden': true }), after] })

/** Inline (Desktop's stylesheet may lack sr-only for plugin markup): read by screen readers, not shown. */
/** Desktop lays the underside out as one wrapping flex row: each plugin row takes a full line (11-08). */
const LINE = { flexBasis: '100%', minWidth: 0 }
const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 } as const

const CONVERT_MODE_LABEL = { smart: 'modeSmart', always: 'modeAlways', never: 'modeNever' } as const
const CONVERT_MODE_HELP = { smart: 'modeSmartHelp', always: 'modeAlwaysHelp', never: 'modeNeverHelp' } as const

/** The local STT models offered in settings (11-08). Sizes: Hugging Face model trees, checked 2026-11-08. */
const STT_MODEL_LABEL = { '': 'sttFollow', base: 'sttFast', small: 'sttBetter', turbo: 'sttBest' } as const
const STT_MODEL_HELP = { '': 'sttFollowHelp', base: 'sttBaseHelp', small: 'sttSmallHelp', turbo: 'sttTurboHelp' } as const

const isPlayable = (path: string) => AUDIO_EXT_RE.test(path) || VIDEO_EXT_RE.test(path)

/** Desktop keeps warnings until closed. The plugin's warnings only report what already happened
 *  (an image kept as a link, a chat switched), so they leave by themselves; errors still stay. */
const WARNING_MS = 8_000

const notify = (kind: 'info' | 'warning' | 'error' | 'success', message: string, detail?: string) => {
  try {
    host.notify({ kind, message, ...(detail ? { detail } : {}), ...(kind === 'warning' ? { durationMs: WARNING_MS } : {}) })
  } catch {
    // toasts are best-effort
  }
}

const unique = <T,>(items: T[]) => Array.from(new Set(items))

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`
}

/** Local paths from a Finder copy (`text/uri-list` of file:// URIs), if Desktop exposes them. */
function finderPaths(data: DataTransfer): string[] {
  const list = data.getData('text/uri-list') || ''
  return list
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('file://'))
    .map(line => {
      try {
        return decodeURIComponent(new URL(line).pathname)
      } catch {
        return ''
      }
    })
    .filter(Boolean)
}

function isComposerTarget(target: EventTarget | null): boolean {
  return !!target && (target as HTMLElement).isContentEditable === true
}

/**
 * Type `text` at the caret of `editor` with the browser's own editing command,
 * the same path as the user typing (A:S3). The SDK's insertText only appends.
 * False when the editor lost focus or the command is unavailable.
 */
function insertAtCaret(editor: Element | null, text: string): boolean {
  if (!editor || document.activeElement !== editor) return false
  try {
    return document.execCommand('insertText', false, text)
  } catch {
    return false
  }
}

/** Plain text of copied composer HTML with every chip written as its `data-ref-text`. */
function refTextFromHtml(html: string): string {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return ''
  }
  const BLOCK = /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE)$/
  let out = ''
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        out += child.nodeValue ?? ''
        continue
      }
      if (child.nodeType !== 1) continue
      const el = child as Element
      const ref = el.getAttribute('data-ref-text')
      if (ref) {
        out += ref
        continue
      }
      if (el.nodeName === 'BR') {
        out += '\n'
        continue
      }
      if (el.nodeName === 'SCRIPT' || el.nodeName === 'STYLE' || el.nodeName === 'svg' || el.nodeName === 'SVG') continue
      const block = BLOCK.test(el.nodeName)
      if (block && out && !out.endsWith('\n')) out += '\n'
      walk(el)
      if (block && !out.endsWith('\n')) out += '\n'
    }
  }
  walk(doc.body ?? doc)
  return out.replace(/\u00a0/g, ' ').trim()
}

export default {
  id: PLUGIN_ID,
  name: 'Rich Paste',
  register(ctx: Ctx) {
    bindI18n(ctx.i18n)
    const settings = atom<RichPasteSettings>(readSettings(ctx.storage))
    const hint = atom<Hint | null>(null)
    const draftText = atom('')
    let hintSeen = false

    const focusedSession = (): SessionId => host.state.focusedSessionId.get() ?? null
    /** Address pinned at paste time: the focused session, or the SDK's `'new'` draft (never the
     *  bus-resolved `null`, which follows whatever composer is active later — A:S2). */
    const pinnedAddress = (): string => host.state.focusedSessionId.get() ?? 'new'
    const stillActive = (address: string) => {
      if (pinnedAddress() === address) return true
      notify('warning', t('sessionSwitched'))
      return false
    }
    /** Finder/Raycast paths read for a paste, shown as chips until send (D5/D6). */
    const pendingRefs: PendingRef[] = []
    /** «截图 N» → a preview copy in the cache, saved at paste time (D9; lost on plugin reload). */
    const screenshotPreviews = new Map<string, string>()
    /** «截图 N» → SHA-256 of the pasted bytes (11-07), matched against the attachment files at send. */
    const screenshotDigests = new Map<string, string>()
    /** Screenshot numbers restart in every chat and after every send (review 11-08): key by chat too,
     *  and forget a chat's numbers once its message has gone. */
    const shotKey = (address: string, n: number) => `${address}\u0000${n}`
    const forgetShots = (address: string) => {
      for (const map of [screenshotPreviews, screenshotDigests]) {
        for (const key of [...map.keys()]) if (key.startsWith(`${address}\u0000`)) map.delete(key)
      }
    }
    interface Preview {
      path: string
      title: string
      replace?: { refText: string; occurrence: number; kind: 'image' | 'file' }
      /** The chip's reference, shown as a label that copies it (11-07): paste it anywhere in the text. */
      copyRef?: { text: string; label: string }
    }
    const preview = atom<Preview | null>(null)
    const positions = positionStore(ctx.storage)
    /** 预览 (dogfood 11-07): the draft text it shows, or null when closed. */
    const split = atom<string | null>(null)
    /** Audio pasted as file chips, offered for transcription (D10). */
    interface AudioHint { sessionId: string; paths: string[]; busy: boolean }
    const audioHint = atom<AudioHint | null>(null)
    /** The offer's chip was seen in the draft at least once (see refreshDraft). */
    let audioSeen = false
    const consent = atom<{ message: string; resolve: (ok: boolean) => void } | null>(null)
    /** Paths the backend returned this session: the only local images the plugin attaches (D2). */
    const downloaded = new Set<string>()
    const isOwnImage = (path: string) =>
      downloaded.has(path) || isPluginCachePath(path) || pendingRefs.some(r => r.kind === 'image' && r.path === path)
    const readDraft = async (sessionId: SessionId) => (await host.composer.getDraft(sessionId)) ?? ''

    // ---- stale backend (D7): the gateway mounts plugin routes once, so after an update it keeps
    // serving the old backend until restarted. Tip only on proof: /version is missing while a
    // route every version has still answers, or /version reports a different api. Network
    // errors, a stopped gateway or a disabled plugin never raise it.
    type Tip = 'restart' | 'reload'
    const tip = atom<Tip | null>(null)
    let tipDismissed = false
    const checkBackend = async (): Promise<Tip | null> => {
      let found: Tip | null = null
      try {
        const res = await ctx.rest<{ api?: unknown }>('/version')
        const api = typeof res?.api === 'number' ? res.api : null
        if (api !== null && api < BACKEND_API) found = 'restart'
        else if (api !== null && api > BACKEND_API) found = 'reload'
      } catch (err) {
        if (is404(err)) {
          try {
            await ctx.rest('/cache-stats')
            found = 'restart'
          } catch {
            found = null
          }
        }
      }
      tip.set(found)
      return found
    }
    const restartMessage = () => t('restartGateway')

    const updateSettings = (patch: Partial<Record<keyof RichPasteSettings, unknown>>) => {
      const current = settings.get()
      const next = normalizeSettings({ ...current, ...patch })
      const changed = (Object.keys(next) as (keyof RichPasteSettings)[]).filter(key => next[key] !== current[key])
      if (!changed.length) return
      settings.set(next)
      for (const key of changed) ctx.storage.set(key, next[key])
    }

    const setHint = (next: Hint | null) => {
      hintSeen = false
      hint.set(next)
    }
    /** dogfood 11-10: the row stays until sent, 忽略/Esc, or the text it is about leaves the draft
     *  (deleted, or the composer emptied). It only goes once that text was seen in the draft, so a
     *  poll that runs before the paste lands does not take it away. Long pastes live in an attachment. */
    const checkHintAgainst = (draft: string) => {
      const h = hint.get()
      if (!h || h.mode === 'busy' || h.long || h.sessionId !== pinnedAddress()) return
      const present = h.mode === 'converted'
        ? Boolean(h.swap?.markdown) && draft.includes(h.swap!.markdown)
        : Boolean(h.plain.trim()) && locatePasted(draft, h.plain) !== null
      if (present) hintSeen = true
      else if (hintSeen) setHint(null)
    }

    let refreshing = false
    const refreshDraft = async () => {
      if (refreshing) return
      refreshing = true
      try {
        const live = await host.composer.getDraft(focusedSession())
        const text = live ?? ''
        if (text !== draftText.get()) draftText.set(text)
        if (typeof live === 'string') checkHintAgainst(live)
        // An audio offer whose chips were all deleted goes too (11-08); only on a live answer, and only
        // once a chip was seen: right after the paste Desktop can still answer with the draft from
        // before the chip went in, which took the offer away at once (dogfood 11-10, real run).
        const a = audioHint.get()
        if (typeof live === 'string' && a && !a.busy && a.sessionId === pinnedAddress()) {
          if (a.paths.some(path => hasChip(live, 'file', path))) audioSeen = true
          else if (audioSeen) audioHint.set(null)
        }
      } catch {
        // no live composer: keep the last value
      } finally {
        refreshing = false
      }
    }

    // ---- convert (U-BEH-2/3) ----
    /** Download web images one request each (progress 1/3). The count limit is the caller's;
     *  the size limit is the backend's. Cache cleanup rides on the first request when asked. */
    const downloadImages = async (
      srcs: string[], s: RichPasteSettings, live: () => boolean, cleanup: boolean, onProgress: (done: number, total: number) => void
    ): Promise<{ map: Record<string, string>; notes: Record<string, SkipReason>; sizes: Record<string, number[] | undefined> }> => {
      const map: Record<string, string> = {}
      const notes: Record<string, SkipReason> = {}
      const sizes: Record<string, number[] | undefined> = {}
      if (!srcs.length) return { map, notes, sizes }
      const params = fetchParams(s)
      let done = 0
      const report = () => { if (live()) onProgress(done, srcs.length) }
      report()
      await inPool(srcs, FETCH_CONCURRENCY, async (src, index) => {
        try {
          const res = await ctx.rest<{ results: FetchResult[] }>('/fetch-images', {
            method: 'POST',
            // Chromium's clipboard HTML carries no source page URL, so no Referer is sent.
            body: { ...params, urls: [src], limits: { ...params.limits, max_images: null }, cleanup: cleanup && index === 0 ? params.cleanup : { ...params.cleanup, auto_delete: false } },
            timeoutMs: FETCH_TIMEOUT_MS
          })
          const r = res.results?.[0]
          if (r?.path) {
            map[src] = r.path
            sizes[src] = r.size
            downloaded.add(r.path)
          } else if (r?.error === 'over_limit') {
            notes[src] = 'count'
          } else if (r?.error === 'too_large') {
            notes[src] = 'size'
          }
        } catch {
          // backend off or this image failed: it stays a link
        } finally {
          done += 1
          report()
        }
      })
      return { map, notes, sizes }
    }

    /** Web images the count limit held back, offered as 再下载 N 张 for that paste (11-07). */
    interface Leftover {
      sessionId: string
      images: { src: string; alt: string; n: number }[]
      busy?: { done: number; total: number }
      /** The long paste these belong to (its plain text), instead of the draft. */
      long?: string
    }
    /** Long pastes converted aside, waiting to replace Desktop's .txt at send (11-07). The Markdown
     *  lives in a cache file (mdPath) and storage keeps only this index, so a reload keeps them. */
    interface LongPaste {
      sessionId: string
      /** Opening of the pasted plain text (control chars stripped): finds the .txt at send. */
      key: string
      /** End of the pasted plain text (control chars stripped), checked against the .txt's end. */
      tail?: string
      chars: number
      images: number
      savedAt: number
      mdPath?: string | null
      markdown?: string
      /** 收起: the row is hidden; the send still swaps the .txt if it is attached (11-08). */
      hidden?: boolean
    }
    const longPastes = atom<LongPaste[]>(loadLongPastes(ctx.storage))
    const setLongs = (next: LongPaste[]) => {
      longPastes.set(next)
      ctx.storage.set(LONG_PASTES_KEY, next.filter(l => l.mdPath).map(({ markdown: _m, ...index }) => index))
    }
    const markdownOf = async (l: LongPaste): Promise<string | null> => {
      if (typeof l.markdown === 'string') return l.markdown
      if (!l.mdPath) return null
      try {
        const res = await ctx.rest<{ markdown: string | null }>('/read-markdown', { method: 'POST', body: { path: l.mdPath }, timeoutMs: DIGEST_TIMEOUT_MS })
        return typeof res?.markdown === 'string' ? res.markdown : null
      } catch (err) {
        if (is404(err)) void checkBackend()
        return null
      }
    }
    /** Write the Markdown to the cache and remember where; the entry stays usable in memory if this fails. */
    const keepOnDisk = async (entry: LongPaste) => {
      try {
        const res = await ctx.rest<{ path: string | null }>('/save-markdown', {
          method: 'POST',
          body: { markdown: entry.markdown, cache_dir: settings.get().cache_dir || null },
          timeoutMs: FETCH_TIMEOUT_MS
        })
        if (!res?.path) return
        setLongs(longPastes.get().map(l => (l === entry || (l.sessionId === entry.sessionId && longId(l) === longId(entry)) ? { ...l, mdPath: res.path } : l)))
      } catch (err) {
        if (is404(err)) void checkBackend()
      }
    }
    const leftover = atom<Leftover | null>(null)
    let moreRun: { cancelled: boolean } | null = null

    const fetchMore = async (lo: Leftover) => {
      const run = { cancelled: false }
      moreRun = run
      const live = () => !run.cancelled
      leftover.set({ ...lo, busy: { done: 0, total: lo.images.length } })
      try {
        const { map, notes } = await downloadImages(lo.images.map(i => i.src), settings.get(), live, false, (done, total) => {
          leftover.set({ ...lo, busy: { done, total } })
        })
        if (!live()) return
        if (!stillActive(lo.sessionId)) {
          leftover.set(null)
          return
        }
        const entry = lo.long !== undefined ? longPastes.get().find(l => l.sessionId === lo.sessionId && longId(l) === lo.long) : null
        const entryMarkdown = entry ? await markdownOf(entry) : null
        if (lo.long !== undefined && (!entry || entryMarkdown === null)) {
          leftover.set(null)
          return
        }
        let draft = entry ? entryMarkdown! : await readDraft(lo.sessionId)
        const failed: number[] = []
        const sized: number[] = []
        for (const image of lo.images) {
          const from = linkFor(missedImageLabel('count'), image.alt, image.src)
          const path = map[image.src]
          const to = path ? markerFor(image.alt, path) : linkFor(missedImageLabel(notes[image.src]), image.alt, image.src)
          if (!path) (notes[image.src] === 'size' ? sized : failed).push(image.n)
          if (draft.includes(from)) draft = draft.replace(from, () => to) // a function: `$` in alt or URL is text, not a pattern
        }
        if (entry) {
          const updated: LongPaste = { ...entry, markdown: draft, images: entry.images + Object.keys(map).length, mdPath: null }
          setLongs(longPastes.get().map(l => (l === entry ? updated : l)))
          void keepOnDisk(updated)
        } else {
          await host.composer.setDraft(lo.sessionId, draft)
        }
        if (failed.length) notify('warning', t('imagesFailed', failed))
        if (sized.length) notify('info', t('imagesTooBig', sized))
        void refreshDraft()
        leftover.set(null)
      } finally {
        if (moreRun === run) moreRun = null
      }
    }

    /** Conversions in flight; sending a chat cancels all of its own (dogfood 11-07: Enter = send as is;
     *  review 11-08: a second paste must not hide the first one from the cancel). */
    const running = new Set<{ sessionId: string; cancelled: boolean }>()

    const convert = async (h: Hint, auto: boolean) => {
      const run = { sessionId: h.sessionId, cancelled: false }
      running.add(run)
      const live = () => !run.cancelled
      setHint({ ...h, mode: 'busy' })
      try {
        const s = settings.get()
        // 「第 k 张」 counts every image in page order; only http(s)/data images can be downloaded.
        const converted = convertHtml(h.html)   // one turndown pass (D3)
        const allImages = unique(converted.images.map(image => image.src))
        const sources = allImages.filter(src => /^(https?:|data:image\/)/i.test(src))
        const failed = allImages.flatMap((src, i) => (sources.includes(src) ? [] : [i + 1]))
        // The count limit is applied here so each image can be its own request (progress 1/3).
        // Even «no limit» stops at MAX_IMAGES_PER_PASTE (review 11-10); the rest get «Download N more».
        const allowed = sources.slice(0, s.limit_images ? Math.min(s.max_images, MAX_IMAGES_PER_PASTE) : MAX_IMAGES_PER_PASTE)
        const { map, notes, sizes } = await downloadImages(allowed, s, live, true, (done, total) => {
          setHint({ ...h, mode: 'busy', progress: { done, total } })
        })
        const small = smallImages(sizes, Object.keys(map))
        small.forEach(src => { delete map[src]; notes[src] = 'small' })
        sources.slice(allowed.length).forEach(src => { notes[src] = 'count' })
        if (!live()) return
        const countSkipped: { src: string; alt: string; n: number }[] = []
        const sizeSkipped: number[] = []
        sources.forEach(src => {
          if (map[src] || notes[src] === 'small') return
          const n = allImages.indexOf(src) + 1
          if (notes[src] === 'count') countSkipped.push({ src, alt: converted.images.find(i => i.src === src)?.alt ?? '', n })
          else if (notes[src] === 'size') sizeSkipped.push(n)
          else failed.push(n)
        })
        failed.sort((a, b) => a - b)
        const markdown = fillImages(converted, map, notes)
        if (!live()) return
        if (h.long) {
          // Desktop holds this paste as a .txt attachment: keep the Markdown aside; at send it replaces
          // that file in the message (11-07). Writing it into the composer would send the text twice.
          const plain = h.plain.trim()
          const key = longKey(plain)
          const entry: LongPaste = { sessionId: h.sessionId, key, tail: longTail(plain), chars: plain.length, images: Object.keys(map).length, savedAt: Date.now(), markdown }
          setLongs([...longPastes.get().filter(l => !(l.sessionId === h.sessionId && longId(l) === longId(entry))), entry])
          void keepOnDisk(entry)
          if (failed.length) notify('warning', t('imagesFailed', failed))
          if (sizeSkipped.length) notify('info', t('imagesTooBig', sizeSkipped))
          if (small.length) notify('info', t('smallSkipped', small.length))
          leftover.set(countSkipped.length ? { sessionId: h.sessionId, images: countSkipped, long: longId(entry) } : null)
          setHint(null)
          return
        }
        if (!stillActive(h.sessionId)) {
          setHint(null)
          return
        }
        const draft = await readDraft(h.sessionId)
        const range = h.plain.trim() ? locatePasted(draft, h.plain) : null
        const replaced = range ? await host.composer.setDraft(h.sessionId, replaceRange(draft, range, markdown)) : false
        const original = range && replaced ? draft.slice(range.start, range.end) : ''
        if (!replaced) {
          await host.composer.insertText(h.sessionId, markdown, { mode: 'block' })
          notify('info', h.plain.trim() ? t('appendedNoOriginal') : t('appended'))
        }
        if (failed.length) notify('warning', t('imagesFailed', failed))
        if (sizeSkipped.length) notify('info', t('imagesTooBig', sizeSkipped))
        if (small.length) notify('info', t('smallSkipped', small.length))
        // Images held back by the count limit: the row below offers 再下载 for this paste (11-07).
        leftover.set(countSkipped.length ? { sessionId: h.sessionId, images: countSkipped } : null)
        void refreshDraft()
        setHint(auto ? { ...h, mode: 'converted', swap: { markdown, original } } : null)
      } catch (err) {
        if (!live()) return
        setHint(null)
        try {
          host.notifyError(err, t('convertFailed'))
        } catch {
          notify('error', t('convertFailed'))
        }
      } finally {
        running.delete(run)
      }
    }

    /** At send: each long paste whose .txt is still attached is replaced by its Markdown, appended to
     *  the text (images then interleave as usual). Unmatched ones are dropped: the user removed the file. */
    const withLongPastes = async (draft: Draft, longs: LongPaste[]): Promise<Draft> => {
      const attachments = Array.isArray(draft.attachments) ? draft.attachments : []
      const candidates = attachments.filter(a => a && a.kind === 'file' && typeof a.path === 'string' && PASTE_FILE_RE.test(a.path))
      if (!candidates.length) return draft
      let files: Record<string, { chars: number; head: string; tail?: string } | null>
      try {
        files = (await ctx.rest<{ files: typeof files }>('/paste-files', { method: 'POST', body: { paths: candidates.map(a => a.path) }, timeoutMs: DIGEST_TIMEOUT_MS })).files ?? {}
      } catch (err) {
        if (is404(err)) void checkBackend()
        return draft
      }
      const replaced = new Set<unknown>()
      const parts: string[] = []
      // Same opening, same end (when both sides know it), and the closest length wins: two pastes that
      // start alike each find their own file (review 11-08).
      const fits = (long: LongPaste, info: { chars: number; head: string; tail?: string }) => {
        const head = norm(info.head)
        const key = norm(long.key)
        if (!head || !(key.startsWith(head) || head.startsWith(key))) return false
        if (typeof info.tail !== 'string' || typeof long.tail !== 'string') return true
        const tail = norm(info.tail)
        const mine = norm(long.tail)
        return !!tail && (mine.endsWith(tail) || tail.endsWith(mine))
      }
      for (const long of longs) {
        let match: (typeof candidates)[number] | undefined
        for (const a of candidates) {
          const info = files[a.path as string]
          if (!info || replaced.has(a) || !fits(long, info)) continue
          if (!match || Math.abs(info.chars - long.chars) < Math.abs(files[match.path as string]!.chars - long.chars)) match = a
        }
        if (!match) continue
        const markdown = await markdownOf(long)
        if (markdown === null) continue // the cache was cleaned: Desktop's plain .txt goes as it is
        replaced.add(match)
        parts.push(markdown)
      }
      if (!parts.length) return draft
      const text = [draft.text.trimEnd(), ...parts].filter(Boolean).join('\n\n')
      return { ...draft, text, attachments: attachments.filter(a => !replaced.has(a)) }
    }

    /** A toast raised while the send middleware runs is wiped: Desktop calls clearNotifications() as it
     *  submits, right after the middleware returns (use-middleware-submit.ts → submit.ts). Show it after. */
    const notifyAfterSend = (kind: 'info' | 'warning', message: string) => {
      ctx.setTimeout(() => notify(kind, message), SEND_NOTE_DELAY_MS)
    }

    /** A row button that removes its own row left keyboard focus nowhere (the window corner); put the
     *  caret back in the composer (dogfood 11-10, real run). */
    const backToComposer = () => {
      ctx.setTimeout(() => { try { host.composer.focus?.(focusedSession()) } catch { /* older hosts */ } }, 0)
    }

    /** On send (dogfood 11-07): the message goes as it is. A conversion still running for this chat is
     *  cancelled so its result never lands in the emptied composer; an offer or 撤销 row goes too. */
    const onSend = () => {
      const address = pinnedAddress()
      const mine = [...running].filter(run => run.sessionId === address && !run.cancelled)
      mine.forEach(run => {
        run.cancelled = true
        running.delete(run)
      })
      if (mine.length) notifyAfterSend('info', t('sentAsIs'))
      if (hint.get()?.sessionId === address) setHint(null)
      if (leftover.get()?.sessionId === address) {
        if (moreRun) moreRun.cancelled = true
        leftover.set(null)
      }
    }

    /** 撤销 puts the pasted text back and offers 转为 Markdown again (dogfood 11-10: after 撤销 there
     *  was nowhere left to convert from). */
    const undo = async (h: Hint) => {
      setHint(null)
      if (leftover.get()?.sessionId === h.sessionId) leftover.set(null)
      if (h.swap) {
        const draft = await readDraft(h.sessionId)
        const at = h.swap.markdown ? draft.lastIndexOf(h.swap.markdown) : -1
        if (at < 0) notify('warning', t('undoEdited'))
        else if (await host.composer.setDraft(h.sessionId, replaceRange(draft, { start: at, end: at + h.swap.markdown.length }, h.swap.original))) {
          setHint({ ...h, mode: 'offer', swap: undefined, reason: undefined })
        }
      }
      void refreshDraft()
    }

    /** Chips for pasteboard entries, remembered so they become attachments on send. */
    const chipsFor = (entries: { path: string; isDir: boolean }[]): string[] =>
      entries.map(e => {
        const kind = e.isDir ? 'folder' : isImageFile(e.path) ? 'image' : 'file'
        if (!pendingRefs.some(r => r.path === e.path && r.kind === kind)) pendingRefs.push({ path: e.path, kind })
        return refChip(kind, e.path)
      })
    const offerTranscription = (sessionId: string, entries: { path: string; isDir: boolean }[]) => {
      const paths = entries.filter(e => !e.isDir && AUDIO_EXT_RE.test(e.path)).map(e => e.path)
      if (paths.length) {
        audioSeen = false
        audioHint.set({ sessionId, paths, busy: false })
      }
    }
    /** Several chips become a Markdown list, one per line (D8). */
    const asList = (chips: string[]) => chips.map(c => `- ${c}`).join('\n')
    /** A list goes in as its own paragraph at the end (the SDK's block insert keeps the line breaks). */
    const placeList = async (sessionId: string, chips: string[]) => {
      if (!stillActive(sessionId)) return
      await host.composer.insertText(sessionId, asList(chips), { mode: 'block' })
      void refreshDraft()
    }

    /** File/folder paths on the macOS pasteboard for this paste (D5/D6). Chromium names only
     *  the first file of a multi-file copy: when the pasteboard's first entry is that file, all
     *  entries are this paste; otherwise only entries named in the paste are kept. */
    const pasteboardEntries = async (names: string[]): Promise<{ path: string; isDir: boolean }[]> => {
      if (!names.length) return []
      try {
        const res = await ctx.rest<{ ok?: boolean; files?: { path?: unknown; is_dir?: unknown }[] }>('/clipboard-files')
        const all = (res?.ok && Array.isArray(res.files) ? res.files : [])
          .filter(f => typeof f?.path === 'string')
          .map(f => ({ path: f.path as string, isDir: f.is_dir === true }))
        if (all.length && basename(all[0].path) === names[0]) return all
        const wanted = new Set(names)
        return all.filter(e => wanted.has(basename(e.path)))
      } catch (err) {
        if (is404(err)) await checkBackend()
        return []
      }
    }

    /** Send-time PNG for formats Desktop cannot preview (TIFF from Raycast, HEIC, BMP, AVIF).
     *  Never throws: a failed conversion keeps the original, Hermes then transcodes it itself. */
    const convertImages = async (draft: Draft): Promise<Draft> => {
      const attachments = Array.isArray(draft.attachments) ? draft.attachments : []
      if (!attachments.some(a => a?.kind === 'image' && typeof a.path === 'string' && CONVERTIBLE_EXT_RE.test(a.path))) return draft
      const s = settings.get()
      const next: DraftAttachment[] = []
      for (const a of attachments) {
        if (a?.kind !== 'image' || typeof a.path !== 'string' || !CONVERTIBLE_EXT_RE.test(a.path)) {
          next.push(a)
          continue
        }
        try {
          const res = await ctx.rest<{ path?: string | null }>('/to-png', {
            method: 'POST',
            body: { path: a.path, cache_dir: s.cache_dir || null },
            timeoutMs: FETCH_TIMEOUT_MS
          })
          if (typeof res?.path === 'string' && res.path) {
            const { previewUrl: _p, thumbnailUrl: _t, ...rest } = a as DraftAttachment & { previewUrl?: unknown; thumbnailUrl?: unknown }
            next.push({ ...rest, path: res.path, label: basename(a.label || a.path).replace(CONVERTIBLE_EXT_RE, '') + '.png' })
            continue
          }
        } catch (err) {
          if (is404(err)) void checkBackend()  // keep the original; Hermes transcodes it itself
        }
        next.push(a)
      }
      return { ...draft, attachments: next }
    }

    /** Upload a pasted image as a preview copy (D9). Silent on any failure. */
    const savePreview = async (file: (Blob & { size: number; type: string }) | null | undefined): Promise<{ path: string | null; sha256: string | null } | null> => {
      if (!file || typeof file.arrayBuffer !== 'function' || file.size > 20 * 1024 * 1024) return null
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        const res = await ctx.rest<{ path?: string | null; sha256?: string | null }>('/save-preview', {
          method: 'POST',
          body: { data_url: `data:${file.type || 'image/png'};base64,${btoa(binary)}`, cache_dir: settings.get().cache_dir || null },
          timeoutMs: FETCH_TIMEOUT_MS
        })
        return {
          path: typeof res?.path === 'string' && res.path ? res.path : null,
          sha256: typeof res?.sha256 === 'string' && res.sha256 ? res.sha256 : null
        }
      } catch (err) {
        if (is404(err)) void checkBackend()
        return null
      }
    }

    /** At send (dogfood 11-07): pin each «截图 N» to the image attachment with the same bytes; one whose
     *  attachment was removed is dropped. Unknown digests or an old backend keep the order-based binding. */
    const shotTargets = async (draft: Draft, address: string): Promise<ShotTarget> => {
      const keep: ShotTarget = () => undefined
      if (!screenshotChipNumbers(draft?.text ?? '').some(n => screenshotDigests.has(shotKey(address, n)))) return keep
      const images = (Array.isArray(draft.attachments) ? draft.attachments : []).filter(a => a && a.kind === 'image')
      const paths = images.map(a => a.path).filter((p): p is string => typeof p === 'string' && !!p)
      let digests: Record<string, string | null> = {}
      if (paths.length) {
        try {
          digests = (await ctx.rest<{ digests: Record<string, string | null> }>('/file-digests', { method: 'POST', body: { paths }, timeoutMs: DIGEST_TIMEOUT_MS })).digests ?? {}
        } catch (err) {
          if (is404(err)) void checkBackend()
          return keep
        }
      }
      return n => {
        const want = screenshotDigests.get(shotKey(address, n))
        if (!want) return undefined
        const index = images.findIndex(a => typeof a.path === 'string' && digests[a.path] === want)
        if (index >= 0) return `rp-image:${index}`
        // Dropped only when every image could be read and none has these bytes (review 11-08).
        return images.every(a => typeof a.path === 'string' && typeof digests[a.path] === 'string') ? null : undefined
      }
    }

    /** Swap one chip (the `occurrence`-th with this ref text) for another in the draft. */
    const replaceChip = async (refText: string, occurrence: number, next: string, ref: PendingRef) => {
      const sessionId = pinnedAddress()
      const draft = await readDraft(sessionId)
      const text = replaceNth(draft, refText, occurrence, next)
      if (text === null) {
        notify('warning', t('blockGone'))
        return
      }
      if (!pendingRefs.some(r => r.path === ref.path && r.kind === ref.kind)) pendingRefs.push(ref)
      await host.composer.setDraft(sessionId, text)
      void refreshDraft()
    }

    const pickReplacement = async (kind: 'file' | 'folder' | 'image', current: string, refText: string, occurrence: number) => {
      if (kind === 'folder') {
        const res = await ctx.files?.requestFolder?.()
        const path = res?.ok ? res.folder?.path : null
        if (path) await replaceChip(refText, occurrence, refChip('folder', path), { path, kind: 'folder' })
        return
      }
      const dir = current.replace(/[\\/][^\\/]*$/, '') || undefined
      const path = await ctx.os.pickOpenPath?.({ defaultPath: dir, title: kind === 'image' ? t('pickImage') : t('pickFile') })
      if (!path) return
      const nextKind = isImageFile(path) ? 'image' : 'file'
      await replaceChip(refText, occurrence, refChip(nextKind, path), { path, kind: nextKind })
    }

    /** Click on a Desktop ref chip in the composer (D9): images/audio/video preview, files and
     *  folders open a picker that replaces the chip. Desktop itself does nothing on chip clicks. */
    const onChipClick = (event: Event) => {
      const target = event.target as (Element & { closest?: (s: string) => Element | null }) | null
      const chip = target?.closest?.('[data-ref-kind][data-ref-text]')
      const editor = chip?.closest?.('[role="textbox"]')
      if (!chip || !editor) return
      const kind = chip.getAttribute('data-ref-kind')
      const refText = chip.getAttribute('data-ref-text') || ''
      const value = chip.getAttribute('data-ref-id') || ''
      const same = Array.from(editor.querySelectorAll('[data-ref-text]')).filter(c => c.getAttribute('data-ref-text') === refText)
      const occurrence = Math.max(0, same.indexOf(chip))
      const shot = kind === 'image' ? screenshotNumber(value) : null
      if (shot !== null) {
        const path = screenshotPreviews.get(shotKey(pinnedAddress(), shot))
        if (path) preview.set({ path, title: value, copyRef: { text: refText, label: value } })
        else notify('info', t('shotNoPreview'))
        return
      }
      if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value)) return
      if (kind === 'image' || (kind === 'file' && (AUDIO_EXT_RE.test(value) || VIDEO_EXT_RE.test(value)))) {
        preview.set({
          path: value,
          title: basename(value),
          replace: { refText, occurrence, kind: kind === 'image' ? 'image' : 'file' },
          ...(kind === 'image' ? { copyRef: { text: refText, label: basename(value) } } : {})
        })
        return
      }
      if (kind === 'file' || kind === 'folder') void pickReplacement(kind, value, refText, occurrence)
    }

    // ---- audio transcription (D10): Hermes' own STT through the plugin backend ----
    interface SttStatus { kind?: string; provider?: string | null; needs_download?: boolean; model?: string | null; download_mb?: number | null; language?: string | null }
    /** First use of a cloud provider, a model download or an unknown setup asks once (stored per setup). */
    const ensureConsent = async (): Promise<boolean> => {
      let status: SttStatus
      try {
        const model = settings.get().stt_model
        status = await ctx.rest<SttStatus>(model ? `/stt-status?model=${encodeURIComponent(model)}` : '/stt-status')
      } catch (err) {
        if (is404(err)) await checkBackend()
        notify('warning', tip.get() === 'restart' ? restartMessage() : t('sttUnknown'))
        return false
      }
      if (status?.kind === 'none') {
        notify('warning', t('sttMissing'))
        return false
      }
      const key = `stt_ok:${status?.kind}:${status?.provider ?? ''}:${status?.model ?? ''}`
      const lang = status?.language ? t('sttLanguage', status.language) : ''
      let message = ''
      if (status?.kind === 'cloud') message = t('sttCloud', status.provider, lang)
      else if (status?.kind === 'local' && status.needs_download) {
        message = t('sttDownload', status.model, status.download_mb, lang)
      } else if (status?.kind !== 'local' && status?.kind !== 'command') message = t('sttUnclear', lang)
      if (!message || ctx.storage.get(key, false) === true) return true
      const ok = await new Promise<boolean>(resolve => consent.set({ message, resolve }))
      consent.set(null)
      if (ok) ctx.storage.set(key, true)
      return ok
    }

    const TRANSCRIBE_ERRORS: Record<string, string> = { unsupported_type: 'sttUnsupported', not_found: 'sttNotFound', too_large: 'sttTooLarge' }
    /** One line for a toast: a 402/401 from a cloud STT reads as an account problem, the rest is cut short. */
    const shortReason = (error: string) => {
      const reason = error.replace(/^failed: /, '')
      if (/HTTP 402|out of credits|spending-limit/i.test(reason)) return t('sttNoCredits')
      if (/HTTP 401|HTTP 403|api key/i.test(reason)) return t('sttBadKey')
      return reason.length > 120 ? `${reason.slice(0, 120)}…` : reason
    }
    const transcribePaths = async (sessionId: string, paths: string[]) => {
      if (!(await ensureConsent())) return
      audioHint.set({ sessionId, paths, busy: true })
      try {
        for (const path of paths) {
          let res: { transcript?: string | null; error?: string | null }
          try {
            const model = settings.get().stt_model
            res = await ctx.rest('/transcribe', { method: 'POST', body: model ? { path, model } : { path }, timeoutMs: 600_000 })
          } catch (err) {
            if (is404(err)) await checkBackend()
            notify('error', tip.get() === 'restart' ? restartMessage() : t('transcribeFailed', basename(path)))
            continue
          }
          if (res?.error) {
            notify('error', TRANSCRIBE_ERRORS[res.error] ? t('transcribeError', basename(path), t(TRANSCRIBE_ERRORS[res.error])) : t('transcribeFailedWhy', basename(path), shortReason(res.error)))
            continue
          }
          const transcript = (res?.transcript || '').trim()
          if (!transcript) {
            notify('info', t('noSpeech', basename(path)))
            continue
          }
          if (!stillActive(sessionId)) return
          const draft = await readDraft(sessionId)
          const next = insertAfterChip(draft, 'file', path, `\n> ${t('transcriptQuote')}${transcript.split(/\r?\n/).join('\n> ')}\n`)
          if (next === null) {
            notify('warning', t('audioChipGone', basename(path)))
            continue
          }
          await host.composer.setDraft(sessionId, next)
          void refreshDraft()
        }
      } finally {
        audioHint.set(null)
      }
    }

    // ---- passive paste listener (U-BEH-1/4/5) ----
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData
      if (!data || !isComposerTarget(event.target)) return
      const sessionId = pinnedAddress()
      const editor = document.activeElement
      const html = data.getData('text/html') || ''
      const plain = data.getData('text/plain') || ''
      const fileItems = Array.from(data.items || []).filter(item => item.kind === 'file')
      const imageItems = fileItems.filter(item => item.type.startsWith('image/'))

      // Text at the caret when the composer still has focus, else appended (and said so). Chip
      // text typed at the caret is re-set through the SDK so it hydrates into chips (D6).
      const placeNow = async (text: string, appendedMessage: string) => {
        if (!stillActive(sessionId)) return
        if (insertAtCaret(editor, text)) {
          if (text.includes('@')) await host.composer.setDraft(sessionId, await readDraft(sessionId))
        } else {
          await host.composer.insertText(sessionId, text, { mode: 'inline' })
          notify('info', appendedMessage)
        }
        void refreshDraft()
      }
      const place = (text: string, appendedMessage: string) => {
        ctx.setTimeout(() => void placeNow(text, appendedMessage), 0)
      }
      // Names are read now: DataTransfer items detach once this handler returns.
      const names = fileItems.map(item => item.getAsFile()?.name || '').filter(Boolean)
      const imageFiles = imageItems.map(item => item.getAsFile())

      if (imageItems.length > 0) {
        // Screenshot, copied image, Raycast entry or Finder image file: the core attaches the
        // blob itself, so no conversion is offered (it would download the image again); we add a
        // `@image:截图 N` chip. Desktop's Chromium hands over only the FIRST file of a multi-file
        // Finder copy, so the rest come from the pasteboard (D6).
        ctx.setTimeout(() => {
          void (async () => {
            const first = countScreenshots(await readDraft(sessionId)) + 1
            const shots = imageItems.map((_item, i) => screenshotChip(first + i))
            imageFiles.forEach((file, i) => {
              const key = shotKey(sessionId, first + i)
              screenshotPreviews.delete(key)
              screenshotDigests.delete(key)
              void savePreview(file).then(saved => {
                if (saved?.path) screenshotPreviews.set(key, saved.path)
                if (saved?.sha256) screenshotDigests.set(key, saved.sha256)
              })
            })
            const restEntries = (await pasteboardEntries(names)).slice(imageItems.length)
            const rest = chipsFor(restEntries)
            if (shots.length + rest.length > 1) await placeList(sessionId, [...shots, ...rest])
            else await placeNow(shots[0], t('shotAppended'))
            offerTranscription(sessionId, restEntries)
          })()
        }, 0)
        return
      }

      if (fileItems.length > 0) {
        // Finder files and folders: a chip now; on send a readable label plus a file attachment
        // (Desktop's own send flow calls `file.attach`, A:S5) or an `@folder:` ref. The paste
        // event usually carries no path (never for a folder), so paths come from the pasteboard.
        const direct = finderPaths(data)
        void (async () => {
          const entries = direct.length ? direct.map(path => ({ path, isDir: false })) : await pasteboardEntries(names)
          if (!entries.length) {
            notify('info', tip.get() === 'restart'
              ? restartMessage()
              : t('noFilePath', names[0] || t('thisFile')))
            return
          }
          const chips = chipsFor(entries)
          const text = chips.length > 1 ? asList(chips) : chips[0]
          if (!stillActive(sessionId)) return
          // The core pasted the plain text (the file names) already: swap it for the chips.
          const draft = plain.trim() ? await readDraft(sessionId) : ''
          const range = draft ? locatePasted(draft, plain) : null
          if (range && (await host.composer.setDraft(sessionId, replaceRange(draft, range, text)))) {
            void refreshDraft()
            offerTranscription(sessionId, entries)
            return
          }
          if (chips.length > 1) await placeList(sessionId, chips)
          else place(text, t('fileAppended'))
          offerTranscription(sessionId, entries)
        })()
        return
      }

      // A copied chip reference (the preview label, 11-07) arrives as plain text: the core pastes it as
      // words, so put the draft back through setDraft, which turns references into chips.
      if (!html && hasRefChips(plain)) {
        ctx.setTimeout(() => {
          void (async () => {
            if (!stillActive(sessionId)) return
            await host.composer.setDraft(sessionId, await readDraft(sessionId))
            void refreshDraft()
          })()
        }, 0)
        return
      }
      if (!html) return
      // Desktop copies a chip as its label only ("截图 1"); its HTML keeps `data-ref-text`.
      // Put the chips back over the plain text the core just pasted (D7).
      if (html.includes('data-ref-text')) {
        const restored = refTextFromHtml(html)
        if (restored && restored !== plain.trim()) {
          ctx.setTimeout(() => {
            void (async () => {
              if (!stillActive(sessionId)) return
              const draft = await readDraft(sessionId)
              const range = locatePasted(draft, plain)
              if (range) await host.composer.setDraft(sessionId, replaceRange(draft, range, restored))
              void refreshDraft()
            })()
          }, 0)
          return
        }
      }
      if (isTooLarge(html)) {
        notify('info', t('tooBig'))
        return
      }
      let shape
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html')
        if (isTooLarge(html, doc)) {
          notify('info', t('tooBig'))
          return
        }
        shape = pasteShape(doc, html)
      } catch {
        return
      }
      const decision = pasteDecision(shape, settings.get().convert_mode)
      if (decision.action === 'none') return
      const long = plain.trim().length > DESKTOP_LONG_PASTE_CHARS
      const next: Hint = { mode: 'offer', sessionId, html, plain, summary: describeSummary(shape.summary), ...(long ? { long } : {}) }
      if (decision.action === 'auto') {
        // Let the core insert its plain text first, then replace it.
        ctx.setTimeout(() => void convert({ ...next, reason: decision.reason === 'always' ? undefined : decision.reason }, true), 0)
      } else {
        setHint(next)
      }
    }

    ctx.addEventListener(document, 'click', onChipClick)
    // Chips the plugin handles on click show a pointer (dogfood 11-07); Desktop gives them none.
    if (typeof document.createElement === 'function' && document.head) {
      const style = document.createElement('style')
      style.textContent = PLUGIN_CSS
      document.head.append(style)
      ctx.onDispose?.(() => style.remove())
    }
    ctx.addEventListener(document, 'paste', event => {
      try {
        onPaste(event as ClipboardEvent)
      } catch {
        // never disturb the core paste
      }
    }, { capture: true })

    // Hint disappears on Esc (U-BEH-1; dogfood 11-10: typing and time no longer take it away).
    ctx.addEventListener(document, 'keydown', event => {
      if ((event as KeyboardEvent).key === 'Escape' && hint.get()?.mode !== 'busy') setHint(null)
    }, { capture: true })
    let cancelInputRefresh: (() => void) | null = null
    ctx.addEventListener(document, 'input', event => {
      if (!isComposerTarget(event.target)) return
      const e = event as InputEvent
      cancelInputRefresh?.()
      cancelInputRefresh = ctx.setTimeout(() => void refreshDraft(), INPUT_REFRESH_MS)
    }, { capture: true })
    // ceiling: the SDK has no draft-change subscription, so the top strip polls getDraft
    // (visible window only). Replace with a subscription once the SDK offers one.
    ctx.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refreshDraft()
    }, STRIP_REFRESH_MS)

    // ---- underside: 「转为 Markdown」 / 「已转换。撤销」 ----
    function Underside() {
      const h = useValue(hint)
      const focused = useValue(host.state.focusedSessionId)
      if (!h || h.sessionId !== (focused ?? 'new')) return null
      const row = 'flex items-center gap-2 px-1 py-0.5 text-xs text-(--ui-text-tertiary)'
      if (h.mode === 'busy') {
        const p = h.progress
        return jsx('div', {
          className: row,
          role: 'status',
          style: { ...LINE, color: 'var(--ui-accent)' },
          children: busyText(p && p.total ? t('downloading', p.done, p.total) : t('converting'), t('enterSendsOriginal'))
        })
      }
      if (h.mode === 'converted') {
        return jsxs('div', {
          className: row,
          style: LINE,
          children: [
            jsx('span', { children: h.reason ? t('autoConverted') : t('converted') }),
            jsx(Button, { type: 'button', size: 'xs', variant: 'text', onClick: () => { backToComposer(); void undo(h) }, children: t('undo') })
          ]
        })
      }
      return jsxs('div', {
        className: row,
        style: LINE,
        children: [
          jsx(Button, { type: 'button', size: 'xs', variant: 'secondary', onClick: () => { backToComposer(); void convert(h, false) }, children: t('toMarkdown') }),
          jsx(Button, { type: 'button', size: 'xs', variant: 'text', onClick: () => { setHint(null); backToComposer() }, children: t('dismiss') }),
          jsx('span', { children: h.summary })
        ]
      })
    }

    // ---- top strip: local images that will be attached on send (F2) ----
    function TopStrip() {
      const text = useValue(draftText)
      const items = localImageMarkers(text).filter(item => isOwnImage(item.path))
      if (!items.length) return null
      const remove = async (path: string) => {
        const sessionId = focusedSession()
        await host.composer.setDraft(sessionId, removeMarkers(await readDraft(sessionId), path))
        void refreshDraft()
      }
      return jsxs('div', {
        className: 'flex flex-wrap items-center gap-1.5 px-2 py-1 text-xs text-(--ui-text-tertiary)',
        children: [
          jsx('span', { children: t('imagesWillSend') }),
          ...items.map((item, i) =>
            jsxs('span', {
              className: 'inline-flex items-center gap-1 rounded bg-(--ui-bg-quaternary) px-1.5 py-0.5 text-(--ui-text-secondary)',
              title: item.path,
              children: [
                jsx('span', { children: t('imageItem', i + 1, basename(item.path)) }),
                jsx('button', {
                  type: 'button',
                  'aria-label': t('removeImage', i + 1),
                  className: 'text-(--ui-text-tertiary) hover:text-(--ui-text-primary)',
                  onClick: () => void remove(item.path),
                  children: '×'
                })
              ]
            }, item.path)
          )
        ]
      })
    }

    function BackendTip() {
      const shown = useValue(tip)
      if (!shown || tipDismissed) return null
      const row = 'flex items-center gap-2 px-1 py-0.5 text-xs text-(--ui-text-tertiary)'
      const restart = async () => {
        tip.set(null)
        try {
          await host.restartGateway()
        } finally {
          ctx.setTimeout(() => void checkBackend(), 8000)
        }
      }
      return jsxs('div', {
        className: row,
        style: LINE,
        children: shown === 'restart'
          ? [
              jsx('span', { children: restartMessage() }),
              jsx(Button, { type: 'button', size: 'xs', variant: 'secondary', onClick: () => void restart(), children: t('restartButton') }),
              jsx(Button, { type: 'button', size: 'xs', variant: 'text', onClick: () => { tipDismissed = true; tip.set(null) }, children: '×' })
            ]
          : [
              jsx('span', { children: t('desktopOlder') }),
              jsx(Button, { type: 'button', size: 'xs', variant: 'text', onClick: () => { tipDismissed = true; tip.set(null) }, children: '×' })
            ]
      })
    }

    /** Above the editor, for a markdown draft only: a 预览 button. Sent bubbles are core UI the
     *  plugin can't reach, and the editor can't be split, so the preview opens its own view. */
    function MarkdownPreview() {
      const text = useValue(draftText)
      if (!looksLikeMarkdown(text)) return null
      const open = async () => {
        let latest = text
        try {
          latest = await readDraft(focusedSession())
        } catch {
          // keep the last known draft
        }
        split.set(latest)
      }
      return jsx('div', {
        className: 'flex items-center px-1',
        children: jsx(Button, { type: 'button', size: 'xs', variant: 'text', className: 'rp-link', title: t('previewTitle'), onClick: () => void open(), children: t('preview') })
      })
    }

    /** The draft rendered with Desktop's own markdown, read-only. Sizes are inline styles: Desktop's
     *  stylesheet only has the classes its own source uses. */
    function SplitDialog() {
      const text = useValue(split)
      if (text === null) return null
      // Back to the composer: the dialog opens from state, not a trigger, so focus fell to the window's
      // first control and a keyboard user needed a dozen Tabs to type again (dogfood 11-10, real run).
      const close = () => {
        split.set(null)
        backToComposer()
      }
      return jsx(Dialog, {
        open: true,
        onOpenChange: (open: boolean) => { if (!open) close() },
        children: jsxs(DialogContent, {
          fitContent: true,
          'aria-describedby': undefined,
          // Desktop centres dialogs with left: 50%, so a content-sized one stops at half the window and
          // clipped a wider body (dogfood 11-08): the dialog itself gets the width, the body fills it.
          style: { width: 'min(960px, 88vw)' },
          children: [
            // Radix needs a title for screen readers; it is not shown (dogfood 11-07: no heading).
            jsx(DialogTitle, { style: VISUALLY_HIDDEN, children: t('preview') }),
            jsx('div', {
              'aria-label': t('rendered'),
              className: 'text-sm rp-preview',
              style: { width: '100%', maxHeight: '72vh', overflowY: 'auto', overflowWrap: 'anywhere' },
              children: jsx(MessageTextContent, { text, media: false })
            }),
            jsx('div', {
              className: 'flex justify-end pt-2',
              children: jsx(Button, { type: 'button', size: 'xs', variant: 'secondary', onClick: close, children: t('close') })
            })
          ]
        })
      })
    }

    /** 「这段长内容（N 字）会按 Markdown 发送，含 K 张图。预览 · 改回纯文字」 (11-07). */
    function LongRow() {
      const all = useValue(longPastes)
      const focused = useValue(host.state.focusedSessionId)
      const mine = all.filter(l => l.sessionId === (focused ?? 'new') && !l.hidden)
      if (!mine.length) return null
      const row = 'flex items-center gap-2 px-1 py-0.5 text-xs text-(--ui-text-tertiary)'
      return jsxs('div', {
        style: LINE,
        children: mine.map(l =>
          jsxs('div', {
            className: row,
            children: [
              jsx('span', { children: t('longPaste', l.chars, l.images) }),
              jsx(Button, { type: 'button',
                size: 'xs',
                variant: 'text',
                className: 'rp-link',
                onClick: async () => {
                  const markdown = await markdownOf(l)
                  if (markdown === null) notify('warning', t('longGone'))
                  else split.set(markdown)
                },
                children: t('preview')
              }),
              jsx(Button, { type: 'button',
                size: 'xs',
                variant: 'text',
                onClick: () => {
                  setLongs(longPastes.get().filter(x => x !== l))
                  if (leftover.get()?.long === longId(l)) leftover.set(null)
                  backToComposer()
                },
                children: t('backToPlain')
              }),
              // The plugin cannot see Desktop's attachments, so a removed .txt leaves this row behind;
              // 收起 lets the user put it away (the send matches the .txt anyway, 11-08).
              jsx(Button, { type: 'button',
                size: 'xs',
                variant: 'text',
                onClick: () => { setLongs(longPastes.get().map(x => (x === l ? { ...x, hidden: true } : x))); backToComposer() },
                children: t('collapse')
              })
            ]
          }, longId(l)))
      })
    }

    /** 「第 4、5 张超出张数上限，没有下载。再下载 2 张 · 忽略」 below the composer (11-07). */
    function MoreImages() {
      const lo = useValue(leftover)
      const focused = useValue(host.state.focusedSessionId)
      const text = useValue(draftText)
      const longs = useValue(longPastes)
      if (!lo || lo.sessionId !== (focused ?? 'new')) return null
      // Hidden once its links are gone (the user deleted them, or the draft was sent).
      const linksLeft = lo.long !== undefined
        ? longs.some(l => l.sessionId === lo.sessionId && longId(l) === lo.long)
        : lo.images.some(i => text.includes(linkFor(missedImageLabel('count'), i.alt, i.src)))
      if (!lo.busy && !linksLeft) return null
      const row = 'flex items-center gap-2 px-1 py-0.5 text-xs text-(--ui-text-tertiary)'
      if (lo.busy) {
        return jsx('div', { className: row, role: 'status', style: { ...LINE, color: 'var(--ui-accent)' }, children: busyText(t('downloading', lo.busy.done, lo.busy.total), t('enterSendsDraft')) })
      }
      return jsxs('div', {
        className: row,
        style: LINE,
        children: [
          jsx('span', { children: t('overLimit', lo.images.map(i => i.n)) }),
          jsx(Button, { type: 'button', size: 'xs', variant: 'secondary', onClick: () => void fetchMore(lo), children: t('downloadMore', lo.images.length) }),
          jsx(Button, { type: 'button', size: 'xs', variant: 'text', onClick: () => { leftover.set(null); backToComposer() }, children: t('dismiss') })
        ]
      })
    }

    /** A thin bar across the top of the composer while converting (dogfood 11-07). Real fraction when
     *  images are downloading, a sweep otherwise. */
    function BusyBar() {
      const h = useValue(hint)
      const lo = useValue(leftover)
      const focused = useValue(host.state.focusedSessionId)
      const here = focused ?? 'new'
      const converting = h && h.mode === 'busy' && h.sessionId === here
      const fetching = lo?.busy && lo.sessionId === here
      if (!converting && !fetching) return null
      const p = converting ? h!.progress : lo!.busy
      const fraction = p && p.total ? Math.max(0.06, p.done / p.total) : null
      return jsx('div', {
        className: 'rp-busy-bar',
        role: 'progressbar',
        'aria-label': t('converting'),
        ...(p && p.total ? { 'aria-valuemin': 0, 'aria-valuemax': p.total, 'aria-valuenow': p.done } : {}),
        children: jsx('div', { className: fraction === null ? 'rp-busy-fill rp-busy-sweep' : 'rp-busy-fill', style: fraction === null ? undefined : { width: `${fraction * 100}%` } })
      })
    }

    const copyRef = async (ref: { text: string; label: string }) => {
      try {
        await writeClipboardText(ref.text)
        notify('info', t('copiedRef', ref.label))
      } catch {
        notify('warning', t('copyFailed'))
      }
    }

    function PreviewDialog() {
      const p = useValue(preview)
      if (!p) return null
      const close = () => preview.set(null)
      const replace = p.replace
      return jsx(Dialog, {
        open: true,
        onOpenChange: (open: boolean) => { if (!open) close() },
        children: jsxs(DialogContent, {
          className: 'max-w-3xl',
          // No focus on open: the title is the copy button, and focusing it showed a ring and the hover look.
          onOpenAutoFocus: (event: Event) => event.preventDefault(),
          children: [
            // The title copies the chip reference (11-07): no second label; the hint is a hover bubble.
            jsx(DialogTitle, {
              children: p.copyRef
                ? jsx(Tip, {
                    label: t('clickToCopyRef'),
                    children: jsx('button', {
                      type: 'button',
                      'data-copy-ref': p.copyRef.text,
                      className: 'rp-copy-title',
                      style: { cursor: 'pointer' },
                      onClick: () => void copyRef(p.copyRef!),
                      children: p.title
                    })
                  })
                : p.title
            }),
            jsx('div', {
              // Audio/video start by themselves and resume where this file was paused (dogfood 11-07).
              ref: isPlayable(p.path) ? (node: Element | null) => (node ? watchMedia(node, el => attachPlayback(el, p.path, positions)) : undefined) : undefined,
              children: jsx(MessageTextContent, { text: `MEDIA:\`${p.path}\`` })
            }),
            jsxs('div', {
              className: 'flex items-center gap-2 pt-2',
              children: [
                jsx(Button, { type: 'button', size: 'xs', variant: 'text', onClick: () => void ctx.os.revealPath(p.path), children: t('revealInFinder') }),
                AUDIO_EXT_RE.test(p.path)
                  ? jsx(Button, { type: 'button', size: 'xs', variant: 'secondary', onClick: () => { close(); void transcribePaths(pinnedAddress(), [p.path]) }, children: t('transcribe') })
                  : null,
                replace
                  ? jsx(Button, { type: 'button',
                      size: 'xs',
                      variant: 'secondary',
                      onClick: () => { close(); void pickReplacement(replace.kind, p.path, replace.refText, replace.occurrence) },
                      children: t('replace')
                    })
                  : null
              ]
            })
          ]
        })
      })
    }

    function AudioPanel() {
      const h = useValue(audioHint)
      const c = useValue(consent)
      const focused = useValue(host.state.focusedSessionId)
      const row = 'flex items-center gap-2 px-1 py-0.5 text-xs text-(--ui-text-tertiary)'
      const label = h ? (h.paths.length > 1 ? t('nAudios', h.paths.length) : t('quotedName', basename(h.paths[0]))) : ''
      if (!(h && h.sessionId === (focused ?? 'new')) && !c) return null
      return jsxs('div', {
        style: LINE,
        children: [
          h && h.sessionId === (focused ?? 'new')
            ? h.busy
              ? jsx('div', { className: row, role: 'status', children: busyText(t('transcribing', label), t('longAudio')) })
              : jsxs('div', {
                  className: row,
                  children: [
                    jsx(Button, { type: 'button', size: 'xs', variant: 'secondary', onClick: () => { backToComposer(); void transcribePaths(h.sessionId, h.paths) }, children: t('transcribe') }),
                    jsx(Button, { type: 'button', size: 'xs', variant: 'text', onClick: () => { audioHint.set(null); backToComposer() }, children: t('dismiss') }),
                    jsx('span', { children: t('audioDetected', label) })
                  ]
                })
            : null,
          c
            ? jsx(Dialog, {
                open: true,
                onOpenChange: (open: boolean) => { if (!open) c.resolve(false) },
                children: jsxs(DialogContent, {
                  className: 'max-w-md',
                  children: [
                    jsx(DialogTitle, { children: t('transcribeTitle') }),
                    jsx('p', { className: 'text-sm', children: c.message }),
                    jsxs('div', {
                      className: 'flex justify-end gap-2 pt-2',
                      children: [
                        jsx(Button, { type: 'button', size: 'sm', variant: 'text', onClick: () => c.resolve(false), children: t('cancel') }),
                        jsx(Button, { type: 'button', size: 'sm', variant: 'secondary', onClick: () => c.resolve(true), children: t('continueTranscribe') })
                      ]
                    })
                  ]
                })
              })
            : null
        ]
      })
    }

    ctx.register({ id: 'hint', area: COMPOSER_AREAS.underside, render: () => jsx(Underside, {}) })
    ctx.register({ id: 'audio', area: COMPOSER_AREAS.underside, render: () => jsx(AudioPanel, {}) })
    ctx.register({ id: 'preview', area: COMPOSER_AREAS.underside, render: () => jsx(PreviewDialog, {}) })
    ctx.register({ id: 'split', area: COMPOSER_AREAS.underside, render: () => jsx(SplitDialog, {}) })
    ctx.register({ id: 'tip', area: COMPOSER_AREAS.underside, render: () => jsx(BackendTip, {}) })
    ctx.setTimeout(() => void checkBackend(), 0)
    ctx.register({ id: 'strip', area: COMPOSER_AREAS.top, render: () => jsx(TopStrip, {}) })
    ctx.register({ id: 'long-paste', area: COMPOSER_AREAS.underside, render: () => jsx(LongRow, {}) })
    ctx.register({ id: 'more-images', area: COMPOSER_AREAS.underside, render: () => jsx(MoreImages, {}) })
    ctx.register({ id: 'busy-bar', area: COMPOSER_AREAS.top, order: -1, render: () => jsx(BusyBar, {}) })
    ctx.register({ id: 'md-preview', area: COMPOSER_AREAS.top, render: () => jsx(MarkdownPreview, {}) })
    ctx.register({
      id: 'attach-markers',
      area: COMPOSER_AREAS.middleware,
      data: {
        handler: async (draft: Draft) => {
          const address = pinnedAddress()
          const longs = longPastes.get().filter(l => l.sessionId === address)
          onSend()
          if (longs.length) {
            setLongs(longPastes.get().filter(l => l.sessionId !== address))
            draft = await withLongPastes(draft, longs)
          }
          const { draft: unchipped, used, dropped } = chipsToMarkers(draft, pendingRefs, await shotTargets(draft, address))
          forgetShots(address)
          if (dropped.length) notifyAfterSend('info', t('shotsRemoved', dropped.map(n => t('screenshot', n))))
          const marked = applyDraftMarkers(unchipped, isOwnImage)
          if (used.size) pendingRefs.splice(0, pendingRefs.length, ...pendingRefs.filter(r => !used.has(r.path)))
          return convertImages(marked)
        }
      }
    })

    // ---- settings page (U-BEH-7/8; mockups/settings.html, settings-nodelete.html) ----
    function NumberInput({ field, unit }: { field: NumberKey; unit: string }) {
      const value = useValue(settings)[field]
      const [draft, setDraft] = useState(String(value))
      useEffect(() => setDraft(String(value)), [value])
      return jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(Input, {
            className: 'w-20',
            inputMode: 'numeric',
            value: draft,
            onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
            onBlur: () => {
              updateSettings({ [field]: draft })
              setDraft(String(settings.get()[field]))
            }
          }),
          jsx('span', { className: 'text-xs text-(--ui-text-tertiary)', children: unit })
        ]
      })
    }

    const numberRow = (show: boolean, title: string, field: NumberKey, unit: string) =>
      show
        ? jsx(ListRow, {
            title,
            description: t('numberHelp', DEFAULTS[field]),
            action: jsx(NumberInput, { field, unit })
          })
        : null

    function Section({ title, children }: { title: string; children: unknown[] }) {
      return jsxs('section', {
        className: 'pt-4',
        children: [jsx('div', { className: 'pb-1 text-xs font-medium text-(--ui-text-tertiary)', children: title }), ...children]
      })
    }

    function SettingsPage() {
      const s = useValue(settings)
      const [stats, setStats] = useState<CacheStats | null>(null)
      const [statsError, setStatsError] = useState(false)

      useEffect(() => {
        let live = true
        setStatsError(false)
        ctx.rest<CacheStats>(`/cache-stats?cache_dir=${encodeURIComponent(s.cache_dir)}`)
          .then(r => live && setStats(r))
          .catch(() => live && setStatsError(true))
        return () => {
          live = false
        }
      }, [s.cache_dir])

      const dirLabel = s.cache_dir || stats?.dir || '$HERMES_HOME/cache/rich-paste/'
      const usage = stats ? t('usage', stats.files, formatBytes(stats.bytes)) : statsError ? t('usageFailed') : t('usageLoading')
      const reveal = async () => {
        const ok = await ctx.os.revealPath(stats?.dir || s.cache_dir)
        if (!ok) notify('warning', t('folderMissing'))
      }
      const pickFolder = async () => {
        const picked = await ctx.files?.requestFolder?.()
        if (picked?.ok && picked.folder?.path) updateSettings({ cache_dir: picked.folder.path })
      }
      const revealButton = jsx(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => void reveal(), children: t('openFolder') })

      return jsxs('div', {
        className: 'flex flex-col',
        children: [
          jsx('div', { className: 'text-base font-medium', children: t('pluginName') }),
          jsx('div', { className: 'text-sm text-(--ui-text-tertiary)', children: t('pluginTagline') }),
          jsx(Section, {
            title: t('sectionPaste'),
            children: [
              jsx(ListRow, {
                title: t('pasteWeb'),
                description: t(CONVERT_MODE_HELP[s.convert_mode]),
                action: jsx('div', {
                  className: 'flex items-center gap-1',
                  role: 'group',
                  'aria-label': t('pasteWeb'),
                  children: (['smart', 'always', 'never'] as const).map(mode =>
                    jsx(Button, { type: 'button',
                      size: 'sm',
                      variant: s.convert_mode === mode ? 'secondary' : 'outline',
                      'aria-pressed': s.convert_mode === mode,
                      onClick: () => updateSettings({ convert_mode: mode }),
                      children: t(CONVERT_MODE_LABEL[mode])
                    }, mode))
                })
              }),
              jsx(ToggleRow, {
                checked: s.limit_images,
                label: t('limitCount'),
                description: t('limitCountHelp'),
                onChange: (on: boolean) => updateSettings({ limit_images: on })
              }),
              numberRow(s.limit_images, t('maxImages'), 'max_images', t('unitImages')),
              jsx(ToggleRow, {
                checked: s.limit_image_size,
                label: t('limitSize'),
                description: t('limitSizeHelp', DEFAULTS.max_image_mb),
                onChange: (on: boolean) => updateSettings({ limit_image_size: on })
              }),
              numberRow(s.limit_image_size, t('maxSize'), 'max_image_mb', t('unitMb'))
            ]
          }),
          jsx(Section, {
            title: t('sectionImages'),
            children: [
              jsx(ToggleRow, {
                checked: s.cache_auto_delete,
                label: t('autoDelete'),
                description: t('autoDeleteHelp'),
                onChange: (on: boolean) => updateSettings({ cache_auto_delete: on })
              }),
              s.cache_auto_delete
                ? numberRow(true, t('keepDays'), 'cache_days', t('unitDays'))
                : jsxs('div', {
                    role: 'alert',
                    className: 'flex flex-wrap items-center gap-2 py-3 text-sm text-destructive',
                    children: [
                      jsx('span', {
                        children: stats
                          ? t('noAutoDeleteUsage', formatBytes(stats.bytes), stats.files)
                          : t('noAutoDelete')
                      }),
                      revealButton
                    ]
                  }),
              jsx(ListRow, {
                title: t('folder'),
                description: jsx('span', { className: 'font-mono break-all', children: dirLabel }),
                action: jsxs('div', {
                  className: 'flex gap-2',
                  children: [
                    jsx(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => void pickFolder(), children: t('chooseFolder') }),
                    jsx(Button, { type: 'button', size: 'sm', variant: 'text', disabled: !s.cache_dir, onClick: () => updateSettings({ cache_dir: '' }), children: t('resetFolder') })
                  ]
                })
              }),
              s.cache_auto_delete
                ? jsx(ListRow, { title: t('currentUsage'), description: usage, action: revealButton })
                : null
            ]
          }),
          jsx(Section, {
            title: t('sectionStt'),
            children: [
              jsx(ListRow, {
                title: t('sttModel'),
                description: t('sttModelHelp', t(STT_MODEL_HELP[s.stt_model]), t('sttNote')),
                action: jsx('div', {
                  className: 'flex items-center gap-1',
                  role: 'group',
                  'aria-label': t('sttModel'),
                  children: STT_MODELS.map(model =>
                    jsx(Button, { type: 'button',
                      size: 'sm',
                      variant: s.stt_model === model ? 'secondary' : 'outline',
                      'aria-pressed': s.stt_model === model,
                      onClick: () => updateSettings({ stt_model: model }),
                      children: t(STT_MODEL_LABEL[model])
                    }, model || 'hermes'))
                })
              })
            ]
          })
        ]
      })
    }

    const page = { id: 'settings', title: t('pluginName'), icon: 'clippy', order: 0, render: () => jsx(SettingsPage, {}) }
    if (typeof ctx.registerSettingsPage === 'function') ctx.registerSettingsPage(page)
    else ctx.register({ ...page, area: SETTINGS_PLUGINS_AREA, data: { icon: page.icon } })
  }
}
