from __future__ import annotations

import json
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.export.anki_exporter import build_apkg_bytes
from app.export.obsidian_exporter import (
    build_obsidian_zip_bytes,
    launch_obsidian_sr_command,
    pull_obsidian_rest_sr_progress,
    pull_obsidian_vault_sr_progress,
    sync_obsidian_rest_api,
    test_obsidian_rest_connection,
    write_obsidian_vault,
)
from app.llm.enricher import enrich_candidates, test_llm_connection
from app.models import (
    EnrichRequest,
    EnrichResponse,
    ExportApkgRequest,
    ExtractRequest,
    ExtractResponse,
    IngestRequest,
    IngestResponse,
    LLMTestRequest,
    LLMTestResponse,
    ObsidianExportRequest,
    ObsidianRestSyncRequest,
    ObsidianRestTestRequest,
    ObsidianRestTestResponse,
    ObsidianSrLaunchRequest,
    ObsidianSrLaunchResponse,
    ObsidianSrPullRequest,
    ObsidianSrPullResponse,
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
    default_model = settings.gemini_model if settings.llm_provider == "gemini" else settings.llm_model
    return {
        "status": "ok",
        "default_provider": settings.llm_provider,
        "default_base_url": settings.llm_base_url,
        "default_model": default_model,
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


@app.post("/api/llm/test", response_model=LLMTestResponse)
async def test_llm_endpoint(payload: LLMTestRequest | None = None) -> LLMTestResponse:
    return await test_llm_connection(override=payload.llm_config if payload else None)


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
        sr_deck_tag=payload.sr_deck_tag if payload else "#flashcards/x-vocab",
        sr_card_style=payload.sr_card_style if payload else "multiline",
        sr_subdeck_by_category=payload.sr_subdeck_by_category if payload else False,
        seed_sr_from_fsrs=payload.sr_seed_progress if payload else False,
        sr_include_audio=payload.sr_include_audio if payload else False,
        sr_audio_autoplay=payload.sr_audio_autoplay if payload else False,
        tts_accent=payload.tts_accent if payload else "en-US",
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
            sr_deck_tag=payload.sr_deck_tag,
            sr_card_style=payload.sr_card_style,
            sr_subdeck_by_category=payload.sr_subdeck_by_category,
            seed_sr_from_fsrs=payload.sr_seed_progress,
            sr_include_audio=payload.sr_include_audio,
            sr_audio_autoplay=payload.sr_audio_autoplay,
            tts_accent=payload.tts_accent,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return ObsidianSyncResponse(
        target_dir=str(target_dir),
        written_count=len(files),
        files=files,
    )


@app.post("/api/export/obsidian-rest-test", response_model=ObsidianRestTestResponse)
async def test_obsidian_rest_endpoint(
    payload: ObsidianRestTestRequest | None = None,
) -> ObsidianRestTestResponse:
    api_url = ((payload.api_url if payload else None) or settings.obsidian_rest_url or "https://127.0.0.1:27124").strip()
    api_key = ((payload.api_key if payload else None) or settings.obsidian_rest_api_key or "").strip()
    return await test_obsidian_rest_connection(api_url=api_url, api_key=api_key)


@app.post("/api/export/obsidian-rest-sync", response_model=ObsidianSyncResponse)
async def sync_obsidian_rest_endpoint(payload: ObsidianRestSyncRequest) -> ObsidianSyncResponse:
    store = get_store()
    cards = payload.cards if payload.cards is not None else store.load_state().cards
    if not cards:
        raise HTTPException(status_code=400, detail="当前没有可写入 Obsidian 的词卡，请先生成或加载词卡。")

    api_url = (payload.api_url or settings.obsidian_rest_url or "https://127.0.0.1:27124").strip()
    api_key = (payload.api_key or settings.obsidian_rest_api_key or "").strip()
    subfolder = payload.subfolder or settings.obsidian_subfolder
    try:
        target_dir, files = await sync_obsidian_rest_api(
            cards,
            api_url=api_url,
            api_key=api_key,
            subfolder=subfolder,
            include_flashcards=payload.include_flashcards,
            sr_deck_tag=payload.sr_deck_tag,
            sr_card_style=payload.sr_card_style,
            sr_subdeck_by_category=payload.sr_subdeck_by_category,
            seed_sr_from_fsrs=payload.sr_seed_progress,
            sr_include_audio=payload.sr_include_audio,
            sr_audio_autoplay=payload.sr_audio_autoplay,
            tts_accent=payload.tts_accent,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"连接 Obsidian Local REST API 失败：{exc}。请确认 Obsidian 已打开并启用 Local REST API 插件。",
        ) from exc

    return ObsidianSyncResponse(
        target_dir=target_dir,
        written_count=len(files),
        files=files,
    )


@app.post("/api/export/obsidian-sr-pull", response_model=ObsidianSrPullResponse)
async def pull_obsidian_sr_endpoint(payload: ObsidianSrPullRequest) -> ObsidianSrPullResponse:
    store = get_store()
    cards = payload.cards if payload.cards is not None else store.load_state().cards
    if not cards:
        raise HTTPException(status_code=400, detail="当前词库为空，无法匹配 Obsidian Spaced Repetition 进度。")

    subfolder = payload.subfolder or settings.obsidian_subfolder
    try:
        if payload.mode == "rest_api":
            api_url = (payload.api_url or settings.obsidian_rest_url or "https://127.0.0.1:27124").strip()
            api_key = (payload.api_key or settings.obsidian_rest_api_key or "").strip()
            scanned_notes, notes_with_sr, updated_cards, updated_words = await pull_obsidian_rest_sr_progress(
                cards,
                api_url=api_url,
                api_key=api_key,
                subfolder=subfolder,
            )
        else:
            vault_path = (payload.vault_path or settings.obsidian_vault_dir or "").strip()
            scanned_notes, notes_with_sr, updated_cards, updated_words = pull_obsidian_vault_sr_progress(
                cards,
                vault_path=vault_path,
                subfolder=subfolder,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"读取 Obsidian Local REST API 失败：{exc}。",
        ) from exc

    if payload.apply_to_store and updated_cards:
        state = store.load_state()
        by_id = {c.id: c for c in updated_cards}
        by_word = {c.word.strip().lower(): c for c in updated_cards}
        changed = False
        merged_cards: list[VocabCard] = []
        for existing in state.cards:
            replacement = by_id.get(existing.id) or by_word.get(existing.word.strip().lower())
            if replacement is not None:
                merged_cards.append(replacement)
                changed = True
            else:
                merged_cards.append(existing)
        if changed:
            state.cards = merged_cards
            store.save_state(state)

    return ObsidianSrPullResponse(
        scanned_notes=scanned_notes,
        notes_with_sr=notes_with_sr,
        updated_count=len(updated_cards),
        updated_words=updated_words,
        updated_cards=updated_cards,
    )


@app.post("/api/export/obsidian-sr-launch", response_model=ObsidianSrLaunchResponse)
async def launch_obsidian_sr_endpoint(
    payload: ObsidianSrLaunchRequest | None = None,
) -> ObsidianSrLaunchResponse:
    api_url = ((payload.api_url if payload else None) or settings.obsidian_rest_url or "https://127.0.0.1:27124").strip()
    api_key = ((payload.api_key if payload else None) or settings.obsidian_rest_api_key or "").strip()
    command_id = payload.command_id if payload else None
    try:
        return await launch_obsidian_sr_command(
            api_url=api_url,
            api_key=api_key,
            command_id=command_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"唤醒 Obsidian Spaced Repetition 插件失败：{exc}。",
        ) from exc

