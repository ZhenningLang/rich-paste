// HTML → Markdown for rich paste (U-BEH-2/3), built on turndown + the GFM plugin.
// Pure functions: the browser build parses with DOMParser (turndown's browser
// entry); Node tests parse with domino (turndown's node entry).

import TurndownService from 'turndown'
import { highlightedCodeBlock, strikethrough, taskListItems } from 'turndown-plugin-gfm'

import { t } from './i18n.ts'
import { linkFor, markerFor, quietRefs } from './markers.ts'

export interface HtmlSummary {
  headings: number
  images: number
  links: number
  lists: number
  tables: number
  pres: number
  /** Bold runs (tags, inline font-weight, bold classes); 0 for code-editor copies (dogfood 11-07). */
  bolds: number
}

/** Counts the structure U-BEH-1 cares about. `doc` is a parsed Document. */
export function summarizeDocument(doc: Document): HtmlSummary {
  const count = (selector: string) => doc.querySelectorAll(selector).length
  return {
    headings: count('h1, h2, h3, h4, h5, h6'),
    images: count('img'),
    links: count('a[href]'),
    lists: count('ul, ol'),
    tables: count('table'),
    pres: count('pre'),
    bolds: countBolds(doc)
  }
}

/** Code editors (VS Code and the like) copy a `white-space: pre` block whose keywords may be bold. */
const CODE_EDITOR_STYLE = /white-space\s*:\s*pre\b/i

function countBolds(doc: Document): number {
  const all = Array.from(doc.querySelectorAll('*')) as unknown as NodeLike[]
  if (all.some(el => CODE_EDITOR_STYLE.test(el.getAttribute('style') || ''))) return 0
  return all.filter(el => (isTagBold(el) || isCssBold(el)) && !insideBold(el)).length
}

export function isRich(summary: HtmlSummary | null): boolean {
  if (!summary) return false
  return Object.values(summary).some(n => n > 0)
}

export type ConvertMode = 'smart' | 'always' | 'never'

/** What the paste decision looks at, besides the element counts. */
export interface PasteShape {
  summary: HtmlSummary
  /** Non-whitespace characters of visible text. */
  textChars: number
  tableRows: number
  tableCells: number
  /** Copied from a spreadsheet (Excel, Google Sheets): a table the user may want as plain cells. */
  spreadsheet: boolean
}

const SPREADSHEET_RE = /urn:schemas-microsoft-com:office:excel|google-sheets-html-origin|content="?Microsoft Excel/i

export function pasteShape(doc: Document, html: string): PasteShape {
  const text = (doc.body?.textContent ?? doc.documentElement?.textContent ?? '').replace(/\s+/g, '')
  return {
    summary: summarizeDocument(doc),
    textChars: text.length,
    tableRows: doc.querySelectorAll('tr').length,
    tableCells: doc.querySelectorAll('td, th').length,
    spreadsheet: SPREADSHEET_RE.test(html)
  }
}

/** Text around the pictures, below which a picture paste is "just an image". */
const INTERLEAVE_MIN_CHARS = 20

/** Smart mode (dogfood 11-07): convert by itself only where plain text loses what matters —
 *  pictures inside text, real tables, structured documents. Light formatting (a link, one list,
 *  one heading, code alone, a bare picture, spreadsheet cells) only offers the button. */
export function pasteDecision(shape: PasteShape, mode: ConvertMode): { action: 'auto' | 'offer' | 'none'; reason: string } {
  const s = shape.summary
  if (!isRich(s)) return { action: 'none', reason: '' }
  if (mode === 'never') return { action: 'offer', reason: '' }
  if (mode === 'always') return { action: 'auto', reason: 'always' }
  if (shape.spreadsheet) return { action: 'offer', reason: '' }
  if (s.images > 0 && shape.textChars >= INTERLEAVE_MIN_CHARS) return { action: 'auto', reason: 'interleave' }
  if (s.tables > 0 && shape.tableRows >= 2 && shape.tableCells >= 4) return { action: 'auto', reason: 'table' }
  const kinds = [s.headings, s.lists, s.tables, s.pres].filter(n => n > 0).length
  if (kinds >= 2 || s.headings >= 2) return { action: 'auto', reason: 'structure' }
  return { action: 'offer', reason: '' }
}

