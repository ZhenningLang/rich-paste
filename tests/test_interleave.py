"""QA2–QA4: interleave.rewrite_request over the three request shapes."""

import copy
import logging

import pytest

import interleave

P1 = "/Users/me/.hermes/cache/rich-paste/20261106/aaaaaaaaaaaa.png"
P2 = "/Users/me/.hermes/cache/rich-paste/20261106/bbbbbbbbbbbb.png"
P3 = "/Users/me/.hermes/images/screenshot_3.png"


def hermes_text(body, paths):
    """What build_native_content_parts puts in the single text block."""
    return f"{body}\n\n" + "\n".join(f"[Image attached at: {p}]" for p in paths)


class OpenAIChat:
    name = "openai"
    text_type = "text"
    key = "messages"

    @staticmethod
    def image(tag):
        return {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{tag}"}}

    @classmethod
    def request(cls, text, images, text_extra=None):
        block = {"type": cls.text_type, "text": text, **(text_extra or {})}
        return {
            "model": "m",
            cls.key: [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "earlier turn ![x](" + P1 + ")"},
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": [block, *images]},
            ],
        }


class AnthropicMessages(OpenAIChat):
    name = "anthropic"

    @staticmethod
    def image(tag):
        return {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": tag}}


class Responses(OpenAIChat):
    name = "responses"
    text_type = "input_text"
    key = "input"

    @staticmethod
    def image(tag):
        return {"type": "input_image", "image_url": f"data:image/png;base64,{tag}"}


SHAPES = [OpenAIChat, AnthropicMessages, Responses]


def last_user_content(shape, request):
    return request[shape.key][-1]["content"]


def kinds(shape, content):
    out = []
    for block in content:
        if block["type"] == shape.text_type:
            out.append("text")
        else:
            out.append(block_tag(block))
    return out


def block_tag(block):
    if block["type"] == "image_url":
        return block["image_url"]["url"].rsplit(",", 1)[1]
    if block["type"] == "image":
        return block["source"]["data"]
    return block["image_url"].rsplit(",", 1)[1]


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_qa2a_no_marker_returns_none(shape):
    request = shape.request(hermes_text("看看这两张图", [P1, P2]), [shape.image("img1"), shape.image("img2")])
    snapshot = copy.deepcopy(request)
    assert interleave.rewrite_request(request) is None
    assert request == snapshot


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_qa2b_two_markers_interleave(shape):
    body = f"第一段\n![图一]({P1})\n第二段\n![图二]({P2})\n第三段"
    request = shape.request(hermes_text(body, [P1, P2]), [shape.image("img1"), shape.image("img2")])
    snapshot = copy.deepcopy(request)
    new = interleave.rewrite_request(request)
    assert request == snapshot, "input must not be mutated"
    content = last_user_content(shape, new)
    assert kinds(shape, content) == ["text", "img1", "text", "img2", "text"]
    texts = [b["text"] for b in content if b["type"] == shape.text_type]
    assert texts[0] == f"第一段\n![图一]({P1})"
    assert texts[1] == f"\n第二段\n![图二]({P2})"
    assert texts[2] == "\n第三段"
    assert all("[Image attached at:" not in t for t in texts)
    # earlier messages untouched, same objects
    assert new[shape.key][:3] == request[shape.key][:3]


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_qa2c_paragraph_with_two_images_then_paragraph_without(shape):
    body = f"alpha 今天的情况：\n![a1]({P1})![a2]({P2})\nbravo 昨天已经下线了，不用管。\ncharlie 重启之后：\n![c]({P3})"
    request = shape.request(hermes_text(body, [P1, P2, P3]),
                            [shape.image("img1"), shape.image("img2"), shape.image("img3")])
    content = last_user_content(shape, interleave.rewrite_request(request))
    # The second marker's own text sits between the two images (marker text stays in front of its image).
    assert kinds(shape, content) == ["text", "img1", "text", "img2", "text", "img3"]
    texts = [b["text"] for b in content if b["type"] == shape.text_type]
    assert texts[0] == f"alpha 今天的情况：\n![a1]({P1})"
    assert texts[1] == f"![a2]({P2})"
    assert texts[2].startswith("\nbravo") and texts[2].endswith(f"![c]({P3})")


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_qa2d_unmatched_marker_keeps_text_and_image_order(shape):
    """Chosen behaviour (QA2d option 2): the unmatched marker stays as text, its
    image stays at the end with its hint line, order unchanged."""
    body = f"甲 ![图一]({P1}) 乙 ![别处](/tmp/not-attached.png) 丙"
    request = shape.request(hermes_text(body, [P1, P2]), [shape.image("img1"), shape.image("img2")])
    content = last_user_content(shape, interleave.rewrite_request(request))
    assert kinds(shape, content) == ["text", "img1", "text", "img2"]
    tail = content[2]["text"]
    assert "![别处](/tmp/not-attached.png)" in tail
    assert tail.endswith(f"[Image attached at: {P2}]")


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_qa2d_no_marker_matches_returns_none(shape):
    body = "看 ![别处](/tmp/not-attached.png)"
    request = shape.request(hermes_text(body, [P1]), [shape.image("img1")])
    assert interleave.rewrite_request(request) is None


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_qa2e_malformed_inputs_return_none(shape):
    # content is neither a list nor a string (string content is text mode, see QA2f)
    for bad in (None, 42, {"text": f"![a]({P1})"}):
        request = shape.request("x", [])
        request[shape.key][-1]["content"] = bad
        assert interleave.rewrite_request(request) is None
    # hint count != image count
    request = shape.request(hermes_text(f"![a]({P1})", [P1]), [shape.image("img1"), shape.image("img2")])
    assert interleave.rewrite_request(request) is None
    # list key missing
    assert interleave.rewrite_request({"model": "m"}) is None
    assert interleave.rewrite_request({shape.key: "nope"}) is None
    assert interleave.rewrite_request(None) is None
    assert interleave.rewrite_request({shape.key: [{"role": "user"}]}) is None
    assert interleave.rewrite_request({shape.key: [{"role": "assistant", "content": []}]}) is None
    # non-dict blocks / unknown block types
    request = shape.request(hermes_text(f"![a]({P1})", [P1]), [shape.image("img1"), "junk"])
    assert interleave.rewrite_request(request) is None
    request = shape.request(hermes_text(f"![a]({P1})", [P1]), [shape.image("img1"), {"type": "document"}])
    assert interleave.rewrite_request(request) is None
    # text not a string
    request = shape.request("x", [shape.image("img1")])
    request[shape.key][-1]["content"][0]["text"] = 42
    assert interleave.rewrite_request(request) is None


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_attached_index_marker(shape):
    body = "截图：![截图 2](attached:2) 然后 ![截图 1](attached:1)"
    request = shape.request(hermes_text(body, [P1, P2]), [shape.image("img1"), shape.image("img2")])
    content = last_user_content(shape, interleave.rewrite_request(request))
    assert kinds(shape, content) == ["text", "img2", "text", "img1"]


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_same_path_twice_only_first_marker_places_image(shape):
    body = f"上 ![a]({P1}) 中 ![again]({P1}) 下"
    request = shape.request(hermes_text(body, [P1]), [shape.image("img1")])
    content = last_user_content(shape, interleave.rewrite_request(request))
    assert kinds(shape, content) == ["text", "img1", "text"]
    assert content[2]["text"] == f" 中 ![again]({P1}) 下"


def test_tilde_and_unnormalised_paths_match(monkeypatch):
    monkeypatch.setenv("HOME", "/Users/me")
    body = "看 ![a](~/.hermes/cache/rich-paste/20261106/./aaaaaaaaaaaa.png)"
    request = OpenAIChat.request(hermes_text(body, [P1]), [OpenAIChat.image("img1")])
    content = last_user_content(OpenAIChat, interleave.rewrite_request(request))
    assert kinds(OpenAIChat, content) == ["text", "img1"]


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_qa4_extra_keys_only_on_last_text_block(shape):
    body = f"一 ![a]({P1}) 二 ![b]({P2}) 三"
    request = shape.request(hermes_text(body, [P1, P2]), [shape.image("img1"), shape.image("img2")],
                            text_extra={"cache_control": {"type": "ephemeral"}})
    content = last_user_content(shape, interleave.rewrite_request(request))
    text_blocks = [b for b in content if b["type"] == shape.text_type]
    assert [("cache_control" in b) for b in text_blocks] == [False, False, True]
    assert text_blocks[-1]["text"] == " 三"


def test_qa4_extra_keys_go_to_last_text_when_marker_ends_message():
    body = f"一 ![a]({P1})"
    request = OpenAIChat.request(hermes_text(body, [P1]), [OpenAIChat.image("img1")],
                                 text_extra={"cache_control": {"type": "ephemeral"}})
    content = last_user_content(OpenAIChat, interleave.rewrite_request(request))
    assert kinds(OpenAIChat, content) == ["text", "img1"]
    assert content[0]["cache_control"] == {"type": "ephemeral"}


def test_qa3_on_llm_request_fails_open(monkeypatch, caplog):
    def boom(_request):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(interleave, "_rewrite", boom)
    with caplog.at_level(logging.DEBUG, logger=interleave.__name__):
        assert interleave.on_llm_request(request={"messages": []}, provider="p") is None
    assert "kaboom" in caplog.text


def test_on_llm_request_returns_trace_and_logs(caplog):
    body = f"一 ![a]({P1}) 二"
    request = OpenAIChat.request(hermes_text(body, [P1]), [OpenAIChat.image("img1")])
    with caplog.at_level(logging.INFO, logger=interleave.__name__):
        out = interleave.on_llm_request(request=request, original_request=request, provider="kimi")
    assert out["source"] == "rich-paste"
    assert out["reason"] == "interleaved 1 images"
    assert set(out["request"]) == set(request), "no private keys leak into the provider request"
    assert "rich-paste interleaved 1 images (shape=openai)" in caplog.text


def test_on_llm_request_no_marker_returns_none():
    request = OpenAIChat.request(hermes_text("hi", [P1]), [OpenAIChat.image("img1")])
    assert interleave.on_llm_request(request=request) is None


def test_marker_scan_terminates_on_adversarial_text():
    body = "![" * 5000 + "](" * 5000 + "!" * 5000 + f"![a]({P1})"
    request = OpenAIChat.request(hermes_text(body, [P1]), [OpenAIChat.image("img1")])
    content = last_user_content(OpenAIChat, interleave.rewrite_request(request))
    assert kinds(OpenAIChat, content) == ["text", "img1"]


# ---- QA2f: text mode (F7) — string content with Desktop reference blocks ----

def ref_block(path):
    name = path.rsplit("/", 1)[1]
    return f"[The user attached an image: {name}]\n[Examine it with the vision_analyze tool using image_url: {path}]"


def desktop_text(body, paths):
    """tui_gateway/session_history.py _build_image_ref_message."""
    prefix = "\n\n".join(ref_block(p) for p in paths)
    return f"{prefix}\n\n{body}" if body else prefix


def text_request(text):
    return {"model": "kimi-k3", "messages": [{"role": "user", "content": "old"},
                                             {"role": "assistant", "content": "ok"},
                                             {"role": "user", "content": text}]}


def test_qa2f_text_mode_moves_both_blocks_after_markers():
    body = f"第一段\n![图一]({P1})\n第二段\n![图二]({P2})\n第三段"
    request = text_request(desktop_text(body, [P1, P2]))
    snapshot = copy.deepcopy(request)
    new = interleave.rewrite_request(request)
    assert request == snapshot
    out = new["messages"][-1]["content"]
    assert out == (f"第一段\n![图一]({P1})\n{ref_block(P1)}\n第二段\n"
                   f"![图二]({P2})\n{ref_block(P2)}\n第三段")
    assert not out.startswith("[The user attached an image")
    assert new["messages"][:2] == request["messages"][:2]


def test_qa2f_text_mode_unmatched_block_stays_on_top():
    body = f"甲 ![图二]({P2}) 乙 ![别处](/tmp/other.png)"
    new = interleave.rewrite_request(text_request(desktop_text(body, [P1, P2])))
    out = new["messages"][-1]["content"]
    assert out == f"{ref_block(P1)}\n\n甲 ![图二]({P2})\n{ref_block(P2)}\n 乙 ![别处](/tmp/other.png)"


def test_qa2f_text_mode_marker_at_end():
    body = f"看这张 ![图一]({P1})"
    out = interleave.rewrite_request(text_request(desktop_text(body, [P1])))["messages"][-1]["content"]
    assert out == f"看这张 ![图一]({P1})\n{ref_block(P1)}"


def test_qa2f_text_mode_no_marker_returns_none():
    assert interleave.rewrite_request(text_request(desktop_text("看看这两张", [P1, P2]))) is None
    assert interleave.rewrite_request(text_request(desktop_text("", [P1]))) is None


def test_qa2f_text_mode_without_reference_blocks_returns_none():
    assert interleave.rewrite_request(text_request(f"手写记号 ![a]({P1})")) is None


def test_qa2f_cli_block_without_bindable_marker_returns_none():
    """CLI pre-described block (hermes_cli/cli_stream_mixin.py:659) and a marker that binds to
    nothing (no attached:k, path differs) → unchanged."""
    cli = ("[The user attached an image. Here's what it contains:\nA chart.]\n"
           f"[If you need a closer look, use vision_analyze with image_url: {P1}]\n\n"
           "看 ![a](/tmp/elsewhere.png)")
    assert interleave.rewrite_request(text_request(cli)) is None


# ---- dogfood D1: every real text-mode block format, bound by attached:k ----
U1 = "/Users/me/.hermes/cache/documents/native-inputs/h/dashboard_20261106_011826_848d8ff8_b825d9f0e7e3.png"
U2 = "/Users/me/.hermes/cache/documents/native-inputs/h/dashboard_20261106_011826_a8274db5_0a2064de7e78.png"
BODY = "## Hermes 插件市场怎么审核\n所有插件都要提交到目录。\n![审核流程示意](attached:1)\n固定提交号以后锁定。\n![签名校验流程](attached:2)\n详见官方文档"

GATEWAY_FAIL = ("[The user sent an image but I couldn't quite see it this time (>_<) You can try looking at it "
                f"yourself with vision_analyze using image_url: {U1}]")
GATEWAY_OK = ("[The user sent an image~ Here's what I can see:\n一张流程图，左边是提交 [PR]，右边是合并。\n"
              "第二行写着 values [1, 2]\n标题：签名校验]\n"
              f"[If you need a closer look, use vision_analyze with image_url: {U2} ~]")
GATEWAY_ERR = ("[The user sent an image but something went wrong when I tried to look at it~ You can try "
               f"examining it yourself with vision_analyze using image_url: {U1}]")
PREP = "[The user attached an image. Here's what it contains:\n一张图，描述。]"
PREP_CLOSER = PREP + f"\n[If you need a closer look, use vision_analyze with image_url: {U2}]"
TUI = f"[The user attached an image: a.png]\n[Examine it with the vision_analyze tool using image_url: {U1}]"
CLI_OK = ("[The user attached an image. Here's what it contains:\nA chart.]\n"
          f"[If you need a closer look, use vision_analyze with image_url: {U2}]")
CLI_FAIL = ("[The user attached an image but it couldn't be analyzed. You can try examining it with "
            f"vision_analyze using image_url: {U1}]")


@pytest.mark.parametrize("first,second", [
    (GATEWAY_FAIL, GATEWAY_OK),     # gateway/run_inbound.py (the author's real turn)
    (GATEWAY_ERR, GATEWAY_OK),
    (PREP, PREP_CLOSER),            # agent/vision_message_prep.py, without and with closer-look line
    (TUI, TUI.replace(U1, U2)),     # tui_gateway/session_history.py
    (CLI_FAIL, CLI_OK),             # hermes_cli/cli_stream_mixin.py
], ids=["gateway-fail+ok", "gateway-error+ok", "vision-prep", "tui", "cli"])
def test_d1_text_mode_formats_bind_by_attachment_order(first, second):
    text = f"{first}\n\n{second}\n\n{BODY}"
    out = interleave.rewrite_request(text_request(text))["messages"][-1]["content"]
    assert out.startswith("## Hermes 插件市场怎么审核"), "no description block left on top"
    assert out.index("![审核流程示意](attached:1)") < out.index(first) < out.index("固定提交号")
    assert out.index("![签名校验流程](attached:2)") < out.index(second) < out.index("详见官方文档")


def test_d1_description_with_brackets_is_one_block():
    blocks, body = interleave._split_ref_blocks(f"{GATEWAY_OK}\n\n{BODY}")
    assert [b for b, _ in blocks] == [GATEWAY_OK]
    assert blocks[0][1] == U2
    assert body == BODY


def test_d1_only_one_marker_moves_its_block_other_stays_on_top():
    text = f"{GATEWAY_FAIL}\n\n{GATEWAY_OK}\n\n只有第二张有记号 ![图](attached:2) 完"
    out = interleave.rewrite_request(text_request(text))["messages"][-1]["content"]
    assert out == f"{GATEWAY_FAIL}\n\n只有第二张有记号 ![图](attached:2)\n{GATEWAY_OK}\n 完"


def test_d1_no_marker_returns_none_for_every_format():
    for block in (GATEWAY_FAIL, GATEWAY_OK, PREP, TUI, CLI_OK):
        assert interleave.rewrite_request(text_request(f"{block}\n\n没有记号的正文")) is None


def test_d1_unterminated_block_is_not_a_block():
    assert interleave.rewrite_request(text_request("[The user sent an image~ Here's\n没有收尾 ![a](attached:1)")) is None


def test_qa2f_on_llm_request_logs_text_shape(caplog):
    body = f"看 ![图一]({P1})"
    with caplog.at_level(logging.INFO, logger=interleave.__name__):
        out = interleave.on_llm_request(request=text_request(desktop_text(body, [P1])))
    assert out["reason"] == "interleaved 1 images"
    assert "shape=text" in caplog.text


def test_qa2f_text_mode_adversarial_prefix_terminates():
    text = ("[The user attached an image: " + "]\n") * 3000 + f"![a]({P1})"
    assert interleave.rewrite_request(text_request(text)) is None


def test_angle_bracket_marker_with_spaces_in_path():
    spaced = "/Users/me/My Cache/20261106/cccccccccccc.png"
    body = f"看 ![a](<{spaced}>) 完"
    request = OpenAIChat.request(hermes_text(body, [spaced]), [OpenAIChat.image("img1")])
    content = last_user_content(OpenAIChat, interleave.rewrite_request(request))
    assert kinds(OpenAIChat, content) == ["text", "img1", "text"]


# ---- review S1: host copies images to new paths on send; markers carry attached:k ----

def load_contract():
    import json
    from pathlib import Path
    return json.loads((Path(__file__).parent / "contract" / "upload_rename.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_s1_contract_native_mode_after_upload_rename(shape):
    fixture = load_contract()
    text, uploaded = fixture["expected"]["text"], fixture["uploaded_paths"]
    request = shape.request(hermes_text(text, uploaded), [shape.image(f"img{i + 1}") for i in range(3)])
    content = last_user_content(shape, interleave.rewrite_request(request))
    assert kinds(shape, content) == ["text", "img1", "text", "img2", "text", "img3", "text"]
    texts = [b["text"] for b in content if b["type"] == shape.text_type]
    assert texts[0].endswith("[截图 1]")
    assert texts[2].startswith("\nbravo") and texts[2].endswith("[图：网页图]")
    assert all("[Image attached at:" not in t for t in texts)


def test_s1_contract_text_mode_after_upload_rename():
    fixture = load_contract()
    text, uploaded = fixture["expected"]["text"], fixture["uploaded_paths"]
    out = interleave.rewrite_request(text_request(desktop_text(text, uploaded)))["messages"][-1]["content"]
    assert out.index("[截图 1]") < out.index(ref_block(uploaded[0])) < out.index("[截图 2]")
    assert out.index("[截图 2]") < out.index(ref_block(uploaded[1])) < out.index("bravo")
    assert out.index("[图：网页图]") < out.index(ref_block(uploaded[2])) < out.index("问题：")
    assert not out.startswith("[The user attached an image")


def test_s1_unbound_placeholder_is_left_as_text():
    body = "看 ![截图 1](未对上的附件)"
    request = OpenAIChat.request(hermes_text(body, [P1]), [OpenAIChat.image("img1")])
    assert interleave.rewrite_request(request) is None


# ---- review B:S1: Anthropic tool loop keeps the interleaving ----

def test_b_s1_anthropic_tool_loop_still_rewrites_the_user_turn():
    body = f"一 ![a]({P1}) 二"
    request = AnthropicMessages.request(hermes_text(body, [P1]), [AnthropicMessages.image("img1")])
    request["messages"] += [
        {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "read", "input": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]},
    ]
    new = interleave.rewrite_request(request)
    assert new is not None
    assert kinds(AnthropicMessages, new["messages"][3]["content"]) == ["text", "img1", "text"]
    assert new["messages"][-1] == request["messages"][-1], "tool result untouched"


def test_b_s1_earlier_turn_is_rewritten_and_a_newer_text_turn_is_left_alone():
    """Review 11-10 (prompt cache): every user turn with markers is interleaved, not only the last."""
    request = AnthropicMessages.request(hermes_text(f"![a]({P1})", [P1]), [AnthropicMessages.image("img1")])
    later = {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "x"},
                                         {"type": "text", "text": "and this"}]}
    request["messages"].append(later)
    new = interleave.rewrite_request(request)
    assert new is not None
    assert kinds(AnthropicMessages, new["messages"][-2]["content"]) == ["text", "img1"]
    assert new["messages"][-1] == later, "the newer turn has no images: untouched"


