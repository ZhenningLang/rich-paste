"""Download cache for web images pasted into Hermes Desktop (standard library only).

Layout: ``<cache_dir>/rich-paste-cache/<YYYYMMDD>/<sha1(url)[:12]>.<ext>``.
Ownership: a date directory gets the ``.rich-paste`` marker only when this
module itself created it (``mkdir`` without ``exist_ok`` succeeded). A date
directory that already existed without the marker is used but never marked and
never deleted. Cleanup removes marked date directories only, and only inside the
plugin's own ``rich-paste-cache`` subdirectory, so pointing ``cache_dir`` at a
folder with the user's own ``20240101/`` directories never touches them.

The desktop half sends all limits with each request; nothing here reads config.
The backend still clamps them (review F2): at most ``MAX_IMAGES_PER_REQUEST`` images
per request and ``MAX_IMAGE_BYTES`` per image, whatever the client asks for, and
it never connects to loopback, private, link-local, multicast or reserved
addresses (``_ip_blocked``), on the first request or on any redirect.
"""

from __future__ import annotations

import base64
import contextlib
import binascii
import datetime as _dt
import functools
import hashlib
import http.client
import ipaddress
import math
import os
import re
import shutil
import socket
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable, Optional

CONCURRENCY = 4
TIMEOUT_SECONDS = 15
CHUNK = 64 * 1024
SNIFF_BYTES = 16
DEFAULT_KEEP_DAYS = 7
# Backend hard caps (review F2): the Desktop setting "unlimited" means these.
MAX_IMAGES_PER_REQUEST = 50
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_DATA_URL_BYTES = 20 * 1024 * 1024  # decoded size; the encoded length is checked before decoding
MAX_URLS = 200  # a longer urls list is refused outright (ValueError → 400)
IMAGE_EXTS = ("png", "jpg", "gif", "webp")  # what sniff_image_ext can return
DIR_MARKER = ".rich-paste"
CACHE_SUBDIR = "rich-paste-cache"
DATE_DIR_RE = re.compile(r"^\d{8}$")
DATA_URL_RE = re.compile(r"^data:(image/[a-z0-9.+-]+)(;[^,]*)?,(.*)$", re.I | re.S)
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# Error codes returned to the desktop half (it shows them as "kept as a link").
OVER_LIMIT = "over_limit"
TOO_LARGE = "too_large"
UNSUPPORTED = "unsupported_url"
NOT_IMAGE = "not_image"
HTTP_ERROR = "http_error"
NETWORK = "network_error"
BAD_DATA = "bad_data_url"
UNSAFE_CACHE = "cache_dir_unsafe"  # cache directory unusable: a link, someone else's, writable by others (F3)
BLOCKED = "blocked_address"  # host resolves to loopback / private / link-local / ... (review F2)


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()


def default_cache_dir() -> Path:
    return hermes_home() / "cache" / "rich-paste"


def resolve_cache_dir(cache_dir: Optional[str]) -> Path:
    """Empty (or not a string) → default. Otherwise an absolute path (``~`` allowed); relative paths are refused."""
    raw = cache_dir.strip() if isinstance(cache_dir, str) else ""
    if not raw:
        return default_cache_dir()
    path = Path(os.path.expanduser(raw))
    if not path.is_absolute():
        raise ValueError(f"cache_dir must be an absolute path: {raw!r}")
    return path


def client_cache_dir(value: Any) -> tuple[Optional[str], Optional[str]]:
    """Which cache directory to use for a ``cache_dir`` sent by a client (review F5): ``(path, None)``
    when it is an absolute path (``~`` allowed) whose realpath lies under the user's home directory,
    else ``(None, warning)`` = the default directory plus a short reason; ``(None, None)`` when empty."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None, None
    ignored = "cache_dir ignored ({}); using the default cache directory"
    if not isinstance(value, str):
        return None, ignored.format("not a string")
    path = os.path.expanduser(value.strip())
    if not os.path.isabs(path):
        return None, ignored.format("not an absolute path")
    try:
        real = Path(os.path.realpath(path))
        home = Path(os.path.realpath(Path.home()))
    except (OSError, ValueError, RuntimeError):
        return None, ignored.format("unreadable path")
    if not real.is_relative_to(home):
        return None, ignored.format("outside the home directory")
    return str(real), None


def cache_root(cache_dir: Optional[str]) -> Path:
    """The plugin-owned subdirectory everything is written to and cleaned in."""
    return resolve_cache_dir(cache_dir) / CACHE_SUBDIR


def sniff_image_ext(head: bytes) -> Optional[str]:
    """Extension by magic bytes; only the formats Desktop treats as images."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def _positive(value: Any) -> Optional[float]:
    """A finite number >= 1, else ``None``. Booleans, strings, inf and nan are not numbers here (review F7)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:  # an int too large for a float
        return None
    return number if math.isfinite(number) and number >= 1 else None


def _inside(child: Path, parent: Path) -> bool:
    return child.resolve().is_relative_to(parent.resolve())


# ---- review F3: what may be written into and read back from the cache ----

class _UnsafeCache(ValueError):
    """A cache directory that is missing, a link, someone else's, or writable by group/others."""


def _uid() -> int:
    return os.getuid()


def _is_default_root(root: Path) -> bool:
    return root == default_cache_dir() / CACHE_SUBDIR


def _check_dir(path: Path, *, repair: bool) -> None:
    """``path`` must be a real directory (not a link) owned by this user and not writable by group or
    others. ``repair``: drop group/other write from such a directory of ours instead (the default cache,
    made under an older, looser umask)."""
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise _UnsafeCache(f"cache directory unavailable: {path}") from exc
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != _uid():
        raise _UnsafeCache(f"cache directory is a link or not ours: {path}")
    if info.st_mode & 0o022:
        if not repair:
            raise _UnsafeCache(f"cache directory is writable by others: {path}")
        os.chmod(path, stat.S_IMODE(info.st_mode) & ~0o022)