/** 「检测到网页内容：1 个标题、2 张图、1 个链接」 (zero counts left out). */
export function describeSummary(s: HtmlSummary): string {
  const parts: string[] = []
  if (s.headings) parts.push(t('nHeadings', s.headings))
  if (s.images) parts.push(t('nImages', s.images))
  if (s.links) parts.push(t('nLinks', s.links))
  if (s.lists) parts.push(t('nLists', s.lists))
  if (s.tables) parts.push(t('nTables', s.tables))
  if (s.pres) parts.push(t('nCodeBlocks', s.pres))
  if (s.bolds) parts.push(t('nBolds', s.bolds))
  return t('detected', parts.join(t('partSep')))
}

type ElementLike = { getAttribute(name: string): string | null }

// Dogfood D4: Feishu cards (and Tailwind pages) bold text with a CSS class or inline
// font-weight, not <b>/<strong>, so turndown alone drops it.
const BOLD_CLASS = /(?:^|[-_])(?:semi)?bold(?:er)?$/i
const BLOCK_SELECTOR = 'p, div, li, ul, ol, table, pre, blockquote, h1, h2, h3, h4, h5, h6, section, article, hr'
type NodeLike = ElementLike & { nodeName: string; parentNode: unknown; querySelector?(s: string): unknown }

/** 'bold' / 'normal' from an inline font-weight; null when the style does not say. */
function styleWeight(el: ElementLike): 'bold' | 'normal' | null {
  const m = /font-weight\s*:\s*([a-z0-9]+)/i.exec(el.getAttribute('style') || '')
  if (!m) return null
  const v = m[1].toLowerCase()
  return v === 'bold' || v === 'bolder' || (/^\d+$/.test(v) && Number(v) >= 600) ? 'bold' : 'normal'
}

function isTagBold(node: NodeLike): boolean {
  return (node.nodeName === 'B' || node.nodeName === 'STRONG') && styleWeight(node) !== 'normal'
}

/** A non-<b> element styled bold that holds only inline content (bolding blocks breaks Markdown). */
/** Headings and header cells are bold by nature; a bold class or style on them (or inside them)
 *  is not emphasis (dogfood 11-10: Tailwind's font-bold turned React docs' headings into **…**). */
const BOLD_BY_NATURE = /^(H[1-6]|TH|DT|SUMMARY)$/
function inBoldByNature(node: NodeLike): boolean {
  for (let p: NodeLike | null = node; p && typeof p.nodeName === 'string'; p = p.parentNode as NodeLike | null) {
    if (BOLD_BY_NATURE.test(p.nodeName)) return true
  }
  return false
}

function isCssBold(node: NodeLike): boolean {
  if (node.nodeName === 'B' || node.nodeName === 'STRONG' || typeof node.getAttribute !== 'function') return false
  if (inBoldByNature(node)) return false
  const weight = styleWeight(node)
  const bold = weight ? weight === 'bold' : (node.getAttribute('class') || '').split(/\s+/).some(t => BOLD_CLASS.test(t))
  return bold && !node.querySelector?.(BLOCK_SELECTOR)
}

function insideBold(node: NodeLike): boolean {
  for (let p = node.parentNode as NodeLike | null; p && typeof p.getAttribute === 'function'; p = p.parentNode as NodeLike | null) {
    if (isTagBold(p) || isCssBold(p)) return true
  }
  return false
}

const strong = (content: string) => (content.trim() ? `**${content}**` : '')

/** The image URL an <img> really shows: lazy-loading pages keep it in data-src. */
export function imageSource(node: ElementLike): string {
  const src = (node.getAttribute('src') || '').trim()
  const lazy = (node.getAttribute('data-src') || node.getAttribute('data-original') || '').trim()
  if (lazy && /^https?:/i.test(lazy) && (!src || /^data:image\/(gif|svg)/i.test(src))) return lazy
  return src || lazy
}