# ---- review 11-10 (teknium1): stable request prefix across turns ----

def test_review_every_marked_user_turn_is_interleaved_and_the_prefix_is_stable():
    """Turn 2 sends turn 1 again in Hermes's shape. Both go out interleaved, and turn 1 reads
    exactly as it did when it was the newest message, so the provider prompt cache keeps hitting."""
    turn1 = OpenAIChat.request(hermes_text(f"一 ![a]({P1}) 二", [P1]), [OpenAIChat.image("img1")])
    first = interleave.rewrite_request(turn1)
    assert first is not None
    turn2 = OpenAIChat.request(hermes_text(f"三 ![b]({P2}) 四", [P2]), [OpenAIChat.image("img2")])
    request = dict(turn1)
    request["messages"] = [*turn1["messages"], {"role": "assistant", "content": "ok"}, turn2["messages"][-1]]
    second = interleave.rewrite_request(request)
    assert second is not None
    assert second["messages"][:len(first["messages"])] == first["messages"], "same prefix as the turn before"
    assert kinds(OpenAIChat, second["messages"][-1]["content"]) == ["text", "img2", "text"]


def test_review_rewrite_is_idempotent():
    request = OpenAIChat.request(hermes_text(f"一 ![a]({P1}) 二", [P1]), [OpenAIChat.image("img1")])
    once = interleave.rewrite_request(request)
    assert once is not None
    assert interleave.rewrite_request(once) is None, "an interleaved request is left as it is"