def _date_dir(root: Path, now: float) -> Path:
    """Today's directory in ``root``, both made private (0700) when this creates them and both checked
    with ``_check_dir``; raises ``_UnsafeCache`` when either may not be used."""
    repair = _is_default_root(root)
    day = root / _dt.date.fromtimestamp(now).strftime("%Y%m%d")
    try:
        root.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(FileExistsError):
            root.mkdir(mode=0o700)
        _check_dir(root, repair=repair)
        try:
            day.mkdir(mode=0o700)
        except FileExistsError:
            pass  # already there: use it, but only mark directories we create ourselves
        else:
            os.close(os.open(day / DIR_MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600))
        _check_dir(day, repair=repair)
    except _UnsafeCache:
        raise
    except OSError as exc:
        raise _UnsafeCache(f"cache directory unavailable: {exc}") from exc
    return day


def _plain_file(path: Path) -> bool:
    """A regular file with a single link: never a symlink or a hard link to a file elsewhere."""
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and info.st_nlink == 1


def _new_part(day: Path, stem: str) -> tuple[int, Path]:
    """A fresh temporary file in ``day`` (``O_CREAT|O_EXCL|O_NOFOLLOW``, unique name, mode 0600)."""
    fd, name = tempfile.mkstemp(dir=day, prefix=f"{stem}.", suffix=".part")
    return fd, Path(name)


def _write_file(day: Path, out: Path, data: bytes) -> None:
    """Write ``data`` to ``out`` through a fresh temporary file and ``os.replace`` (never through a link)."""
    fd, part = _new_part(day, out.stem)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(part, out)
    except BaseException:
        part.unlink(missing_ok=True)
        raise


def _existing(day: Path, stem: str) -> Optional[Path]:
    for ext in IMAGE_EXTS:
        candidate = day / f"{stem}.{ext}"
        if _plain_file(candidate):
            return candidate
    return None


def cleanup(cache_dir: Optional[str], days: Any = DEFAULT_KEEP_DAYS, *, now: Optional[float] = None) -> int:
    """Delete plugin-created date directories older than ``days`` days. Returns how many were removed."""
    root = cache_root(cache_dir)
    keep_days = int(_positive(days) or DEFAULT_KEEP_DAYS)
    try:
        _check_dir(root, repair=_is_default_root(root))
    except (_UnsafeCache, OSError):
        return 0  # missing, or not a directory this may clean (review F3)
    today = _dt.date.fromtimestamp(now if now is not None else time.time())
    removed = 0
    for entry in root.iterdir():
        if not DATE_DIR_RE.match(entry.name) or entry.is_symlink() or not entry.is_dir():
            continue
        if not (entry / DIR_MARKER).is_file():
            continue
        try:
            day = _dt.datetime.strptime(entry.name, "%Y%m%d").date()
        except ValueError:
            continue
        if (today - day).days > keep_days and _inside(entry, root):
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
    return removed


def cache_stats(cache_dir: Optional[str]) -> dict:
    root = cache_root(cache_dir)
    total = files = 0
    if root.is_dir():
        for dirpath, _dirnames, filenames in os.walk(root, followlinks=False):
            for name in filenames:
                if name == DIR_MARKER:
                    continue
                path = os.path.join(dirpath, name)
                if os.path.islink(path):
                    continue
                try:
                    total += os.path.getsize(path)
                except OSError:
                    continue
                files += 1
    return {"bytes": total, "files": files, "dir": str(root)}


def _ok(path: Path) -> dict:
    return {"path": str(path.resolve()), "error": None}


def _fail(code: str) -> dict:
    return {"path": None, "error": code}


# ---- dogfood 11-10: SVG (blog diagrams) → PNG; models and Desktop's attach take raster images ----

SVG_MAX_BYTES = 5 * 1024 * 1024
SVG_MAX_SIDE = 2048  # longest side of the rendered PNG, in pixels
SVG_SCALE = 2  # small diagrams are drawn at twice their size so text stays readable
_SVG_START_RE = re.compile(r"^\ufeff?\s*(<\?xml[^>]*>\s*)?((<!--.*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s>]", re.I | re.S)
_SVG_TAG_RE = re.compile(r"<svg\b[^>]*>", re.I | re.S)
_LENGTH_RE = re.compile(r"^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$", re.I)
# Any href that is not an in-document reference (#id) or inline data: resvg would read it from disk.
# Any namespace prefix: `xmlns:x=".../xlink"` makes `x:href` an xlink:href (review 11-10).
_FILE_HREF_RE = re.compile(r"""\s(?:[\w.-]+:)?href\s*=\s*(?:"(?!\s*(?:#|data:))[^"]*"|'(?!\s*(?:#|data:))[^']*')""", re.I)


def _attr(tag: str, name: str) -> Optional[str]:
    match = re.search(rf"""\s{name}\s*=\s*(?:"([^"]*)"|'([^']*)')""", tag, re.I)
    return None if match is None else (match.group(1) if match.group(1) is not None else match.group(2))


def _svg_size(tag: str) -> Optional[tuple[float, float]]:
    """Intrinsic size from the root tag: width/height in px, else the viewBox."""
    width, height = (_LENGTH_RE.match(_attr(tag, n) or "") for n in ("width", "height"))
    box = (_attr(tag, "viewBox") or "").replace(",", " ").split()
    box_size = None
    if len(box) == 4:
        try:
            box_size = (float(box[2]), float(box[3]))
        except ValueError:
            box_size = None
    if width and height:
        return float(width.group(1)), float(height.group(1))
    if box_size and width:
        return float(width.group(1)), float(width.group(1)) * box_size[1] / box_size[0] if box_size[0] else None
    if box_size and height:
        return float(height.group(1)) * box_size[0] / box_size[1] if box_size[1] else None, float(height.group(1))
    return box_size


