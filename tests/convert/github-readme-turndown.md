## Options

Options can be passed in to the constructor on instantiation. For example:

```js
var turndownService = new TurndownService({ option: 'value' })
```

| Option | Valid values | Default |
| :-- | :-- | :-- |
| `headingStyle` | `setext` or `atx` | `setext` |
| `hr` | Any [Thematic break](http://spec.commonmark.org/0.27/#thematic-breaks) | `* * *` |
| `bulletListMarker` | `-`, `+`, or `*` | `*` |
| `codeBlockStyle` | `indented` or `fenced` | `indented` |
| `fence` | ` ``` ` or `~~~` | ` ``` ` |
| `emDelimiter` | `_` or `*` | `_` |
| `strongDelimiter` | `**` or `__` | `**` |
| `linkStyle` | `inlined` or `referenced` | `inlined` |
| `linkReferenceStyle` | `full`, `collapsed`, or `shortcut` | `full` |
| `preformattedCode` | `false` or [`true`](https://github.com/lucthev/collapse-whitespace/issues/16) | `false` |

### Advanced Options

| Option | Valid values | Default |
| :-- | :-- | :-- |
| `blankReplacement` | rule replacement function | See **Special Rules** below |
| `keepReplacement` | rule replacement function | See **Special Rules** below |
| `defaultReplacement` | rule replacement function | See **Special Rules** below |
