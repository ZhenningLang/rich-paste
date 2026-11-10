# Rich Paste for Hermes

Paste a web page, a screenshot or a file into Hermes Desktop and it arrives the way you meant it:
headings, links, lists, tables and code as Markdown, and every image placed **where it sits in your
text** when the message reaches the model, instead of piled up at the end.

[中文说明](README.zh-CN.md)

## Why

Hermes builds every user turn as "all the text, then all the images". When a message has a few
paragraphs, each with its own picture, the model has to guess which picture belongs to which
paragraph, and it guesses wrong. Same synthetic monitoring screenshots, asking kimi-k3 for "the CPU
reading of each machine" (5 rounds × 6 readings per scenario):

| Scenario | Hermes today (images at the end) | Rich Paste (interleaved) |
|---|---|---|
| One image per paragraph | 30/30 | 30/30 |
| Several images or none in a paragraph | 18/30 | 30/30 |

The typical miss: "2 images, 1 image, 3 images" read as "2, 2, 2". Rerun it with
`bench/replay_experiment.py`. This is not something a prompt or a skill can fix: the order is decided
when Hermes builds the request, so the plugin rewrites the request itself (an `llm_request`
middleware).

## What it does

- **Web pages become Markdown.** Copy part of a page in the browser and paste it into the composer.
  Pages with images in the text, tables or structured documents are converted right away, with an
  **Undo** below the composer. Light formatting (a few links, one list) gets a **Convert to Markdown**
  button instead. You can choose *Smart*, *Always* or *Never automatically* in settings.
- **Images on the page come along.** The plugin backend downloads them to a local cache and the draft
  shows them as Markdown images. A strip above the composer lists the web images that will be sent;
  × removes one. Avatars and icons (96 px or smaller) are skipped when the page has real images.
  SVG is rasterised to PNG.
- **Screenshots keep their place.** Pasting a screenshot attaches it as usual and adds a
  "Screenshot N" block right after what you have typed (Desktop's own `@image:` block, so it is
  selected, moved and deleted as one piece). The sent message reads `[Screenshot 1]` at that spot.
- **Finder files and folders, several at once.** Pasted as Desktop's own file, folder and image
  blocks; files are sent as file attachments, folders as an `@folder:` reference, images interleave.
- **TIFF, HEIC, BMP and AVIF are sent as PNG** (Raycast's clipboard history gives TIFF, which shows
  as a broken image in the chat).
- **Audio transcription.** Paste an audio file and click *Transcribe*: Hermes's own speech-to-text
  writes `> Transcript: …` under the block. The first time a model has to be downloaded or audio
  has to go to a cloud service, you are asked first.
- **Preview** shows how a Markdown draft will look once sent.
- **Interleaving.** Right before the request goes to the model, each image block is moved after its
  label, in every user message of the request (so earlier turns go out the same way each time and
  the provider's prompt cache keeps working). Only the outgoing request changes, never the session
  history; anything unexpected passes the request through untouched. It also works in Hermes's text mode (models judged unable to see
  images), moving each image description next to its label.

The interface is in English, and in Chinese when Desktop's language is Chinese (Traditional Chinese gets the Simplified strings).

## Install

```bash
hermes plugins install rich-paste            # once it is in the plugin catalog
# or straight from this repository:
hermes plugins install ZhenningLang/rich-paste
```

Then:

1. Restart the gateway (`hermes gateway restart`): the middleware and the image backend load with it.
2. In Desktop, turn on the plugin's desktop half (**Capabilities → Plugins**, or search "Rich Paste"
   in the command palette) and run **Reload desktop plugins**.
3. Settings are under **Settings → Plugins → Rich Paste**.

After an update, do both again (restart the gateway, reload desktop plugins). The plugin checks its
own backend: if the backend is older than the desktop half, a "restart the gateway" tip with a
button appears below the composer.

### Tip: let a vision model see the original images

When Hermes decides the model cannot see images, it uses text mode: images are described in text
first. If your model can see images (kimi-k3, for example), set this in `~/.hermes/config.yaml` and
the images go straight into the request, which interleaves best:

```yaml
model:
  supports_vision: true
```

The plugin never changes your Hermes configuration.

## Settings

| Setting | Default | Notes |
|---|---|---|
| When pasting web content | Smart | Smart / Always convert / Never automatically |
| Limit images per paste | Off | When on: at most N images (default 10); the rest stay as links. When off, a paste still downloads at most 50 on its own; **Download N more** fetches the rest |
| Limit image size | Off | When on: largest size per image in MB (default 10). The backend never keeps an image over 20 MB |
| Delete downloaded images automatically | On | Deletes cache folders older than the retention days, only the plugin's own dated folders |
| Keep for (days) | 7 | |
| Folder | `$HERMES_HOME/cache/rich-paste/` | Images go in `rich-paste-cache/<date>/` under it. A folder outside your home directory is ignored by the backend |
| Local transcription model | Follow Hermes | base (~150 MB), small (~490 MB), turbo (~1.6 GB); local transcription only |