# ---- review B / security F9: paths are compared as strings, the file system is never asked ----

def test_f9_symlinked_marker_path_is_not_resolved(tmp_path):
    """Was the realpath fallback (review B). F9: a realpath on an automounted path can block the request,
    so a marker that names the image through a symlink is left as text (the desktop half sends
    ``attached:<n>`` markers, which do not depend on paths)."""
    real = tmp_path / "real"
    real.mkdir()
    image = real / "a.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n")
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    body = f"看 ![a]({link / 'a.png'}) 完"
    request = OpenAIChat.request(hermes_text(body, [str(image.resolve())]), [OpenAIChat.image("img1")])
    assert interleave.rewrite_request(request) is None


def test_f9_middleware_never_touches_the_file_system(monkeypatch):
    import os
    calls = []
    for name in ("realpath", "exists", "isfile", "isdir", "islink", "lexists", "abspath"):
        original = getattr(os.path, name)
        monkeypatch.setattr(os.path, name, lambda *a, _n=name, _o=original, **k: (calls.append(_n), _o(*a, **k))[1])
    monkeypatch.setattr(os, "stat", lambda *a, _o=os.stat, **k: (calls.append("stat"), _o(*a, **k))[1])
    body = f"一 ![a]({P1}) 二 ![b](/Volumes/net/share/x.png) 三 ![c](attached:2)"
    request = OpenAIChat.request(hermes_text(body, [P1, P3]), [OpenAIChat.image("img1"), OpenAIChat.image("img2")])
    result = interleave.rewrite_request(request)
    seen = list(calls)
    monkeypatch.undo()
    assert seen == [], "file system call in the middleware"
    assert kinds(OpenAIChat, last_user_content(OpenAIChat, result)) == ["text", "img1", "text", "img2"]


