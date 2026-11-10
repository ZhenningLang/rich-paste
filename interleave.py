"""Interleave pasted images back into the text of the last user message.

Hermes builds every user turn as ``[one text block (all text + one
"[Image attached at: <path>]" line per image), image 1, image 2, ...]``
(``agent/image_routing.py`` ``build_native_content_parts``). The position of
each image inside the text is lost. Desktop's rich-paste half writes an image
marker ``![alt](<absolute path>)`` (or ``![alt](attached:<n>)``) where the image
belongs; this module moves each image block right after its marker.

Only the outgoing request is rewritten. Nothing here touches session history.
``rewrite_request`` returns ``None`` whenever it is not sure, which tells the
Hermes middleware chain "leave the request unchanged".
"""

from __future__ import annotations

import logging
import os
import re
import urllib.parse
from typing import Any, Optional

logger = logging.getLogger(__name__)

SOURCE = "rich-paste"

MARKER_RE = re.compile(r"!\[([^\[\]\n]*)\]\((?:<([^<>\n]+)>|([^()\[\]\s]+))\)")

# Hermes' per-image hint line (agent/image_routing.py build_native_content_parts).
HINT_FMT = "[Image attached at: {}]"
HINT_RE = re.compile(r"^\[Image attached at: (.+)\]$")
ATTACHED_RE = re.compile(r"^attached:(\d+)$")

# Sent form (11-10): the desktop half writes each bound image as a readable label between two
# INVISIBLE SEPARATORs (U+2063), e.g. "\u2063[截图 2]\u2063", and orders the image attachments
# so the k-th label is the k-th image. The bubble and the session title then read "[截图 2]"
# instead of "![截图 2](attached:1)". The older forms above are still read.
SENT_MARK = "\u2063"
SENT_RE = re.compile(r"\u2063\[([^\[\]\n\u2063]*)\]\u2063")
# Count token (review 11-10): the desktop half ends the text with how many image attachments it sent,
# as invisible TAG DIGITs (U+E0030–U+E0039) between two U+2063. Hermes drops an image it cannot read
# (its hint line and its block together), which would shift every later label by one; when the
# count and the images disagree, nothing is moved.
COUNT_RE = re.compile("\u2063([\U000E0030-\U000E0039]+)\u2063")
# Hermes appends expanded @file:/@url: content after the user's text (agent/context_references.py);
# labels in there are someone else's text, never bindings.
_CONTEXT_FOOTER_RE = re.compile(r"\n+--- (?:Context Warnings|Attached Context) ---\n")

# Text mode (model judged unable to see images): Hermes puts one description block per
# image, in attachment order, before the user's text, blocks separated by a blank line.
# Known producers (all handled by the same parser, not by their wording):
#   gateway/run_inbound.py _enrich_message_with_vision   "[The user sent an image~ Here's what I can see:\n…]\n[If you need a closer look, … image_url: P ~]"
#                                                        or one line "[The user sent an image but … image_url: P]"
#   agent/vision_message_prep.py                         "[The user attached an image. Here's what it contains:\n…]" (+ closer-look line)
#   tui_gateway/session_history.py                       "[The user attached an image: NAME]\n[Examine it with … image_url: P]"
#   hermes_cli/cli_stream_mixin.py                       like vision_message_prep, or one-line failures
BLOCK_START = "[The "
IMAGE_URL_RE = re.compile(r"image_url:\s*(.+?)(?:\s+~)?\]\s*$")

TEXT_TYPES = frozenset({"text", "input_text"})
IMAGE_TYPES = frozenset({"image_url", "image", "input_image"})

def _target(match: "re.Match[str]") -> str:
    """Marker target; the desktop half percent-encodes spaces and ``<>()[]`` in it."""
    return urllib.parse.unquote(match.group(2) or match.group(3))


def _norm(path: str) -> str:
    """String-only normalisation (review F9): no realpath, no file system call, so an automounted
    or network path in a message can never block the request. Only ``~`` / ``~/`` is expanded
    (from $HOME); ``~user`` would need a user database lookup and stays as it is."""
    if path == "~" or path.startswith("~/"):
        path = os.path.expanduser(path)
    return os.path.normpath(path)


def _is_tool_result_only(content: Any) -> bool:
    """Anthropic sends tool results as a user message made only of ``tool_result`` blocks."""
    return (isinstance(content, list) and bool(content)
            and all(isinstance(b, dict) and b.get("type") == "tool_result" for b in content))


def _find_last_user(items: list) -> Optional[int]:
    """Index of the last user message the person wrote: tool-result-only user messages
    (Anthropic tool loop) are skipped so the same turn keeps its interleaving."""
    for index in range(len(items) - 1, -1, -1):
        item = items[index]
        if isinstance(item, dict) and item.get("role") == "user" and not _is_tool_result_only(item.get("content")):
            return index
    return None