function imageAlt(node: ElementLike): string {
  return (node.getAttribute('alt') || node.getAttribute('title') || '').replace(/\s+/g, ' ').trim()
}

// ---- tables (dogfood 11-08): every data table becomes a Markdown table; layout tables become text ----

type TableNode = ElementLike & { nodeName: string; parentNode: TableNode | null; children: ArrayLike<TableNode>; textContent: string | null; querySelector?: (s: string) => unknown }
const CELL = '\u001f'
const ROW = '\u001e'
const tagOf = (n: TableNode | null) => (n ? n.nodeName.toUpperCase() : '')
function closestTable(node: TableNode): TableNode | null {
  let n = node.parentNode
  while (n && tagOf(n) !== 'TABLE') n = n.parentNode
  return n
}
function ownRows(table: TableNode): TableNode[] {
  const rows: TableNode[] = []
  for (const child of Array.from(table.children)) {
    if (tagOf(child) === 'TR') rows.push(child)
    else if (['THEAD', 'TBODY', 'TFOOT'].includes(tagOf(child))) rows.push(...Array.from(child.children).filter(r => tagOf(r) === 'TR'))
  }
  return rows
}
const ownCells = (row: TableNode) => Array.from(row.children).filter(c => ['TD', 'TH'].includes(tagOf(c)))
/** Tables used for page layout (tables inside, or a single column): their cells are text blocks. */
function isLayoutTable(table: TableNode | null): boolean {
  if (!table) return true
  if (table.querySelector?.('table')) return true
  return ownRows(table).every(row => ownCells(row).length <= 1)
}
const ALIGN: Record<string, string> = { left: ':--', right: '--:', center: ':-:' }

