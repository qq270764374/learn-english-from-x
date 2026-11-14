from __future__ import annotations

import json
import re
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

import lemminflect
import simplemma
from wordfreq import zipf_frequency

from app.models import CandidateWord, SampleContext, TweetItem

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

TIER_LIMITS = {
    "strict_1200": 1200,
    "basic_2000": 2000,
    "cet4_3500": 3500,
}

PHRASAL_VERBS: dict[str, str] = {
    "adapt to": "适应",
    "back up": "支持；备份",
    "break down": "拆解；出故障",
    "break through": "突破",
    "bring up": "提出；养育",
    "burn out": "精力耗尽",
    "carry out": "执行，落实",
    "catch up": "赶上，叙旧",
    "check out": "查看，体验",
    "come across": "偶遇；给人的印象",
    "come up": "出现；被提及",
    "count on": "指望，依赖",
    "cut back": "削减，减少",
    "deal with": "处理，应对",
    "double down": "加倍投入，坚持到底",
    "end up": "最终成为，结果是",
    "fall behind": "落后",
    "figure out": "弄明白，想出办法",
    "find out": "查明，发现",
    "focus on": "专注于",
    "follow up": "跟进",
    "get over": "克服，从……恢复",
    "give up": "放弃",
    "grow up": "成长，长大",
    "hang out": "闲逛，聚会",
    "hold back": "抑制，阻碍",
    "hold on": "坚持，稍等",
    "hold up": "撑住，经受住；延误",
    "keep up": "跟上，保持",
    "kick off": "开始，启动",
    "lay off": "裁员；停止",
    "lean into": "顺势发力，全身心投入",
    "look forward": "期待",
    "look into": "调查，研究",
    "make up": "编造；弥补；组成",
    "miss out": "错过机会",
    "move on": "继续前进，翻篇",
    "open up": "敞开心扉；开放",
    "pan out": "成功，结果证明有效",
    "pay off": "得到回报，还清",
    "pick up": "捡起；学会；接人",
    "point out": "指出",
    "pull off": "成功做到（难事）",
    "put off": "推迟；使反感",
    "rely on": "依赖，依靠",
    "roll out": "推出，铺开",
    "run into": "偶遇；遇到困难",
    "scale back": "缩减规模",
    "scale down": "按比例缩小，降维简化",
    "scale up": "扩大规模",
    "set up": "建立，设置",
    "show up": "露面，到场，坚持出现",
    "slow down": "放慢速度",
    "sort out": "整理，解决",
    "stand out": "脱颖而出",
    "step up": "站出来，提升水平",
    "stick to": "坚持（原则/计划）",
    "take off": "起飞；突然流行",
    "take over": "接管",
    "think through": "想透彻",
    "throw away": "扔掉，浪费",
    "turn down": "拒绝；调小",
    "turn out": "结果是，证明是",
    "wake up": "醒来，意识到",
    "wind up": "最终落得",
    "work out": "解决；锻炼；奏效",
    "wrap up": "收尾，总结完成",
}

PARTICLES = {
    "up",
    "out",
    "down",
    "off",
    "on",
    "in",
    "away",
    "back",
    "over",
    "through",
    "to",
    "into",
    "with",
}

URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
MENTION_RE = re.compile(r"@[A-Za-z0-9_]+")
RT_PREFIX_RE = re.compile(r"^RT\s+", re.IGNORECASE)
TOKEN_RE = re.compile(r"[A-Za-z]+(?:['’-][A-Za-z]+)*")
ELONGATION_RE = re.compile(r"(.)\1{2,}")

CONTRACTION_SKIP = {
    "i'm",
    "you're",
    "he's",
    "she's",
    "it's",
    "we're",
    "they're",
    "i've",
    "you've",
    "we've",
    "they've",
    "i'll",
    "you'll",
    "he'll",
    "she'll",
    "we'll",
    "they'll",
    "i'd",
    "you'd",
    "he'd",
    "she'd",
    "we'd",
    "they'd",
    "isn't",
    "aren't",
    "wasn't",
    "weren't",
    "don't",
    "doesn't",
    "didn't",
    "can't",
    "couldn't",
    "won't",
    "wouldn't",
    "shouldn't",
    "haven't",
    "hasn't",
    "hadn't",
    "let's",
    "that's",
    "what's",
    "there's",
    "here's",
    "who's",
}