def _svg_to_png(part: Path, day: Path, stem: str) -> Optional[dict]:
    """``None`` when ``part`` is not SVG markup; otherwise the PNG result (or a failure)."""
    try:
        if part.stat().st_size > SVG_MAX_BYTES:
            return None
        text = part.read_bytes().decode("utf-8", errors="replace")
    except OSError:
        return None
    if not _SVG_START_RE.match(text[:4096]):
        return None
    if re.search(r"<!ENTITY", text, re.I):  # entities could expand into markup the href filter never sees
        return _fail(NOT_IMAGE)
    tag = _SVG_TAG_RE.search(text)
    size = _svg_size(tag.group(0)) if tag else None
    if not size or not all(size) or min(size) <= 0:
        return _fail(NOT_IMAGE)
    scale = min(SVG_SCALE, SVG_MAX_SIDE / max(size))
    width = max(1, round(size[0] * scale))
    try:
        import tempfile

        import resvg_py  # a Hermes core dependency (pyproject.toml)

        with tempfile.TemporaryDirectory() as empty:  # relative hrefs resolve to nothing
            data = bytes(resvg_py.svg_to_bytes(
                svg_string=_FILE_HREF_RE.sub("", text), background="#ffffff", width=width, resources_dir=empty))
    except Exception:
        return _fail(NOT_IMAGE)
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return _fail(NOT_IMAGE)
    final = day / f"{stem}.png"
    _write_file(day, final, data)
    return _ok(final)


def _finish(part: Path, head: bytes, day: Path, stem: str) -> dict:
    """Sniff the downloaded ``.part`` file; keep it as ``<stem>.<ext>`` or delete it."""
    ext = sniff_image_ext(head)
    if ext is None:
        try:
            result = _svg_to_png(part, day, stem)
        finally:
            part.unlink(missing_ok=True)
        return result or _fail(NOT_IMAGE)
    final = day / f"{stem}.{ext}"
    try:
        os.replace(part, final)
    except OSError:
        part.unlink(missing_ok=True)
        raise
    return _ok(final)


def _fetch_data_url(url: str, day: Path, stem: str, max_bytes: Optional[int]) -> dict:
    match = DATA_URL_RE.match(url)
    if not match or ";base64" not in (match.group(2) or "").lower():
        return _fail(BAD_DATA)
    payload = match.group(3)
    if len(payload) > MAX_DATA_URL_BYTES * 4 // 3 + 4:  # before decoding (review F2)
        return _fail(TOO_LARGE)
    if max_bytes is not None and len(payload) * 3 // 4 > max_bytes + 3:
        return _fail(TOO_LARGE)
    try:
        data = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError):
        return _fail(BAD_DATA)
    if len(data) > MAX_DATA_URL_BYTES or (max_bytes is not None and len(data) > max_bytes):
        return _fail(TOO_LARGE)
    fd, part = _new_part(day, stem)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    return _finish(part, data[:SNIFF_BYTES], day, stem)


class _TooLarge(Exception):
    pass


# ---- review F2: which addresses may be fetched ----
# Every connection urllib opens goes through _GuardedHTTP(S)Handler: a direct connection resolves the
# host once, refuses it when any answer is blocked, and connects only to the addresses it checked (no
# second lookup, so DNS rebinding between check and connect does not get through). Through an HTTP(S)
# proxy the connection is to the proxy, so the URL's host is resolved and checked here before the request
# is handed over; the proxy then resolves it again itself, and that second lookup is not ours to check.
# Redirects are followed by urllib, but each hop is a new request through the same handlers.

_NAT64 = ipaddress.ip_network("64:ff9b::/96")
# Clash / Surge "fake-ip" mode (TUN) answers every DNS lookup from this RFC 2544 benchmarking range and
# proxies the connection by name (the author's machine resolves all hosts this way). Accepted only when it
# comes back from DNS for a host name; a literal 198.18.x.x in a URL is refused like any other private
# address. Under fake-ip the real destination is decided by the proxy, so only literal addresses are checked.
FAKE_IP_NET = ipaddress.ip_network("198.18.0.0/15")


class _Refused(OSError):
    """The address check refused a host; reported as ``BLOCKED``."""


def _ip_blocked(ip: "ipaddress.IPv4Address | ipaddress.IPv6Address") -> bool:
    """True for anything that is not a public unicast address, including IPv4 hidden in IPv6 forms."""
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = ip.ipv4_mapped or ip.sixtofour
        if embedded is None and ip in _NAT64:
            embedded = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        if embedded is not None:
            return _ip_blocked(embedded)
    return (ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_multicast or ip.is_reserved
            or ip.is_unspecified or not ip.is_global)


def _addr_blocked(ip: "ipaddress.IPv4Address | ipaddress.IPv6Address", *, from_dns: bool) -> bool:
    if from_dns and ip.version == 4 and ip in FAKE_IP_NET:
        return False
    return _ip_blocked(ip)


def _literal_ip(host: str) -> "Optional[ipaddress.IPv4Address | ipaddress.IPv6Address]":
    """The address a host string names by itself: dotted, IPv6, and the short/decimal/hex IPv4 forms
    (``127.1``, ``2130706433``, ``0x7f000001``) that the C resolver also takes as numbers."""
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass
    try:
        return ipaddress.IPv4Address(socket.inet_aton(host))
    except (OSError, ValueError):
        return None


def _resolve(host: str, port: int) -> list:
    return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)


