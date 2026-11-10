"""QA8: rp_cache downloads against a local http.server fixture (no internet)."""

import base64
import datetime as dt
import http.server
import ipaddress
import os
import socket
import sys
import threading
import urllib.parse
import time
from pathlib import Path

import pytest

import rp_cache

# dashboard/plugin_api.py loads rp_cache under this name; share the one module so monkeypatches reach the routes.
sys.modules.setdefault("rich_paste_rp_cache", rp_cache)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200
JPG = b"\xff\xd8\xff\xe0" + b"\x01" * 200
BIG = b"\x89PNG\r\n\x1a\n" + b"\x00" * (3 * 1024 * 1024)


class Handler(http.server.BaseHTTPRequestHandler):
    seen_headers = []

    def log_message(self, *args):
        pass

    def do_GET(self):  # noqa: N802
        Handler.seen_headers.append(dict(self.headers))
        if self.path.startswith("http://"):  # asked as an HTTP proxy (review F2 proxy test)
            self.path = urllib.parse.urlsplit(self.path).path
        redirects = {
            "/redirect-meta": "http://169.254.169.254/latest/meta-data/",
            "/redirect-lan": "http://10.0.0.1/a.png",
            "/redirect-ok": "/a.png",
        }
        if self.path in redirects:
            self.send_response(302)
            self.send_header("Location", redirects[self.path])
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        routes = {
            "/a.png": (200, PNG, True),
            "/b": (200, JPG, True),
            "/big.png": (200, BIG, True),
            "/big-nolen.png": (200, BIG, False),
            "/page.html": (200, b"<html>not an image</html>", True),
        }
        if self.path == "/redirect-file":
            self.send_response(302)
            self.send_header("Location", "file:///etc/passwd")
            self.end_headers()
            return
        if self.path == "/slow.png":  # review F6: two downloads of one URL overlap
            body = PNG + bytes(range(256)) * 64
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body[: len(body) // 2])
            self.wfile.flush()
            time.sleep(0.4)
            self.wfile.write(body[len(body) // 2:])
            return
        if self.path in ("/hotlink.png", "/always403.png"):
            # dogfood 11-10 (少数派's CDN): an empty Referer is refused, any Referer is let in.
            ok = self.path == "/hotlink.png" and bool(self.headers.get("Referer"))
            self.send_response(200 if ok else 403)
            self.send_header("Content-Length", str(len(PNG) if ok else 0))
            self.end_headers()
            if ok:
                self.wfile.write(PNG)
            return
        if self.path not in routes:
            self.send_response(404)
            self.end_headers()
            return
        code, body, with_length = routes[self.path]
        self.send_response(code)
        self.send_header("Content-Type", "application/octet-stream")
        if with_length:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


@pytest.fixture(scope="module")
def server():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


REAL_IP_BLOCKED = getattr(rp_cache, "_ip_blocked", None)


@pytest.fixture(autouse=True)
def _home_is_a_temp_dir(monkeypatch, tmp_path, tmp_path_factory):
    """Route tests pass tmp_path as cache_dir, which the backend takes only under the home directory
    (review F5); the default cache never lands in the real ~/.hermes."""
    monkeypatch.setenv("HOME", str(tmp_path_factory.getbasetemp()))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))


@pytest.fixture(autouse=True)
def _loopback_is_the_test_server(monkeypatch):
    """The fixture server listens on 127.0.0.1, which the address check refuses (review F2). Tests let exactly
    that address through; the F2 tests that need the real policy use ``real_policy``."""
    if REAL_IP_BLOCKED is not None:
        monkeypatch.setattr(rp_cache, "_ip_blocked", lambda ip: False if str(ip) == "127.0.0.1" else REAL_IP_BLOCKED(ip))


@pytest.fixture
def real_policy(monkeypatch):
    monkeypatch.setattr(rp_cache, "_ip_blocked", REAL_IP_BLOCKED)


@pytest.fixture
def fake_dns(monkeypatch):
    """``fake_dns.answers[host] = ["1.2.3.4"]`` (every lookup) or ``[["a"], ["b"]]`` (one list per lookup)."""
    answers: dict = {}
    calls: list = []
    real = rp_cache._resolve

    def resolve(host, port):
        calls.append(host)
        if host not in answers:
            return real(host, port)
        value = answers[host]
        ips = value.pop(0) if value and isinstance(value[0], list) else value
        return [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", (ip, port, 0, 0)) if ":" in ip
                else (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in ips]

    monkeypatch.setattr(rp_cache, "_resolve", resolve)
    resolve.answers, resolve.calls = answers, calls
    return resolve


def files_in(root: Path):
    return sorted(p.name for p in root.rglob("*") if p.is_file() and p.name != rp_cache.DIR_MARKER)


def test_downloads_into_dated_dir_with_sniffed_ext(server, tmp_path):
    Handler.seen_headers.clear()
    out = rp_cache.fetch_images([f"{server}/a.png", f"{server}/b"], cache_dir=str(tmp_path),
                                referer="https://blog.example.com/post")
    assert [r["error"] for r in out] == [None, None]
    today = dt.date.today().strftime("%Y%m%d")
    for r in out:
        path = Path(r["path"])
        assert path.is_absolute() and path.parent.name == today
        assert path.parent.parent == (tmp_path / "rich-paste-cache").resolve()
    assert out[0]["path"].endswith(".png") and out[1]["path"].endswith(".jpg")
    assert all("Mozilla" in h["User-Agent"] for h in Handler.seen_headers)
    assert all(h.get("Referer") == "https://blog.example.com/post" for h in Handler.seen_headers)


def test_over_limit_not_downloaded(server, tmp_path):
    urls = [f"{server}/a.png", f"{server}/b", f"{server}/a.png?x=1"]
    out = rp_cache.fetch_images(urls, max_images=2, cache_dir=str(tmp_path))
    assert [r["error"] for r in out] == [None, None, "over_limit"]
    assert out[2]["path"] is None
    assert len(files_in(tmp_path)) == 2


@pytest.mark.parametrize("bad", [0, -3, "abc", "", None])
def test_invalid_limits_mean_the_backend_caps(server, tmp_path, bad):
    out = rp_cache.fetch_images([f"{server}/a.png", f"{server}/b"], max_images=bad, max_mb=bad,
                                cache_dir=str(tmp_path))
    assert [r["error"] for r in out] == [None, None]


@pytest.mark.parametrize("name", ["big.png", "big-nolen.png"])
def test_size_limit_aborts_and_removes_partial(server, tmp_path, name):
    out = rp_cache.fetch_images([f"{server}/{name}"], max_mb=1, cache_dir=str(tmp_path))
    assert out[0]["error"] == "too_large" and out[0]["path"] is None
    assert files_in(tmp_path) == []  # no .part left behind


def test_not_an_image_is_rejected_and_removed(server, tmp_path):
    out = rp_cache.fetch_images([f"{server}/page.html"], cache_dir=str(tmp_path))
    assert out[0]["error"] == "not_image"
    assert files_in(tmp_path) == []


def test_http_error_and_unreachable(server, tmp_path):
    out = rp_cache.fetch_images([f"{server}/missing.png", "http://127.0.0.1:9/x.png"],
                                cache_dir=str(tmp_path), timeout=3)
    assert out[0]["error"] == "http_error:404"
    assert out[1]["error"].startswith("network_error")


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "ftp://example.com/a.png", "javascript:alert(1)", "blob:https://x/1",
    "data:text/html;base64,PGgxPg==", "/etc/passwd", "http://", 42, None,
])
def test_unsupported_schemes_rejected(tmp_path, url):
    out = rp_cache.fetch_images([url], cache_dir=str(tmp_path))
    assert out[0]["error"] == "unsupported_url" and out[0]["path"] is None
    assert files_in(tmp_path) == []


def test_redirect_to_file_scheme_refused(server, tmp_path):
    out = rp_cache.fetch_images([f"{server}/redirect-file"], cache_dir=str(tmp_path))
    assert out[0]["path"] is None
    assert files_in(tmp_path) == []