def test_d2_percent_encoded_marker_target_is_decoded():
    spaced = "/Users/me/My Cache/rich-paste-cache/20261106/a (1).png"
    body = "看 ![a](/Users/me/My%20Cache/rich-paste-cache/20261106/a%20%281%29.png) 完"
    request = OpenAIChat.request(hermes_text(body, [spaced]), [OpenAIChat.image("img1")])
    assert kinds(OpenAIChat, last_user_content(OpenAIChat, interleave.rewrite_request(request))) == ["text", "img1", "text"]


# ---- 11-10: readable sent labels ("\u2063[截图 2]\u2063"), bound by order ----
S = "\u2063"


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_sent_labels_bind_in_order_and_lose_the_invisible_marks(shape):
    body = f"先看 {S}[截图 2]{S} 再看 {S}[图：流程]{S} 完"
    request = shape.request(hermes_text(body, [P3, P1]), [shape.image("img1"), shape.image("img2")])
    content = last_user_content(shape, interleave.rewrite_request(request))
    assert kinds(shape, content) == ["text", "img1", "text", "img2", "text"]
    texts = [b["text"] for b in content if b["type"] == shape.text_type]
    assert texts == ["先看 [截图 2]", " 再看 [图：流程]", " 完"]


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_sent_labels_leave_extra_images_at_the_end(shape):
    body = f"只有一张标了 {S}[截图 1]{S} 结束"
    request = shape.request(hermes_text(body, [P1, P2]), [shape.image("img1"), shape.image("img2")])
    content = last_user_content(shape, interleave.rewrite_request(request))
    assert kinds(shape, content) == ["text", "img1", "text", "img2"]


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_more_sent_labels_than_images_changes_nothing(shape):
    body = f"{S}[截图 1]{S} {S}[截图 2]{S}"
    request = shape.request(hermes_text(body, [P1]), [shape.image("img1")])
    assert interleave.rewrite_request(request) is None