def _checked_addresses(host: str, port: int) -> list:
    """getaddrinfo-style entries for ``host``; raises ``_Refused`` when any of them is blocked."""
    literal = _literal_ip(host)
    if literal is not None:
        if _addr_blocked(literal, from_dns=False):
            raise _Refused(f"refused address: {host}")
        if literal.version == 4:
            return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (str(literal), port))]
        return [(socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (str(literal), port, 0, 0))]
    infos = _resolve(host, port)
    if not infos:
        raise OSError(f"no address for {host}")
    for info in infos:
        if _addr_blocked(ipaddress.ip_address(info[4][0]), from_dns=True):
            raise _Refused(f"refused address for {host}: {info[4][0]}")
    return infos


def _guarded_create_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None, *args, **kwargs):
    """``socket.create_connection`` that connects only to addresses ``_checked_addresses`` let through."""
    host, port = address[0], address[1]
    error: Optional[OSError] = None
    for family, kind, proto, _canon, sockaddr in _checked_addresses(host, port):
        sock = socket.socket(family, kind, proto)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(sockaddr)
            return sock
        except OSError as exc:
            error = exc
            sock.close()
    raise error or OSError(f"could not connect to {host}")


class _GuardedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args, rp_direct: bool = True, **kwargs):
        super().__init__(*args, **kwargs)
        if rp_direct:
            self._create_connection = _guarded_create_connection


class _GuardedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, rp_direct: bool = True, **kwargs):
        super().__init__(*args, **kwargs)
        if rp_direct:
            self._create_connection = _guarded_create_connection


def _guarded_open(handler, connection_class, req, **kwargs):
    proxied = req.has_proxy() or bool(getattr(req, "_tunnel_host", None))
    if proxied:  # the socket goes to the proxy: check the URL's own host here, before sending anything
        parts = urllib.parse.urlsplit(req.full_url)
        _checked_addresses(parts.hostname or "", parts.port or (443 if parts.scheme == "https" else 80))
    return handler.do_open(functools.partial(connection_class, rp_direct=not proxied), req, **kwargs)


class _GuardedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return _guarded_open(self, _GuardedHTTPConnection, req)


class _GuardedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return _guarded_open(self, _GuardedHTTPSConnection, req, context=self._context)