function addTableRules(service: TurndownService) {
  service.addRule('rich-paste-table-section', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: content => content
  })
  service.addRule('rich-paste-table-caption', {
    filter: 'caption',
    replacement: (content, node) => (isLayoutTable(closestTable(node as unknown as TableNode)) ? `\n\n${content}\n\n` : '')
  })
  service.addRule('rich-paste-table-cell', {
    filter: ['th', 'td'],
    replacement: (content, node) => {
      const el = node as unknown as TableNode
      if (isLayoutTable(closestTable(el))) return `\n\n${content}\n\n`
      const text = content.replace(/[\u001e\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
      const span = Math.min(Math.max(Number(el.getAttribute('colspan')) || 1, 1), 50)
      return CELL + text + CELL.repeat(span - 1)
    }
  })
  service.addRule('rich-paste-table-row', {
    filter: 'tr',
    replacement: (content, node) => (isLayoutTable(closestTable(node as unknown as TableNode)) ? content : ROW + content)
  })
  service.addRule('rich-paste-table', {
    filter: 'table',
    replacement: (content, node) => {
      const table = node as unknown as TableNode
      if (isLayoutTable(table)) return `\n\n${content}\n\n`
      const rows = content.split(ROW).slice(1).map(row => row.split(CELL).slice(1).map(cell => cell.trim()))
      if (!rows.length) return content
      const width = Math.max(...rows.map(r => r.length))
      const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
      const head = ownCells(ownRows(table)[0])
      const rule = Array.from({ length: width }, (_, i) => ALIGN[(head[i]?.getAttribute('align') || '').toLowerCase()] ?? '---')
      const caption = Array.from(table.children).find(c => tagOf(c) === 'CAPTION')
      const title = caption ? (caption.textContent || '').replace(/\s+/g, ' ').trim() : ''
      return `\n\n${title ? `**${title}**\n\n` : ''}${[line(rows[0]), line(rule), ...rows.slice(1).map(line)].join('\n')}\n\n`
    }
  })
}

/** Code-block language from the block or its near ancestors: `language-js`, `lang-go`,
 *  Sphinx's `highlight-python3`, GitHub's `highlight-source-rust`. Empty when none says. */
const LANG_CLASS = /(?:^|\s)(?:language|lang|highlight(?:-source)?)-([A-Za-z0-9_+#.-]+)/
const NO_LANGUAGE = new Set(['default', 'none', 'text', 'plain', 'plaintext', 'nohighlight', 'output'])
function codeLanguage(start: ElementLike): string {
  let node = start as ElementLike & { parentNode?: unknown }
  for (let depth = 0; node && depth < 4; depth++) {
    const match = LANG_CLASS.exec(node.getAttribute?.('class') || '')
    if (match) {
      const lang = match[1].toLowerCase().replace(/^python3$|^pycon$|^py$/, 'python')
      return NO_LANGUAGE.has(lang) ? '' : lang
    }
    node = node.parentNode as ElementLike & { parentNode?: unknown }
  }
  return ''
}

/** turndown escapes `-` `+` `=` `>` `#` at the start of every text node, as if each began a line;
 *  mid-line they mean nothing, so `**下载** \- 得益于` (少数派, dogfood 11-10) keeps only the `-`.
 *  Line starts (after quote/list markers), code fences and inline code are left alone. A backslash the
 *  page itself had was escaped to a double backslash by turndown, so every `\-` here is turndown's own. */
function midLineUnescape(md: string): string {
  let fence = ''
  return md.split('\n').map(line => {
    const f = /^\s*(?:>\s?)*(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (!fence) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = ''
      return line
    }
    if (fence) return line
    const lead = /^\s*(?:>\s?)*(?:(?:[-+*]|\d+[.)])\s+)?(?:#{1,6}\s+)?/.exec(line)![0].length
    let at = lead
    return line.slice(0, lead) + line.slice(lead).split(/(`+[^`]*`+)/).map((part, i) => {
      const start = at
      at += part.length
      if (i % 2) return part
      return part.replace(/(?<!\\)\\([-+=>#])/g, (m, ch, offset) => (start + offset > lead ? ch : m))
    }).join('')
  }).join('\n')
}

function createService(onImage: (src: string, alt: string) => string): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined'
  })
  // GFM minus its tables: those keep a headerless table as raw HTML (security F8) and break on
  // multi-line cells; the table rules below handle every table (dogfood 11-08, real sites).
  service.use([highlightedCodeBlock, strikethrough, taskListItems])
  addTableRules(service)
  // dogfood 11-10 (docs.python.org): Sphinx/Pygments highlight a <pre> of <span>s with no <code>
  // inside; turndown only fences <pre><code>, so the code came out as escaped prose (`a \= [...]`).
  service.addRule('rich-paste-bare-pre', {
    filter: node => node.nodeName === 'PRE' && node.firstElementChild?.nodeName !== 'CODE',
    replacement: (_content, node) => {
      const text = (node.textContent || '').replace(/^\n+|\s+$/g, '')
      const longest = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length))
      const fence = '`'.repeat(Math.max(3, longest + 1))
      const code = (node as unknown as { querySelector(s: string): ElementLike | null }).querySelector('code')
      return `\n\n${fence}${codeLanguage(code ?? (node as unknown as ElementLike)) || codeLanguage(node as unknown as ElementLike)}\n${text}\n${fence}\n\n`
    }
  })
  // 取舍 (dogfood 11-10, apple.com.cn): text kept for screen readers only repeated visible text
  // («iPhone Duo iPhone Duo»); a copy is about what the page shows.
  service.addRule('rich-paste-screen-reader-only', {
    filter: node => /(?:^|\s)(?:sr-only|visually-?hidden|screen-reader-text|a11y-hidden)(?:\s|$)/i.test((node as unknown as ElementLike).getAttribute?.('class') || ''),
    replacement: () => ''
  })
  service.remove(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'iframe', 'svg', 'button', 'input'] as never)
  // turndown tries the LAST added rule first: this general one goes first so the link rules below win.
  // Inline links as turndown writes them, minus a title that only repeats the link text.
  service.addRule('rich-paste-link', {
    filter: node => node.nodeName === 'A' && !!(node as unknown as ElementLike).getAttribute('href'),
    replacement: (content, node) => {
      const el = node as unknown as ElementLike
      // A script link is not a destination; the model and the chat get its text (dogfood 11-10, arXiv).
      if (/^\s*(?:javascript|vbscript):/i.test(el.getAttribute('href') || '')) return content
      const href = (el.getAttribute('href') || '').replace(/([()])/g, '\\$1')
      const raw = (el.getAttribute('title') || '').replace(/\s+/g, ' ').trim()
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim()
      const title = raw && raw !== text ? ` "${raw.replace(/"/g, '\\"')}"` : ''
      // A card link around a heading (Cloudflare blog, BBC; dogfood 11-10): `[## t](u)` is no heading,
      // so the heading carries the link and the rest of the card stays as blocks below it.
      const heading = /^(#{1,6}) (.+)$/m.exec(content)
      if (heading) {
        const linked = content.replace(heading[0], `${heading[1]} [${heading[2].trim()}](${href}${title})`)
        return `\n\n${linked.trim()}\n\n`
      }
      // Block content inside a link (a card linking to a profile) would split it over blank lines.
      return `[${content.replace(/\s*\n+\s*/g, ' ').trim()}](${href}${title})`
    }
  })
  // turndown pads bullets to `-   item`; write `- item` / `1. item`, nested lines indented to match.
  service.addRule('rich-paste-list-item', {
    filter: 'li',
    replacement: (content, node) => {
      const parent = node.parentNode as unknown as (ElementLike & { nodeName: string; children: ArrayLike<unknown> }) | null
      let prefix = '- '
      if (parent && parent.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start'))
        const index = Array.prototype.indexOf.call(parent.children, node)
        prefix = `${(Number.isFinite(start) && start > 0 ? start : 1) + index}. `
      }
      const indent = ' '.repeat(prefix.length)
      const body = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n(?=[^\n])/g, `\n${indent}`)
      return prefix + body + (node.nextSibling && !/\n$/.test(body) ? '\n' : '')
    }
  })
  // Heading permalink anchors (GitHub's `<a class="anchor"><svg/></a>`) have no text: drop them.
  service.addRule('rich-paste-empty-link', {
    filter: node => node.nodeName === 'A' && !(node.textContent || '').trim() && !(node as unknown as Element).querySelector?.('img'),
    replacement: () => ''
  })
  // 11-08 (Wikipedia): a link around nothing but an image (a thumbnail linking to its file page)
  // becomes the image alone — Desktop renders a web link as its label and drops an image inside it.
  service.addRule('rich-paste-image-link', {
    filter: node => node.nodeName === 'A' && !(node.textContent || '').trim() && !!(node as unknown as Element).querySelector?.('img'),
    replacement: content => content
  })
  // 11-08: a citation marker links to a note that is not in the paste: keep its text ([30]) only.
  service.addRule('rich-paste-citation', {
    filter: node => node.nodeName === 'A' && /#cite_note-/.test((node as unknown as ElementLike).getAttribute('href') || ''),
    replacement: content => content
  })
  // D4: CSS-styled bold → **…**; <b>/<strong> nested in bold do not double up; a
  // normal-weight <b> (Google Docs wraps whole documents in one) is not bold.
  service.addRule('rich-paste-strong', {
    filter: node => node.nodeName === 'B' || node.nodeName === 'STRONG',
    replacement: (content, node) => (isTagBold(node as unknown as NodeLike) && !insideBold(node as unknown as NodeLike) ? strong(content) : content)
  })
  service.addRule('rich-paste-css-bold', {
    filter: node => isCssBold(node as unknown as NodeLike) && !insideBold(node as unknown as NodeLike),
    replacement: content => strong(content)
  })
  // D4: turndown escapes every [ ] and _, so 「[推断]」 reaches the model as 「\[推断\]」. Keep
  // brackets literal unless the text would form a link ([a](b), [a][b], [a]: b), and keep
  // underscores inside words (snake_case cannot start emphasis in CommonMark).
  const baseEscape = service.escape.bind(service)
  service.escape = (text: string) => {
    let out = baseEscape(text)
    if (!/\][(\[:]/.test(text)) out = out.replace(/\\([[\]])/g, '$1')
    return out.replace(/(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, '_')
  }
  service.addRule('rich-paste-image', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as unknown as ElementLike
      const src = imageSource(el)
      if (!src) return ''
      return onImage(src, imageAlt(el))
    }
  })
  return service
}

/** HTML the converter refuses (dogfood D3): bigger than this, or with more elements. */
export const MAX_HTML_BYTES = 512 * 1024
export const MAX_HTML_ELEMENTS = 20000

/** True when pasted HTML is too large to convert; checked before any hint or conversion. */
export function isTooLarge(html: string, doc?: { getElementsByTagName(name: string): { length: number } }): boolean {
  if (new TextEncoder().encode(html || '').length > MAX_HTML_BYTES) return true
  return !!doc && doc.getElementsByTagName('*').length > MAX_HTML_ELEMENTS
}

const SLOT_OPEN = '\uE000'
const SLOT_CLOSE = '\uE001'
const SLOT_RE = /\uE000(\d+)\uE001/g

export interface Converted {
  /** Markdown with one private-use placeholder per image, in output order. */
  markdown: string
  images: { src: string; alt: string }[]
}

/** One turndown pass: Markdown plus the images it contains, in output order (D3). */
export function convertHtml(html: string): Converted {
  const images: { src: string; alt: string }[] = []
  const markdown = createService((src, alt) => {
    images.push({ src, alt })
    return `${SLOT_OPEN}${images.length - 1}${SLOT_CLOSE}`
  }).turndown(html || '')
  return { markdown: quietRefs(midLineUnescape(markdown)), images }
}

/** Image sources in the order they appear in the converted Markdown. */
export function extractImageSources(html: string): string[] {
  return convertHtml(html).images.map(image => image.src)
}

/** Target for an image that was not saved: its http(s) URL; a short placeholder for an inline
 *  `data:` image (never hundreds of KB of base64 in the draft); and a placeholder for anything
 *  else (`/Users/…`, `file:`, `blob:`, relative) so pasted HTML never names a local path (D2). */
function keptTarget(src: string): string {
  if (/^https?:\/\//i.test(src)) return src
  return /^data:/i.test(src) ? t('unsavedInlineImage') : t('notDownloadedImage')
}

/**
 * Fill the image placeholders: `imageMap[src]` is the downloaded local path; other images
 * keep their http(s) URL or get a placeholder (U-BEH-3, D2).
 */
/** Why a web image was not downloaded: the user's count or size limit (no note = it failed). */
export type SkipReason = 'count' | 'size' | 'small'

/** 取舍 (dogfood 11-10, 少数派): a page's avatars and icons came along as 22 of 29 images. An image
 *  no bigger than this on both sides is left out when the same paste has a real picture. */
export const SMALL_IMAGE_PX = 96
export function smallImages(sizes: Record<string, number[] | undefined>, kept: string[]): string[] {
  const small = kept.filter(src => { const s = sizes[src]; return !!s && s.length === 2 && Math.max(s[0], s[1]) <= SMALL_IMAGE_PX })
  return small.length < kept.length ? small : []
}

/** Link text for an image that did not arrive; the reason is for the model as much as the user. */
export function missedImageLabel(reason?: SkipReason): string {
  return reason === 'count' ? t('missedCount') : reason === 'size' ? t('missedSize') : t('missedFailed')
}

export function fillImages(converted: Converted, imageMap: Record<string, string> = {}, notes: Record<string, SkipReason> = {}): string {
  return converted.markdown
    .replace(SLOT_RE, (_m, i) => {
      const image = converted.images[Number(i)]
      const local = imageMap[image.src]
      if (local) return markerFor(image.alt, local)
      if (notes[image.src] === 'small') return ''
      // dogfood 11-07: a web image that did not arrive is a plain link that says so, not image syntax
      // (the model would think a picture was attached; the preview would show a broken image).
      if (/^https?:\/\//i.test(image.src)) return linkFor(missedImageLabel(notes[image.src]), image.alt, image.src)
      return markerFor(image.alt, keptTarget(image.src))
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Convert clipboard HTML to Markdown in one pass (see convertHtml / fillImages). */
export function htmlToMarkdown(html: string, imageMap: Record<string, string> = {}): string {
  return fillImages(convertHtml(html), imageMap)
}
