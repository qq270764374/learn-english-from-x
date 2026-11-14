from pathlib import Path
import json

from app.models import TweetItem
from app.nlp.extractor import clean_tweet_text, extract_candidates, lemmatize_word


def test_clean_tweet_text_removes_urls_mentions_and_rt():
    raw = "RT @karpathy: Check out https://example.com/demo for #Workflow subtle tips!"
    cleaned = clean_tweet_text(raw)
    assert "https://" not in cleaned
    assert "@karpathy" not in cleaned
    assert not cleaned.startswith("RT")
    assert "Workflow" in cleaned
    assert "subtle" in cleaned


def test_lemmatize_handles_inflections_and_slang():
    lemma, _ = lemmatize_word("running")
    assert lemma == "run"
    lemma2, _ = lemmatize_word("compounds")
    assert lemma2 == "compound"
    slang_lemma, pos = lemmatize_word("ngl")
    assert slang_lemma == "ngl"
    assert pos == "slang"


def test_extract_candidates_filters_basic_2000_and_catches_phrasal_verbs():
    sample_path = Path(__file__).resolve().parent.parent / "app" / "data" / "sample_tweets.json"
    tweets = [TweetItem.model_validate(item) for item in json.loads(sample_path.read_text(encoding="utf-8"))]

    candidates = extract_candidates(
        tweets=tweets,
        filter_tier="basic_2000",
        known_words=["workflow"],
        ignored_words=["simmer"],
        include_slang=True,
    )
    lemmas = {c.lemma for c in candidates}

    # Ultra-basic words must be filtered out
    for basic in ("the", "new", "small", "every", "day", "people", "life", "make"):
        assert basic not in lemmas

    # Known/ignored words skipped
    assert "workflow" not in lemmas
    assert "simmer" not in lemmas

    # High-value target words, phrasal verbs, and slang must be extracted
    assert "subtle" in lemmas
    assert "momentum" in lemmas
    assert "overwhelm" in lemmas
    assert "figure out" in lemmas
    assert "hold up" in lemmas
    assert "scale down" in lemmas
    assert "ngl" in lemmas
    assert "tbh" in lemmas
