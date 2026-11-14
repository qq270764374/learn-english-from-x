from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.export.anki_exporter import build_apkg_bytes
from app.export.obsidian_exporter import build_obsidian_zip_bytes, write_obsidian_vault
from app.llm.enricher import enrich_candidates
from app.models import (
    EnrichRequest,
    EnrichResponse,
    ExportApkgRequest,
    ExtractRequest,
    ExtractResponse,
    IngestRequest,
    IngestResponse,
    ObsidianExportRequest,
    ObsidianSyncResponse,
    SyncStateDocument,
    TweetItem,
    VocabCard,
)
from app.nlp.extractor import extract_candidates
from app.storage.local_store import LocalStore

DATA_DIR = Path(__file__).resolve().parent / "data"

app = FastAPI(
    title="LearnEnglishFromX API",
    version="0.1.0",
    description="Local NLP + DeepSeek/Gemini vocabulary extraction and Anki export service",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_store() -> LocalStore:
    return LocalStore(settings.data_dir)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "default_provider": settings.llm_provider,
        "default_model": settings.llm_model,
        "default_filter_tier": settings.default_filter_tier,
    }


@app.get("/api/creators")
def list_starter_creators() -> list[dict]:
    path = DATA_DIR / "starter_creators.json"
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/demo-tweets")
def list_demo_tweets() -> list[TweetItem]:
    path = DATA_DIR / "sample_tweets.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    return [TweetItem.model_validate(item) for item in raw]


@app.get("/api/demo-cards")
def list_demo_cards() -> list[VocabCard]:
    path = DATA_DIR / "demo_cards.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    return [VocabCard.model_validate(item) for item in raw]


@app.get("/api/tweets")
def list_tweets() -> list[TweetItem]:
    return get_store().load_tweets()


@app.post("/api/ingest", response_model=IngestResponse)
def ingest_tweets(payload: IngestRequest) -> IngestResponse:
    added, total = get_store().ingest_tweets(payload.tweets)
    return IngestResponse(added=added, total_tweets=total)


@app.post("/api/extract", response_model=ExtractResponse)
def extract_vocab(payload: ExtractRequest) -> ExtractResponse:
    store = get_store()
    tweets = payload.tweets if payload.tweets is not None else store.load_tweets()
    state = store.load_state()
    known = sorted(set(state.known_words) | set(payload.known_words))
    ignored = sorted(set(state.ignored_words) | set(payload.ignored_words))

    candidates = extract_candidates(
        tweets=tweets,
        filter_tier=payload.filter_tier,
        known_words=known,
        ignored_words=ignored,
        max_candidates=payload.max_candidates,
        include_slang=payload.include_slang,
    )
    return ExtractResponse(total_tweets_analyzed=len(tweets), candidates=candidates)


@app.post("/api/enrich", response_model=EnrichResponse)
async def enrich_vocab(payload: EnrichRequest) -> EnrichResponse:
    try:
        cards, skipped_ignored = await enrich_candidates(
            candidates=payload.candidates,
            override=payload.llm_config,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"大模型请求失败：{exc}") from exc

    if payload.auto_save and (cards or skipped_ignored):
        get_store().append_cards(cards, skipped_ignored)

    return EnrichResponse(cards=cards, skipped_ignored=skipped_ignored)


@app.get("/api/state", response_model=SyncStateDocument)
def get_state() -> SyncStateDocument:
    return get_store().load_state()


@app.post("/api/state/sync", response_model=SyncStateDocument)
def sync_state(remote_state: SyncStateDocument) -> SyncStateDocument:
    return get_store().merge_state(remote_state)


@app.post("/api/export/apkg")
def export_apkg(payload: ExportApkgRequest | None = None) -> Response:
    store = get_store()
    cards = payload.cards if payload and payload.cards is not None else store.load_state().cards
    if not cards:
        raise HTTPException(status_code=400, detail="当前没有可导出的词卡，请先采集并生成词卡。")
    deck_name = payload.deck_name if payload else "LearnEnglishFromX"
    apkg_bytes = build_apkg_bytes(cards, deck_name=deck_name)
    return Response(
        content=apkg_bytes,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{deck_name}.apkg"'},
    )


@app.post("/api/export/obsidian-zip")
def export_obsidian_zip(payload: ObsidianExportRequest | None = None) -> Response:
    store = get_store()
    cards = payload.cards if payload and payload.cards is not None else store.load_state().cards
    if not cards:
        raise HTTPException(status_code=400, detail="当前没有可导出的词卡，请先加载示例词卡或采集生成词卡。")
    subfolder = (payload.subfolder if payload else None) or settings.obsidian_subfolder
    include_flashcards = payload.include_flashcards if payload else True
    zip_bytes = build_obsidian_zip_bytes(
        cards,
        subfolder=subfolder,
        include_flashcards=include_flashcards,
    )
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="LearnEnglishFromX-Obsidian.zip"'},
    )


@app.post("/api/export/obsidian-sync", response_model=ObsidianSyncResponse)
def sync_obsidian_vault(payload: ObsidianExportRequest) -> ObsidianSyncResponse:
    store = get_store()
    cards = payload.cards if payload.cards is not None else store.load_state().cards
    if not cards:
        raise HTTPException(status_code=400, detail="当前没有可写入 Obsidian 的词卡，请先生成或加载词卡。")

    vault_path = (payload.vault_path or settings.obsidian_vault_dir or "").strip()
    subfolder = payload.subfolder or settings.obsidian_subfolder
    try:
        target_dir, files = write_obsidian_vault(
            cards,
            vault_path=vault_path,
            subfolder=subfolder,
            include_flashcards=payload.include_flashcards,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return ObsidianSyncResponse(
        target_dir=str(target_dir),
        written_count=len(files),
        files=files,
    )