def test_plain_bracket_text_is_not_a_label():
    request = OpenAIChat.request(hermes_text("看 [截图 1] 这里", [P1]), [OpenAIChat.image("img1")])
    assert interleave.rewrite_request(request) is None


def test_text_mode_sent_labels_bind_by_order():
    body = f"## 标题\n{S}[图：审核流程]{S}\n中间\n{S}[截图 1]{S}\n结尾"
    out = interleave.rewrite_request(text_request(f"{TUI}\n\n{TUI.replace(U1, U2)}\n\n{body}"))["messages"][-1]["content"]
    assert S not in out
    assert out.startswith("## 标题")
    assert out.index("[图：审核流程]") < out.index(U1) < out.index("中间") < out.index("[截图 1]") < out.index(U2) < out.index("结尾")


# ---- review 11-10: the sent image count, and labels in Hermes's appended context ----
def count_token(n):
    return S + "".join(chr(0xE0000 + ord(d)) for d in str(n)) + S


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_a_dropped_image_changes_nothing_instead_of_shifting_labels(shape):
    # Desktop sent 3 images; Hermes could not read the first and dropped its hint and block.
    body = f"a {S}[截图 1]{S} b {S}[截图 2]{S}{count_token(3)}"
    request = shape.request(hermes_text(body, [P2, P3]), [shape.image("img2"), shape.image("plus")])
    assert interleave.rewrite_request(request) is None


