import io
import json
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.export.obsidian_exporter import (
    USER_NOTES_MARKER,
    build_obsidian_zip_bytes,
    render_card_markdown,
    write_obsidian_vault,
)
from app.main import app
from app.models import VocabCard


def _load_demo_cards() -> list[VocabCard]:
    demo_path = Path(__file__).resolve().parent.parent / "app" / "data" / "demo_cards.json"
    return [VocabCard.model_validate(item) for item in json.loads(demo_path.read_text(encoding="utf-8"))]


def test_render_card_markdown_both_modes():
    card = _load_demo_cards()[0]  # subtle

    with_sr = render_card_markdown(card, include_flashcards=True)
    assert 'word: "subtle"' in with_sr
    assert 'author: "[[@karpathy]]"' in with_sr
    assert "==subtle==" in with_sr
    assert "#flashcards/x-vocab" in with_sr
    assert "\n?\n" in with_sr

    notes_only = render_card_markdown(card, include_flashcards=False)
    assert 'word: "subtle"' in notes_only
    assert "==subtle==" in notes_only
    assert "#flashcards/x-vocab" not in notes_only


def test_write_obsidian_vault_preserves_user_notes_and_sr_metadata(tmp_path):
    cards = _load_demo_cards()[:2]

    target_dir, written = write_obsidian_vault(
        cards,
        vault_path=str(tmp_path),
        subfolder="X-Vocab",
        include_flashcards=True,
    )
    assert target_dir == tmp_path / "X-Vocab"
    assert "_X-Vocab 词库总览.md" in written
    assert "subtle.md" in written
    assert "figure out.md" in written

    subtle_file = target_dir / "subtle.md"
    existing = subtle_file.read_text(encoding="utf-8")
    # Simulate Obsidian Spaced Repetition scheduling comment + personal user note
    edited = existing.replace(
        "## 我的个人笔记\n\n- 在这里补充联想、同义词或自己造的句子…",
        "## 我的个人笔记\n\n- 自己造句：a subtle shift in tone.",
    ).replace(
        USER_NOTES_MARKER,
        "<!--SR:!2026-11-18,4,250-->\n\n" + USER_NOTES_MARKER,
    )
    subtle_file.write_text(edited, encoding="utf-8")

    # Re-sync should preserve both SR scheduling comment and user notes
    write_obsidian_vault(
        cards,
        vault_path=str(tmp_path),
        subfolder="X-Vocab",
        include_flashcards=True,
    )
    resynced = subtle_file.read_text(encoding="utf-8")
    assert "<!--SR:!2026-11-18,4,250-->" in resynced
    assert "自己造句：a subtle shift in tone." in resynced


def test_build_obsidian_zip_bytes_contains_index_and_notes():
    cards = _load_demo_cards()
    zip_bytes = build_obsidian_zip_bytes(cards, subfolder="X-Vocab", include_flashcards=True)

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = set(zf.namelist())
        assert "X-Vocab/_X-Vocab 词库总览.md" in names
        assert "X-Vocab/subtle.md" in names
        assert "X-Vocab/figure out.md" in names
        assert len(names) == len(cards) + 1


def test_fastapi_obsidian_endpoints(tmp_path, monkeypatch):
    from app import config

    monkeypatch.setattr(config.settings, "data_dir", tmp_path / "data")
    vault_dir = tmp_path / "MyObsidianVault"
    vault_dir.mkdir(parents=True)

    client = TestClient(app)
    demo_cards = client.get("/api/demo-cards").json()

    zip_res = client.post(
        "/api/export/obsidian-zip",
        json={"cards": demo_cards, "subfolder": "X-Vocab", "include_flashcards": True},
    )
    assert zip_res.status_code == 200
    assert zip_res.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(zip_res.content)) as zf:
        assert "X-Vocab/subtle.md" in zf.namelist()

    sync_res = client.post(
        "/api/export/obsidian-sync",
        json={
            "cards": demo_cards,
            "vault_path": str(vault_dir),
            "subfolder": "X-Vocab",
            "include_flashcards": True,
        },
    )
    assert sync_res.status_code == 200
    body = sync_res.json()
    assert body["written_count"] == len(demo_cards) + 1
    assert (vault_dir / "X-Vocab" / "subtle.md").exists()
