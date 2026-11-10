/**
 * The plugin's own strings, English first, Chinese when Desktop's language is Chinese (11-10).
 *
 * Desktop resolves `ctx.i18n.t(key)` against the app's active language, falling back to `en`
 * (sdk: i18n/plugin-i18n.ts). Keys are flat (no dots: the SDK reads dots as nesting). Some
 * strings end up in the sent message (screenshot labels, file labels, missed-image links), so
 * the model reads them too.
 *
 * Without the SDK door (tests, an older Desktop) `t` resolves locally; `setLocale` picks the table.
 */

type Message = string | ((...args: any[]) => string)
type Messages = Record<string, Message>

const list = (items: (string | number)[], sep: string) => items.join(sep)

export const en: Messages = {
  pluginName: 'Rich Paste',
  pluginTagline: 'Web pages, screenshots and files come into the chat where you put them.',

  // paste summary row
  detected: (parts: string) => `Web content: ${parts}`,
  partSep: ', ',
  nHeadings: (n: number) => `${n} heading${n === 1 ? '' : 's'}`,
  nImages: (n: number) => `${n} image${n === 1 ? '' : 's'}`,
  nLinks: (n: number) => `${n} link${n === 1 ? '' : 's'}`,
  nLists: (n: number) => `${n} list${n === 1 ? '' : 's'}`,
  nTables: (n: number) => `${n} table${n === 1 ? '' : 's'}`,
  nCodeBlocks: (n: number) => `${n} code block${n === 1 ? '' : 's'}`,
  nBolds: (n: number) => `${n} bold span${n === 1 ? '' : 's'}`,

  // text written into the draft / sent message
  screenshot: (n: number) => `Screenshot ${n}`,
  imageLabel: (alt: string) => `Image: ${alt}`,
  image: 'Image',
  unboundImage: 'attachment not found',
  unboundLabel: (label: string) => `${label}: attachment not found`,
  fileLabel: (name: string) => `[File: ${name}]`,
  folderLabel: (name: string) => `[Folder: ${name}]`,
  transcriptQuote: 'Transcript: ',
  unsavedInlineImage: 'inline image not saved',
  notDownloadedImage: 'image not downloaded',
  missedCount: 'image not downloaded (over the per-paste limit)',
  missedSize: 'image not downloaded (over the size limit)',
  missedFailed: 'image download failed',

  // notices
  sessionSwitched: 'You switched chats; the converted text was not written.',
  restartGateway: 'Rich Paste\'s backend is out of date: restart the gateway to turn on this update.',
  imagesFailed: (nums: number[]) => `Image ${list(nums, ', ')} could not be downloaded; kept as a link.`,
  imagesTooBig: (nums: number[]) => `Image ${list(nums, ', ')} is over the size limit; kept as a link.`,
  smallSkipped: (n: number) => `Skipped ${n} small image${n === 1 ? '' : 's'} (avatars, icons).`,
  appendedNoOriginal: 'Could not find the text you just pasted; the Markdown was added at the end.',
  appended: 'The Markdown was added at the end.',
  convertFailed: 'Could not convert to Markdown.',
  sentAsIs: 'Sent as pasted; this conversion was cancelled.',
  undoEdited: 'The converted text was edited since, so it was not undone.',
  blockGone: 'That block is gone; nothing was replaced.',
  pickImage: 'Choose another image',
  pickFile: 'Choose another file',
  shotNoPreview: 'This screenshot has no saved preview; click its thumbnail above the composer.',
  sttUnknown: 'Could not read Hermes\'s speech-to-text settings; nothing was transcribed.',
  sttMissing: 'Hermes has no speech-to-text set up. Configure it in Hermes settings, then click Transcribe.',
  sttLanguage: (lang: string) => `Transcription language follows Hermes: ${lang}. `,
  sttCloud: (provider: string, lang: string) => `Transcribing uploads the audio to ${provider}. ${lang}`,
  sttDownload: (model: string, mb: number | undefined, lang: string) =>
    `The first transcription downloads the speech model “${model}”${mb ? ` (about ${mb} MB)` : ''}, once. ${lang}`,
  sttUnclear: (lang: string) => `Could not tell how this machine transcribes: the first run may download a model or upload the audio. ${lang}`,
  sttUnsupported: 'This format cannot be transcribed.',
  sttNotFound: 'Audio file not found.',
  sttTooLarge: 'The audio is too large (over 200 MB); not transcribed.',
  sttNoCredits: 'The transcription service is out of credits (HTTP 402). Top up with the provider or pick another transcription method in Hermes.',
  sttBadKey: 'The transcription service key is invalid or lacks permission.',
  transcribeFailed: (name: string) => `Could not transcribe “${name}”.`,
  transcribeFailedWhy: (name: string, why: string) => `Could not transcribe “${name}”: ${why}`,
  transcribeError: (name: string, message: string) => `“${name}”: ${message}`,
  noSpeech: (name: string) => `No speech found in “${name}”.`,
  audioChipGone: (name: string) => `The audio block was removed; the transcript of “${name}” was not written.`,
  shotAppended: 'The screenshot marker was added at the end.',
  fileAppended: 'The file marker was added at the end.',
  noFilePath: (name: string) => `Could not get where “${name}” is on this computer, so it was not pasted. You can drag it into the composer instead.`,
  thisFile: 'this file',
  tooBig: 'The web content is too large; not converted.',
  copiedRef: (label: string) => `Copied the reference to “${label}”; paste it anywhere in your text.`,
  copyFailed: 'Copy failed; you can cut this block in the text and paste it instead.',
  shotsRemoved: (labels: string[]) => `The attachment of ${labels.map(l => `“${l}”`).join(', ')} was removed, so the sent message leaves it out.`,
  longGone: 'The Markdown for this paste is gone (the cache may have been cleared); it will be sent as Desktop\'s plain-text attachment.',
  folderMissing: 'Could not open the folder (maybe no image has been downloaded yet).',

  // composer rows
  downloading: (done: number, total: number) => `Downloading images ${done}/${total}`,
  converting: 'Converting to Markdown',
  enterSendsOriginal: '· Enter sends the text as pasted',
  enterSendsDraft: '· Enter sends the draft as it is now',
  autoConverted: 'Converted to Markdown automatically',
  converted: 'Converted',
  undo: 'Undo',
  toMarkdown: 'Convert to Markdown',
  dismiss: 'Dismiss',
  imagesWillSend: 'Web images sent with the message:',
  imageItem: (n: number, name: string) => `Image ${n} · ${name}`,
  removeImage: (n: number) => `Remove image ${n}`,
  restartButton: 'Restart gateway',
  desktopOlder: 'Rich Paste\'s desktop part is older than its backend: run “Reload desktop plugins” from the command palette.',
  previewTitle: 'See how it will look once sent',
  preview: 'Preview',
  rendered: 'Rendered preview',
  close: 'Close',
  longPaste: (chars: number, images: number) =>
    `Desktop saved this long paste (${chars} characters) as an attachment; it will be sent as Markdown${images ? `, with ${images} image${images === 1 ? '' : 's'}` : ''}.`,
  backToPlain: 'Back to plain text',
  collapse: 'Hide',
  overLimit: (nums: number[]) => `Image ${list(nums, ', ')} went over the per-paste limit and was not downloaded.`,
  downloadMore: (n: number) => `Download ${n} more`,
  clickToCopyRef: 'Click to copy a reference; paste it into your text to put this image there',
  revealInFinder: 'Show in Finder',
  transcribe: 'Transcribe',
  replace: 'Replace…',
  nAudios: (n: number) => `${n} audio files`,
  quotedName: (name: string) => `“${name}”`,
  transcribing: (label: string) => `Transcribing ${label}`,
  longAudio: '(long audio can take a minute or two)',
  audioDetected: (label: string) => `Audio: ${label}`,
  transcribeTitle: 'Transcribe audio',
  cancel: 'Cancel',
  continueTranscribe: 'Transcribe',

  // settings
  numberHelp: (fallback: number) => `Below 1 or not a number counts as ${fallback}`,
  usage: (files: number, size: string) => `${files} file${files === 1 ? '' : 's'} · ${size}`,
  usageFailed: 'Could not read (plugin backend not enabled?)',
  usageLoading: 'Reading…',
  openFolder: 'Open folder',
  sectionPaste: 'Paste',
  pasteWeb: 'When pasting web content',
  modeSmart: 'Smart',
  modeAlways: 'Always convert',
  modeNever: 'Never automatically',
  modeSmartHelp: 'Pages with images in the text, tables or structured documents become Markdown right away; light formatting like a few links or one list gets a “Convert to Markdown” button after pasting.',
  modeAlwaysHelp: 'Any web content with headings, links, lists or images becomes Markdown right away.',
  modeNeverHelp: 'After pasting you get a “Convert to Markdown” button below the composer; nothing changes until you click it.',
  limitCount: 'Limit images per paste',
  limitCountHelp: 'Off: no limit. On: images over the limit stay as link text.',
  maxImages: 'At most',
  unitImages: 'images',
  limitSize: 'Limit image size',
  limitSizeHelp: (mb: number) => `Off: no limit. On: set the largest size per image in MB (default ${mb}).`,
  maxSize: 'Largest per image',
  unitMb: 'MB',
  sectionImages: 'Downloaded images',
  autoDelete: 'Delete downloaded images automatically',
  autoDeleteHelp: 'Only the local cache is deleted; replies already sent are not affected.',
  keepDays: 'Keep for',
  unitDays: 'days',
  noAutoDeleteUsage: (size: string, files: number) =>
    `Nothing is deleted automatically. Downloaded images already use ${size} (${files} file${files === 1 ? '' : 's'}) and keep growing; turn on automatic deletion or empty the folder when disk space is tight.`,
  noAutoDelete: 'Nothing is deleted automatically. Downloaded images keep growing; turn on automatic deletion or empty the folder when disk space is tight.',
  folder: 'Folder',
  chooseFolder: 'Choose folder…',
  resetFolder: 'Reset to default',
  currentUsage: 'Space used',
  sectionStt: 'Transcription',
  sttModel: 'Local transcription model',
  sttFollow: 'Follow Hermes',
  sttFast: 'Fast',
  sttBetter: 'More accurate',
  sttBest: 'Most accurate',
  sttFollowHelp: 'Use the local model set in Hermes (base if never set).',
  sttBaseHelp: 'base, about 150 MB: fastest, a few more homophone mistakes',
  sttSmallHelp: 'small, about 490 MB: more accurate than base, a bit slower',
  sttTurboHelp: 'turbo, about 1.6 GB: most accurate, slowest',
  sttNote: 'Only for local transcription; has no effect when Hermes transcribes in the cloud. The first use of a model downloads it, and you are asked first.',
  sttModelHelp: (help: string, note: string) => `${help}. ${note}`
}