class _HttpOnlyRedirects(urllib.request.HTTPRedirectHandler):
    """Follow redirects only to http(s); urllib would otherwise also follow ``ftp:``. The address of
    every hop is checked when its connection is opened (``_GuardedHTTP(S)Handler``)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - urllib hook
        if urllib.parse.urlsplit(newurl).scheme.lower() not in ("http", "https"):
            raise urllib.error.HTTPError(newurl, code, "redirect to unsupported scheme", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _build_opener(proxies: Optional[dict] = None):
    """``proxies``: as for ``urllib.request.ProxyHandler`` (``None`` = from the environment)."""
    return urllib.request.build_opener(urllib.request.ProxyHandler(proxies), _GuardedHTTPHandler,
                                       _GuardedHTTPSHandler, _HttpOnlyRedirects)


_OPENER = _build_opener()


def _fetch_http(url: str, day: Path, stem: str, max_bytes: Optional[int], referer: Optional[str], timeout: float) -> dict:
    headers = {"User-Agent": USER_AGENT, "Accept": "image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5"}
    if referer and urllib.parse.urlsplit(referer).scheme in ("http", "https"):
        headers["Referer"] = referer
    part: Optional[Path] = None  # set while a temporary file exists that is not yet handed to _finish
    deadline = time.monotonic() + timeout
    try:
        request = urllib.request.Request(url, headers=headers)
        with _OPENER.open(request, timeout=timeout) as response:
            length = response.headers.get("Content-Length")
            if max_bytes is not None and length and length.isdigit() and int(length) > max_bytes:
                return _fail(TOO_LARGE)
            size = 0
            head = b""
            fd, part = _new_part(day, stem)
            with os.fdopen(fd, "wb") as out:
                while True:
                    if time.monotonic() > deadline:
                        raise TimeoutError("download exceeded timeout")
                    chunk = response.read(CHUNK)
                    if not chunk:
                        break
                    size += len(chunk)
                    if max_bytes is not None and size > max_bytes:
                        raise _TooLarge()
                    if len(head) < SNIFF_BYTES:
                        head += chunk[: SNIFF_BYTES - len(head)]
                    out.write(chunk)
        done, part = part, None
        return _finish(done, head, day, stem)
    except _TooLarge:
        return _fail(TOO_LARGE)
    except _Refused:  # a proxied request's host, checked before it was sent
        return _fail(BLOCKED)
    except urllib.error.HTTPError as exc:
        if exc.code == 403 and not referer:
            # Hotlink protection that refuses an empty Referer (dogfood 11-10, 少数派's CDN). The
            # image's own site is sent, never the page the user copied from; one retry only.
            parts = urllib.parse.urlsplit(url)
            return _fetch_http(url, day, stem, max_bytes, f"{parts.scheme}://{parts.netloc}/", max(1.0, deadline - time.monotonic()))
        return _fail(f"{HTTP_ERROR}:{exc.code}")
    except (urllib.error.URLError, OSError, TimeoutError, ValueError) as exc:
        if isinstance(getattr(exc, "reason", None), _Refused):  # a direct connection, wrapped by urllib
            return _fail(BLOCKED)
        return _fail(f"{NETWORK}:{type(exc).__name__}")
    finally:
        if part is not None:
            part.unlink(missing_ok=True)


def classify_url(url: Any) -> Optional[str]:
    """``"http"`` / ``"data"`` for accepted URLs, ``None`` for everything else (``file:``, ``blob:`` …)."""
    if not isinstance(url, str):
        return None
    parts = urllib.parse.urlsplit(url.strip())
    scheme = parts.scheme.lower()
    if scheme in ("http", "https") and parts.hostname:
        return "http"
    if scheme == "data" and DATA_URL_RE.match(url.strip()):
        return "data"
    return None


def _image_size(path: str) -> Optional[list]:
    """``[width, height]`` read from the file header (dogfood 11-10: the desktop half leaves out
    avatars and icons next to real pictures); ``None`` without Pillow or for an unreadable file."""
    try:
        from PIL import Image

        with Image.open(path) as image:
            return [int(image.width), int(image.height)]
    except Exception:
        return None


def fetch_images(
    urls: Iterable[Any],
    *,
    max_images: Any = None,
    max_mb: Any = None,
    cache_dir: Optional[str] = None,
    auto_delete: bool = True,
    days: Any = DEFAULT_KEEP_DAYS,
    referer: Optional[str] = None,
    timeout: float = TIMEOUT_SECONDS,
    now: Optional[float] = None,
) -> list[dict]:
    """Download ``urls`` into the cache. One result per input URL, same order.

    ``max_images`` / ``max_mb``: ``None`` (or < 1, or not a number) = the backend caps
    (``MAX_IMAGES_PER_REQUEST``, ``MAX_IMAGE_BYTES``), which also bound larger values. More than
    ``MAX_URLS`` URLs raises ValueError.
    Each result: ``{"url", "path": abs path | None, "error": code | None}``.
    """
    url_list = list(urls)
    if len(url_list) > MAX_URLS:
        raise ValueError(f"at most {MAX_URLS} urls per request")
    referer = referer if isinstance(referer, str) else None
    root = cache_root(cache_dir)
    if auto_delete:
        cleanup(cache_dir, days, now=now)
    try:
        day = _date_dir(root, now if now is not None else time.time())
    except _UnsafeCache:
        return [{"url": url, **_fail(UNSAFE_CACHE)} for url in url_list]
    limit_count = min(_positive(max_images) or MAX_IMAGES_PER_REQUEST, MAX_IMAGES_PER_REQUEST)
    limit_mb = _positive(max_mb)
    max_bytes = MAX_IMAGE_BYTES if limit_mb is None else int(min(limit_mb * 1024 * 1024, MAX_IMAGE_BYTES))

    def one(position_url: tuple[int, Any]) -> dict:
        position, url = position_url
        if limit_count is not None and position >= int(limit_count):
            return {"url": url, **_fail(OVER_LIMIT)}
        kind = classify_url(url)
        if kind is None:
            return {"url": url, **_fail(UNSUPPORTED)}
        clean = url.strip()
        stem = hashlib.sha1(clean.encode("utf-8")).hexdigest()[:12]
        cached = _existing(day, stem)
        if cached:
            # The size limit applies to cache hits too (a file cached before the limit was turned on).
            result = _fail(TOO_LARGE) if max_bytes is not None and cached.stat().st_size > max_bytes else _ok(cached)
        elif kind == "data":
            result = _fetch_data_url(clean, day, stem, max_bytes)
        else:
            result = _fetch_http(clean, day, stem, max_bytes, referer, timeout)
        if result["path"] and not _inside(Path(result["path"]), root):
            result = _fail(UNSUPPORTED)
        size = _image_size(result["path"]) if result["path"] else None
        return {"url": url, **result, **({"size": size} if size else {})}

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        return list(pool.map(one, enumerate(url_list)))


# ---- dogfood D5: Finder copies whose path Chromium hides ----
# A Finder copy of a folder (and, in Desktop's Chromium, of many files) reaches the paste
# event as a File with no `text/uri-list`, so the desktop half asks here for the file URLs
# on the macOS pasteboard. Disclosed in README: runs `osascript`, reads only file URLs.

MAX_CLIPBOARD_FILES = 20
CLIPBOARD_TIMEOUT_S = 3.0
_CLIPBOARD_JXA = r"""ObjC.import("AppKit");
var items = $.NSPasteboard.generalPasteboard.pasteboardItems, out = [];
for (var i = 0; items && i < items.count; i++) {
  var s = items.objectAtIndex(i).stringForType("public.file-url");
  if (s && !s.isNil()) {
    var u = $.NSURL.URLWithString(s);
    if (u && !u.isNil() && u.isFileURL) out.push(ObjC.unwrap(u.path));
  }
}
JSON.stringify(out)"""


def clipboard_file_paths(*, run=None, platform: str | None = None) -> dict:
    """File and folder paths on the macOS pasteboard: ``{"ok", "files": [{"path", "is_dir"}]}``.

    Fails closed (``ok: False``, no files) off macOS, on timeout, or on any unexpected output;
    only existing absolute paths are returned, at most ``MAX_CLIPBOARD_FILES``."""
    import json as _json
    import subprocess as _subprocess

    platform = sys.platform if platform is None else platform
    if platform != "darwin":
        return {"ok": False, "reason": "unsupported", "files": []}
    run = run or _subprocess.run
    try:
        proc = run(["/usr/bin/osascript", "-l", "JavaScript", "-e", _CLIPBOARD_JXA],
                   capture_output=True, text=True, timeout=CLIPBOARD_TIMEOUT_S, check=False)
        paths = _json.loads((proc.stdout or "").strip() or "[]") if proc.returncode == 0 else None
    except (OSError, ValueError, _subprocess.TimeoutExpired):
        paths = None
    if not isinstance(paths, list):
        return {"ok": False, "reason": "unavailable", "files": []}
    files = []
    for path in paths:
        if len(files) >= MAX_CLIPBOARD_FILES:
            break
        if isinstance(path, str) and os.path.isabs(path) and os.path.exists(path):
            files.append({"path": path, "is_dir": os.path.isdir(path)})
    return {"ok": True, "files": files}


# ---- dogfood D6: send-time PNG for formats Desktop cannot preview ----

CONVERTIBLE_EXTS = (".tif", ".tiff", ".heic", ".heif", ".bmp", ".avif")
MAX_CONVERT_BYTES = 50 * 1024 * 1024


def to_png(path: str, cache_dir: Optional[str] = None, *, now: Optional[float] = None) -> dict:
    """Re-encode one local TIFF/HEIC/BMP/AVIF image as PNG inside the plugin cache.

    Returns ``{"path": <png>, "error": None}`` or ``{"path": None, "error": <code>}`` with code
    ``unsupported_type`` / ``not_found`` / ``too_large`` / ``decode_failed``. The same bytes map
    to the same PNG (content hash), so a re-send reuses it. Raises ValueError for a relative path
    or a bad cache directory."""
    src = Path(path)
    if not src.is_absolute():
        raise ValueError(f"path must be absolute: {path}")
    if src.suffix.lower() not in CONVERTIBLE_EXTS:
        return {"path": None, "error": "unsupported_type"}
    if not src.is_file():
        return {"path": None, "error": "not_found"}
    if src.stat().st_size > MAX_CONVERT_BYTES:
        return {"path": None, "error": "too_large"}
    data = src.read_bytes()
    try:
        day = _date_dir(cache_root(cache_dir), time.time() if now is None else now)
    except _UnsafeCache:
        return {"path": None, "error": UNSAFE_CACHE}
    out = day / f"{hashlib.sha256(data).hexdigest()[:20]}.png"
    if _plain_file(out):
        return {"path": str(out), "error": None}
    try:
        import io
        import tempfile

        from PIL import Image

        if src.suffix.lower() in (".heic", ".heif"):
            try:
                from pillow_heif import register_heif_opener  # optional plugin
                register_heif_opener()
            except Exception:
                pass
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            converted = image if image.mode in ("RGB", "RGBA", "L", "LA") else image.convert("RGBA")
            fd, tmp = tempfile.mkstemp(dir=day, suffix=".png.part")
            try:
                with os.fdopen(fd, "wb") as handle:
                    converted.save(handle, format="PNG")
                os.replace(tmp, out)
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)
                raise
    except Exception:
        return {"path": None, "error": "decode_failed"}
    return {"path": str(out), "error": None}


# ---- dogfood D9: preview copy of a pasted image (the composer chip «截图 N» has no path) ----

MAX_PREVIEW_BYTES = 20 * 1024 * 1024
_PREVIEW_SUFFIX = {"image/tiff": ".tiff", "image/tif": ".tiff", "image/heic": ".heic", "image/heif": ".heif",
                   "image/bmp": ".bmp", "image/avif": ".avif"}


def save_preview(data_url: Any, cache_dir: Optional[str] = None, *, now: Optional[float] = None) -> dict:
    """Store a pasted image (``data:image/...;base64,...``) in the cache for preview only.

    PNG/JPEG/GIF/WebP are kept as they are; TIFF/HEIC/BMP/AVIF become PNG (via ``to_png``).
    Returns ``{"path", "error", "sha256"}``; error codes ``not_an_image`` / ``too_large`` /
    ``unsupported_type`` / ``decode_failed``. ``sha256`` is the digest of the pasted bytes (None when
    they could not be read): the plugin matches it against the attachment files at send (11-07)."""
    match = DATA_URL_RE.match(data_url.strip()) if isinstance(data_url, str) else None
    if not match or ";base64" not in (match.group(2) or "").lower():
        return {"path": None, "error": "not_an_image"}
    if len(match.group(3)) > MAX_PREVIEW_BYTES * 4 // 3 + 8:
        return {"path": None, "error": "too_large"}
    try:
        data = base64.b64decode(match.group(3), validate=False)
    except (binascii.Error, ValueError):
        return {"path": None, "error": "not_an_image"}
    if not data:
        return {"path": None, "error": "not_an_image"}
    if len(data) > MAX_PREVIEW_BYTES:
        return {"path": None, "error": "too_large"}
    return {**_store_preview(data, match.group(1), cache_dir, now), "sha256": hashlib.sha256(data).hexdigest()}


def _store_preview(data: bytes, mime: str, cache_dir: Optional[str], now: Optional[float]) -> dict:
    now = time.time() if now is None else now
    try:
        day = _date_dir(cache_root(cache_dir), now)
    except _UnsafeCache:
        return {"path": None, "error": UNSAFE_CACHE}
    digest = hashlib.sha256(data).hexdigest()[:20]
    ext = sniff_image_ext(data[:16])
    if ext:
        out = day / f"{digest}.{ext}"
        if not _plain_file(out):
            _write_file(day, out, data)
        return {"path": str(out), "error": None}
    suffix = _PREVIEW_SUFFIX.get(mime.lower())
    if not suffix:
        return {"path": None, "error": "unsupported_type"}
    fd, raw = tempfile.mkstemp(dir=day, prefix=f"{digest}.src.", suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        return to_png(raw, cache_dir, now=now)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(raw)


# ---- dogfood D10: audio transcription through Hermes' own STT ----
# Transcribes with the public ``tools.transcription_tools.transcribe_audio`` and reads the ``stt``
# section of Hermes' config through the public ``hermes_cli.config.load_config`` (review 11-10: no
# private STT helpers). Only an explicit ``stt.provider`` is classified; without one Hermes
# auto-detects, so the status is "unknown" and the desktop half asks before the first use.

AUDIO_EXTS = (".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".oga", ".opus", ".aif", ".aiff", ".caf", ".amr", ".webm")
MAX_TRANSCRIBE_BYTES = 200 * 1024 * 1024
# Download sizes from the Hugging Face model trees (checked 2026-11-08: base 148, small 486, medium 1531,
# turbo 1618 MB). The keys are Hermes' local model names (STT_MODEL_CATALOG["local"]).
_LOCAL_MODEL_SIZES_MB = {"tiny": 75, "base": 150, "small": 490, "medium": 1530, "large-v3": 3100, "turbo": 1620, "large-v3-turbo": 1620}
# faster-whisper's own name -> repo map, for the ones not under Systran/faster-whisper-<name>.
_LOCAL_MODEL_REPOS = {"turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
                      "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo"}


def _local_model(choice) -> str | None:
    """A model the user picked in the plugin settings, if it is one Hermes' local STT knows (11-08)."""
    return choice if isinstance(choice, str) and choice in _LOCAL_MODEL_SIZES_MB else None