def test_data_url_image(tmp_path):
    url = "data:image/png;base64," + base64.b64encode(PNG).decode()
    out = rp_cache.fetch_images([url, "data:image/png;base64,!!!notbase64"], cache_dir=str(tmp_path))
    assert out[0]["error"] is None and Path(out[0]["path"]).read_bytes() == PNG
    assert out[1]["path"] is None and out[1]["error"] in ("bad_data_url", "not_image")


def test_data_url_size_limit(tmp_path):
    url = "data:image/png;base64," + base64.b64encode(BIG).decode()
    out = rp_cache.fetch_images([url], max_mb=1, cache_dir=str(tmp_path))
    assert out[0]["error"] == "too_large"


def test_paths_stay_inside_cache_dir(server, tmp_path):
    out = rp_cache.fetch_images([f"{server}/a.png?../../../../etc/x", f"{server}/../a.png"],
                                cache_dir=str(tmp_path))
    for r in out:
        if r["path"]:
            assert Path(r["path"]).resolve().is_relative_to(tmp_path.resolve())


def test_relative_cache_dir_refused():
    with pytest.raises(ValueError):
        rp_cache.fetch_images([], cache_dir="relative/dir")


def test_default_cache_dir_under_hermes_home(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hh"))
    assert rp_cache.resolve_cache_dir("") == tmp_path / "hh" / "cache" / "rich-paste"


def make_day(cache_dir: Path, days_ago: int, now: float, marked=True):
    day = cache_dir / rp_cache.CACHE_SUBDIR / dt.date.fromtimestamp(now - days_ago * 86400).strftime("%Y%m%d")
    day.mkdir(parents=True)
    (day / "x.png").write_bytes(PNG)
    if marked:
        (day / rp_cache.DIR_MARKER).touch()
    return day


def test_auto_delete_removes_only_expired_marked_dirs(server, tmp_path):
    now = time.time()
    old = make_day(tmp_path, 10, now)
    edge = make_day(tmp_path, 7, now)
    fresh = make_day(tmp_path, 2, now)
    foreign = make_day(tmp_path, 30, now, marked=False)  # a user's own folder named like a date
    other = tmp_path / rp_cache.CACHE_SUBDIR / "notes"
    other.mkdir()
    rp_cache.fetch_images([f"{server}/a.png"], cache_dir=str(tmp_path), auto_delete=True, days=7, now=now)
    assert not old.exists()
    assert edge.exists() and fresh.exists() and foreign.exists() and other.exists()


def test_auto_delete_off_keeps_everything(server, tmp_path):
    now = time.time()
    old = make_day(tmp_path, 100, now)
    rp_cache.fetch_images([f"{server}/a.png"], cache_dir=str(tmp_path), auto_delete=False, days=7, now=now)
    assert old.exists()


@pytest.mark.parametrize("bad", [0, -1, "x", None])
def test_cleanup_invalid_days_means_seven(tmp_path, bad):
    now = time.time()
    eight = make_day(tmp_path, 8, now)
    six = make_day(tmp_path, 6, now)
    assert rp_cache.cleanup(str(tmp_path), bad, now=now) == 1
    assert not eight.exists() and six.exists()


def test_cache_stats_counts_files_and_bytes(tmp_path):
    now = time.time()
    make_day(tmp_path, 1, now)
    day = make_day(tmp_path, 2, now)
    (day / "y.jpg").write_bytes(JPG)
    stats = rp_cache.cache_stats(str(tmp_path))
    assert stats == {"bytes": 2 * len(PNG) + len(JPG), "files": 3, "dir": str(tmp_path / "rich-paste-cache")}
    assert rp_cache.cache_stats(str(tmp_path / "missing")) == {"bytes": 0, "files": 0,
                                                               "dir": str(tmp_path / "missing" / "rich-paste-cache")}


def test_same_url_reuses_cached_file(server, tmp_path):
    first = rp_cache.fetch_images([f"{server}/a.png"], cache_dir=str(tmp_path))[0]["path"]
    mtime = os.path.getmtime(first)
    second = rp_cache.fetch_images([f"{server}/a.png"], cache_dir=str(tmp_path))[0]["path"]
    assert first == second and os.path.getmtime(second) == mtime


def test_plugin_api_routes(server, tmp_path):
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    import importlib.util
    spec = importlib.util.spec_from_file_location("rp_api_under_test",
                                                  Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = fastapi.FastAPI()
    app.include_router(module.router)
    client = TestClient(app)
    r = client.post("/fetch-images", json={"urls": [f"{server}/a.png", "file:///etc/passwd"],
                                           "limits": {"max_images": None, "max_mb": None},
                                           "cache_dir": str(tmp_path), "cleanup": {"auto_delete": True, "days": 7}})
    assert r.status_code == 200
    assert [x["error"] for x in r.json()["results"]] == [None, "unsupported_url"]
    assert client.get("/cache-stats", params={"cache_dir": str(tmp_path)}).json()["files"] == 1
    assert client.post("/cleanup", json={"cache_dir": str(tmp_path), "days": 7}).json() == {"removed": 0}
    assert client.post("/fetch-images", json={"urls": "x"}).status_code == 400
    relative = client.post("/fetch-images", json={"urls": [], "cache_dir": "rel"})
    assert relative.status_code == 200 and relative.json()["warning"], "review F5: ignored, not a 400"


def test_a_b1_preexisting_user_date_dirs_are_never_adopted_or_deleted(server, tmp_path):
    """A:B1 regression: a user folder chosen as cache_dir with its own dated folders survives
    downloads and later cleanups — both at the top level and inside rich-paste-cache/."""
    now = time.time()
    today = dt.date.fromtimestamp(now).strftime("%Y%m%d")
    user_top = tmp_path / today
    user_top.mkdir()
    (user_top / "holiday.jpg").write_bytes(JPG)
    user_inner = tmp_path / rp_cache.CACHE_SUBDIR / today      # same name the plugin will use today
    user_inner.mkdir(parents=True)
    (user_inner / "mine.txt").write_text("keep me")

    out = rp_cache.fetch_images([f"{server}/a.png"], cache_dir=str(tmp_path), now=now)
    assert out[0]["error"] is None
    assert not (user_inner / rp_cache.DIR_MARKER).exists(), "pre-existing dir must not be marked"

    later = now + 30 * 86400
    rp_cache.fetch_images([f"{server}/b"], cache_dir=str(tmp_path), auto_delete=True, days=7, now=later)
    rp_cache.cleanup(str(tmp_path), 1, now=later + 86400)
    assert (user_top / "holiday.jpg").read_bytes() == JPG
    assert (user_inner / "mine.txt").read_text() == "keep me"


def test_a_b1_plugin_created_date_dir_is_marked_and_expires(server, tmp_path):
    now = time.time() - 30 * 86400
    first = rp_cache.fetch_images([f"{server}/a.png"], cache_dir=str(tmp_path), now=now)[0]["path"]
    day = Path(first).parent
    assert (day / rp_cache.DIR_MARKER).is_file()
    rp_cache.fetch_images([f"{server}/b"], cache_dir=str(tmp_path), auto_delete=True, days=7)
    assert not day.exists()


def test_a_s4_cache_hit_respects_a_size_limit_turned_on_later(tmp_path):
    big = "data:image/png;base64," + base64.b64encode(BIG).decode()
    first = rp_cache.fetch_images([big], cache_dir=str(tmp_path))[0]
    assert first["error"] is None
    limited = rp_cache.fetch_images([big], max_mb=1, cache_dir=str(tmp_path))[0]
    assert limited == {"url": big, "path": None, "error": "too_large"}
    assert Path(first["path"]).is_file(), "the earlier legal cache entry is not deleted"
    again = rp_cache.fetch_images([big], cache_dir=str(tmp_path))[0]
    assert again["path"] == first["path"]


# ---- dogfood D5: Finder copies (files and folders) whose path Chromium hides ----

import json
import subprocess
from types import SimpleNamespace


def _runner(stdout="", returncode=0, exc=None):
    calls = []

    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        if exc:
            raise exc
        return SimpleNamespace(returncode=returncode, stdout=stdout, stderr="")

    run.calls = calls
    return run


def test_d5_clipboard_file_paths_reads_files_and_folders(tmp_path):
    folder = tmp_path / "ssh heavy"
    folder.mkdir()
    doc = tmp_path / "a.pdf"
    doc.write_bytes(b"%PDF")
    run = _runner(json.dumps([str(folder), str(doc), str(tmp_path / "gone.txt"), "relative.txt", 3]))
    out = rp_cache.clipboard_file_paths(run=run, platform="darwin")
    assert out == {"ok": True, "files": [{"path": str(folder), "is_dir": True}, {"path": str(doc), "is_dir": False}]}
    argv, kwargs = run.calls[0]
    assert argv[:3] == ["/usr/bin/osascript", "-l", "JavaScript"]
    assert kwargs["timeout"] <= 5 and kwargs.get("check") is False


@pytest.mark.parametrize("run", [
    _runner(exc=subprocess.TimeoutExpired("osascript", 3)),
    _runner(exc=OSError("no osascript")),
    _runner(returncode=1),
    _runner(stdout="not json"),
    _runner(stdout='{"a": 1}'),
])
def test_d5_clipboard_file_paths_fails_closed(run):
    assert rp_cache.clipboard_file_paths(run=run, platform="darwin") == {"ok": False, "reason": "unavailable", "files": []}


def test_d5_clipboard_file_paths_other_platforms_unsupported():
    run = _runner("[]")
    assert rp_cache.clipboard_file_paths(run=run, platform="linux") == {"ok": False, "reason": "unsupported", "files": []}
    assert run.calls == []


def test_d5_clipboard_file_paths_caps_count(tmp_path):
    paths = []
    for i in range(rp_cache.MAX_CLIPBOARD_FILES + 5):
        p = tmp_path / f"f{i}.txt"
        p.write_text("x")
        paths.append(str(p))
    out = rp_cache.clipboard_file_paths(run=_runner(json.dumps(paths)), platform="darwin")
    assert len(out["files"]) == rp_cache.MAX_CLIPBOARD_FILES


def test_d5_clipboard_files_route(monkeypatch, tmp_path):
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    import importlib.util
    spec = importlib.util.spec_from_file_location("rp_api_under_test_d5",
                                                  Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.rp_cache, "clipboard_file_paths", lambda: {"ok": True, "files": [{"path": "/x", "is_dir": True}]})
    app = fastapi.FastAPI()
    app.include_router(module.router)
    assert TestClient(app).get("/clipboard-files").json() == {"ok": True, "files": [{"path": "/x", "is_dir": True}]}


# ---- dogfood D6: send-time PNG for TIFF/HEIC/BMP ----

def _tiff(path, color=(200, 10, 10)):
    Image = pytest.importorskip("PIL.Image")
    Image.new("RGB", (6, 4), color).save(path, format="TIFF")
    return path


def test_d6_to_png_converts_tiff_into_cache_and_reuses_it(tmp_path):
    PIL = pytest.importorskip("PIL.Image")
    src = _tiff(tmp_path / "file-raycast.tiff")
    cache = tmp_path / "cache"
    out = rp_cache.to_png(str(src), str(cache))
    assert out["error"] is None and out["path"].endswith(".png")
    assert "/rich-paste-cache/" in out["path"]
    with PIL.open(out["path"]) as img:
        assert img.format == "PNG" and img.size == (6, 4)
    assert rp_cache.to_png(str(src), str(cache)) == out
    assert not list(Path(out["path"]).parent.glob("*.part"))


def test_d6_to_png_errors(tmp_path):
    pytest.importorskip("PIL.Image")
    png = tmp_path / "a.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n")
    assert rp_cache.to_png(str(png), str(tmp_path))["error"] == "unsupported_type"
    assert rp_cache.to_png(str(tmp_path / "gone.tiff"), str(tmp_path))["error"] == "not_found"
    bad = tmp_path / "bad.tiff"
    bad.write_bytes(b"II*\x00garbage")
    assert rp_cache.to_png(str(bad), str(tmp_path))["error"] == "decode_failed"
    with pytest.raises(ValueError):
        rp_cache.to_png("rel.tiff", str(tmp_path))


def test_d6_to_png_size_cap(monkeypatch, tmp_path):
    src = _tiff(tmp_path / "big.tiff")
    monkeypatch.setattr(rp_cache, "MAX_CONVERT_BYTES", 10)
    assert rp_cache.to_png(str(src), str(tmp_path)) == {"path": None, "error": "too_large"}


def test_d6_to_png_route(tmp_path):
    fastapi = pytest.importorskip("fastapi")
    pytest.importorskip("PIL.Image")
    from fastapi.testclient import TestClient
    import importlib.util
    spec = importlib.util.spec_from_file_location("rp_api_under_test_d6",
                                                  Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = fastapi.FastAPI()
    app.include_router(module.router)
    client = TestClient(app)
    src = _tiff(tmp_path / "x.tiff")
    r = client.post("/to-png", json={"path": str(src), "cache_dir": str(tmp_path / "c")})
    assert r.status_code == 200 and r.json()["path"].endswith(".png")
    assert client.post("/to-png", json={"path": 3}).status_code == 400
    assert client.post("/to-png", json={"path": "rel.tiff"}).status_code == 400


def test_d7_version_route_matches_desktop_constant():
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    import importlib.util
    import re
    root = Path(__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location("rp_api_under_test_d7", root / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = fastapi.FastAPI()
    app.include_router(module.router)
    api = TestClient(app).get("/version").json()["api"]
    desktop = re.search(r"export const BACKEND_API = (\d+)", (root / "desktop" / "src" / "plugin.ts").read_text()).group(1)
    assert api == module.API_VERSION == int(desktop)


# ---- dogfood D9: preview copies of pasted images ----

def _data_url(raw: bytes, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


def test_d9_save_preview_png_kept_and_reused(tmp_path):
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    out = rp_cache.save_preview(_data_url(png, "image/png"), str(tmp_path))
    assert out["error"] is None and out["path"].endswith(".png") and Path(out["path"]).read_bytes() == png
    assert rp_cache.save_preview(_data_url(png, "image/png"), str(tmp_path)) == out


def test_d9_save_preview_tiff_becomes_png(tmp_path):
    PIL = pytest.importorskip("PIL.Image")
    src = _tiff(tmp_path / "s.tiff")
    out = rp_cache.save_preview(_data_url(src.read_bytes(), "image/tiff"), str(tmp_path / "c"))
    assert out["error"] is None and out["path"].endswith(".png")
    with PIL.open(out["path"]) as img:
        assert img.format == "PNG"
    assert not list(Path(out["path"]).parent.glob("*.src.*")), "the raw upload is removed"


def test_d9_save_preview_rejects(monkeypatch, tmp_path):
    assert rp_cache.save_preview("https://x/a.png", str(tmp_path))["error"] == "not_an_image"
    assert rp_cache.save_preview(None, str(tmp_path))["error"] == "not_an_image"
    assert rp_cache.save_preview("data:image/png,raw", str(tmp_path))["error"] == "not_an_image"
    assert rp_cache.save_preview(_data_url(b"hello", "image/x-foo"), str(tmp_path))["error"] == "unsupported_type"
    monkeypatch.setattr(rp_cache, "MAX_PREVIEW_BYTES", 10)
    assert rp_cache.save_preview(_data_url(b"\x89PNG\r\n\x1a\n" + b"0" * 64, "image/png"), str(tmp_path))["error"] == "too_large"


# ---- dogfood D10: transcription ----

class _FakeSTT:
    def __init__(self, provider="local", cfg=None, result=None, raises=None):
        self.provider, self.cfg, self.result, self.raises, self.calls = provider, cfg or {"local": {"model": "base"}}, result, raises, []

    def _load_stt_config(self):
        return self.cfg

    def _get_provider(self, cfg):
        if self.raises == "provider":
            raise RuntimeError("boom")
        return self.provider

    def _resolve_stt_language(self, provider, cfg):
        return "en"

    def transcribe_audio(self, path, model=None):
        self.calls.append(path)
        self.models = getattr(self, "models", []) + [model]
        if self.raises == "transcribe":
            raise RuntimeError("model crashed")
        return self.result


def test_d10_stt_status_local_needs_download(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_HOME", str(tmp_path))
    out = rp_cache.stt_status(config={"provider": "local", "language": "en"})
    assert out == {"kind": "local", "provider": "local", "needs_download": True, "model": "base", "download_mb": 150, "language": "en"}
    (tmp_path / "hub" / "models--Systran--faster-whisper-base").mkdir(parents=True)
    assert rp_cache.stt_status(config={"provider": "local", "language": "en"})["needs_download"] is False


def test_d10_stt_status_cloud_none_unknown():
    assert rp_cache.stt_status(config={"provider": "xai", "language": "en"})["kind"] == "cloud"
    assert rp_cache.stt_status(config={"provider": "local_command", "language": "en"})["kind"] == "command"
    assert rp_cache.stt_status(config={"enabled": False})["kind"] == "none"
    monkeypatch_free = rp_cache._faster_whisper_installed
    rp_cache._faster_whisper_installed = lambda: False
    try:
        assert rp_cache.stt_status(config={})["kind"] == "unknown", "no provider and no local backend: Hermes looks at cloud keys"
        rp_cache._faster_whisper_installed = lambda: True
        assert rp_cache.stt_status(config={})["kind"] == "local", "auto-detection tries a local backend first"
    finally:
        rp_cache._faster_whisper_installed = monkeypatch_free
    assert rp_cache.stt_status(config={"provider": 3})["kind"] == "unknown"


def test_d10_transcribe(tmp_path):
    audio = tmp_path / "voice memo.m4a"
    audio.write_bytes(b"\x00" * 10)
    ok = _FakeSTT(result={"success": True, "transcript": " 你好 ", "provider": "xai"})
    assert rp_cache.transcribe(str(audio), module=ok) == {"transcript": "你好", "error": None, "provider": "xai"}
    assert ok.calls == [str(audio)]
    bad = _FakeSTT(result={"success": False, "error": "no key"})
    assert rp_cache.transcribe(str(audio), module=bad)["error"] == "failed: no key"
    assert rp_cache.transcribe(str(audio), module=_FakeSTT(raises="transcribe"))["error"] == "failed: model crashed"
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(b"%PDF")
    assert rp_cache.transcribe(str(pdf), module=ok)["error"] == "unsupported_type"
    assert rp_cache.transcribe(str(tmp_path / "gone.mp3"), module=ok)["error"] == "not_found"
    with pytest.raises(ValueError):
        rp_cache.transcribe("rel.mp3", module=ok)


def test_d10_transcribe_size_cap(monkeypatch, tmp_path):
    audio = tmp_path / "long.mp3"
    audio.write_bytes(b"\x00" * 100)
    monkeypatch.setattr(rp_cache, "MAX_TRANSCRIBE_BYTES", 10)
    assert rp_cache.transcribe(str(audio), module=_FakeSTT())["error"] == "too_large"


# ---- dogfood 11-07: «截图 N» bound to its attachment by content ----

def test_1107_save_preview_returns_the_pasted_bytes_digest(tmp_path):
    import hashlib
    png = b"\x89PNG\r\n\x1a\n" + b"\x01" * 40
    out = rp_cache.save_preview(_data_url(png, "image/png"), str(tmp_path))
    assert out["sha256"] == hashlib.sha256(png).hexdigest()
    bad = rp_cache.save_preview(_data_url(b"hello", "image/x-foo"), str(tmp_path))
    assert bad["error"] == "unsupported_type" and bad["sha256"] == hashlib.sha256(b"hello").hexdigest()


def test_1107_file_digests_images_only_with_limits(tmp_path):
    import hashlib
    img = tmp_path / "composer_a.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x02" * 10)
    text = tmp_path / "notes.txt"
    text.write_text("secret")
    big = tmp_path / "big.png"
    big.write_bytes(b"\x00" * 16)
    out = rp_cache.file_digests([str(img), str(text), "relative.png", str(tmp_path / "missing.png"), str(tmp_path), 42, str(big)],
                                max_bytes=8)
    assert out == {
        str(img): None,  # over max_bytes in this call
        str(text): None, "relative.png": None, str(tmp_path / "missing.png"): None, str(tmp_path): None, str(big): None,
    }
    out = rp_cache.file_digests([str(img), str(text)])
    assert out[str(img)] == hashlib.sha256(img.read_bytes()).hexdigest()
    assert out[str(text)] is None, "not an image: never hashed"
    with pytest.raises(ValueError):
        rp_cache.file_digests([str(img)] * (rp_cache.MAX_DIGEST_FILES + 1))
    with pytest.raises(ValueError):
        rp_cache.file_digests("not a list")


def test_1107_file_digests_route():
    import importlib.util
    import fastapi
    from fastapi.testclient import TestClient
    root = Path(__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location("rp_api_under_test_1107", root / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = fastapi.FastAPI()
    app.include_router(module.router)
    client = TestClient(app)
    assert client.post("/file-digests", json={"paths": ["relative.png"]}).json() == {"digests": {"relative.png": None}}
    assert client.post("/file-digests", json={"paths": "x"}).status_code == 400


# ---- dogfood 11-07: long pastes Desktop turned into pasted_content_*.txt ----

def test_1107_paste_files_reads_only_desktop_paste_files(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    pastes = tmp_path / "home" / "composer-pastes"
    pastes.mkdir(parents=True)
    good = pastes / "pasted_content_2026-11-07_16-02-18-458_4daa59.txt"
    good.write_text("一万两千行列表\n第 1 行", encoding="utf-8")
    other = pastes / "notes.txt"
    other.write_text("x")
    outside = tmp_path / "pasted_content_x.txt"
    outside.write_text("secret")
    out = rp_cache.paste_files([str(good), str(other), str(outside), "relative.txt", 7])
    assert out[str(good)] == {"chars": len("一万两千行列表\n第 1 行"), "head": "一万两千行列表\n第 1 行", "tail": "一万两千行列表\n第 1 行"}
    assert out[str(other)] is None and out[str(outside)] is None and out["relative.txt"] is None
    big = pastes / "pasted_content_big.txt"
    big.write_text("字" * 500 + "尾", encoding="utf-8")
    info = rp_cache.paste_files([str(big)])[str(big)]
    assert len(info["head"]) == rp_cache.PASTE_HEAD_CHARS
    assert len(info["tail"]) == rp_cache.PASTE_HEAD_CHARS and info["tail"].endswith("尾"), "review 11-08: the end tells alike openings apart"
    with pytest.raises(ValueError):
        rp_cache.paste_files("x")


def test_1107_paste_files_route(tmp_path, monkeypatch):
    import importlib.util
    import fastapi
    from fastapi.testclient import TestClient
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    root = Path(__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location("rp_api_under_test_paste", root / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = fastapi.FastAPI()
    app.include_router(module.router)
    client = TestClient(app)
    assert client.post("/paste-files", json={"paths": ["a.txt"]}).json() == {"files": {"a.txt": None}}
    assert client.post("/paste-files", json={"paths": 1}).status_code == 400


# ---- dogfood 11-07: long-paste Markdown kept on disk (survives a plugin reload) ----

def test_1107_save_and_read_markdown(tmp_path):
    md = "## 长文\n\n" + "字" * 1000 + "\n\n![一](/c/1.png)"
    out = rp_cache.save_markdown(md, str(tmp_path))
    assert out["error"] is None and out["path"].endswith(".md") and "rich-paste-cache" in out["path"]
    assert rp_cache.save_markdown(md, str(tmp_path)) == out, "same content, same file"
    assert rp_cache.read_markdown(out["path"]) == {"markdown": md, "error": None}


def test_1107_markdown_routes_refuse_what_is_not_theirs(tmp_path):
    other = tmp_path / "notes.md"
    other.write_text("secret")
    assert rp_cache.read_markdown(str(other))["markdown"] is None
    fake = tmp_path / "rich-paste-cache" / "20261108"
    fake.mkdir(parents=True)
    (fake / "id_rsa.md").write_text("x")
    assert rp_cache.read_markdown(str(fake / "id_rsa.md"))["markdown"] is None, "only our own hashed names"
    assert rp_cache.read_markdown("relative.md")["markdown"] is None
    assert rp_cache.read_markdown(None)["markdown"] is None
    assert rp_cache.save_markdown(123, str(tmp_path))["error"] == "not_text"
    assert rp_cache.save_markdown("x" * (rp_cache.MAX_MARKDOWN_BYTES + 1), str(tmp_path))["error"] == "too_large"


def test_1108_read_markdown_stays_inside_the_cache(tmp_path):
    """Review 11-08 (B6): a path that names rich-paste-cache but climbs out of it with .. is refused."""
    outside = tmp_path / "0123456789abcdef0123.md"
    outside.write_text("OUTSIDE-CACHE-PRIVATE-CONTENT")
    (tmp_path / "rich-paste-cache").mkdir()
    climbing = str(tmp_path / "rich-paste-cache" / ".." / "0123456789abcdef0123.md")
    assert rp_cache.read_markdown(climbing)["markdown"] is None
    loose = tmp_path / "rich-paste-cache" / "0123456789abcdef0123.md"
    loose.write_text("not in a day folder")
    assert rp_cache.read_markdown(str(loose))["markdown"] is None, "save_markdown only writes into a day folder"
    linked = tmp_path / "x" / "rich-paste-cache" / "20261108"
    linked.parent.mkdir(parents=True)
    linked.symlink_to(tmp_path, target_is_directory=True)
    assert rp_cache.read_markdown(str(linked / "0123456789abcdef0123.md"))["markdown"] is None, "a linked day folder leads elsewhere"


def test_1108_read_markdown_not_utf8_is_not_found(tmp_path):
    day = tmp_path / "rich-paste-cache" / "20261108"
    day.mkdir(parents=True)
    (day / "0123456789abcdef0123.md").write_bytes(b"\xff\xfe\x00broken")
    assert rp_cache.read_markdown(str(day / "0123456789abcdef0123.md")) == {"markdown": None, "error": "not_found"}


def test_1107_markdown_routes():
    import importlib.util
    import fastapi
    from fastapi.testclient import TestClient
    root = Path(__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location("rp_api_under_test_md", root / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = fastapi.FastAPI()
    app.include_router(module.router)
    client = TestClient(app)
    assert client.post("/read-markdown", json={"path": "x.md"}).json() == {"markdown": None, "error": "not_found"}
    assert client.post("/save-markdown", json={"markdown": 1}).json()["error"] == "not_text"


# ---- 11-08: the user picks the local model in the plugin settings ----

def test_stt_model_choice_reaches_local_only(tmp_path):
    audio = tmp_path / "a.m4a"
    audio.write_bytes(b"x")
    ok = {"success": True, "transcript": "你好", "provider": "local"}
    local = _FakeSTT("local", result=ok)
    rp_cache.transcribe(str(audio), model="small", module=local, config={"provider": "local"})
    rp_cache.transcribe(str(audio), module=local, config={"provider": "local"})
    rp_cache.transcribe(str(audio), model="evil; rm", module=local, config={"provider": "local"})
    assert local.models == ["small", None, None]
    cloud = _FakeSTT("xai", result=ok)
    rp_cache.transcribe(str(audio), model="small", module=cloud, config={"provider": "xai"})
    assert cloud.models == [None], "a cloud provider keeps its own model"


def test_stt_status_reports_the_chosen_model(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_HOME", str(tmp_path))
    out = rp_cache.stt_status(model="small", config={"provider": "local", "language": "en"})
    assert (out["model"], out["needs_download"], out["download_mb"]) == ("small", True, 490)
    turbo = rp_cache.stt_status(model="turbo", config={"provider": "local", "language": "en"})
    assert (turbo["model"], turbo["download_mb"]) == ("turbo", 1620)
    (tmp_path / "hub" / "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo").mkdir(parents=True)
    assert rp_cache.stt_status(model="turbo", config={"provider": "local", "language": "en"})["needs_download"] is False
    assert rp_cache.stt_status(model="bogus", config={"provider": "local", "language": "en"})["model"] == "base"
    assert rp_cache.stt_status(model="small", config={"provider": "xai", "language": "en"})["model"] is None


# ---- dogfood 11-10: SVG images (diagrams on blogs) become PNG; models do not take SVG ----

def _svg_url(markup: str) -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(markup.encode()).decode()


def _png_size(path):
    from PIL import Image
    with Image.open(path) as image:
        return image.size, image.convert("RGB").getpixel((image.width // 2, image.height // 2))


def test_svg_becomes_png_at_twice_its_size_on_white(tmp_path):
    svg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect x="15" y="5" width="10" height="10" fill="red"/></svg>'
    out = rp_cache.fetch_images([_svg_url(svg)], cache_dir=str(tmp_path))
    assert out[0]["error"] is None, out
    assert out[0]["path"].endswith(".png")
    assert Path(out[0]["path"]).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    size, centre = _png_size(out[0]["path"])
    assert size == (80, 40)
    assert centre == (255, 0, 0)
    assert not [p for p in files_in(tmp_path) if p.endswith(".part") or p.endswith(".svg")]


def test_svg_from_server_without_xml_prolog(tmp_path):
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 10"><rect width="30" height="10" fill="blue"/></svg>'
    out = rp_cache.fetch_images([_svg_url(svg)], cache_dir=str(tmp_path))
    assert out[0]["error"] is None, out
    size, centre = _png_size(out[0]["path"])
    assert size == (60, 20) and centre == (0, 0, 255)


def test_svg_never_draws_local_files(tmp_path):
    from PIL import Image
    secret = tmp_path / "secret.png"
    Image.new("RGB", (10, 10), (0, 255, 0)).save(secret)
    for href in (str(secret), secret.as_uri(), "secret.png"):
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">'
               f'<image href="{href}" width="10" height="10"/><image xlink:href="{href}" width="10" height="10"/></svg>')
        out = rp_cache.fetch_images([_svg_url(svg)], cache_dir=str(tmp_path), auto_delete=False)
        assert out[0]["error"] is None, out
        assert _png_size(out[0]["path"])[1] == (255, 255, 255), href


def test_svg_never_draws_local_files_through_any_namespace_prefix(tmp_path):
    """Review 11-10: `xmlns:x=".../xlink"` + `x:href` is xlink:href to resvg; any prefix is stripped."""
    from PIL import Image
    secret = tmp_path / "secret.png"
    Image.new("RGB", (10, 10), (0, 255, 0)).save(secret)
    for prefix in ("x", "a-b.c", "XLINK"):
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:{prefix}="http://www.w3.org/1999/xlink" width="10" height="10">'
               f'<image {prefix}:href="{secret}" width="10" height="10"/></svg>')
        out = rp_cache.fetch_images([_svg_url(svg)], cache_dir=str(tmp_path), auto_delete=False)
        assert out[0]["error"] is None, out
        assert _png_size(out[0]["path"])[1] == (255, 255, 255), prefix


def test_svg_with_entity_declarations_is_refused(tmp_path):
    """An internal DTD subset could expand into markup the href filter never sees."""
    svg = ('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY i "<image href=\'/etc/x.png\'/>">]>'
           '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">&i;</svg>')
    out = rp_cache.fetch_images([_svg_url(svg)], cache_dir=str(tmp_path), auto_delete=False)
    assert out[0]["path"] is None and out[0]["error"], out


def test_huge_svg_is_capped(tmp_path):
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="50000"><rect width="100%" height="100%" fill="red"/></svg>'
    out = rp_cache.fetch_images([_svg_url(svg)], cache_dir=str(tmp_path))
    assert out[0]["error"] is None, out
    size, _ = _png_size(out[0]["path"])
    assert max(size) == rp_cache.SVG_MAX_SIDE and size[0] == 2 * size[1]


def test_text_that_is_not_svg_is_still_not_an_image(tmp_path):
    url = "data:image/svg+xml;base64," + base64.b64encode(b"<html><body>svg</body></html>").decode()
    out = rp_cache.fetch_images([url], cache_dir=str(tmp_path))
    assert out[0]["error"] == "not_image"


def test_hotlink_403_retries_once_with_the_image_sites_own_origin(server, tmp_path):
    Handler.seen_headers.clear()
    out = rp_cache.fetch_images([f"{server}/hotlink.png"], cache_dir=str(tmp_path))
    assert out[0]["error"] is None, out
    assert [h.get("Referer") for h in Handler.seen_headers] == [None, f"{server}/"]


def test_a_real_403_is_still_an_error_after_one_retry(server, tmp_path):
    Handler.seen_headers.clear()
    out = rp_cache.fetch_images([f"{server}/always403.png"], cache_dir=str(tmp_path))
    assert out[0]["error"] == "http_error:403"
    assert len(Handler.seen_headers) == 2


def test_no_retry_when_a_referer_was_given(server, tmp_path):
    Handler.seen_headers.clear()
    out = rp_cache.fetch_images([f"{server}/always403.png"], cache_dir=str(tmp_path), referer="https://blog.example.com/p")
    assert out[0]["error"] == "http_error:403"
    assert len(Handler.seen_headers) == 1


def test_results_carry_the_image_size_for_the_small_image_rule(tmp_path):
    # dogfood 11-10: the desktop half leaves out avatars and icons (≤ 96 px) next to real pictures.
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (1, 2, 3)).save(buf, format="PNG")
    url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    out = rp_cache.fetch_images([url, "data:image/png;base64," + base64.b64encode(PNG).decode()], cache_dir=str(tmp_path))
    assert out[0]["size"] == [64, 48]
    assert out[1]["error"] is None and "size" not in out[1]  # a file PIL cannot read just has no size


# ---- security review 2026-11-06 ----

ROOT = Path(__file__).resolve().parent.parent


def _api(name):
    """The plugin's FastAPI routes under a TestClient (a 500 raises in the test)."""
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, ROOT / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = fastapi.FastAPI()
    app.include_router(module.router)
    return TestClient(app), module


def _post_raw(client, path, text):
    return client.post(path, content=text.encode(), headers={"content-type": "application/json"})


# F7: odd numbers and odd types are refused or ignored, never a 500.

@pytest.mark.parametrize("value", [float("inf"), float("-inf"), float("nan"), True, False, "5", "abc", [3], {"n": 3},
                                   None, 0, 0.5, -2, 10 ** 400])
def test_f7_positive_rejects_what_is_not_a_finite_number(value):
    assert rp_cache._positive(value) is None


def test_f7_positive_keeps_finite_numbers():
    assert rp_cache._positive(3) == 3.0 and rp_cache._positive(2.5) == 2.5


def test_f7_infinity_limits_and_days_do_not_raise(tmp_path):
    assert rp_cache.cleanup(str(tmp_path), float("inf")) == 0
    assert rp_cache.cleanup(str(tmp_path), 10 ** 400) == 0
    out = rp_cache.fetch_images([_data_url(PNG, "image/png")], max_images=float("inf"), max_mb=float("nan"),
                                days=float("inf"), cache_dir=str(tmp_path))
    assert out[0]["error"] is None, out


def test_f7_non_string_cache_dir_and_referer_do_not_raise(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hh"))
    out = rp_cache.fetch_images([_data_url(PNG, "image/png")], cache_dir=5, referer=7)
    assert out[0]["error"] is None, out
    assert Path(out[0]["path"]).is_relative_to((tmp_path / "hh").resolve()), "a non-string cache_dir means the default"


def test_f7_routes_answer_odd_bodies_with_4xx_or_a_clean_result(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hh"))
    client, _module = _api("rp_api_under_test_f7")
    r = _post_raw(client, "/fetch-images",
                  '{"urls": [], "limits": {"max_images": Infinity, "max_mb": NaN}, "cleanup": {"days": Infinity}}')
    assert r.status_code == 200 and r.json()["results"] == []
    assert _post_raw(client, "/cleanup", '{"days": Infinity}').json()["removed"] == 0
    assert _post_raw(client, "/cleanup", '{"days": 1e999, "cache_dir": 5}').json()["removed"] == 0
    data = _data_url(PNG, "image/png")
    r = client.post("/fetch-images", json={"urls": [data, {"a": 1}, None, 5], "pageUrl": 7, "cache_dir": ["x"],
                                           "limits": "x", "cleanup": 5})
    assert r.status_code == 200
    assert [x["error"] for x in r.json()["results"]] == [None, "unsupported_url", "unsupported_url", "unsupported_url"]
    assert client.post("/save-markdown", json={"markdown": "x", "cache_dir": {"a": 1}}).json()["error"] is None
    assert client.post("/save-preview", json={"data_url": data, "cache_dir": 3}).json()["error"] is None
    routes = ("/fetch-images", "/cleanup", "/to-png", "/save-preview", "/save-markdown", "/file-digests", "/paste-files",
              "/read-markdown", "/transcribe")
    bodies = ("[1, 2]", "not json", '"x"', "null", "{}", '{"cache_dir": {"a": 1}, "path": 5, "paths": 5, "urls": 5}')
    for route in routes:
        for body in bodies:
            status = _post_raw(client, route, body).status_code
            assert status == 200 or 400 <= status < 500, (route, body, status)


# F2: no fetches of loopback / private / link-local / ... addresses, every hop checked; backend hard caps.

@pytest.mark.parametrize("address", [
    "127.0.0.1", "127.8.9.10", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "2002:7f00:1::1", "2002:a9fe:a9fe::1",
    "64:ff9b::7f00:1", "64:ff9b::a00:1",
])
def test_f2_blocked_addresses(address, real_policy):
    assert REAL_IP_BLOCKED(ipaddress.ip_address(address)) is True


@pytest.mark.parametrize("address", ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:93.184.216.34"])
def test_f2_public_addresses_allowed(address, real_policy):
    assert REAL_IP_BLOCKED(ipaddress.ip_address(address)) is False


def test_f2_fake_ip_range_only_when_it_comes_from_dns(real_policy):
    # Clash / Surge "fake-ip" answer every lookup from 198.18.0.0/15 (this is how the author's machine resolves).
    fake = ipaddress.ip_address("198.18.0.34")
    assert rp_cache._addr_blocked(fake, from_dns=True) is False
    assert rp_cache._addr_blocked(fake, from_dns=False) is True
    assert rp_cache._addr_blocked(ipaddress.ip_address("10.0.0.1"), from_dns=True) is True


def test_f2_internal_urls_refused_before_connecting(server, tmp_path, real_policy):
    port = server.rsplit(":", 1)[1]
    urls = [f"{server}/a.png", f"http://localhost:{port}/a.png", f"http://[::1]:{port}/a.png",
            f"http://0.0.0.0:{port}/a.png", f"http://2130706433:{port}/a.png", f"http://0x7f000001:{port}/a.png",
            f"http://127.1:{port}/a.png", f"http://[::ffff:127.0.0.1]:{port}/a.png",
            "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/a.png", "https://192.168.1.1/a.png",
            "http://198.18.0.34/a.png", "http://224.0.0.1/a.png"]
    Handler.seen_headers.clear()
    out = rp_cache.fetch_images(urls, cache_dir=str(tmp_path), timeout=3)
    assert [r["error"] for r in out] == ["blocked_address"] * len(urls), out
    assert Handler.seen_headers == [], "nothing reached the server"
    assert files_in(tmp_path) == []


def test_f2_every_redirect_hop_is_checked(server, tmp_path):
    out = rp_cache.fetch_images([f"{server}/redirect-meta", f"{server}/redirect-lan", f"{server}/redirect-ok"],
                                cache_dir=str(tmp_path), timeout=3)
    assert [r["error"] for r in out] == ["blocked_address", "blocked_address", None], out


def test_f2_connects_to_the_address_it_checked(server, tmp_path, fake_dns):
    port = server.rsplit(":", 1)[1]
    fake_dns.answers.update({"img.test": ["127.0.0.1"], "lan.test": ["10.0.0.1"], "mixed.test": ["127.0.0.1", "10.0.0.2"]})
    Handler.seen_headers.clear()
    out = rp_cache.fetch_images([f"http://img.test:{port}/a.png", f"http://lan.test:{port}/a.png",
                                 f"http://mixed.test:{port}/a.png"], cache_dir=str(tmp_path), timeout=3)
    assert [r["error"] for r in out] == [None, "blocked_address", "blocked_address"], out
    assert [h["Host"] for h in Handler.seen_headers] == [f"img.test:{port}"]


def test_f2_hotlink_retry_is_checked_again(server, tmp_path, fake_dns):
    # DNS answers a public-looking (here: the test server) address first and a private one on the retry.
    port = server.rsplit(":", 1)[1]
    fake_dns.answers["hot.test"] = [["127.0.0.1"], ["10.0.0.1"]]
    Handler.seen_headers.clear()
    out = rp_cache.fetch_images([f"http://hot.test:{port}/hotlink.png"], cache_dir=str(tmp_path), timeout=3)
    assert out[0]["error"] == "blocked_address", out
    assert fake_dns.calls == ["hot.test", "hot.test"]
    assert len(Handler.seen_headers) == 1


def test_f2_through_a_proxy_the_url_host_is_checked(server, tmp_path, fake_dns, monkeypatch):
    for name in ("no_proxy", "NO_PROXY"):
        monkeypatch.setenv(name, "nothing.invalid")
    monkeypatch.setattr(rp_cache, "_OPENER", rp_cache._build_opener({"http": server}))
    fake_dns.answers.update({"img.test": ["93.184.216.34"], "lan.test": ["10.0.0.9"]})
    Handler.seen_headers.clear()
    out = rp_cache.fetch_images(["http://img.test/a.png", "http://10.0.0.1/a.png", "http://lan.test/a.png"],
                                cache_dir=str(tmp_path), timeout=3)
    assert [r["error"] for r in out] == [None, "blocked_address", "blocked_address"], out
    assert [h["Host"] for h in Handler.seen_headers] == ["img.test"], "only the public host went to the proxy"


def test_f2_backend_caps_count_at_50_whatever_the_client_sends(tmp_path):
    urls = [_data_url(PNG + bytes([i]), "image/png") for i in range(rp_cache.MAX_IMAGES_PER_REQUEST + 2)]
    for asked in (None, 1000, float("inf")):
        out = rp_cache.fetch_images(urls, max_images=asked, cache_dir=str(tmp_path))
        assert [r["error"] for r in out] == [None] * 50 + ["over_limit"] * 2
    assert rp_cache.MAX_IMAGES_PER_REQUEST == 50


@pytest.mark.parametrize("name", ["big.png", "big-nolen.png"])
@pytest.mark.parametrize("asked", [None, 100])
def test_f2_backend_caps_image_size(server, tmp_path, monkeypatch, name, asked):
    assert rp_cache.MAX_IMAGE_BYTES == 20 * 1024 * 1024
    monkeypatch.setattr(rp_cache, "MAX_IMAGE_BYTES", 1024 * 1024)
    out = rp_cache.fetch_images([f"{server}/{name}"], max_mb=asked, cache_dir=str(tmp_path))
    assert out[0]["error"] == "too_large" and out[0]["path"] is None
    assert files_in(tmp_path) == []


def test_f2_data_url_length_checked_before_decoding(tmp_path, monkeypatch):
    assert rp_cache.MAX_DATA_URL_BYTES == 20 * 1024 * 1024
    url = _data_url(PNG + b"\x00" * 4096, "image/png")
    monkeypatch.setattr(rp_cache, "MAX_DATA_URL_BYTES", 1024)

    def no_decode(*args, **kwargs):
        raise AssertionError("decoded an over-long data: URL")

    monkeypatch.setattr(rp_cache.base64, "b64decode", no_decode)
    out = rp_cache.fetch_images([url], max_mb=100, cache_dir=str(tmp_path))
    assert out[0]["error"] == "too_large"


def test_f2_url_list_length_capped(tmp_path):
    with pytest.raises(ValueError):
        rp_cache.fetch_images(["data:x"] * (rp_cache.MAX_URLS + 1), cache_dir=str(tmp_path))


def test_f2_fetch_route_caps_and_refuses_cleanly(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hh"))
    client, module = _api("rp_api_under_test_f2")
    r = client.post("/fetch-images", json={"urls": ["http://169.254.169.254/latest/meta-data/"]})
    assert r.status_code == 200 and r.json()["results"][0]["error"] == "blocked_address"
    assert client.post("/fetch-images", json={"urls": ["data:x"] * (rp_cache.MAX_URLS + 1)}).status_code == 400
    monkeypatch.setattr(module, "MAX_FETCH_BODY_BYTES", 1000)
    big = '{"urls": ["' + "a" * 2000 + '"]}'
    assert _post_raw(client, "/fetch-images", big).status_code == 413
    chunked = client.post("/fetch-images", content=(big[i:i + 100].encode() for i in range(0, len(big), 100)),
                          headers={"content-type": "application/json"})
    assert chunked.status_code == 413
    assert _post_raw(client, "/fetch-images", '{"urls": []}').status_code == 200


# F6: two requests for the same URL never share a temporary file.

def test_f6_concurrent_downloads_of_one_url_both_end_with_a_valid_file(server, tmp_path):
    expected = PNG + bytes(range(256)) * 64
    barrier = threading.Barrier(2)
    results = [None, None]

    def run(i):
        barrier.wait()
        results[i] = rp_cache.fetch_images([f"{server}/slow.png"], cache_dir=str(tmp_path), auto_delete=False)[0]

    threads = [threading.Thread(target=run, args=(i,)) for i in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert [r["error"] for r in results] == [None, None], results
    for r in results:
        assert Path(r["path"]).read_bytes() == expected
    assert not [p for p in files_in(tmp_path) if p.endswith(".part")]


# F3: temporary files are never followed through links; cache directories and cache hits are checked.

def _day_for(tmp_path, now):
    return tmp_path / rp_cache.CACHE_SUBDIR / dt.date.fromtimestamp(now).strftime("%Y%m%d")


def _stem(url):
    import hashlib
    return hashlib.sha1(url.encode()).hexdigest()[:12]


@pytest.mark.parametrize("kind", ["http", "data"])
def test_f3_part_file_symlink_is_not_followed(server, tmp_path, kind):
    now = time.time()
    url = f"{server}/a.png" if kind == "http" else _data_url(PNG, "image/png")
    day = _day_for(tmp_path, now)
    day.mkdir(parents=True)
    victim = tmp_path / "victim.txt"
    victim.write_bytes(b"precious")
    (day / f"{_stem(url)}.part").symlink_to(victim)
    out = rp_cache.fetch_images([url], cache_dir=str(tmp_path), now=now, auto_delete=False)[0]
    assert victim.read_bytes() == b"precious"
    assert out["error"] is None, out
    assert Path(out["path"]).read_bytes() == PNG and not Path(out["path"]).is_symlink()


def test_f3_svg_png_is_not_written_through_a_link(tmp_path):
    now = time.time()
    url = "data:image/svg+xml;base64," + base64.b64encode(
        b'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>').decode()
    day = _day_for(tmp_path, now)
    day.mkdir(parents=True)
    victim = tmp_path / "victim.txt"
    victim.write_bytes(b"precious")
    (day / f"{_stem(url)}.png").symlink_to(victim)
    out = rp_cache.fetch_images([url], cache_dir=str(tmp_path), now=now, auto_delete=False)[0]
    assert victim.read_bytes() == b"precious"
    assert out["error"] is None and Path(out["path"]).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


@pytest.mark.parametrize("link", ["hard", "sym"])
def test_f3_cache_hit_must_be_a_plain_single_link_file(server, tmp_path, link):
    now = time.time()
    url = f"{server}/a.png"
    day = _day_for(tmp_path, now)
    day.mkdir(parents=True)
    victim = tmp_path / "someone-elses.png"
    victim.write_bytes(b"\x89PNG\r\n\x1a\n" + b"secret")
    target = day / f"{_stem(url)}.png"
    os.link(victim, target) if link == "hard" else target.symlink_to(victim)
    out = rp_cache.fetch_images([url], cache_dir=str(tmp_path), now=now, auto_delete=False)[0]
    assert out["error"] is None, out
    assert Path(out["path"]).read_bytes() == PNG, "downloaded again instead of handing out the linked file"
    assert os.lstat(out["path"]).st_nlink == 1
    assert victim.read_bytes() == b"\x89PNG\r\n\x1a\n" + b"secret"


def test_f3_symlinked_cache_root_fails_per_image(tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (tmp_path / "c").mkdir()
    (tmp_path / "c" / rp_cache.CACHE_SUBDIR).symlink_to(elsewhere, target_is_directory=True)
    urls = [_data_url(PNG, "image/png"), "file:///etc/passwd"]
    out = rp_cache.fetch_images(urls, cache_dir=str(tmp_path / "c"))
    assert [r["error"] for r in out] == ["cache_dir_unsafe", "cache_dir_unsafe"]
    assert list(elsewhere.iterdir()) == []


def test_f3_symlinked_day_dir_fails_per_image(tmp_path):
    now = time.time()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    day = _day_for(tmp_path, now)
    day.parent.mkdir(parents=True)
    day.symlink_to(elsewhere, target_is_directory=True)
    out = rp_cache.fetch_images([_data_url(PNG, "image/png")], cache_dir=str(tmp_path), now=now)
    assert out[0]["error"] == "cache_dir_unsafe"
    assert list(elsewhere.iterdir()) == []


@pytest.mark.parametrize("which", ["root", "day"])
def test_f3_group_or_other_writable_cache_dirs_are_refused(tmp_path, which):
    now = time.time()
    day = _day_for(tmp_path, now)
    day.mkdir(parents=True)
    (day.parent if which == "root" else day).chmod(0o777)
    out = rp_cache.fetch_images([_data_url(PNG, "image/png")], cache_dir=str(tmp_path), now=now)
    assert out[0]["error"] == "cache_dir_unsafe"


def test_f3_cache_dir_owned_by_someone_else_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(rp_cache, "_uid", lambda: os.getuid() + 1)
    out = rp_cache.fetch_images([_data_url(PNG, "image/png")], cache_dir=str(tmp_path))
    assert out[0]["error"] == "cache_dir_unsafe"


def test_f3_default_cache_dir_left_group_writable_is_repaired(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hh"))
    root = rp_cache.default_cache_dir() / rp_cache.CACHE_SUBDIR
    root.mkdir(parents=True)
    root.chmod(0o775)
    out = rp_cache.fetch_images([_data_url(PNG, "image/png")])
    assert out[0]["error"] is None, out
    assert root.stat().st_mode & 0o022 == 0
    assert Path(out[0]["path"]).parent.stat().st_mode & 0o077 == 0, "new day folders are private"


def test_f3_other_writers_report_an_unsafe_cache_instead_of_raising(tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (tmp_path / "c").mkdir()
    (tmp_path / "c" / rp_cache.CACHE_SUBDIR).symlink_to(elsewhere, target_is_directory=True)
    cache = str(tmp_path / "c")
    assert rp_cache.save_markdown("x", cache)["error"] == "cache_dir_unsafe"
    assert rp_cache.save_preview(_data_url(PNG, "image/png"), cache)["error"] == "cache_dir_unsafe"
    src = _tiff(tmp_path / "s.tiff")
    assert rp_cache.to_png(str(src), cache) == {"path": None, "error": "cache_dir_unsafe"}
    assert rp_cache.cleanup(cache, 1) == 0
    assert list(elsewhere.iterdir()) == []


def test_f3_read_markdown_refuses_a_hard_link(tmp_path):
    day = tmp_path / "rich-paste-cache" / "20261108"
    day.mkdir(parents=True)
    secret = tmp_path / "secret.txt"
    secret.write_text("PRIVATE")
    os.link(secret, day / "0123456789abcdef0123.md")
    assert rp_cache.read_markdown(str(day / "0123456789abcdef0123.md")) == {"markdown": None, "error": "not_found"}


# F5: a cache_dir from the client is used only when it is absolute and lies under the home directory.

def test_f5_client_cache_dir_rule(tmp_path):
    home = Path.home().resolve()
    inside = tmp_path / "pick"
    assert tmp_path.resolve().is_relative_to(home)
    assert rp_cache.client_cache_dir(str(inside)) == (str(inside.resolve()), None)
    assert rp_cache.client_cache_dir("~/x") == (str(home / "x"), None)
    assert rp_cache.client_cache_dir("") == (None, None)
    assert rp_cache.client_cache_dir(None) == (None, None)
    link = tmp_path / "link"
    link.symlink_to(home.parent, target_is_directory=True)
    for bad in ("relative/dir", "/etc", str(home.parent / "elsewhere"), str(link / "x"), str(inside) + "/../../../..",
                "/tmp/x\x00y", 5, ["x"], {"a": 1}, True):
        chosen, warning = rp_cache.client_cache_dir(bad)
        assert chosen is None and isinstance(warning, str) and warning, bad


def test_f5_routes_ignore_a_cache_dir_outside_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    default_root = home / ".hermes" / "cache" / "rich-paste" / rp_cache.CACHE_SUBDIR
    outside = tmp_path / "outside"
    outside.mkdir()
    client, _module = _api("rp_api_under_test_f5")
    png = _data_url(PNG, "image/png")

    r = client.post("/fetch-images", json={"urls": [png], "cache_dir": str(outside)}).json()
    assert r["results"][0]["error"] is None and r["warning"]
    assert Path(r["results"][0]["path"]).is_relative_to(default_root.resolve())
    stats = client.get("/cache-stats", params={"cache_dir": str(outside)}).json()
    assert stats["dir"] == str(default_root) and stats["files"] == 1 and stats["warning"]
    cleaned = client.post("/cleanup", json={"cache_dir": str(outside), "days": 7}).json()
    assert cleaned["removed"] == 0 and cleaned["warning"]
    md = client.post("/save-markdown", json={"markdown": "x", "cache_dir": str(outside)}).json()
    assert Path(md["path"]).is_relative_to(default_root) and md["warning"]
    preview = client.post("/save-preview", json={"data_url": png, "cache_dir": str(outside)}).json()
    assert Path(preview["path"]).is_relative_to(default_root) and preview["warning"]
    tiff = _tiff(tmp_path / "s.tiff")
    converted = client.post("/to-png", json={"path": str(tiff), "cache_dir": str(outside)}).json()
    assert Path(converted["path"]).is_relative_to(default_root) and converted["warning"]
    assert list(outside.iterdir()) == []

    pick = home / "pick"
    r = client.post("/fetch-images", json={"urls": [png], "cache_dir": str(pick)}).json()
    assert "warning" not in r and Path(r["results"][0]["path"]).is_relative_to(pick.resolve())
    assert "warning" not in client.get("/cache-stats", params={"cache_dir": str(pick)}).json()
    assert "warning" not in client.post("/save-markdown", json={"markdown": "y"}).json()



def test_deeply_nested_json_body_is_a_400_not_a_500():
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    import importlib.util
    spec = importlib.util.spec_from_file_location("rp_api_nested",
                                                  Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = fastapi.FastAPI()
    app.include_router(module.router)
    body = "[" * 100_000 + "]" * 100_000
    r = TestClient(app).post("/fetch-images", content=body, headers={"content-type": "application/json"})
    assert r.status_code == 400, r.text


def test_review_1110_stt_uses_no_private_hermes_helpers():
    """Review 11-10: only the public transcribe_audio and the public config loader are used."""
    import inspect
    source = inspect.getsource(rp_cache)
    for name in ("_load_stt_config", "_get_provider", "_resolve_stt_language"):
        assert f"stt.{name}" not in source, name


def test_review_1110_stt_language_order(monkeypatch):
    monkeypatch.delenv("HERMES_LOCAL_STT_LANGUAGE", raising=False)
    assert rp_cache.stt_status(config={"provider": "local", "local": {"language": "zh"}, "language": "en"})["language"] == "zh"
    assert rp_cache.stt_status(config={"provider": "local", "language": "en"})["language"] == "en"
    monkeypatch.setenv("HERMES_LOCAL_STT_LANGUAGE", "fr")
    assert rp_cache.stt_status(config={"provider": "local", "language": ""})["language"] == "fr"


def test_review_1110_stt_disabled_like_hermes():
    for value in (False, "false", "off", "", "0", "disabled"):
        assert rp_cache.stt_status(config={"enabled": value, "provider": "local"})["kind"] == "none", value
