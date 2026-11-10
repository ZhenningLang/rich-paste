// Image markers in the draft text, and the composer middleware that turns them
// into attachments right before send (spec F1, F3). Pure functions: no SDK imports.

/** `![alt](target)` or `![alt](<target with spaces>)`. Same grammar as interleave.py. */
export const MARKER_RE = /!\[([^[\]\n]*)\]\((?:<([^<>\n]+)>|([^()[\]\s]+))\)/g

/** Keep in step with rp_cache.IMAGE_EXTS (the formats the backend keeps). */
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i

/** Formats Desktop cannot preview and some providers refuse; sent as PNG (dogfood D6). */
export const CONVERTIBLE_EXT_RE = /\.(tiff?|heic|heif|bmp|avif)$/i
export const isImageFile = (path: string) => IMAGE_EXT_RE.test(path) || CONVERTIBLE_EXT_RE.test(path)
export const AUDIO_EXT_RE = /\.(mp3|m4a|wav|aac|flac|ogg|oga|opus|aiff?|caf|amr)$/i
export const VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i

/** Replace the `occurrence`-th (0-based) `needle` in `text`; null when there is no such one. */
export function replaceNth(text: string, needle: string, occurrence: number, replacement: string): string | null {
  let at = -1
  for (let i = 0; i <= occurrence; i++) {
    at = text.indexOf(needle, at + 1)
    if (at < 0) return null
  }
  return text.slice(0, at) + replacement + text.slice(at + needle.length)
}

import { SCREENSHOT_WORDS, t } from './i18n.ts'

const ATTACHED_RE = /^attached:(\d+)$/

export interface Marker {
  alt: string
  target: string
  start: number
  end: number
}

