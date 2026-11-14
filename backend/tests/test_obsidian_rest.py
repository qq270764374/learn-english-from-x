from __future__ import annotations

import asyncio
from urllib.parse import unquote

import httpx
import pytest
from fastapi.testclient import TestClient

from app.export.obsidian_exporter import (
    USER_NOTES_MARKER,
    apply_obsidian_sr_to_cards,
    build_obsidian_audio_url,
    launch_obsidian_sr_command,
    parse_obsidian_sr_metadata,
    pull_obsidian_rest_sr_progress,
    pull_obsidian_vault_sr_progress,
    render_card_markdown,
    sync_obsidian_rest_api,
    test_obsidian_rest_connection,
    write_obsidian_vault,
)
from app.main import app
from app.models import FSRSStateModel, ObsidianRestTestResponse, ObsidianSrLaunchResponse, VocabCard


def _make_card(
    *,
    card_id: str = "c1",
    word: str = "nuance",
    category: str = "standard",
    meaning_zh: str = "微妙之处",
    sample_tweet: str = "There is a subtle nuance in that phrasing.",
) -> VocabCard:
    return VocabCard(
        id=card_id,
        word=word,
        ipa="/ˈnjuːɑːns/",
        pos="n.",
        category=category,
        cefr_level="C1",
        meaning_zh=meaning_zh,
        memory_tip_zh="关注细微差别",
        sample_tweet=sample_tweet,
        sample_tweet_zh="那句话里有一个微妙的区别。",
        author_handle="@paulg",
        tweet_url="https://x.com/paulg/status/1",
    )


def test_obsidian_rest_connection_success_and_auth_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/"
        auth = request.headers.get("authorization", "")
        if auth == "Bearer valid-key":
            return httpx.Response(
                200,
                json={
                    "status": "OK",
                    "authenticated": True,
                    "versions": {"obsidian": "1.8.4", "self": "3.1.0"},
                },
            )
        return httpx.Response(
            200,
            json={
                "status": "OK",
                "authenticated": False,
                "versions": {"obsidian": "1.8.4", "self": "3.1.0"},
            },
        )

    transport = httpx.MockTransport(handler)
    async def run_checks() -> None:
        async with httpx.AsyncClient(transport=transport) as client:
            ok_res = await test_obsidian_rest_connection(
                "https://127.0.0.1:27124/",
                "valid-key",
                client=client,
            )
            assert ok_res.ok is True
            assert ok_res.authenticated is True
            assert ok_res.plugin_version == "3.1.0"

            bad_res = await test_obsidian_rest_connection(
                "https://127.0.0.1:27124",
                "wrong-key",
                client=client,
            )
            assert bad_res.ok is False
            assert bad_res.authenticated is False
            assert "API Key" in bad_res.message

    asyncio.run(run_checks())


