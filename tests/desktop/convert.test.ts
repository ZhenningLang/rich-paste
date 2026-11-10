// QA5 (U-ACC-4): snapshot tests over real page sections in tests/convert/.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import domino from '@mixmark-io/domino'

import {
  convertHtml, describeSummary, extractImageSources, fillImages, htmlToMarkdown, imageSource, isRich, isTooLarge,
  MAX_HTML_BYTES, MAX_HTML_ELEMENTS, summarizeDocument
} from '../../desktop/src/convert.ts'
import { quietRefs } from '../../desktop/src/markers.ts'
import { setLocale } from '../../desktop/src/i18n.ts'

setLocale('zh') // these tests pin the Chinese strings; english.test.ts covers English

const DIR = new URL('../convert/', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, DIR), 'utf8')
const local = (i: number) => `/Users/me/.hermes/cache/rich-paste/20261106/img${i + 1}.webp`

/** First two images are "downloaded" (local path); the rest keep their URL. */
function imageMap(html: string) {
  const map: Record<string, string> = {}
  extractImageSources(html).slice(0, 2).forEach((src, i) => { map[src] = local(i) })
  return map
}

const fixtures = readdirSync(DIR).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, ''))

test('at least three real page fixtures', () => {
  assert.ok(fixtures.length >= 3, fixtures.join(','))
})

for (const name of fixtures) {
  test(`snapshot: ${name}`, () => {
    const html = read(`${name}.html`)
    assert.equal(htmlToMarkdown(html, imageMap(html)) + '\n', read(`${name}.md`))
  })
}