def _split_hints(text: str) -> tuple[str, list[str]]:
    """Remove ``[Image attached at: <path>]`` lines; return (rest, paths in order)."""
    kept: list[str] = []
    paths: list[str] = []
    for line in text.split("\n"):
        match = HINT_RE.match(line.strip())
        if match:
            paths.append(match.group(1))
        else:
            kept.append(line)
    return "\n".join(kept).rstrip(), paths


def _match_image(target: str, paths: list[str], used: set[int]) -> Optional[int]:
    attached = ATTACHED_RE.match(target)
    if attached:
        index = int(attached.group(1)) - 1
        if 0 <= index < len(paths) and index not in used:
            return index
        return None
    wanted = _norm(target)
    if not os.path.isabs(wanted):
        return None
    for index, path in enumerate(paths):
        if path and index not in used and _norm(path) == wanted:
            return index
    return None


def _expected_count(own: str) -> Optional[int]:
    match = COUNT_RE.search(own)
    return None if match is None else int("".join(chr(ord(c) - 0xE0000) for c in match.group(1)))


def _strip_tokens(text: str) -> str:
    return COUNT_RE.sub("", text).replace(SENT_MARK, "")


def _bind(body: str, paths: list[str]) -> Optional[list[tuple[int, int]]]:
    """[(end offset of a marker, image index)] in text order; ``None`` when the sent labels
    outnumber the images or the sent image count disagrees (never guess which label lost its image).
    Only the user's own text is read, not the context Hermes appended after it."""
    footer = _CONTEXT_FOOTER_RE.search(body)
    own = body[:footer.start()] if footer else body
    expected = _expected_count(own)
    if expected is not None and expected != len(paths):
        return None
    sent = list(SENT_RE.finditer(own))
    if sent:
        if len(sent) > len(paths):
            return None
        return [(match.end(), index) for index, match in enumerate(sent)]
    used: set[int] = set()
    bound: list[tuple[int, int]] = []
    for match in MARKER_RE.finditer(own):
        index = _match_image(_target(match), paths, used)
        if index is None:
            continue  # unmatched marker stays plain text
        used.add(index)
        bound.append((match.end(), index))
    return bound


def _shape_name(key: str, image_type: str) -> str:
    if key == "input":
        return "responses"
    return "anthropic" if image_type == "image" else "openai"


def rewrite_request(request: Any) -> Optional[dict]:
    """Return a new request with the last user message interleaved, or ``None``.

    ``None`` means "no change": no recognisable shape, no image markers, a hint
    count that does not match the image blocks, or no marker matching an image.
    The input object is never mutated.
    """
    result = _rewrite(request)
    return result[0] if result else None


def _rewrite(request: Any) -> Optional[tuple[dict, int, str]]:
    """(new request, images placed, shape) or ``None``. List content (native image
    blocks) and string content (text mode, F7) are both handled."""
    if not isinstance(request, dict):
        return None
    key = next((k for k in ("messages", "input") if isinstance(request.get(k), list)), None)
    if key is None:
        return None
    items = request[key]
    user_index = _find_last_user(items)
    if user_index is None:
        return None
    message = items[user_index]
    content = message.get("content")
    if isinstance(content, str):
        rewritten = _rewrite_text_mode(content)
        if rewritten is None:
            return None
        return _replace_content(request, key, user_index, rewritten[0]), rewritten[1], "text"
    if not isinstance(content, list):
        return None

    text_blocks = [b for b in content if isinstance(b, dict) and b.get("type") in TEXT_TYPES]
    image_blocks = [b for b in content if isinstance(b, dict) and b.get("type") in IMAGE_TYPES]
    if len(text_blocks) != 1 or not image_blocks:
        return None
    if len(text_blocks) + len(image_blocks) != len(content):
        return None  # an unknown block type: do not guess where it belongs
    text_block = text_blocks[0]
    text = text_block.get("text")
    if not isinstance(text, str):
        return None

    body, hint_paths = _split_hints(text)
    if len(hint_paths) != len(image_blocks):
        return None

    bound = _bind(body, hint_paths)
    if not bound:
        return None
    segments: list[tuple[str, Optional[int]]] = []  # (text up to and incl. marker, image index)
    used = {index for _end, index in bound}
    cursor = 0
    for end, image_index in bound:
        segments.append((body[cursor:end], image_index))
        cursor = end

    tail = body[cursor:]
    leftover = [i for i in range(len(image_blocks)) if i not in used]
    if leftover:
        hints = "\n".join(HINT_FMT.format(hint_paths[i]) for i in leftover)
        tail = f"{tail.rstrip()}\n\n{hints}" if tail.strip() else hints

    block_type = text_block.get("type")
    extra = {k: v for k, v in text_block.items() if k not in ("type", "text")}
    new_content: list[dict] = []
    last_text = -1
    for segment_text, image_index in [*segments, (tail, None)]:
        segment_text = _strip_tokens(segment_text)
        if segment_text.strip():
            last_text = len(new_content)
            new_content.append({"type": block_type, "text": segment_text})
        if image_index is not None:
            new_content.append(image_blocks[image_index])
    new_content.extend(image_blocks[i] for i in leftover)
    if extra and last_text >= 0:
        new_content[last_text].update(extra)

    return _replace_content(request, key, user_index, new_content), len(used), _shape_name(key, image_blocks[0].get("type"))


