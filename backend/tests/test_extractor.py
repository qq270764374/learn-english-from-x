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


def test_extract_candidates_supports_advanced_tiers_custom_bounds_and_collocations():
    tweets = [
        TweetItem(
            id="adv-1",
            author_handle="researcher",
            url="https://x.com/researcher/status/1",
            text=(
                "We are facing diminishing returns here: what used to look like a paradigm shift "
                "soon boiled down to ephemeral hype and idiosyncratic edge cases, though agentic "
                "workflows keep ushering in subtle gains along the learning curve. Copium won't fix "
                "this ubiquitous bottleneck or recalcitrant momentum."
            ),
        )
    ]

    # Advanced 12000 tier filters top 12000 lemmas while keeping rare C1/C2 words & collocations
    advanced = extract_candidates(
        tweets=tweets,
        filter_tier="advanced_12000",
        include_slang=True,
    )
    adv_lemmas = {c.lemma for c in advanced}
    assert "ephemeral" in adv_lemmas
    assert "idiosyncratic" in adv_lemmas
    assert "recalcitrant" in adv_lemmas
    assert "diminishing return" in adv_lemmas
    assert "learning curve" in adv_lemmas
    assert "paradigm shift" in adv_lemmas
    assert "edge case" in adv_lemmas
    assert "boil down" in adv_lemmas
    assert "usher in" in adv_lemmas
    assert "copium" in adv_lemmas
    assert "agentic" in adv_lemmas
    # Words inside top 12000 must be filtered out at advanced_12000
    assert "ubiquitous" not in adv_lemmas
    assert "momentum" not in adv_lemmas
    assert "gain" not in adv_lemmas
    assert "face" not in adv_lemmas

    # IELTS 8000 tier filters top 8000 words while retaining ubiquitous (~rank 11500) & ephemeral
    ielts = extract_candidates(
        tweets=tweets,
        filter_tier="ielts_8000",
        include_slang=False,
    )
    ielts_lemmas = {c.lemma for c in ielts}
    assert "ubiquitous" in ielts_lemmas
    assert "ephemeral" in ielts_lemmas
    assert "momentum" not in ielts_lemmas
    assert "copium" not in ielts_lemmas

    # Custom tier lets user dial filtering and Zipf window manually
    custom = extract_candidates(
        tweets=tweets,
        filter_tier="custom",
        custom_vocab_limit=15000,
        custom_zipf_min=1.5,
        custom_zipf_max=3.8,
        include_slang=True,
    )
    custom_lemmas = {c.lemma for c in custom}
    assert "ephemeral" in custom_lemmas
    assert "bottleneck" in custom_lemmas or "paradigm shift" in custom_lemmas
