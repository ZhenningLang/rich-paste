// Composer 原文/预览 tabs (dogfood 11-07): when should the switch appear at all.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { looksLikeMarkdown } from '../../desktop/src/markers.ts'
import { setLocale } from '../../desktop/src/i18n.ts'

setLocale('zh') // these tests pin the Chinese strings; english.test.ts covers English

test('markdown structure shows the switch', () => {
  for (const text of [
    '# 标题', '### 小标题\n正文', '**需求**\n\n- 一条', '- 一条\n- 两条', '1. 第一\n2. 第二', '看 [文档](https://x.test)',
    '| a | b |\n| --- | --- |\n| 1 | 2 |', '> 引用', '```\ncode\n```', '![图](https://x.test/a.png)', '这是 **加粗** 的话',
    // dogfood 11-10: an image without alt text (an SVG diagram from martinfowler.com)
    '正文。\n\n![](/Users/me/.hermes/cache/rich-paste/a.png)\n\n图注'
  ]) assert.equal(looksLikeMarkdown(text), true, text)
})

test('plain chat text, chips and single symbols do not', () => {
  for (const text of [
    '', '今天下午三点开会', '帮我看看 @file:/Users/me/a.pdf', '@image:`截图 1` 这是什么', '2*3=6 对吗', '价格 - 优惠 = 实付',
    '用 `npm test` 跑一下', 'a_b_c', '#话题 不是标题', '空链接 [](x) 不算'
  ]) assert.equal(looksLikeMarkdown(text), false, text)
})