## What the plugin does on your machine (disclosure)

- **Network:** the backend downloads the images of pages *you* paste, over http(s) only. It refuses
  loopback, private, link-local, multicast and reserved addresses, checks every redirect again,
  downloads at most 50 images per paste on its own (more only when you click **Download N more**)
  and at most 20 MB per image, and keeps only PNG, JPEG, GIF, WebP (and SVG,
  rasterised). A blocked hotlink (403) is retried once with the image's own site as Referer.
  Behind an HTTP proxy, or a fake-IP proxy such as Clash or Surge (which resolves every name to
  `198.18.x.x`, allowed only when it comes from DNS), the proxy decides the real destination, so
  only addresses written in the URL itself can be checked. No other network calls, no telemetry.
- **Shell command:** when a paste contains files, the backend runs `/usr/bin/osascript` once
  (3-second timeout) to read the file URLs on the macOS clipboard (`public.file-url`, at most 20). It
  does not read clipboard text or images.
- **Files outside the plugin's own data:** at send time, a TIFF/HEIC/BMP/AVIF image attachment you
  added is read (up to 50 MB) and converted to PNG in the cache folder. The image attachments of the
  message are hashed (SHA-256, up to 50 MB each, image extensions only) so each "Screenshot N" block
  finds its own image. A long paste that Desktop saved as `composer-pastes/pasted_content_*.txt` is
  read (its length and first 200 characters, up to 4 MB) to find which saved paste a conversion
  replaces. Audio you choose to transcribe
  is passed to Hermes's speech-to-text (local or cloud, per your Hermes `stt` settings).
- **Hermes internals used:** transcription calls the public `transcribe_audio` of Hermes's
  `tools.transcription_tools` and reads the `stt` settings through `hermes_cli.config.load_config`;
  if either changes, transcription reports "status unknown" and does nothing. The desktop half
  writes into the composer only through the SDK (`host.composer`), never by editing its DOM, and
  its CSS styles only the plugin's own elements. Restoring a copied block reads the `data-ref-*`
  attributes of the copied HTML on the clipboard; if Desktop changes them, that feature does nothing.
- **Pasted text is not a request:** `@file:`, `@url:`, `@diff` written inside a pasted page get an
  invisible U+2060 after the `@`, so Hermes does not expand them (read a local file, fetch a URL).
  Images in a page that point at local paths (`file:`, `/Users/…`) are never read or attached.

## Known limits

- A pasted screenshot's block is added at the end of the draft: the plugin SDK can append text but
  not insert it at the caret. Paste right where you are typing, or move the block afterwards.
- Tested on macOS only. Finder file paths come from the macOS clipboard; elsewhere, drag the file
  into the composer instead.
- The sent label is `[Screenshot 1]` between two invisible U+2063 characters, and the text ends with
  the number of images sent, also invisible. Image attachments are put in label order so the k-th
  label is the k-th image. If labels and images do not add up (you removed a screenshot's
  attachment, or Hermes could not read an image), the label reads
  `[Screenshot 1: attachment not found]` or the images stay at the end, rather than going in the
  wrong spot. One gap remains: a screenshot is matched to its image by a fingerprint taken when
  you paste it; without one (after a plugin reload, or a screenshot over 20 MB) it is matched by
  order, so if you also removed its attachment and added another image with +, the label can
  point at that image.
- Web content over 512 KB or 20,000 elements is not converted ("too large").
- Automatic deletion removes cached files only; old chats that showed those images cannot show them
  after the retention period. Replies already given are not affected.
- When Desktop talks to a remote Hermes, web images are downloaded on the remote machine.
- The send preview is a strip above the composer, not cards in the attachment bar: the plugin SDK
  has no way to add attachment cards.

## Development

```bash
npm install
npm run build        # desktop/src → desktop/plugin.js (the bundle is committed)
npm test             # node --test: converter snapshots, markers, middleware, plugin glue, i18n
uv run --no-project --with pytest --with fastapi --with httpx --with pillow --with resvg-py python -m pytest tests
hermes plugins validate . --install-deps
bash verify.sh       # all of the above
```

`tests/convert/` holds HTML excerpts of real pages and the Markdown they should become; sources and
licences are in `tests/convert/SOURCES.md`.

## License

MIT. `desktop/plugin.js` bundles turndown and turndown-plugin-gfm (both MIT, © Dom Christie).