def _stt_module():
    import tools.transcription_tools as stt  # Hermes' own module; present when running inside Hermes
    return stt


def _hf_cached(repo: str) -> bool:
    hub = Path(os.environ.get("HF_HOME") or (Path.home() / ".cache" / "huggingface")) / "hub"
    return (hub / f"models--{repo.replace('/', '--')}").is_dir()


def _stt_config() -> dict:
    """The ``stt`` section of Hermes' config, through its public loader; ``{}`` when unavailable."""
    from hermes_cli.config import load_config  # Hermes' own config loader; present when running inside Hermes
    cfg = load_config().get("stt")
    return cfg if isinstance(cfg, dict) else {}


def _stt_language(provider: str, cfg: dict) -> str | None:
    """Same order Hermes documents: ``stt.<provider>.language`` > ``stt.language`` > env > auto."""
    section = cfg.get(provider) if isinstance(cfg.get(provider), dict) else {}
    for value in (section.get("language"), cfg.get("language"), os.environ.get("HERMES_LOCAL_STT_LANGUAGE")):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _faster_whisper_installed() -> bool:
    import importlib.util
    try:
        return importlib.util.find_spec("faster_whisper") is not None
    except (ImportError, ValueError):
        return False


def _stt_enabled(cfg: dict) -> bool:
    """Hermes' public ``is_stt_enabled`` when importable; the same truthiness rule otherwise."""
    try:
        from tools.transcription_tools import is_stt_enabled
        return bool(is_stt_enabled(cfg))
    except Exception:  # noqa: BLE001 - outside Hermes (tests): mirror its rule
        value = cfg.get("enabled", True)
        if isinstance(value, str):
            return value.strip().lower() not in ("", "0", "false", "no", "off", "disabled")
        return bool(value)