export const zh: Messages = {
  pluginName: '富粘贴',
  pluginTagline: '网页、截图和文件按原位置带进对话。',

  detected: (parts: string) => `检测到网页内容：${parts}`,
  partSep: '、',
  nHeadings: (n: number) => `${n} 个标题`,
  nImages: (n: number) => `${n} 张图`,
  nLinks: (n: number) => `${n} 个链接`,
  nLists: (n: number) => `${n} 个列表`,
  nTables: (n: number) => `${n} 个表格`,
  nCodeBlocks: (n: number) => `${n} 个代码块`,
  nBolds: (n: number) => `${n} 处加粗`,

  screenshot: (n: number) => `截图 ${n}`,
  imageLabel: (alt: string) => `图：${alt}`,
  image: '图',
  unboundImage: '未对上的附件',
  unboundLabel: (label: string) => `${label}：未对上的附件`,
  fileLabel: (name: string) => `[附件：${name}]`,
  folderLabel: (name: string) => `[文件夹：${name}]`,
  transcriptQuote: '转写：',
  unsavedInlineImage: '内嵌图片未保存',
  notDownloadedImage: '未下载的图片',
  missedCount: '图片未下载（超出张数上限）',
  missedSize: '图片未下载（超出单张大小上限）',
  missedFailed: '图片下载失败',

  sessionSwitched: '会话已切换，转换结果没有写入',
  restartGateway: '富粘贴的后端还是旧版本：重启网关后，这次更新的功能才生效。',
  imagesFailed: (nums: number[]) => `第 ${list(nums, '、')} 张图下载失败，保留为链接`,
  imagesTooBig: (nums: number[]) => `第 ${list(nums, '、')} 张超出单张大小上限，保留为链接`,
  smallSkipped: (n: number) => `跳过了 ${n} 张小图（头像、图标）`,
  appendedNoOriginal: '没找到刚粘贴的原文，Markdown 加在了末尾',
  appended: 'Markdown 加在了末尾',
  convertFailed: '转为 Markdown 失败',
  sentAsIs: '已按原文发送，这次转换取消了',
  undoEdited: '转换后的内容已经改过，没有撤销',
  blockGone: '没找到这个块，没有替换',
  pickImage: '换一张图片',
  pickFile: '换一个文件',
  shotNoPreview: '这张截图的预览没有保存，点输入框上方的缩略图查看',
  sttUnknown: '查不到 Hermes 的语音转写设置，没有转写',
  sttMissing: 'Hermes 没有可用的语音转写：先在 Hermes 设置里配置语音转文字，再点转写',
  sttLanguage: (lang: string) => `转写语言跟随 Hermes 设置：${lang}。`,
  sttCloud: (provider: string, lang: string) => `转写会把音频上传到 ${provider} 处理。${lang}`,
  sttDownload: (model: string, mb: number | undefined, lang: string) =>
    `第一次转写要下载语音模型「${model}」${mb ? `（约 ${mb} MB）` : ''}，之后不再下载。${lang}`,
  sttUnclear: (lang: string) => `查不清这台机器的转写方式：第一次可能要下载模型或上传音频。${lang}`,
  sttUnsupported: '这个格式不能转写',
  sttNotFound: '找不到这个音频文件',
  sttTooLarge: '音频太大（超过 200 MB），没有转写',
  sttNoCredits: '转写服务的额度用完了（HTTP 402），去服务商充值或在 Hermes 里换一个转写方式',
  sttBadKey: '转写服务的密钥无效或没有权限',
  transcribeFailed: (name: string) => `「${name}」转写失败`,
  transcribeFailedWhy: (name: string, why: string) => `「${name}」转写失败：${why}`,
  transcribeError: (name: string, message: string) => `「${name}」${message}`,
  noSpeech: (name: string) => `「${name}」里没有识别出语音`,
  audioChipGone: (name: string) => `音频块已删除，「${name}」的转写没有写入`,
  shotAppended: '截图记号加在了末尾',
  fileAppended: '文件记号加在了末尾',
  noFilePath: (name: string) => `没拿到「${name}」在电脑上的位置，没有贴进去。可以把它直接拖进输入框。`,
  thisFile: '这个文件',
  tooBig: '网页内容太大，没有转换',
  copiedRef: (label: string) => `已复制「${label}」的引用，粘到文字中间即可`,
  copyFailed: '复制失败，可以直接剪切文字里的这个块再粘贴',
  shotsRemoved: (labels: string[]) => `「${labels.join('」「')}」的附件已删除，发出的消息里去掉了这个引用`,
  longGone: '这段的 Markdown 找不到了（缓存可能已清理），发送时会按 Desktop 的纯文字附件发出',
  folderMissing: '打不开存放目录（可能还没下载过图片）',

  downloading: (done: number, total: number) => `正在下载图片 ${done}/${total}`,
  converting: '正在转为 Markdown',
  enterSendsOriginal: '· 按回车会按原文发送',
  enterSendsDraft: '· 按回车会按现在的草稿发送',
  autoConverted: '已自动转为 Markdown',
  converted: '已转换',
  undo: '撤销',
  toMarkdown: '转为 Markdown',
  dismiss: '忽略',
  imagesWillSend: '将随消息发送的网页图：',
  imageItem: (n: number, name: string) => `图 ${n} · ${name}`,
  removeImage: (n: number) => `移除图 ${n}`,
  restartButton: '重启网关',
  desktopOlder: '富粘贴的桌面部分比后端旧：在命令面板运行「Reload desktop plugins」。',
  previewTitle: '看发出去后的排版效果',
  preview: '预览',
  rendered: '渲染效果',
  close: '关闭',
  longPaste: (chars: number, images: number) =>
    `这段长内容（${chars} 字）Desktop 存成了附件，会按 Markdown 发送${images ? `，含 ${images} 张图` : ''}。`,
  backToPlain: '改回纯文字',
  collapse: '收起',
  overLimit: (nums: number[]) => `第 ${list(nums, '、')} 张超出张数上限，没有下载。`,
  downloadMore: (n: number) => `再下载 ${n} 张`,
  clickToCopyRef: '点击复制引用，粘到文字中间就是这张图',
  revealInFinder: '在访达中显示',
  transcribe: '转写',
  replace: '替换…',
  nAudios: (n: number) => `${n} 段音频`,
  quotedName: (name: string) => `「${name}」`,
  transcribing: (label: string) => `正在转写${label}`,
  longAudio: '（长音频可能要一两分钟）',
  audioDetected: (label: string) => `检测到音频：${label}`,
  transcribeTitle: '转写音频',
  cancel: '取消',
  continueTranscribe: '继续转写',

  numberHelp: (fallback: number) => `小于 1 或不是数字时按 ${fallback} 处理`,
  usage: (files: number, size: string) => `${files} 个文件 · ${size}`,
  usageFailed: '读取失败（插件后端未启用？）',
  usageLoading: '读取中…',
  openFolder: '打开目录',
  sectionPaste: '粘贴',
  pasteWeb: '粘贴网页时',
  modeSmart: '智能',
  modeAlways: '总是转换',
  modeNever: '从不自动',
  modeSmartHelp: '图文交错、表格、成段的文档直接转为 Markdown；只有链接、一个列表这类轻格式，粘完给「转为 Markdown」按钮',
  modeAlwaysHelp: '凡是有标题、链接、列表、图的网页内容，都直接转为 Markdown',
  modeNeverHelp: '粘完只在输入框下方给「转为 Markdown」按钮，你点了才转换',
  limitCount: '限制每次下载的张数',
  limitCountHelp: '关闭时不限；打开后超出的图保留为链接文字',
  maxImages: '每次最多下载',
  unitImages: '张',
  limitSize: '限制每张图的大小',
  limitSizeHelp: (mb: number) => `关闭时不限；打开后可填每张最大几兆，默认 ${mb}`,
  maxSize: '每张最大',
  unitMb: '兆',
  sectionImages: '下载的图片',
  autoDelete: '自动删除下载的图片',
  autoDeleteHelp: '只删本机缓存；已发出的那轮回答不受影响',
  keepDays: '保留天数',
  unitDays: '天',
  noAutoDeleteUsage: (size: string, files: number) =>
    `不会自动删除。下载的图已占用 ${size}（${files} 个文件），会一直增长；硬盘紧张时请打开自动删除，或手动清空存放目录。`,
  noAutoDelete: '不会自动删除。下载的图会一直增长；硬盘紧张时请打开自动删除，或手动清空存放目录。',
  folder: '存放目录',
  chooseFolder: '选择目录…',
  resetFolder: '恢复默认',
  currentUsage: '当前占用',
  sectionStt: '语音转写',
  sttModel: '本机转写模型',
  sttFollow: '跟随 Hermes',
  sttFast: '快',
  sttBetter: '较准',
  sttBest: '最准',
  sttFollowHelp: '用 Hermes 设置里的本机模型（没设过就是 base）',
  sttBaseHelp: 'base，约 150 MB：最快，同音字错稍多',
  sttSmallHelp: 'small，约 490 MB：比 base 准，慢一些',
  sttTurboHelp: 'turbo，约 1.6 GB：最准，最慢',
  sttNote: '只管本机转写；Hermes 用云端转写时不起作用。第一次用某一档会先下载模型，下载前会问你。',
  sttModelHelp: (help: string, note: string) => `${help}。${note}`
}

