from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal
from pydantic import BaseModel, Field


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class TweetItem(BaseModel):
    id: str
    url: str = ""
    author_handle: str = ""
    author_name: str = ""
    text: str
    created_at: str = ""
    source_page: str = "manual"
    captured_at: str = Field(default_factory=utc_now_iso)


class IngestRequest(BaseModel):
    tweets: list[TweetItem]


class IngestResponse(BaseModel):
    added: int
    total_tweets: int


class SampleContext(BaseModel):
    tweet_id: str
    author_handle: str
    url: str
    text: str


class CandidateWord(BaseModel):
    lemma: str
    surface_forms: list[str]
    pos: str = "noun"
    is_phrase: bool = False
    is_slang_seed: bool = False
    slang_hint: str = ""
    corpus_count: int
    zipf_score: float
    sweet_spot_score: float
    sample_tweets: list[SampleContext]


FilterTier = Literal[
    "strict_1200",
    "basic_2000",
    "cet4_3500",
    "cet6_5500",
    "ielts_8000",
    "advanced_12000",
    "custom",
]


class ExtractRequest(BaseModel):
    filter_tier: FilterTier = "basic_2000"
    custom_vocab_limit: int = Field(default=5500, ge=0, le=25000)
    custom_zipf_min: float = Field(default=1.8, ge=1.0, le=5.8)
    custom_zipf_max: float = Field(default=5.0, ge=1.2, le=6.5)
    known_words: list[str] = Field(default_factory=list)
    ignored_words: list[str] = Field(default_factory=list)
    max_candidates: int = 80
    include_slang: bool = True
    tweets: list[TweetItem] | None = None


class ExtractResponse(BaseModel):
    total_tweets_analyzed: int
    candidates: list[CandidateWord]


class LLMOverrideConfig(BaseModel):
    provider: Literal["openai_compatible", "gemini"] | None = None
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None


class EnrichRequest(BaseModel):
    candidates: list[CandidateWord]
    llm_config: LLMOverrideConfig | None = None
    auto_save: bool = True
    filter_tier: FilterTier = "basic_2000"
    custom_vocab_limit: int = Field(default=5500, ge=0, le=25000)


class LLMTestRequest(BaseModel):
    """Payload for probing connectivity to the configured LLM provider."""

    llm_config: LLMOverrideConfig | None = None


class LLMTestResponse(BaseModel):
    """Structured diagnostic result from testing an LLM endpoint."""

    ok: bool
    provider: Literal["openai_compatible", "gemini"]
    model: str
    endpoint: str
    latency_ms: int
    is_local: bool = False
    message: str
    reply_preview: str = ""
    available_models: list[str] = Field(default_factory=list)


class FSRSStateModel(BaseModel):
    due: str = Field(default_factory=utc_now_iso)
    stability: float = 0.0
    difficulty: float = 0.0
    elapsed_days: int = 0
    scheduled_days: int = 0
    learning_steps: int = 0
    reps: int = 0
    lapses: int = 0
    state: int = 0  # 0=New, 1=Learning, 2=Review, 3=Relearning
    last_review: str | None = None


class VocabCard(BaseModel):
    id: str
    word: str
    ipa: str = ""
    pos: str = ""
    category: Literal["standard", "collocation", "slang"] = "standard"
    cefr_level: str = "B1"
    meaning_zh: str
    memory_tip_zh: str = ""
    sample_tweet: str
    sample_tweet_zh: str = ""
    author_handle: str = ""
    tweet_url: str = ""
    fsrs: FSRSStateModel = Field(default_factory=FSRSStateModel)
    created_at: str = Field(default_factory=utc_now_iso)
    updated_at: str = Field(default_factory=utc_now_iso)


class ReviewLogEntry(BaseModel):
    card_id: str
    word: str
    rating: int  # 1=Again, 2=Hard, 3=Good, 4=Easy
    reviewed_at: str
    state: int = 0


class SyncStateDocument(BaseModel):
    version: int = 1
    updated_at: str = Field(default_factory=utc_now_iso)
    cards: list[VocabCard] = Field(default_factory=list)
    known_words: list[str] = Field(default_factory=list)
    ignored_words: list[str] = Field(default_factory=list)
    processed_tweet_ids: list[str] = Field(default_factory=list)
    review_logs: list[ReviewLogEntry] = Field(default_factory=list)


class EnrichResponse(BaseModel):
    cards: list[VocabCard]
    skipped_ignored: list[str]


class ExportApkgRequest(BaseModel):
    cards: list[VocabCard] | None = None
    deck_name: str = "LearnEnglishFromX"


class ObsidianExportRequest(BaseModel):
    cards: list[VocabCard] | None = None
    vault_path: str | None = None
    subfolder: str = "X-Vocab"
    include_flashcards: bool = True
    sr_deck_tag: str = "#flashcards/x-vocab"
    sr_card_style: Literal["multiline", "bidirectional", "inline"] = "multiline"
    sr_subdeck_by_category: bool = False
    sr_seed_progress: bool = False
    sr_include_audio: bool = False
    sr_audio_autoplay: bool = False
    tts_accent: Literal["en-US", "en-GB"] = "en-US"


class ObsidianSyncResponse(BaseModel):
    target_dir: str
    written_count: int
    files: list[str]


class ObsidianRestTestRequest(BaseModel):
    """Payload for probing connectivity to the Obsidian Local REST API plugin."""

    api_url: str | None = None
    api_key: str | None = None


class ObsidianRestTestResponse(BaseModel):
    """Structured diagnostic result from probing Obsidian Local REST API."""

    ok: bool
    url: str
    status_code: int | None = None
    authenticated: bool = False
    latency_ms: int = 0
    plugin_version: str = ""
    obsidian_version: str = ""
    message: str


class ObsidianRestSyncRequest(BaseModel):
    """Payload for syncing vocabulary cards through Obsidian Local REST API."""

    cards: list[VocabCard] | None = None
    api_url: str | None = None
    api_key: str | None = None
    subfolder: str = "X-Vocab"
    include_flashcards: bool = True
    sr_deck_tag: str = "#flashcards/x-vocab"
    sr_card_style: Literal["multiline", "bidirectional", "inline"] = "multiline"
    sr_subdeck_by_category: bool = False
    sr_seed_progress: bool = False
    sr_include_audio: bool = False
    sr_audio_autoplay: bool = False
    tts_accent: Literal["en-US", "en-GB"] = "en-US"


class ObsidianSrPullRequest(BaseModel):
    """Payload for pulling Obsidian Spaced Repetition schedules back into FSRS state."""

    mode: Literal["local_path", "rest_api"] = "local_path"
    cards: list[VocabCard] | None = None
    vault_path: str | None = None
    api_url: str | None = None
    api_key: str | None = None
    subfolder: str = "X-Vocab"
    apply_to_store: bool = True


class ObsidianSrPullResponse(BaseModel):
    """Diagnostic summary and updated cards returned after pulling SR comments."""

    scanned_notes: int
    notes_with_sr: int
    updated_count: int
    updated_words: list[str]
    updated_cards: list[VocabCard]


class ObsidianSrLaunchRequest(BaseModel):
    """Payload for triggering an Obsidian Spaced Repetition command via Local REST API."""

    api_url: str | None = None
    api_key: str | None = None
    command_id: str | None = None


class ObsidianSrLaunchResponse(BaseModel):
    """Result from executing an Obsidian Spaced Repetition plugin command."""

    ok: bool
    command_id: str
    command_name: str = ""
    message: str