def _stt_provider(cfg: dict) -> str | None:
    """``none`` when STT is off, else the provider Hermes would pick when that can be told from
    public facts: an explicit ``stt.provider``, or (none set) a local backend, which Hermes'
    auto-detection tries first. ``None``: Hermes would look further (cloud keys), so unknown."""
    if not _stt_enabled(cfg):
        return "none"
    provider = cfg.get("provider")
    if isinstance(provider, str) and provider.strip():
        provider = provider.strip().lower()
        return "openai" if provider == "nous" else provider
    if _faster_whisper_installed():
        return "local"
    if os.environ.get("HERMES_LOCAL_STT_COMMAND", "").strip():
        return "local_command"
    return None


def stt_status(model=None, *, config=None) -> dict:
    """What transcribing will do: ``{"kind": local|cloud|command|none|unknown, "provider",
    "needs_download", "model", "download_mb", "language"}``. ``model`` is the plugin setting; it only
    applies to Hermes' local STT. ``config``: the ``stt`` section (tests); read from Hermes otherwise."""
    unknown = {"kind": "unknown", "provider": None, "needs_download": False, "model": None, "download_mb": None, "language": None}
    try:
        cfg = _stt_config() if config is None else config
        provider = _stt_provider(cfg)
    except Exception:
        return unknown
    if provider == "none":
        return {**unknown, "kind": "none"}
    if provider is None:
        return {**unknown, "language": _stt_language("", cfg)}
    language = _stt_language(provider, cfg)
    if provider == "local":
        model = _local_model(model) or str(((cfg.get("local") or {}) if isinstance(cfg.get("local"), dict) else {}).get("model") or "base")
        needs = not _hf_cached(_LOCAL_MODEL_REPOS.get(model, f"Systran/faster-whisper-{model}"))
        return {"kind": "local", "provider": provider, "needs_download": needs, "model": model,
                "download_mb": _LOCAL_MODEL_SIZES_MB.get(model) if needs else None, "language": language}
    kind = "command" if provider.startswith("local_command") or provider.startswith("command") else "cloud"
    return {"kind": kind, "provider": provider, "needs_download": False, "model": None, "download_mb": None, "language": language}


def transcribe(path: str, model=None, *, module=None, config=None) -> dict:
    """Transcribe one local audio file with Hermes' STT. ``{"transcript", "error", "provider"}``;
    error codes ``unsupported_type`` / ``not_found`` / ``too_large`` / ``failed: <reason>``.
    ``model`` (plugin setting) overrides the local model; a cloud provider keeps its own."""
    src = Path(path)
    if not src.is_absolute():
        raise ValueError(f"path must be absolute: {path}")
    if src.suffix.lower() not in AUDIO_EXTS:
        return {"transcript": None, "error": "unsupported_type", "provider": None}
    if not src.is_file():
        return {"transcript": None, "error": "not_found", "provider": None}
    if src.stat().st_size > MAX_TRANSCRIBE_BYTES:
        return {"transcript": None, "error": "too_large", "provider": None}
    try:
        stt = module or _stt_module()
        chosen = _local_model(model)
        if chosen:
            try:
                local = _stt_provider(_stt_config() if config is None else config) == "local"
            except Exception:  # noqa: BLE001 - unknown setup: leave the model to Hermes
                local = False
            chosen = chosen if local else None
        result = stt.transcribe_audio(str(src), model=chosen) if chosen else stt.transcribe_audio(str(src))
    except Exception as exc:  # noqa: BLE001 - surface any STT failure as a message
        return {"transcript": None, "error": f"failed: {exc}", "provider": None}
    if not isinstance(result, dict) or not result.get("success"):
        reason = (result or {}).get("error") if isinstance(result, dict) else None
        return {"transcript": None, "error": f"failed: {reason or 'unknown'}", "provider": (result or {}).get("provider") if isinstance(result, dict) else None}
    return {"transcript": str(result.get("transcript") or "").strip(), "error": None, "provider": result.get("provider")}