/** Labels that mean "screenshot N" in any language the plugin speaks (a draft can outlive a switch). */
export const SCREENSHOT_WORDS = ['截图', 'Screenshot']
/** Labels that already read as an image label. */
export const IMAGE_WORDS = ['图', 'Image']

type Translate = (key: string, ...args: unknown[]) => string

function local(table: Messages): Translate {
  return (key, ...args) => {
    const message = table[key] ?? en[key]
    if (message === undefined) return key
    return typeof message === 'function' ? message(...(args as never[])) : message
  }
}

let active: Translate = local(en)

/** Use Desktop's translator (follows the app language) when the SDK has one. */
export function bindI18n(i18n: { register?: (bundles: Record<string, Messages>) => unknown; t?: Translate } | undefined): void {
  if (!i18n || typeof i18n.register !== 'function' || typeof i18n.t !== 'function') return
  i18n.register({ en, zh, 'zh-hant': zh }) // Traditional Chinese readers get the Simplified strings, not English
  const sdk = i18n.t
  active = (key, ...args) => sdk(key, ...args)
}

/** Resolve locally in one language (tests; no SDK door). */
export function setLocale(locale: 'en' | 'zh'): void {
  active = local(locale === 'zh' ? zh : en)
}

export const t: Translate = (key, ...args) => active(key, ...args)