def _replace_content(request: dict, key: str, user_index: int, content: Any) -> dict:
    items = list(request[key])
    items[user_index] = {**items[user_index], "content": content}
    new_request = dict(request)
    new_request[key] = items
    return new_request


def _is_follow_up(line: str) -> bool:
    """The closer-look / examine line that ends a block: ``[… image_url: P]``."""
    return line.startswith("[") and "image_url:" in line and line.rstrip().endswith("]")


def _split_ref_blocks(text: str) -> tuple[list[tuple[str, Optional[str]]], str]:
    """Leading image description blocks → ([(block text, path or None)], rest of the text).

    A block starts with a line ``[The …image…``. A one-line block ends on that line when it
    ends with ``]``; a description block runs to the first line ending in ``]`` that is
    followed by a closer-look line, a blank line or the end. An optional ``[… image_url: …]``
    line right after belongs to the block. Blocks are separated by one blank line.
    ceiling: a description containing a line that ends with ``]`` followed by a blank line
    ends the block early; the remaining blocks are then not recognised and nothing moves
    for them (the count check below still keeps images from being misplaced).
    """
    lines = text.split("\n")
    blocks: list[tuple[str, Optional[str]]] = []
    i, n = 0, len(lines)
    while i < n and lines[i].startswith(BLOCK_START) and "image" in lines[i].lower():
        j = i
        while j < n:
            line = lines[j].rstrip()
            if line.endswith("]") and (j + 1 == n or lines[j + 1] == "" or _is_follow_up(lines[j + 1])
                                       or j == i):
                break
            j += 1
        if j == n:
            break  # unterminated: not a block
        if j + 1 < n and _is_follow_up(lines[j + 1]):
            j += 1
        block = lines[i:j + 1]
        path = None
        for line in reversed(block):
            found = IMAGE_URL_RE.search(line)
            if found:
                path = found.group(1).strip()
                break
        blocks.append(("\n".join(block), path))
        i = j + 1
        if i < n and lines[i] == "":
            i += 1
        else:
            break
    return blocks, "\n".join(lines[i:])


def _rewrite_text_mode(text: str) -> Optional[tuple[str, int]]:
    """Move each reference block from the top of the message to just after its marker."""
    if not text.startswith(BLOCK_START):
        return None  # the common plain-text turn: no image description blocks at the top
    blocks, body = _split_ref_blocks(text)
    if not blocks:
        return None
    paths = [path or "" for _block, path in blocks]
    bound = _bind(body, paths)
    if not bound:
        return None
    used = {index for _end, index in bound}
    pieces: list[str] = []
    cursor = 0
    for end, index in bound:
        after = body[end:end + 1]
        pieces.append(body[cursor:end])
        pieces.append("\n" + blocks[index][0] + ("\n" if after and after != "\n" else ""))
        cursor = end
    pieces.append(body[cursor:])
    leftover = "\n\n".join(blocks[i][0] for i in range(len(blocks)) if i not in used)
    new_body = _strip_tokens("".join(pieces))
    return (f"{leftover}\n\n{new_body}" if leftover else new_body), len(used)


def on_llm_request(**kwargs: Any) -> Optional[dict]:
    """``llm_request`` middleware: fail open on anything unexpected."""
    try:
        result = _rewrite(kwargs.get("request"))
    except Exception as exc:  # noqa: BLE001 - fail open (U-CTR-3): log and pass the request through
        logger.debug("rich-paste: pass through (%s: %s)", type(exc).__name__, exc)
        return None
    if result is None:
        logger.debug("rich-paste: pass through (no image marker matched an image block)")
        return None
    new_request, count, shape = result
    logger.info("rich-paste interleaved %d images (shape=%s)", count, shape)
    return {"request": new_request, "source": SOURCE, "reason": f"interleaved {count} images"}