# ---- dogfood 11-07: «截图 N» chips bound to their attachment by content ----

MAX_DIGEST_FILES = 20
MAX_DIGEST_BYTES = 50 * 1024 * 1024
DIGEST_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".tif", ".tiff", ".heic", ".heif", ".bmp", ".avif"}


def file_digests(paths: Any, *, max_bytes: int = MAX_DIGEST_BYTES) -> dict:
    """SHA-256 of image attachment files, so a «截图 N» chip finds its own image at send.

    Only absolute paths to regular image files (by extension) up to ``max_bytes`` are read; anything
    else maps to None. More than ``MAX_DIGEST_FILES`` paths, or not a list, raises ValueError."""
    if not isinstance(paths, list):
        raise ValueError("paths must be a list")
    if len(paths) > MAX_DIGEST_FILES:
        raise ValueError(f"at most {MAX_DIGEST_FILES} paths")
    out: dict = {}
    for raw in paths:
        if not isinstance(raw, str):
            continue
        out[raw] = None
        path = Path(raw)
        try:
            if not path.is_absolute() or path.suffix.lower() not in DIGEST_EXTS or not path.is_file():
                continue
            if path.stat().st_size > max_bytes:
                continue
            digest = hashlib.sha256()
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
            out[raw] = digest.hexdigest()
        except OSError:
            out[raw] = None
    return out


# ---- dogfood 11-07: long pastes Desktop stored as composer-pastes/pasted_content_*.txt ----

PASTE_HEAD_CHARS = 200
MAX_PASTE_FILE_BYTES = 4 * 1024 * 1024
PASTE_FILE_RE = re.compile(r"^pasted_content_[\w-]+\.txt$")


def paste_files(paths: Any) -> dict:
    """Length and opening of Desktop's own long-paste files, so the plugin can tell which one holds
    the text it converted. Only ``<HERMES_HOME>/composer-pastes/pasted_content_*.txt`` is read;
    anything else maps to None. Not a list (or more than MAX_DIGEST_FILES) raises ValueError."""
    if not isinstance(paths, list):
        raise ValueError("paths must be a list")
    if len(paths) > MAX_DIGEST_FILES:
        raise ValueError(f"at most {MAX_DIGEST_FILES} paths")
    root = (hermes_home() / "composer-pastes").resolve()
    out: dict = {}
    for raw in paths:
        if not isinstance(raw, str):
            continue
        out[raw] = None
        path = Path(raw)
        try:
            if not path.is_absolute() or not PASTE_FILE_RE.match(path.name):
                continue
            resolved = path.resolve()
            if resolved.parent != root or not resolved.is_file() or resolved.stat().st_size > MAX_PASTE_FILE_BYTES:
                continue
            text = resolved.read_text(encoding="utf-8", errors="replace")
            out[raw] = {"chars": len(text), "head": text[:PASTE_HEAD_CHARS], "tail": text[-PASTE_HEAD_CHARS:]}
        except OSError:
            out[raw] = None
    return out


# ---- dogfood 11-07: long-paste Markdown kept on disk so a plugin reload does not lose it ----

MAX_MARKDOWN_BYTES = 4 * 1024 * 1024
MARKDOWN_NAME_RE = re.compile(r"^[0-9a-f]{20}\.md$")


def save_markdown(markdown: Any, cache_dir: Optional[str] = None, *, now: Optional[float] = None) -> dict:
    """Write a converted long paste to ``<cache>/<date>/<sha20>.md``. Returns ``{"path", "error"}``;
    errors ``not_text`` / ``too_large``. Same content → same file."""
    if not isinstance(markdown, str):
        return {"path": None, "error": "not_text"}
    data = markdown.encode("utf-8")
    if len(data) > MAX_MARKDOWN_BYTES:
        return {"path": None, "error": "too_large"}
    now = time.time() if now is None else now
    try:
        day = _date_dir(cache_root(cache_dir), now)
    except _UnsafeCache:
        return {"path": None, "error": UNSAFE_CACHE}
    out = day / f"{hashlib.sha256(data).hexdigest()[:20]}.md"
    if not _plain_file(out):
        _write_file(day, out, data)
    return {"path": str(out), "error": None}


def read_markdown(path: Any) -> dict:
    """Read back a file written by ``save_markdown``: an absolute ``<sha20>.md`` inside a
    ``rich-paste-cache`` directory, nothing else. Returns ``{"markdown", "error"}``."""
    if not isinstance(path, str):
        return {"markdown": None, "error": "not_found"}
    p = Path(path)
    try:
        # Only where save_markdown writes: <cache>/rich-paste-cache/<day>/<sha20>.md, checked on the
        # path as given and as resolved, so neither `..` nor a linked folder leads outside (review 11-08).
        if not p.is_absolute() or not MARKDOWN_NAME_RE.match(p.name) or ".." in p.parts:
            return {"markdown": None, "error": "not_found"}
        real = p.resolve()
        if p.parent.parent.name != CACHE_SUBDIR or real.parent.parent.name != CACHE_SUBDIR or real.parent.name != p.parent.name:
            return {"markdown": None, "error": "not_found"}
        if not _plain_file(p) or p.stat().st_size > MAX_MARKDOWN_BYTES:  # no links (review F3)
            return {"markdown": None, "error": "not_found"}
        return {"markdown": p.read_text(encoding="utf-8"), "error": None}
    except (OSError, UnicodeDecodeError):
        return {"markdown": None, "error": "not_found"}