@lru_cache(maxsize=1)
def load_basic_vocab_list() -> list[str]:
    path = DATA_DIR / "basic_vocab_ranked.txt"
    if not path.exists():
        return []
    return [line.strip().lower() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


@lru_cache(maxsize=1)
def load_slang_seed() -> dict[str, dict[str, str]]:
    path = DATA_DIR / "slang_seed.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def clean_tweet_text(text: str) -> str:
    cleaned = RT_PREFIX_RE.sub("", text)
    cleaned = URL_RE.sub(" ", cleaned)
    cleaned = MENTION_RE.sub(" ", cleaned)
    cleaned = cleaned.replace("#", " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def lemmatize_word(token: str) -> tuple[str, str]:
    """Return (lemma, guessed_pos) without requiring external downloads."""
    low = token.lower().replace("’", "'")
    low = ELONGATION_RE.sub(r"\1\1", low)

    slang_seed = load_slang_seed()
    if low in slang_seed:
        return low, "slang"

    # Strip possessive 's
    if low.endswith("'s") and len(low) > 3:
        low = low[:-2]

    all_lemmas = lemminflect.getAllLemmas(low)
    simple_lemma = simplemma.lemmatize(low, lang="en").lower()

    if "VERB" in all_lemmas and low.endswith(("ed", "ing")):
        verb_lemma = all_lemmas["VERB"][0].lower()
        return verb_lemma, "verb"
    if "VERB" in all_lemmas and simple_lemma == low and all_lemmas["VERB"][0].lower() != low:
        return all_lemmas["VERB"][0].lower(), "verb"
    if "NOUN" in all_lemmas and low.endswith("s") and not low.endswith("ss"):
        return all_lemmas["NOUN"][0].lower(), "noun"
    if "ADJ" in all_lemmas and simple_lemma == low and all_lemmas["ADJ"][0].lower() != low:
        return all_lemmas["ADJ"][0].lower(), "adj"

    guessed_pos = "noun"
    if "VERB" in all_lemmas and simple_lemma in [v.lower() for v in all_lemmas["VERB"]]:
        guessed_pos = "verb"
    elif "ADJ" in all_lemmas and simple_lemma in [a.lower() for a in all_lemmas["ADJ"]]:
        guessed_pos = "adj"
    elif "ADV" in all_lemmas and simple_lemma in [r.lower() for r in all_lemmas["ADV"]]:
        guessed_pos = "adv"

    return simple_lemma, guessed_pos


def compute_sweet_spot_score(
    corpus_count: int,
    zipf_score: float,
    is_phrase: bool,
    is_slang_seed: bool,
) -> float:
    """
    Score candidate words for learners below CET-4:
    Prioritizes words that appear multiple times in user's tweets AND fall in the
    high-ROI Zipf band (3.6 - 5.1, i.e., practical everyday / CET-4 core English).
    """
    freq_bonus = min(corpus_count, 5) * 1.6
    if is_phrase:
        band_score = 4.2
    elif is_slang_seed:
        band_score = 3.5
    elif 3.6 <= zipf_score <= 5.1:
        band_score = 4.5 - abs(zipf_score - 4.35) * 0.8
    elif 2.8 <= zipf_score < 3.6:
        band_score = 2.8
    elif 5.1 < zipf_score <= 5.6:
        band_score = 2.4
    else:
        band_score = 1.2
    return round(freq_bonus + band_score, 2)


def extract_candidates(
    tweets: list[TweetItem],
    filter_tier: str = "basic_2000",
    known_words: list[str] | None = None,
    ignored_words: list[str] | None = None,
    max_candidates: int = 80,
    include_slang: bool = True,
) -> list[CandidateWord]:
    ranked_basic = load_basic_vocab_list()
    limit = TIER_LIMITS.get(filter_tier, 2000)
    basic_set = set(ranked_basic[:limit])

    skip_set = set(w.strip().lower() for w in (known_words or []) if w.strip())
    skip_set.update(w.strip().lower() for w in (ignored_words or []) if w.strip())

    slang_seed = load_slang_seed()

    stats: dict[str, dict] = defaultdict(
        lambda: {
            "surface_forms": set(),
            "pos": "noun",
            "is_phrase": False,
            "is_slang_seed": False,
            "slang_hint": "",
            "count": 0,
            "tweet_ids": set(),
            "samples": [],
        }
    )

    for tweet in tweets:
        cleaned = clean_tweet_text(tweet.text)
        if not cleaned:
            continue

        raw_tokens = TOKEN_RE.findall(cleaned)
        # Keep token info for phrasal verb pass
        normalized_seq: list[tuple[str, str, str]] = []

        for raw in raw_tokens:
            low = raw.lower().replace("’", "'")
            if low in CONTRACTION_SKIP:
                normalized_seq.append((raw, low, "skip"))
                continue

            # Split hyphenated compounds unless it's a known dictionary word with hyphen
            subtokens = [low] if "-" not in low or zipf_frequency(low, "en") >= 3.0 else low.split("-")

            for sub in subtokens:
                if len(sub) < 2 or not sub.replace("'", "").isalpha():
                    continue
                if "'" in sub:
                    sub = sub.split("'")[0]
                    if len(sub) < 2:
                        continue

                lemma, pos = lemmatize_word(sub)
                normalized_seq.append((raw, lemma, pos))

                is_slang = lemma in slang_seed
                if is_slang and not include_slang:
                    continue
                if lemma in skip_set:
                    continue
                if not is_slang and lemma in basic_set:
                    continue

                z = zipf_frequency(lemma, "en")
                # Filter out unknown gibberish / ultra-rare proper nouns unless in slang seed
                if not is_slang and (z < 2.2 or z > 5.7):
                    continue
                # Skip likely standalone proper nouns (capitalized mid-sentence with very low zipf)
                if raw[0].isupper() and z < 3.0 and not is_slang:
                    continue

                entry = stats[lemma]
                entry["surface_forms"].add(raw)
                if entry["count"] == 0:
                    entry["pos"] = pos
                entry["is_slang_seed"] = is_slang
                if is_slang:
                    entry["slang_hint"] = slang_seed[lemma]["hint"]
                entry["count"] += 1
                if tweet.id not in entry["tweet_ids"] and len(entry["samples"]) < 3:
                    entry["tweet_ids"].add(tweet.id)
                    entry["samples"].append(
                        SampleContext(
                            tweet_id=tweet.id,
                            author_handle=tweet.author_handle,
                            url=tweet.url,
                            text=tweet.text,
                        )
                    )

        # Phrasal verb detection pass
        for idx in range(len(normalized_seq) - 1):
            raw1, lemma1, _ = normalized_seq[idx]
            raw2, lemma2, _ = normalized_seq[idx + 1]
            # Check raw2 lowercase too because particles stay particles
            part = raw2.lower()
            if part not in PARTICLES:
                continue
            phrase = f"{lemma1} {part}"
            if phrase not in PHRASAL_VERBS:
                continue
            if phrase in skip_set:
                continue

            entry = stats[phrase]
            entry["surface_forms"].add(f"{raw1} {raw2}")
            entry["pos"] = "phrasal_verb"
            entry["is_phrase"] = True
            entry["slang_hint"] = PHRASAL_VERBS[phrase]
            entry["count"] += 1
            if tweet.id not in entry["tweet_ids"] and len(entry["samples"]) < 3:
                entry["tweet_ids"].add(tweet.id)
                entry["samples"].append(
                    SampleContext(
                        tweet_id=tweet.id,
                        author_handle=tweet.author_handle,
                        url=tweet.url,
                        text=tweet.text,
                    )
                )

    candidates: list[CandidateWord] = []
    for lemma, entry in stats.items():
        z = zipf_frequency(lemma.split()[0], "en") if entry["is_phrase"] else zipf_frequency(lemma, "en")
        score = compute_sweet_spot_score(
            corpus_count=entry["count"],
            zipf_score=z,
            is_phrase=entry["is_phrase"],
            is_slang_seed=entry["is_slang_seed"],
        )
        candidates.append(
            CandidateWord(
                lemma=lemma,
                surface_forms=sorted(entry["surface_forms"]),
                pos=entry["pos"],
                is_phrase=entry["is_phrase"],
                is_slang_seed=entry["is_slang_seed"],
                slang_hint=entry["slang_hint"],
                corpus_count=entry["count"],
                zipf_score=round(z, 2),
                sweet_spot_score=score,
                sample_tweets=entry["samples"],
            )
        )

    candidates.sort(key=lambda c: (c.sweet_spot_score, c.corpus_count, c.zipf_score), reverse=True)
    return candidates[:max_candidates]