def test_sync_obsidian_rest_api_preserves_sr_and_user_notes() -> None:
    vault: dict[str, str] = {
        "Study/X-Vocab/nuance.md": "\n".join(
            [
                "# nuance",
                "<!--SR:!2026-04-20,7,250-->",
                USER_NOTES_MARKER,
                "",
                "## 我的个人笔记",
                "",
                "- 自己造句：Capture every nuance.",
            ]
        )
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != "Bearer secret-token":
            return httpx.Response(401, text="Unauthorized")
        path = unquote(request.url.path)
        assert path.startswith("/vault/")
        rel_path = path[len("/vault/") :]
        if request.method == "GET":
            if rel_path in vault:
                return httpx.Response(200, text=vault[rel_path])
            return httpx.Response(404, text="Not Found")
        if request.method == "PUT":
            assert "text/markdown" in request.headers.get("content-type", "")
            vault[rel_path] = request.content.decode("utf-8")
            return httpx.Response(204)
        return httpx.Response(405)

    cards = [
        _make_card(),
        _make_card(
            card_id="c2",
            word="figure out",
            category="collocation",
            meaning_zh="弄明白",
            sample_tweet="We figured out the bottleneck.",
        ),
    ]

    async def run_sync() -> tuple[str, list[str]]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await sync_obsidian_rest_api(
                cards,
                api_url="http://127.0.0.1:27123/",
                api_key="secret-token",
                subfolder="Study/X-Vocab",
                include_flashcards=True,
                client=client,
            )

    target_dir, written = asyncio.run(run_sync())
    assert target_dir == "http://127.0.0.1:27123 (Study/X-Vocab)"
    assert written == ["_X-Vocab 词库总览.md", "nuance.md", "figure out.md"]

    nuance_md = vault["Study/X-Vocab/nuance.md"]
    assert "<!--SR:!2026-04-20,7,250-->" in nuance_md
    assert "- 自己造句：Capture every nuance." in nuance_md
    assert "==nuance==" in nuance_md

    phrase_md = vault["Study/X-Vocab/figure out.md"]
    assert "==figured out==" in phrase_md
    assert "[[nuance]]" in vault["Study/X-Vocab/_X-Vocab 词库总览.md"]


def test_sync_obsidian_rest_api_requires_key() -> None:
    async def run_missing_key() -> None:
        await sync_obsidian_rest_api(
            [_make_card()],
            api_url="http://127.0.0.1:27123",
            api_key=" ",
        )

    with pytest.raises(ValueError, match="API Key"):
        asyncio.run(run_missing_key())


def test_fastapi_obsidian_rest_endpoints(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_test(api_url: str, api_key: str = "") -> ObsidianRestTestResponse:
        return ObsidianRestTestResponse(
            ok=True,
            url=api_url,
            status_code=200,
            authenticated=True,
            latency_ms=12,
            plugin_version="3.1.0",
            obsidian_version="1.8.4",
            message="ok",
        )

    async def fake_sync(
        cards: list[VocabCard],
        api_url: str,
        api_key: str,
        subfolder: str = "X-Vocab",
        include_flashcards: bool = True,
        **_: object,
    ) -> tuple[str, list[str]]:
        assert len(cards) == 1
        assert api_key == "abc"
        return f"{api_url} ({subfolder})", ["_X-Vocab 词库总览.md", "nuance.md"]

    async def fake_pull(
        cards: list[VocabCard],
        api_url: str,
        api_key: str,
        subfolder: str = "X-Vocab",
    ) -> tuple[int, int, list[VocabCard], list[str]]:
        assert api_key == "abc"
        updated = cards[0].model_copy(
            update={"fsrs": cards[0].fsrs.model_copy(update={"reps": 2, "scheduled_days": 5})}
        )
        return 1, 1, [updated], [updated.word]

    async def fake_launch(
        api_url: str,
        api_key: str,
        command_id: str | None = None,
    ) -> ObsidianSrLaunchResponse:
        assert api_key == "abc"
        return ObsidianSrLaunchResponse(
            ok=True,
            command_id=command_id or "obsidian-spaced-repetition:review-flashcards",
            command_name="Review flashcards",
            message="ok",
        )

    monkeypatch.setattr("app.main.test_obsidian_rest_connection", fake_test)
    monkeypatch.setattr("app.main.sync_obsidian_rest_api", fake_sync)
    monkeypatch.setattr("app.main.pull_obsidian_rest_sr_progress", fake_pull)
    monkeypatch.setattr("app.main.launch_obsidian_sr_command", fake_launch)

    client = TestClient(app)
    test_resp = client.post(
        "/api/export/obsidian-rest-test",
        json={"api_url": "http://127.0.0.1:27123", "api_key": "abc"},
    )
    assert test_resp.status_code == 200
    assert test_resp.json()["ok"] is True

    sync_resp = client.post(
        "/api/export/obsidian-rest-sync",
        json={
            "cards": [_make_card().model_dump()],
            "api_url": "http://127.0.0.1:27123",
            "api_key": "abc",
            "subfolder": "X-Vocab",
            "include_flashcards": True,
        },
    )
    assert sync_resp.status_code == 200
    assert sync_resp.json()["written_count"] == 2
    assert sync_resp.json()["files"] == ["_X-Vocab 词库总览.md", "nuance.md"]

    pull_resp = client.post(
        "/api/export/obsidian-sr-pull",
        json={
            "mode": "rest_api",
            "cards": [_make_card().model_dump()],
            "api_url": "http://127.0.0.1:27123",
            "api_key": "abc",
            "subfolder": "X-Vocab",
            "apply_to_store": False,
        },
    )
    assert pull_resp.status_code == 200
    assert pull_resp.json()["updated_count"] == 1
    assert pull_resp.json()["updated_words"] == ["nuance"]

    launch_resp = client.post(
        "/api/export/obsidian-sr-launch",
        json={"api_url": "http://127.0.0.1:27123", "api_key": "abc"},
    )
    assert launch_resp.status_code == 200
    assert launch_resp.json()["command_id"] == "obsidian-spaced-repetition:review-flashcards"


def test_render_sr_styles_subdecks_multiline_quotes_and_seed() -> None:
    card = _make_card(
        word="figure out",
        category="collocation",
        meaning_zh="弄明白",
        sample_tweet="First line figure out.\n\nSecond paragraph still quoted.",
    ).model_copy(
        update={
            "fsrs": FSRSStateModel(
                due="2026-11-20T09:00:00Z",
                stability=6.0,
                difficulty=4.0,
                scheduled_days=6,
                reps=2,
                state=2,
                last_review="2026-11-14T09:00:00Z",
            )
        }
    )

    bidir_md = render_card_markdown(
        card,
        include_flashcards=True,
        sr_deck_tag="#flashcards/英语",
        sr_card_style="bidirectional",
        sr_subdeck_by_category=True,
        seed_sr_from_fsrs=True,
    )
    assert "## 闪卡复习 #flashcards/英语/地道搭配" in bidir_md
    assert "\n??\n" in bidir_md
    assert "> First line ==figure out==.\n>\n> Second paragraph still quoted." in bidir_md
    assert "<!--SR:!2026-11-20,6,250!2026-11-20,6,250-->" in bidir_md

    inline_md = render_card_markdown(
        card,
        include_flashcards=True,
        sr_deck_tag="flashcards/x-vocab",
        sr_card_style="inline",
        seed_sr_from_fsrs=True,
    )
    assert "## 闪卡复习 #flashcards/x-vocab" in inline_md
    assert ":: **弄明白**" in inline_md
    assert "<!--SR:!2026-11-20,6,250-->" in inline_md


def test_parse_and_apply_obsidian_sr_pull_vault_and_rest(tmp_path) -> None:
    parsed_bidir = parse_obsidian_sr_metadata(
        '---\nword: "nuance"\n---\n<!--SR:!2026-11-25,10,270!2026-11-18,4,240-->'
    )
    assert parsed_bidir == {"due": "2026-11-18", "interval": 4, "ease": 240, "word": "nuance"}

    new_card = _make_card(word="nuance")
    newer_web_card = _make_card(card_id="c2", word="resilient").model_copy(
        update={
            "fsrs": FSRSStateModel(
                due="2026-11-30T09:00:00+00:00",
                scheduled_days=10,
                stability=10.0,
                reps=3,
                state=2,
                last_review="2026-11-20T09:00:00+00:00",
            )
        }
    )

    write_obsidian_vault([new_card, newer_web_card], vault_path=str(tmp_path), subfolder="X-Vocab")
    nuance_path = tmp_path / "X-Vocab" / "nuance.md"
    nuance_path.write_text(
        nuance_path.read_text(encoding="utf-8") + "\n<!--SR:!2026-11-21,7,260-->\n",
        encoding="utf-8",
    )
    resilient_path = tmp_path / "X-Vocab" / "resilient.md"
    resilient_path.write_text(
        resilient_path.read_text(encoding="utf-8") + "\n<!--SR:!2026-11-12,2,240-->\n",
        encoding="utf-8",
    )

    scanned, with_sr, updated_cards, updated_words = pull_obsidian_vault_sr_progress(
        [new_card, newer_web_card],
        vault_path=str(tmp_path),
        subfolder="X-Vocab",
    )
    assert scanned == 2
    assert with_sr == 2
    assert updated_words == ["nuance"]
    assert updated_cards[0].fsrs.scheduled_days == 7
    assert updated_cards[0].fsrs.due.startswith("2026-11-21")
    assert updated_cards[0].fsrs.reps == 1

    # Verify REST pull + launch command via MockTransport
    notes_map = {
        "X-Vocab/nuance.md": nuance_path.read_text(encoding="utf-8"),
    }
    executed_cmds: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = unquote(request.url.path)
        if path == "/vault/X-Vocab/":
            return httpx.Response(200, json={"files": ["nuance.md", "_X-Vocab 词库总览.md"]})
        if path.startswith("/vault/") and request.method == "GET":
            rel = path[len("/vault/") :]
            return (
                httpx.Response(200, text=notes_map[rel])
                if rel in notes_map
                else httpx.Response(404)
            )
        if path == "/commands/" and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "commands": [
                        {"id": "obsidian-spaced-repetition:cram-flashcards", "name": "Cram"},
                        {"id": "obsidian-spaced-repetition:review-flashcards", "name": "Review Flashcards"},
                    ]
                },
            )
        if path.startswith("/commands/") and request.method == "POST":
            executed_cmds.append(path)
            return httpx.Response(204)
        return httpx.Response(404)

    async def run_rest_sr() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            r_scan, _, r_cards, _ = await pull_obsidian_rest_sr_progress(
                [new_card],
                api_url="http://127.0.0.1:27123",
                api_key="tok",
                subfolder="X-Vocab",
                client=client,
            )
            assert r_scan == 1
            assert len(r_cards) == 1
            assert r_cards[0].fsrs.scheduled_days == 7

            launch_res = await launch_obsidian_sr_command(
                api_url="http://127.0.0.1:27123",
                api_key="tok",
                client=client,
            )
            assert launch_res.ok is True
            assert launch_res.command_id == "obsidian-spaced-repetition:review-flashcards"
            assert executed_cmds == ["/commands/obsidian-spaced-repetition:review-flashcards/"]

    asyncio.run(run_rest_sr())
    assert apply_obsidian_sr_to_cards([], []) == (0, 0, [], [])

    empty_resp = client.post(
        "/api/export/obsidian-rest-sync",
        json={"cards": [], "api_url": "http://127.0.0.1:27123", "api_key": "abc"},
    )
    assert empty_resp.status_code == 400