@pytest.mark.parametrize("shape", SHAPES, ids=lambda s: s.name)
def test_matching_count_binds_and_the_token_is_not_sent(shape):
    body = f"a {S}[截图 1]{S} b{count_token(2)}"
    request = shape.request(hermes_text(body, [P1, P2]), [shape.image("img1"), shape.image("plus")])
    content = last_user_content(shape, interleave.rewrite_request(request))
    assert kinds(shape, content) == ["text", "img1", "text", "plus"]
    texts = [b["text"] for b in content if b["type"] == shape.text_type]
    assert all(S not in t and not any(0xE0000 <= ord(c) <= 0xE007F for c in t) for t in texts), texts


def test_labels_inside_appended_context_are_not_bindings():
    body = (f"看这里 {S}[截图 1]{S}{count_token(2)}\n\n--- Attached Context ---\n\n"
            f"📄 old.txt\n旧对话 {S}[截图 7]{S} 结束")
    request = OpenAIChat.request(hermes_text(body, [P1, P2]), [OpenAIChat.image("img1"), OpenAIChat.image("plus")])
    content = last_user_content(OpenAIChat, interleave.rewrite_request(request))
    assert kinds(OpenAIChat, content) == ["text", "img1", "text", "plus"]


def test_text_mode_count_mismatch_changes_nothing():
    body = f"## 标题\n{S}[截图 1]{S}\n{S}[截图 2]{S}{count_token(3)}"
    assert interleave.rewrite_request(text_request(f"{TUI}\n\n{TUI.replace(U1, U2)}\n\n{body}")) is None


def test_review_text_mode_with_cache_marker_reads_the_same_as_the_plain_string():
    """Hermes adds cache_control by wrapping the newest string message as one text block before the
    middleware runs; next turn the same message comes back as a plain string. Both must be rewritten
    identically, or the prefix changes between turns."""
    plain = OpenAIChat.request("x", [])
    text = None
    for candidate in [f"[The user sent an image~ Here's what I can see:\nA receipt.]\n[If you need a closer look, use vision_analyze with image_url: {P1} ~]\n\nAnna paid: \u2063[Screenshot 1]\u2063 thanks"]:
        text = candidate
    as_string = {"model": "m", "messages": [{"role": "user", "content": text}]}
    marked = {"model": "m", "messages": [{"role": "user", "content": [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]}]}
    a = interleave.rewrite_request(as_string)
    b = interleave.rewrite_request(marked)
    assert a is not None and b is not None
    assert b["messages"][0]["content"][0]["text"] == a["messages"][0]["content"]
    assert b["messages"][0]["content"][0]["cache_control"] == {"type": "ephemeral"}
