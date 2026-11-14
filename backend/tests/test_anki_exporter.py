import io
import json
import sqlite3
import tempfile
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.export.anki_exporter import build_apkg_bytes
from app.main import app
from app.models import VocabCard


def test_build_apkg_bytes_contains_valid_anki_sqlite():
    demo_path = Path(__file__).resolve().parent.parent / "app" / "data" / "demo_cards.json"
    cards = [VocabCard.model_validate(item) for item in json.loads(demo_path.read_text(encoding="utf-8"))]

    apkg_bytes = build_apkg_bytes(cards, deck_name="LearnEnglishFromX_Test")
    assert len(apkg_bytes) > 1000

    with zipfile.ZipFile(io.BytesIO(apkg_bytes)) as zf:
        names = set(zf.namelist())
        assert "collection.anki2" in names
        sqlite_bytes = zf.read("collection.anki2")

    with tempfile.NamedTemporaryFile(suffix=".anki2") as tmp:
        tmp.write(sqlite_bytes)
        tmp.flush()
        conn = sqlite3.connect(tmp.name)
        count = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        conn.close()

    assert count == len(cards)


def test_fastapi_endpoints_demo_and_export(tmp_path, monkeypatch):
    from app import config

    monkeypatch.setattr(config.settings, "data_dir", tmp_path)
    client = TestClient(app)

    health_res = client.get("/api/health")
    assert health_res.status_code == 200
    assert health_res.json()["default_model"] == "deepseek-chat"

    creators_res = client.get("/api/creators")
    assert creators_res.status_code == 200
    creators = creators_res.json()
    assert len(creators) >= 12
    categories = {c["category"] for c in creators}
    assert {"AI", "科技", "游戏", "音乐", "生活"}.issubset(categories)

    demo_cards = client.get("/api/demo-cards").json()
    assert len(demo_cards) == 7

    export_res = client.post("/api/export/apkg", json={"cards": demo_cards, "deck_name": "DemoX"})
    assert export_res.status_code == 200
    assert export_res.headers["content-type"] == "application/octet-stream"
    assert len(export_res.content) > 1000