def test_obsidian_sr_inline_audio_option_b(tmp_path) -> None:
    phrase_card = _make_card(
        card_id="c-phrase",
        word="figure out",
        category="collocation",
        meaning_zh="弄明白；想出",
        sample_tweet="Let us figure out how to optimize this workflow.",
    )

    assert build_obsidian_audio_url("figure out", "en-US") == (
        "https://dict.youdao.com/dictvoice?audio=figure%20out&type=2"
    )
    assert build_obsidian_audio_url("figure out", "en-GB") == (
        "https://dict.youdao.com/dictvoice?audio=figure%20out&type=1"
    )

    default_md = render_card_markdown(phrase_card)
    assert "<audio" not in default_md

    us_multiline = render_card_markdown(
        phrase_card,
        include_flashcards=True,
        sr_card_style="multiline",
        sr_include_audio=True,
        sr_audio_autoplay=True,
        tts_accent="en-US",
    )
    expected_us_url = "https://dict.youdao.com/dictvoice?audio=figure%20out&type=2"
    assert f'<audio controls preload="none" src="{expected_us_url}"></audio>\n\n## 语境释义' in us_multiline
    assert (
        f'**figure out** /ˈnjuːɑːns/ n.\n'
        f'<audio controls autoplay src="{expected_us_url}"></audio>\n'
        f'> Let us ==figure out== how to optimize this workflow.'
    ) in us_multiline

    gb_bidir = render_card_markdown(
        phrase_card,
        include_flashcards=True,
        sr_card_style="bidirectional",
        sr_include_audio=True,
        sr_audio_autoplay=True,
        tts_accent="en-GB",
    )
    expected_gb_url = "https://dict.youdao.com/dictvoice?audio=figure%20out&type=1"
    assert expected_gb_url in gb_bidir
    assert "autoplay" not in gb_bidir
    assert gb_bidir.count(f'<audio controls preload="none" src="{expected_gb_url}"></audio>') == 2

    inline_md = render_card_markdown(
        phrase_card,
        include_flashcards=True,
        sr_card_style="inline",
        sr_include_audio=True,
        sr_audio_autoplay=True,
        tts_accent="en-US",
    )
    assert f'<audio controls autoplay src="{expected_us_url}"></audio> :: **弄明白；想出**' in inline_md

    write_obsidian_vault(
        [phrase_card],
        vault_path=str(tmp_path),
        subfolder="X-Vocab",
        sr_include_audio=True,
        sr_audio_autoplay=False,
        tts_accent="en-GB",
    )
    written_note = (tmp_path / "X-Vocab" / "figure out.md").read_text(encoding="utf-8")
    assert f'<audio controls preload="none" src="{expected_gb_url}"></audio>' in written_note
    assert "autoplay" not in written_note

    client = TestClient(app)
    api_sync_resp = client.post(
        "/api/export/obsidian-sync",
        json={
            "cards": [phrase_card.model_dump()],
            "vault_path": str(tmp_path),
            "subfolder": "X-Vocab-API",
            "include_flashcards": True,
            "sr_card_style": "multiline",
            "sr_include_audio": True,
            "sr_audio_autoplay": True,
            "tts_accent": "en-US",
        },
    )
    assert api_sync_resp.status_code == 200
    api_note = (tmp_path / "X-Vocab-API" / "figure out.md").read_text(encoding="utf-8")
    assert f'<audio controls autoplay src="{expected_us_url}"></audio>' in api_note