test('go blog: heading levels, inline code link, fenced code with language', () => {
  const md = htmlToMarkdown(read('tech-blog-go-pgo.html'))
  assert.match(md, /^## Example$/m)
  assert.match(md, /^### Set up$/m)
  assert.match(md, /\[`gitlab\.com\/golang-commonmark\/markdown`\]\(https:\/\/pkg\.go\.dev\/gitlab\.com\/golang-commonmark\/markdown\)/)
  assert.match(md, /^```go\npackage main$/m)
})

test('github readme: tables, no empty heading anchors', () => {
  const md = htmlToMarkdown(read('github-readme-turndown.html'))
  assert.match(md, /^\| Option \| Valid values \| Default \|$/m)
  assert.match(md, /^### Advanced Options$/m)
  assert.doesNotMatch(md, /\[\]\(/)
})

test('chinese news: quote, links, image order with local paths then URLs', () => {
  const html = read('zh-news-ruanyf-weekly-321.html')
  const md = htmlToMarkdown(html, imageMap(html))
  const targets = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1])
  assert.deepEqual(targets, [local(0), local(1)], 'only downloaded images keep image syntax')
  const missed = [...md.matchAll(/\[图片下载失败(?:：[^\]]*)?\]\(([^)]+)\)/g)].map(m => m[1])
  assert.deepEqual(missed, extractImageSources(html).slice(2))
  assert.match(md, /^> 1978年生于江西景德镇/m)
  assert.match(md, /\[百度百科\]\(https:\/\/money\.163\.com\/baike\/fusheng\/\)/)
  assert.match(md, /^### 一、金山毒霸时期$/m)
})

test('alt text with brackets/newlines is sanitised; spaced paths are percent-encoded', () => {
  const md = htmlToMarkdown('<p>a<img src="https://x/a.png" alt="审核 [流程]\n图"></p>', { 'https://x/a.png': '/My Cache/a.png' })
  assert.equal(md, 'a![审核 流程 图](/My%20Cache/a.png)')
})

test('D2: non-http(s) image sources never become path markers', () => {
  for (const src of ['/Users/me/secret.png', 'file:///Users/me/secret.png', 'blob:https://x/1', 'img/rel.png']) {
    assert.equal(htmlToMarkdown(`<p>x<img src="${src}" alt="a"></p>`), 'x![a](未下载的图片)', src)
  }
})

test('D2: an injected src (&gt; and a closing paren) stays one URL marker', () => {
  const html = '<p><img src="https://x.test/a.png) ![x](/Users/me/.ssh/id.png&gt;" alt="a"></p>'
  const md = htmlToMarkdown(html)
  assert.equal(md, '[图片下载失败：a](https://x.test/a.png%29%20!%5Bx%5D%28/Users/me/.ssh/id.png%3E)')
  assert.doesNotMatch(md, /\]\(\/Users/)
})

test('D3: one turndown pass gives Markdown with image slots and the images in order', () => {
  const converted = convertHtml('<p>a<img src="https://x/1.png" alt="一">b<img src="https://x/2.png" alt="二"></p>')
  assert.deepEqual(converted.images, [{ src: 'https://x/1.png', alt: '一' }, { src: 'https://x/2.png', alt: '二' }])
  assert.equal(fillImages(converted, { 'https://x/2.png': '/c/2.png' }), 'a[图片下载失败：一](https://x/1.png)b![二](/c/2.png)')
})

test('D3: oversized HTML (bytes or elements) is refused', () => {
  assert.equal(isTooLarge('<p>small</p>'), false)
  assert.equal(isTooLarge('x'.repeat(MAX_HTML_BYTES + 1)), true)
  assert.equal(isTooLarge('<b>多</b>'.repeat(MAX_HTML_BYTES / 8)), true, 'counted in UTF-8 bytes')
  const many = domino.createDocument('<i></i>'.repeat(MAX_HTML_ELEMENTS + 1)) as unknown as Document
  assert.equal(isTooLarge('<p></p>', many), true)
  const few = domino.createDocument('<i></i>'.repeat(10)) as unknown as Document
  assert.equal(isTooLarge('<p></p>', few), false)
})

test('lazy images use data-src over a placeholder', () => {
  const el = { getAttribute: (k: string) => ({ src: 'data:image/gif;base64,R0lG', 'data-src': 'https://x/real.png' } as Record<string, string>)[k] ?? null }
  assert.equal(imageSource(el), 'https://x/real.png')
  assert.deepEqual(extractImageSources('<img src="data:image/png;base64,AAAA"><img alt="x">'), ['data:image/png;base64,AAAA'])
})

test('lists: tight markers, ordered start, nested indent', () => {
  const md = htmlToMarkdown('<ul><li>一<ul><li>深</li></ul></li><li>二</li></ul><ol start="9"><li>九</li><li>十</li></ol>')
  assert.equal(md, '- 一\n  - 深\n- 二\n\n9. 九\n10. 十')
})

test('scripts and styles are dropped', () => {
  assert.equal(htmlToMarkdown('<style>p{}</style><script>x()</script><p>hi</p>'), 'hi')
})

test('summary detects structure; plain paragraphs are not rich', () => {
  const doc = (html: string) => domino.createDocument(html) as unknown as Document
  const s = summarizeDocument(doc('<h2>t</h2><p><a href="https://a">l</a><img src="x"><img src="y"></p>'))
  assert.ok(isRich(s))
  assert.equal(describeSummary(s), '检测到网页内容：1 个标题、2 张图、1 个链接')
  assert.equal(isRich(summarizeDocument(doc('<p>just plain text</p><a>no href</a>'))), false)
  assert.ok(isRich(summarizeDocument(doc('<table><tr><td>1</td></tr></table>'))))
  assert.ok(isRich(summarizeDocument(doc('<pre>code</pre>'))))
  assert.ok(isRich(summarizeDocument(doc('<ol><li>a</li></ol>'))))
  assert.equal(isRich(null), false)
})

test('B nit: an unsaved data: image becomes a short placeholder, not base64 in the draft', () => {
  const data = 'data:image/png;base64,' + 'A'.repeat(5000)
  assert.equal(htmlToMarkdown(`<p>x<img src="${data}" alt="内嵌"></p>`), 'x![内嵌](内嵌图片未保存)')
  assert.equal(htmlToMarkdown(`<p>x<img src="${data}" alt="内嵌"></p>`, { [data]: '/c/a.png' }), 'x![内嵌](/c/a.png)')
})

test('dogfood D4: Feishu card bold (class / inline style) becomes **bold**', () => {
  const md = htmlToMarkdown(read('feishu-card-bold-class.html'))
  assert.match(md, /^\*\*本周摘要\*\*/)
  assert.match(md, /^- \*\*新版发布 3 项改动\*\*｜评分/m)
  assert.equal(htmlToMarkdown('<p><span style="font-weight: 700">重</span>轻</p>'), '**重**轻')
  assert.equal(htmlToMarkdown('<p><span style="font-weight:bold">重</span></p>'), '**重**')
  assert.equal(htmlToMarkdown('<p><span class="font-semibold">半粗</span></p>'), '**半粗**')
})

test('dogfood D4: bold-looking class names that are not bold stay plain', () => {
  assert.equal(htmlToMarkdown('<p><span class="boldness-meter">x</span><span class="unbold">y</span></p>'), 'xy')
  assert.equal(htmlToMarkdown('<p><span style="font-weight: 400" class="text--bold">普</span></p>'), '普')
})

test('dogfood D4: no double bold, no bold around blocks, Google Docs normal-weight <b> wrapper', () => {
  assert.equal(htmlToMarkdown('<p><strong><span class="x--bold">一</span></strong></p>'), '**一**')
  assert.equal(htmlToMarkdown('<div class="card--bold"><p>段一</p><p>段二</p></div>'), '段一\n\n段二')
  assert.equal(htmlToMarkdown('<b style="font-weight:normal;" id="docs-internal-guid-1"><p>正文</p><p><span style="font-weight:700">粗</span></p></b>'), '正文\n\n**粗**')
})

test('dogfood D4: brackets and intraword underscores are not escaped unless they would form Markdown', () => {
  assert.equal(htmlToMarkdown('<p>能跑 [推断]Zen 见 config_file</p>'), '能跑 [推断]Zen 见 config_file')
  assert.equal(htmlToMarkdown('<p>字面 [a](b) 与 [c]: d</p>'), '字面 \\[a\\](b) 与 \\[c\\]: d')
  assert.equal(htmlToMarkdown('<p>_lead and trail_</p>'), '\\_lead and trail\\_')
  assert.equal(htmlToMarkdown('<p>* 星号开头</p>'), '\\* 星号开头')
})

test('dogfood 11-07: an image that was not downloaded becomes a plain link that says so', () => {
  const html = '<p>a<img src="https://x/ok.png" alt="好">b<img src="https://x/404.png" alt="坏 [图]">c<img src="https://x/many.png" alt="">d</p>'
  const converted = convertHtml(html)
  const md = fillImages(converted, { 'https://x/ok.png': '/c/ok.png' }, { 'https://x/many.png': 'count' })
  assert.equal(md, 'a![好](/c/ok.png)b[图片下载失败：坏 图](https://x/404.png)c[图片未下载（超出张数上限）](https://x/many.png)d')
  const big = fillImages(converted, { 'https://x/ok.png': '/c/ok.png' }, { 'https://x/404.png': 'size' })
  assert.match(big, /\[图片未下载（超出单张大小上限）：坏 图\]\(https:\/\/x\/404\.png\)/)
  assert.doesNotMatch(md, /!\[[^\]]*\]\(https/, 'no image syntax pointing at the web')
})

test('dogfood 11-07: bold text counts as light formatting (offer only); code-editor copies do not', () => {
  const doc = (html: string) => domino.createDocument(html) as unknown as Document
  const feishu = '<div style="font-weight: 400;"><span class="text-bold" style="font-weight: 700;">机会</span></div><div><span class="title-semibold" style="font-weight: 600;">1. 插件</span>：说明</div><div>普通 <b>加粗</b> 与 <strong>强调</strong></div>'
  const s = summarizeDocument(doc(feishu))
  assert.equal(s.bolds, 4)
  assert.ok(isRich(s))
  assert.equal(describeSummary(s), '检测到网页内容：4 处加粗')
  const nested = summarizeDocument(doc('<p><b>外<strong>内</strong></b></p>'))
  assert.equal(nested.bolds, 1, 'a bold run inside bold counts once')
  const vscode = '<div style="color: #d4d4d4;font-family: Menlo, monospace;white-space: pre;"><div><span style="color: #569cd6;font-weight: bold;">const</span> a = 1</div></div>'
  assert.equal(summarizeDocument(doc(vscode)).bolds, 0)
  assert.equal(isRich(summarizeDocument(doc(vscode))), false)
})

test('dogfood 11-08 (Wikipedia): an image wrapped in a link stays an image; Desktop drops images inside links', () => {
  const html = '<figure><a href="https://zh.wikipedia.org/wiki/File:Panda.jpg" class="mw-file-description"><img src="https://upload.wikimedia.org/p.jpg" alt="大熊猫"></a><figcaption>苏琳</figcaption></figure>'
  const filled = fillImages(convertHtml(html), { 'https://upload.wikimedia.org/p.jpg': '/c/p.jpg' })
  assert.match(filled, /^!\[大熊猫\]\(\/c\/p\.jpg\)\n\n苏琳$/)
  assert.doesNotMatch(htmlToMarkdown(html), /File:Panda/, 'not downloaded: the image link, without the file page around it')
  // A link with words next to its image keeps the link.
  const worded = '<a href="https://h.test/x"><img src="https://h.test/i.png" alt="i">文档</a>'
  assert.equal(fillImages(convertHtml(worded), { 'https://h.test/i.png': '/c/i.png' }), '[![i](/c/i.png)文档](https://h.test/x)')
})

test('dogfood 11-08 (Wikipedia): a title equal to the link text is dropped; citation links keep only their number', () => {
  assert.equal(htmlToMarkdown('<p><a href="https://zh.wikipedia.org/wiki/A" title="阿尔芒·戴维">阿尔芒·戴维</a></p>'), '[阿尔芒·戴维](https://zh.wikipedia.org/wiki/A)')
  assert.equal(htmlToMarkdown('<p><a href="https://h.test/a" title="更多说明">文档</a></p>'), '[文档](https://h.test/a "更多说明")')
  assert.equal(htmlToMarkdown('<p>大熊猫<sup class="reference"><a href="https://zh.wikipedia.org/zh-cn/x#cite_note-31">[30]</a></sup>。</p>'), '大熊猫[30]。')
})

test('dogfood 11-08 (real sites): a table without a header row becomes a Markdown table, never raw HTML', () => {
  const md = htmlToMarkdown('<table><tbody><tr><td><b>A real terminal</b></td><td>Full TUI</td></tr><tr><td>Lives where you do</td><td>Telegram, Discord</td></tr></tbody></table>')
  assert.equal(md, '| **A real terminal** | Full TUI |\n| --- | --- |\n| Lives where you do | Telegram, Discord |')
  assert.doesNotMatch(md, /<t[dr]|<table/)
})

test('dogfood 11-08 (Wikipedia infobox): caption, colspan, multi-line cells and pipes stay one table', () => {
  const html = '<table class="infobox"><caption>萬里长城</caption><tbody>'
    + '<tr><th colspan="2">世界遗产</th></tr>'
    + '<tr><th>位置</th><td><p>中国</p><p>北方</p></td></tr>'
    + '<tr><th>标准</th><td>a | b</td></tr></tbody></table>'
  assert.equal(htmlToMarkdown(html), '**萬里长城**\n\n| 世界遗产 |  |\n| --- | --- |\n| 位置 | 中国 北方 |\n| 标准 | a \\| b |')
})

test('dogfood 11-08 (Hacker News): a layout table (tables inside, or one column) is laid out as text, not as a table', () => {
  const html = '<table id="hnmain"><tr><td><table><tr><td>1.</td><td><a href="https://a.test/">Story one</a></td></tr><tr><td>2.</td><td><a href="https://b.test/">Story two</a></td></tr></table></td></tr><tr><td><p>Footer text</p></td></tr></table>'
  const md = htmlToMarkdown(html)
  assert.match(md, /^\| 1\. \| \[Story one\]\(https:\/\/a\.test\/\) \|\n\| --- \| --- \|\n\| 2\. \| \[Story two\]\(https:\/\/b\.test\/\) \|\n\nFooter text$/)
  assert.equal(htmlToMarkdown('<table><tr><td><p>只有一列</p></td></tr><tr><td><p>第二行</p></td></tr></table>'), '只有一列\n\n第二行')
})

test('dogfood 11-08 (sspai): a link around block content stays one link on one line', () => {
  assert.equal(htmlToMarkdown('<a href="https://sspai.com/u/wsine"><div><p>正弦定理</p><p>少数派作者</p></div></a>'), '[正弦定理 少数派作者](https://sspai.com/u/wsine)')
})

// 11-08: Hermes expands @diff / @file: / @url: in a sent message (agent/context_references.py).
// Text from a pasted page must not trigger it; a WORD JOINER after the @ keeps it from matching.
test('page text never becomes a Hermes @ reference', () => {
  const html = '<p>看 @diff 和 @staged，@file:/etc/hosts、@url:http://x.test/a 还有 @todo:abc</p>'
    + '<p>邮箱 a@diff.com，<a href="https://medium.com/@me/post">文章</a>，@alice 你好，@difference</p>'
    + '<img src="https://x.test/a.png" alt="@file:secret">'
  const { markdown } = convertHtml(html)
  for (const ref of ['diff', 'staged', 'file:', 'url:', 'todo:']) assert.ok(markdown.includes(`@⁠${ref}`), ref)
  assert.ok(markdown.includes('a@diff.com'))
  assert.ok(markdown.includes('https://medium.com/@me/post'))
  assert.ok(markdown.includes('@alice') && markdown.includes('@difference'))
  const filled = fillImages(convertHtml(html), { 'https://x.test/a.png': '/c/rich-paste-cache/20261108/a.png' })
  assert.ok(filled.includes('![@⁠file:secret]('), filled)
  assert.equal(quietRefs(quietRefs('@diff')), '@⁠diff')
})

test('dogfood 11-10 sweep: a <pre> wrapping <pre><code class="language-x"> (mdBook) keeps the language', () => {
  const md = htmlToMarkdown('<pre><pre class="playground"><code class="language-rust edition2021 hljs"><span class="hljs-keyword">let</span> x: u32 = 1;</code></pre></pre>')
  assert.equal(md, '```rust\nlet x: u32 = 1;\n```')
})

test('dogfood 11-10 sweep: a heading styled bold (Tailwind font-bold, inline font-weight) stays a heading, not **bold**', () => {
  assert.equal(htmlToMarkdown('<h1 class="mx-0 font-display font-bold">Quick Start</h1><p>正文</p>'), '# Quick Start\n\n正文')
  assert.equal(htmlToMarkdown('<h2 style="font-weight:700"><span class="font-semibold">二级标题</span></h2>'), '## 二级标题')
  assert.equal(htmlToMarkdown('<p>普通 <span class="font-bold">加粗</span></p>'), '普通 **加粗**')
})

test('dogfood 11-10 sweep: script links (arXiv\'s javascript:setMathjaxCookie()) keep only their text', () => {
  assert.equal(htmlToMarkdown('<p>看 <a href="javascript:setMathjaxCookie()">MathJax 开关</a> 和 <a href="https://x.test/a">文档</a></p>'),
    '看 MathJax 开关 和 [文档](https://x.test/a)')
  assert.equal(htmlToMarkdown('<p><a href=" JavaScript:alert(1)">点</a><a href="vbscript:x">我</a></p>'), '点我')
})

test('dogfood 11-10 sweep: a card link around a heading (Cloudflare blog, BBC) becomes a heading with the link inside', () => {
  assert.equal(htmlToMarkdown('<time>November 9, 2026</time><a href="https://blog.x.test/fund/"><h2>Launching the Fund</h2></a><p>摘要</p>'),
    'November 9, 2026\n\n## [Launching the Fund](https://blog.x.test/fund/)\n\n摘要')
  assert.equal(htmlToMarkdown('<a href="https://x.test/n"><div><h3>标题</h3><p>导语一句</p></div></a>'),
    '### [标题](https://x.test/n)\n\n导语一句')
})

test('dogfood 11-10 sweep: list/quote/heading markers are escaped only where they could start a block', () => {
  // 少数派 writes `<strong>下载 feishu2md </strong>-<strong> </strong>得益于`: the `-` is a text node of its own.
  assert.equal(htmlToMarkdown('<p><strong>下载 feishu2md </strong>-<strong> </strong>得益于</p>'), '**下载 feishu2md** - 得益于')
  assert.equal(htmlToMarkdown('<p><b>a</b>+<b>b</b>=<i>c</i> <span>#话题</span><span>&gt; 号</span></p>'), '**a**+**b**=*c* #话题> 号')
  assert.equal(htmlToMarkdown('<p>- 不是列表</p><p># 不是标题</p><p>&gt; 不是引用</p>'), '\\- 不是列表\n\n\\# 不是标题\n\n\\> 不是引用')
  assert.equal(htmlToMarkdown('<p>用 <code>a \\- b</code> 写</p>'), '用 `a \\- b` 写')
  assert.equal(htmlToMarkdown('<p>转义写法 a\\-b 原样</p>'), '转义写法 a\\\\-b 原样', 'a backslash the page itself had stays')
})

test('dogfood 11-10 sweep (取舍): text only screen readers see (Apple\'s visuallyhidden, sr-only) is dropped', () => {
  assert.equal(htmlToMarkdown('<h3><span>新款</span> <span class="product-name">iPhone Duo</span><span class="visuallyhidden">iPhone Duo</span></h3>'), '### 新款 iPhone Duo')
  assert.equal(htmlToMarkdown('<p>价格<span class="sr-only">（人民币）</span> 8999 <span class="screen-reader-text visually-hidden">元</span></p>'), '价格 8999')
})