function decodeTarget(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Markers with their decoded targets (targets are percent-encoded by markerFor). */
export function findMarkers(text: string): Marker[] {
  const out: Marker[] = []
  for (const m of text.matchAll(MARKER_RE)) {
    out.push({ alt: m[1], target: decodeTarget(m[2] ?? m[3]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }
  return out
}

/**
 * Hermes expands `@diff`, `@staged`, `@file:…`, `@url:…` and plugin `@name:…` in a sent message
 * (agent/context_references.py REFERENCE_PATTERN): it reads the file, fetches the URL, or refuses the
 * whole message when the path is outside the chat folder. Text from a pasted page is not the user's
 * request, so a WORD JOINER (U+2060) goes after its `@`: invisible, and the pattern no longer matches.
 * Same lookbehind as Hermes, so e-mail addresses and `/@user` URLs stay as they are (11-08).
 */
const REF_AT_RE = /(?<![\p{L}\p{N}_/])@(?=(?:diff|staged)(?![\p{L}\p{N}_])|[A-Za-z][A-Za-z0-9_-]*:)/gu
// Built from code points so the bundle carries no literal invisible characters (install scanner).
const WORD_JOINER = String.fromCharCode(0x2060)
export const quietRefs = (text: string) => text.replace(REF_AT_RE, `@${WORD_JOINER}`)

/**
 * Marker text for a target. Whitespace, `%` and `<>()[]` in the target are percent-encoded so
 * no image URL can close the marker early and smuggle in a second one (dogfood D2).
 */
const safeAlt = (alt: string) => quietRefs(alt).replace(/[[\]\n\r\u2063]+/g, ' ').replace(/\s+/g, ' ').trim()
const safeTarget = (target: string) =>
  target.replace(/[\s%<>()[\]]/g, ch => encodeURIComponent(ch).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))

export function markerFor(alt: string, target: string): string {
  return `![${safeAlt(alt)}](${safeTarget(target)})`
}

/** `[label：alt](url)` for an image that was not downloaded; same sanitising as markerFor. */
export function linkFor(label: string, alt: string, url: string): string {
  const text = safeAlt(alt)
  return `[${text ? `${label}：${text}` : label}](${safeTarget(url)})`
}

/** Paths inside the plugin's own cache root (rp_cache.CACHE_SUBDIR). */
export const CACHE_SEGMENT = '/rich-paste-cache/'
export const isPluginCachePath = (path: string) => path.replace(/\\/g, '/').includes(CACHE_SEGMENT)

export function isLocalPath(target: string): boolean {
  return target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)
}

export function isLocalImagePath(target: string): boolean {
  return isLocalPath(target) && isImageFile(target)
}

/** How many `attached:N` screenshot markers the draft already has (spec F3). */
export function countAttachedMarkers(text: string): number {
  return findMarkers(text).filter(m => ATTACHED_RE.test(m.target)).length
}

export function screenshotMarker(n: number): string {
  return `![${t('screenshot', n)}](attached:${n})`
}

export function basename(path: string): string {
  const parts = path.replace(/(.)[\\/]+$/, '$1').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Unique local image paths referenced by markers, in draft order (top strip, F2). */
export function localImageMarkers(text: string): { path: string; alt: string }[] {
  const seen = new Set<string>()
  const out: { path: string; alt: string }[] = []
  for (const m of findMarkers(text)) {
    if (isLocalImagePath(m.target) && !seen.has(m.target)) {
      seen.add(m.target)
      out.push({ path: m.target, alt: m.alt })
    }
  }
  return out
}

/** Remove every marker that points at `path`; other text is untouched. */
export function removeMarkers(text: string, path: string): string {
  let out = ''
  let cursor = 0
  for (const m of findMarkers(text)) {
    if (m.target !== path) continue
    out += text.slice(cursor, m.start)
    cursor = m.end
  }
  return out + text.slice(cursor)
}

export interface DraftAttachment {
  id: string
  kind: string
  label: string
  path?: string
  [key: string]: unknown
}

export interface Draft {
  text: string
  attachments?: DraftAttachment[]
}

/** Written after a label whose image could not be bound to an attachment. */

/**
 * What a bound image looks like in the sent message (11-10): a readable label between two
 * INVISIBLE SEPARATORs (U+2063), e.g. `\u2063[截图 2]\u2063`. Image attachments are reordered so
 * the k-th label is the k-th image, which is how interleave.py (SENT_RE) binds them. The user's
 * bubble and the session title read `[截图 2]` instead of `![截图 2](attached:1)`.
 */
export const SENT_MARK = String.fromCharCode(0x2063)
const SELF_LABELED_RE = /^(?:(?:截图|Screenshot) \d+|图|Image)$/ // already an image label: «截图 2», a bare «图» (i18n.ts SCREENSHOT_WORDS)
export function sentLabel(alt: string): string {
  const text = safeAlt(alt)
  return SELF_LABELED_RE.test(text) ? text : text ? t('imageLabel', text) : t('image')
}
export const sentMarker = (alt: string) => `${SENT_MARK}[${sentLabel(alt)}]${SENT_MARK}`
/** How many image attachments went out, as invisible TAG DIGITs between two U+2063 at the end of the
 *  text (review 11-10). Hermes drops an image it cannot read; interleave.py then sees the counts
 *  disagree and moves nothing, instead of shifting every later label by one. */
export const countToken = (n: number) => SENT_MARK + Array.from(String(n), d => String.fromCodePoint(0xe0000 + d.charCodeAt(0))).join('') + SENT_MARK
const TAG_CHARS_RE = /[\u{E0000}-\u{E007F}]/gu
const unboundMarker = (alt: string) => `[${t('unboundLabel', sentLabel(alt))}]`

const placeholderNumber = (m: Marker) => Number(ATTACHED_RE.exec(m.target)?.[1] ?? 0)

/**
 * Composer middleware (spec F1/F3, reworked after review S1/B:S2).
 *
 * The host may copy every image to a new path while sending (local sessions
 * upload through `/api/chat/image-upload`), so paths in the text cannot be
 * matched afterwards. Instead every marker is bound to its image's ordinal in
 * the final image-attachment list and written as `attached:<k>`; Hermes keeps
 * that order in its hint lines / reference blocks, which is what interleave.py
 * reads.
 *
 * 1. A marker pointing at an image the plugin downloaded (`isOwnImage`) binds to the
 *    attachment with that path, appending `{ id, kind: 'image', label, path }` when it is
 *    not attached yet. Other local paths stay plain text and are never attached.
 * 2. Screenshot placeholders (`attached:N`, written at paste time) bind to the
 *    image attachments no path marker claimed, in placeholder-number order —
 *    only when both counts are equal. Otherwise they are written as
 *    `![…](未对上的附件)` so no image is put in the wrong place.
 * Returns the same draft object when there are no markers.
 */
const PINNED_RE = /^rp-image:(\d+)$/

export function applyDraftMarkers(draft: Draft, isOwnImage: (path: string) => boolean = isPluginCachePath): Draft {
  if (!draft || typeof draft.text !== 'string') return draft
  // Sent labels copied back from an earlier bubble are plain text now, never a binding.
  const source = draft.text.includes(SENT_MARK) ? draft.text.split(SENT_MARK).join('').replace(TAG_CHARS_RE, '') : draft.text
  const markers = findMarkers(source)
  if (markers.length === 0) return source === draft.text ? draft : { ...draft, text: source }
  const attachments = Array.isArray(draft.attachments) ? draft.attachments : []
  const images = attachments.filter(a => a && a.kind === 'image')
  const originalCount = images.length
  const added: DraftAttachment[] = []
  const bound = new Map<Marker, number>()
  const claimed = new Set<number>()

  for (const m of markers) {
    const pin = PINNED_RE.exec(m.target)
    if (pin) {
      // A «截图 N» matched to its attachment by content (11-07): that image or nothing.
      const index = Number(pin[1])
      if (index < originalCount) {
        claimed.add(index)
        bound.set(m, index)
      }
      continue
    }
    // Only images this plugin downloaded get attached (dogfood D2): any other local path in the
    // text stays plain text, so pasted HTML can never make Hermes read an arbitrary local file.
    if (!isLocalImagePath(m.target) || !isOwnImage(m.target)) continue
    let index = images.findIndex(a => a.path === m.target)
    if (index < 0) {
      const attachment = { id: `rich-paste:${m.target}`, kind: 'image', label: basename(m.target), path: m.target }
      images.push(attachment)
      added.push(attachment)
      index = images.length - 1
    }
    claimed.add(index)
    bound.set(m, index)
  }

  const placeholders = markers.filter(m => ATTACHED_RE.test(m.target))
  const unclaimed = [...Array(originalCount).keys()].filter(i => !claimed.has(i))
  if (placeholders.length && unclaimed.length === placeholders.length) {
    ;[...placeholders].sort((a, b) => placeholderNumber(a) - placeholderNumber(b))
      .forEach((m, i) => bound.set(m, unclaimed[i]))
  }

  let text = ''
  let cursor = 0
  const order: number[] = [] // image indexes in the order their labels appear
  for (const m of markers) {
    const index = bound.get(m)
    const isPlaceholder = ATTACHED_RE.test(m.target) || PINNED_RE.test(m.target)
    if (index === undefined && !isPlaceholder) continue
    let replacement: string
    if (index === undefined) replacement = unboundMarker(m.alt)
    else if (order.includes(index)) replacement = `[${sentLabel(m.alt)}]` // same image again: its picture goes at the first label
    else {
      order.push(index)
      replacement = sentMarker(m.alt)
    }
    text += source.slice(cursor, m.start) + replacement
    cursor = m.end
  }
  text += source.slice(cursor)

  if (text === draft.text && added.length === 0 && order.every((index, at) => index === at)) return draft
  const all = [...attachments, ...added]
  const ranked = [...order, ...images.keys()].filter((index, at, list) => list.indexOf(index) === at)
  let slot = 0
  const reordered = all.map(a => (a && a.kind === 'image' ? images[ranked[slot++]] : a))
  return { ...draft, text: order.length ? text + countToken(images.length) : text, attachments: reordered }
}

/** Desktop's own ref quoting (`formatRefValue`): plain when safe, else backticks, quotes. */
export function formatRefValue(value: string): string {
  if (!/[\s()[\]{}<>"'`]/.test(value)) return value
  if (!value.includes('`')) return `\`${value}\``
  if (!value.includes('"')) return `"${value}"`
  return `'${value}'`
}

// ---- Placeholders as Desktop's own reference chips (dogfood D6) ----
// `@image:` / `@file:` / `@folder:` text hydrates into one non-editable chip in the composer,
// so a placeholder is selected, copied, moved and deleted as a block. At send the plugin's
// chips turn back into the markers/attachments the rest of the pipeline understands.

export type RefKind = 'image' | 'file' | 'folder'
const CHIP_RE = /@(image|file|folder):(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/g
const SCREENSHOT_VALUE_RE = new RegExp(`^(?:${SCREENSHOT_WORDS.join('|')}) (\\d+)$`)
/** N of a «截图 N» / «Screenshot N» chip value, or null. */
export const screenshotNumber = (value: string): number | null => {
  const m = SCREENSHOT_VALUE_RE.exec(value)
  return m ? Number(m[1]) : null
}

export function refChip(kind: RefKind, value: string): string {
  return `@${kind}:${formatRefValue(value)}`
}

export function screenshotChip(n: number): string {
  return refChip('image', t('screenshot', n))
}

function unquote(raw: string): string {
  const q = raw[0]
  return (q === '`' || q === '"' || q === "'") && raw.endsWith(q) && raw.length > 1 ? raw.slice(1, -1) : raw
}

interface Chip { kind: RefKind; value: string; start: number; end: number }

/** True when the text holds `@image:` / `@file:` / `@folder:` chip references. */
export function hasRefChips(text: string): boolean {
  return findChips(text).length > 0
}

/** N of every «截图 N» chip in the text. */
export function screenshotChipNumbers(text: string): number[] {
  return findChips(text).flatMap(c => {
    const m = c.kind === 'image' ? SCREENSHOT_VALUE_RE.exec(c.value) : null
    return m ? [Number(m[1])] : []
  })
}

function findChips(text: string): Chip[] {
  return [...text.matchAll(CHIP_RE)].map(m => ({
    kind: m[1] as RefKind, value: unquote(m[2]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length
  }))
}

/** Whether the draft holds a chip of `kind` for `path`, quoted or not: Desktop writes its chips back
 *  quoted (@file:`/a/b.m4a`) even when the plugin wrote them bare (dogfood 11-10). */
export function hasChip(text: string, kind: RefKind, path: string): boolean {
  return findChips(text).some(c => c.kind === kind && c.value === path)
}

/** Insert `insertion` right after the first chip of `kind` whose value is `path` (quoted or not,
 *  the way Desktop wrote it); null when the chip is gone. */
export function insertAfterChip(text: string, kind: RefKind, path: string, insertion: string): string | null {
  const chip = findChips(text).find(c => c.kind === kind && c.value === path)
  return chip ? text.slice(0, chip.end) + insertion + text.slice(chip.end) : null
}

/** Highest screenshot number in the draft, chips and `attached:N` markers alike. */
export function countScreenshots(text: string): number {
  const fromChips = findChips(text).map(c => Number(SCREENSHOT_VALUE_RE.exec(c.value)?.[1] ?? 0))
  return Math.max(0, countAttachedMarkers(text), ...fromChips)
}

/** A path the plugin read for a paste (Finder/Raycast), sent as a chip until send. */
export interface PendingRef {
  path: string
  kind: RefKind
}

export const fileLabel = (path: string) => t('fileLabel', basename(path))
export const folderLabel = (path: string) => t('folderLabel', basename(path))

/**
 * Turn the plugin's chips back into what the send pipeline understands: screenshot chips into
 * `![截图 N](attached:N)`, pending image paths into `![name](path)` (attached by
 * applyDraftMarkers), pending files/folders into a readable `[附件：…]` / `[文件夹：…]` at
 * that spot plus a file attachment / an `@folder:` ref the way Desktop's own drop does.
 * Chips the plugin did not create are left alone. `used` lists the pending paths consumed.
 */
/** Where a «截图 N» chip points at send (dogfood 11-07): `rp-image:<k>` pins it to the k-th image
 *  attachment (found by content), null drops it (its attachment was removed), undefined keeps the
 *  order-based `attached:N` placeholder. */
export type ShotTarget = (n: number) => string | null | undefined

export function chipsToMarkers(draft: Draft, pending: PendingRef[], shotTarget: ShotTarget = () => undefined): { draft: Draft; used: Set<string>; dropped: number[] } {
  const used = new Set<string>()
  const dropped: number[] = []
  if (!draft || typeof draft.text !== 'string') return { draft, used, dropped }
  const chips = findChips(draft.text)
  if (!chips.length) return { draft, used, dropped }
  const attachments = Array.isArray(draft.attachments) ? draft.attachments : []
  const known = new Set(attachments.map(a => a?.path).filter(Boolean))
  const added: DraftAttachment[] = []
  let text = ''
  let cursor = 0
  for (const chip of chips) {
    const shot = chip.kind === 'image' ? SCREENSHOT_VALUE_RE.exec(chip.value) : null
    const own = pending.find(p => p.kind === chip.kind && p.path === chip.value)
    let replacement: string | null = null
    if (shot) {
      const n = Number(shot[1])
      const target = shotTarget(n)
      if (target === null) dropped.push(n)
      replacement = target === null ? '' : target === undefined ? screenshotMarker(n) : markerFor(t('screenshot', n), target)
    } else if (own) {
      used.add(own.path)
      if (own.kind === 'image') {
        replacement = markerFor(basename(own.path), own.path)
      } else {
        replacement = own.kind === 'folder' ? folderLabel(own.path) : fileLabel(own.path)
        if (!known.has(own.path)) {
          known.add(own.path)
          added.push(own.kind === 'folder'
            ? { id: `rich-paste-folder:${own.path}`, kind: 'folder', label: basename(own.path), path: own.path, refText: `@folder:${formatRefValue(own.path)}` }
            : { id: `rich-paste-file:${own.path}`, kind: 'file', label: basename(own.path), path: own.path })
        }
      }
    }
    if (replacement === null) continue
    text += draft.text.slice(cursor, chip.start) + replacement
    cursor = chip.end
  }
  if (cursor === 0) return { draft, used, dropped }
  text += draft.text.slice(cursor)
  return { draft: { ...draft, text, attachments: added.length ? [...attachments, ...added] : attachments }, used, dropped }
}

// ---- Locating the plain text the core pasted (U-BEH-2) ----

const REF_PREFIX_RE = /^@(?:url|file|folder):/

/**
 * Normalised view of `text` for matching: whitespace, backticks and the
 * `@url:` / `@file:` / `@folder:` prefixes the core adds while pasting are
 * dropped. `map[i]` is the index in `text` of normalised char `i`.
 */
function normalize(text: string): { chars: string; map: number[] } {
  let chars = ''
  const map: number[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '@') {
      const prefix = REF_PREFIX_RE.exec(text.slice(i, i + 8))
      if (prefix) {
        i += prefix[0].length
        continue
      }
    }
    const ch = text[i]
    if (!/\s/.test(ch) && ch !== '`') {
      chars += ch
      map.push(i)
    }
    i += 1
  }
  return { chars, map }
}

/**
 * Where the core put the pasted plain text in the draft: exact match first
 * (after the same `trim()` the core applies), then a match that ignores
 * whitespace and the core's URL/path chips. The last occurrence wins.
 */
export function locatePasted(draft: string, plain: string): { start: number; end: number } | null {
  const needle = (plain || '').trim()
  if (!needle || !draft) return null
  const exact = draft.lastIndexOf(needle)
  if (exact >= 0) return { start: exact, end: exact + needle.length }

  const d = normalize(draft)
  const n = normalize(needle)
  if (!n.chars) return null
  const at = d.chars.lastIndexOf(n.chars)
  if (at < 0) return null
  const start = d.map[at]
  let end = d.map[at + n.chars.length - 1] + 1
  // swallow a closing backtick the core put around a quoted ref value
  if (draft[end] === '`' && needle[needle.length - 1] !== '`') end += 1
  return { start, end }
}

export function replaceRange(text: string, range: { start: number; end: number }, insert: string): string {
  return text.slice(0, range.start) + insert + text.slice(range.end)
}

/** Markdown structure that Desktop's sent-message bubble shows raw (it renders only `code` and
 *  fences): headings, bold, lists, links/images, tables, quotes, fences. Plain chat text, chips
 *  and inline code alone do not count, so the 原文/预览 switch stays out of the way (dogfood 11-07). */
const MARKDOWN_SIGNS: RegExp[] = [
  /^#{1,6}\s+\S/m,
  /\*\*[^*\n]+\*\*/,
  /^\s*(?:[-*+]|\d+[.)])\s+\S/m,
  /\[[^\]\n]+\]\([^)\s]+\)/,
  /!\[[^\]\n]*\]\([^)\s]+\)/,  // an image counts even without alt text (dogfood 11-10)
  /^\s*\|?\s*:?-{3,}:?\s*\|/m,
  /^>\s?\S/m,
  /^```/m
]

export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_SIGNS.some(re => re.test(text))
}
