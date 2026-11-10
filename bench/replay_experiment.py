"""U-ACC-3 / QA10: replay the comparison experiment through the rich-paste middleware.

Copied from the original comparison experiment (gen.py, kimi.py, run.py)
and changed in one place: instead of hand-building the
interleaved content, the text carries image labels (``[Screenshot k]`` between two U+2063, as the
composer middleware sends them), Hermes' own
``build_native_content_parts`` builds today's request (all text first, all
images last), and ``interleave.rewrite_request`` rewrites it — exactly what the
plugin does on the wire.

Usage (needs Pillow; KIMI_API_KEY for the real run):
    uv run --no-project --with pillow python bench/replay_experiment.py [--trials 5] [--model kimi-k3]
    uv run --no-project --with pillow python bench/replay_experiment.py --dry-run   # no API calls

Prints one line per scenario and exits non-zero when a threshold is missed:
「一段多图或无图」>= 29/30, 「一段一图」 30/30.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures as cf
import json
import os
import random
import re
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERMES = Path(os.environ.get("HERMES_AGENT_DIR", Path.home() / ".hermes" / "hermes-agent"))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERMES))

import interleave  # noqa: E402

KIMI_URL = "https://api.kimi.com/coding/v1/chat/completions"
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"
NAMES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]
ASK = ("\n\n问题：按机器名给出每张截图里的 CPU 读数，同一台机器多张就按截图先后列。"
       "只输出 JSON，例如 {\"alpha\": [12], \"bravo\": [34, 56]}。")
THRESHOLDS = {"一段多图或无图": 29, "一段一图": 30}


def generate_cards(out: Path, trials: int) -> list[dict]:
    """gen.py: same-layout monitoring cards, only the numbers differ; no machine name in the image."""
    from PIL import Image, ImageDraw, ImageFont

    out.mkdir(parents=True, exist_ok=True)
    f_big, f_mid, f_small = (ImageFont.truetype(FONT, size) for size in (64, 30, 22))

    def card(path: Path, cpu: int, mem: int, err: int) -> None:
        im = Image.new("RGB", (640, 380), (24, 26, 32))
        d = ImageDraw.Draw(im)
        d.text((32, 24), "主机监控 · 11-05", font=f_small, fill=(150, 155, 165))
        d.text((32, 80), f"CPU {cpu}%", font=f_big, fill=(235, 235, 240))
        d.text((32, 190), f"内存 {mem}%", font=f_mid, fill=(200, 200, 210))
        d.text((32, 240), f"错误 {err}", font=f_mid, fill=(200, 200, 210))
        d.rectangle((32, 310, 32 + int(5.7 * cpu), 330), fill=(80, 180, 120))
        im.save(path)

    meta = []
    for trial in range(trials):
        values = random.sample(range(11, 99), 6)
        paths = []
        for value in values:
            path = out / f"paste_{random.getrandbits(40):010x}.png"
            card(path, value, random.randint(20, 95), random.randint(0, 60))
            paths.append(str(path))
        meta.append({"trial": trial, "cpu": values, "paths": paths})
    return meta


def scenarios(m: dict) -> dict:
    """run.py scenarios, unchanged."""
    p, v = m["paths"], m["cpu"]
    s1 = [(f"这是 {n} 的监控截图，昨晚开始报警。", [p[i]]) for i, n in enumerate(NAMES)]
    s1_ans = {n: [v[i]] for i, n in enumerate(NAMES)}
    s2 = [("alpha 今天的情况：", [p[0], p[1]]), ("bravo 昨天已经下线了，不用管。", []),
          ("charlie 重启之后：", [p[2]]), ("delta 这台最可疑：", [p[3], p[4], p[5]])]
    s2_ans = {"alpha": v[0:2], "charlie": [v[2]], "delta": v[3:6]}
    return {"一段一图": (s1, s1_ans), "一段多图或无图": (s2, s2_ans)}


def plugin_request(segs: list, model: str) -> tuple[dict, dict]:
    """Text with image markers → Hermes' current request → the middleware's rewrite."""
    from agent.image_routing import build_native_content_parts

    # Labels as the composer middleware sends them: the k-th label is the k-th image attachment.
    ordinal = iter(range(1, 100))
    text = "\n".join(t + "".join(f"\n\u2063[Screenshot {next(ordinal)}]\u2063" for _path in imgs) for t, imgs in segs) + ASK
    parts, skipped = build_native_content_parts(text, [x for _, imgs in segs for x in imgs])
    if skipped:
        raise RuntimeError(f"Hermes skipped images: {skipped}")
    original = {"model": model, "messages": [{"role": "user", "content": parts}], "max_tokens": 4000}
    rewritten = interleave.rewrite_request(original)
    if rewritten is None:
        raise RuntimeError("middleware did not rewrite the request")
    return original, rewritten


def layout(content: list) -> list[str]:
    return ["img" if block.get("type") == "image_url" else "text" for block in content]


def chat(request: dict, timeout: int = 300) -> str:
    """kimi.py, taking a whole request body."""
    body = json.dumps(request).encode()
    req = urllib.request.Request(KIMI_URL, data=body, headers={
        "Authorization": "Bearer " + os.environ["KIMI_API_KEY"], "Content-Type": "application/json",
        "User-Agent": "claude-code/0.1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.load(r)
    return data["choices"][0]["message"].get("content") or ""


def score(ans: dict, text: str) -> tuple[int, int]:
    """run.py score, unchanged."""
    m = re.search(r"\{.*\}", text, re.S)
    try:
        got = json.loads(m.group(0)) if m else {}
    except Exception:  # noqa: BLE001 - an unparsable answer scores zero
        got = {}
    total = sum(len(v) for v in ans.values())
    ok = sum(1 for k, v in ans.items() for i, x in enumerate(v)
             if isinstance(got.get(k), list) and i < len(got[k]) and str(got[k][i]).strip("%") == str(x))
    return ok, total


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--trials", type=int, default=5)
    parser.add_argument("--model", default="kimi-k3")
    parser.add_argument("--dry-run", action="store_true", help="build and check the rewritten requests, call no API")
    parser.add_argument("--out", type=Path, help="keep generated cards and results here")
    args = parser.parse_args()

    if not args.dry_run and not os.environ.get("KIMI_API_KEY"):
        print("SKIPPED: no KIMI_API_KEY")
        return 0

    work = args.out or Path(tempfile.mkdtemp(prefix="rich-paste-replay-"))
    meta = generate_cards(work / "imgs", args.trials)
    jobs = [(m, sc) for m in meta for sc in THRESHOLDS]

    def build(job):
        m, sc = job
        segs, ans = scenarios(m)[sc]
        return m["trial"], sc, ans, plugin_request(segs, args.model)

    built = [build(job) for job in jobs]
    for _trial, sc, _ans, (original, rewritten) in built:
        before = layout(original["messages"][0]["content"])
        after = layout(rewritten["messages"][0]["content"])
        assert before[0] == "text" and set(before[1:]) == {"img"}, before
        assert after.count("img") == before.count("img"), (before, after)
        assert after != before, f"{sc}: not interleaved"
    if args.dry_run:
        example = layout(built[1][3][1]["messages"][0]["content"])
        print(f"DRY-RUN ok: {len(built)} requests rewritten; 一段多图或无图 layout = {' '.join(example)}")
        return 0

    def run(item):
        trial, sc, ans, (_original, rewritten) = item
        started = time.time()
        try:
            text = chat(rewritten)
        except Exception as exc:  # noqa: BLE001 - recorded per job, counted as an error
            return {"trial": trial, "scenario": sc, "error": repr(exc)}
        ok, total = score(ans, text)
        return {"trial": trial, "scenario": sc, "ok": ok, "total": total, "raw": text[-400:],
                "secs": round(time.time() - started, 1)}

    with cf.ThreadPoolExecutor(5) as pool:
        results = list(pool.map(run, built))
    (work / f"results_{args.model}_plugin.jsonl").write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in results), encoding="utf-8")

    passed = True
    for sc, need in THRESHOLDS.items():
        rows = [r for r in results if r["scenario"] == sc]
        ok = sum(r.get("ok", 0) for r in rows)
        total = sum(r.get("total", 0) for r in rows) or 6 * args.trials
        errors = sum(1 for r in rows if "error" in r)
        good = ok >= need * args.trials / 5 and errors == 0
        passed &= good
        print(f"{args.model} | {sc} | 插件交错 | 对 {ok}/{total} | 报错 {errors} | 门槛 {need}/30 | {'PASS' if good else 'FAIL'}")
    print(f"results: {work}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
