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


class ExtractRequest(BaseModel):
    filter_tier: Literal["strict_1200", "basic_2000", "cet4_3500"] = "basic_2000"
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


class ObsidianSyncResponse(BaseModel):
    target_dir: str
    written_count: int
    files: list[str]

