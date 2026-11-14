from __future__ import annotations

import json
import re
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

import lemminflect
import simplemma
from wordfreq import top_n_list, zipf_frequency

from app.models import CandidateWord, SampleContext, TweetItem

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

TIER_PROFILES: dict[str, dict[str, float | int]] = {
    "strict_1200": {
        "limit": 1200,
        "zipf_min": 2.4,
        "zipf_max": 5.8,
        "sweet_low": 3.8,
        "sweet_high": 5.3,
        "sweet_center": 4.55,
        "proper_noun_floor": 3.0,
    },
    "basic_2000": {
        "limit": 2000,
        "zipf_min": 2.2,
        "zipf_max": 5.7,
        "sweet_low": 3.6,
        "sweet_high": 5.1,
        "sweet_center": 4.35,
        "proper_noun_floor": 3.0,
    },
    "cet4_3500": {
        "limit": 3500,
        "zipf_min": 2.1,
        "zipf_max": 5.5,
        "sweet_low": 3.3,
        "sweet_high": 4.8,
        "sweet_center": 4.05,
        "proper_noun_floor": 2.9,
    },
    "cet6_5500": {
        "limit": 5500,
        "zipf_min": 1.9,
        "zipf_max": 5.2,
        "sweet_low": 2.9,
        "sweet_high": 4.5,
        "sweet_center": 3.7,
        "proper_noun_floor": 2.7,
    },
    "ielts_8000": {
        "limit": 8000,
        "zipf_min": 1.7,
        "zipf_max": 4.9,
        "sweet_low": 2.5,
        "sweet_high": 4.1,
        "sweet_center": 3.3,
        "proper_noun_floor": 2.5,
    },
    "advanced_12000": {
        "limit": 12000,
        "zipf_min": 1.5,
        "zipf_max": 4.6,
        "sweet_low": 2.0,
        "sweet_high": 3.7,
        "sweet_center": 2.85,
        "proper_noun_floor": 2.3,
    },
}

TIER_LIMITS = {tier: int(profile["limit"]) for tier, profile in TIER_PROFILES.items()}


def resolve_tier_profile(
    filter_tier: str = "basic_2000",
    *,
    custom_vocab_limit: int = 5500,
    custom_zipf_min: float = 1.8,
    custom_zipf_max: float = 5.0,
) -> dict[str, float | int]:
    """Resolve vocabulary cutoff and Zipf scoring profile for named or custom tiers."""
    if filter_tier != "custom":
        return dict(TIER_PROFILES.get(filter_tier, TIER_PROFILES["basic_2000"]))

    limit = max(0, min(25000, int(custom_vocab_limit)))
    zmin = max(1.0, min(5.8, float(custom_zipf_min)))
    zmax = max(zmin + 0.3, min(6.5, float(custom_zipf_max)))
    span = zmax - zmin
    sweet_low = round(zmin + span * 0.2, 2)
    sweet_high = round(zmax - span * 0.2, 2)
    return {
        "limit": limit,
        "zipf_min": round(zmin, 2),
        "zipf_max": round(zmax, 2),
        "sweet_low": sweet_low,
        "sweet_high": sweet_high,
        "sweet_center": round((sweet_low + sweet_high) / 2, 2),
        "proper_noun_floor": round(min(3.0, zmin + 0.6), 2),
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
    "boil down": "归结为，本质上是",
    "branch out": "拓展新业务或领域",
    "brush up": "复习，重温巩固",
    "call out": "公开点名批评，指出问题",
    "cash in": "套现，趁机获利",
    "clamp down": "严厉打压，收紧管控",
    "crop up": "突然冒出，意外出现",
    "dive into": "深入钻研，一头扎进",
    "draw on": "借鉴，利用",
    "drop off": "骤降；顺路送达",
    "dwell on": "老想着，反复纠结",
    "ease off": "缓和，减弱",
    "factor in": "把……考虑在内",
    "fade out": "逐渐消失，淡出",
    "fall apart": "崩溃，瓦解",
    "fall short": "未达预期，不足",
    "fend off": "抵挡，击退",
    "flesh out": "充实细节，使具体化",
    "follow through": "贯彻到底，兑现承诺",
    "gear up": "做好准备，蓄势待发",
    "gloss over": "轻描淡写，掩盖",
    "hammer out": "反复协商后敲定",
    "hinge on": "取决于，以……为转移",
    "iron out": "消除分歧，理顺细节",
    "latch onto": "紧紧抓住，蹭热度/依附",
    "lay out": "清晰阐述，规划布置",
    "level up": "升级，提升水平",
    "lock in": "锁定；全神贯注投入",
    "map out": "详细规划，绘制蓝图",
    "narrow down": "缩小范围，逐一排除",
    "opt out": "选择退出",
    "phase out": "逐步淘汰",
    "pin down": "准确定位；迫使明确表态",
    "play down": "淡化，贬低重要性",
    "push back": "反对，回击，推迟",
    "ramp up": "加大力度，加速提升",
    "rule out": "排除……的可能性",
    "shrug off": "耸肩不在乎，轻松摆脱",
    "spell out": "说清楚，明确阐述",
    "spin off": "分拆独立；衍生",
    "spur on": "激励，促使前进",
    "stem from": "源自，由……引起",
    "stumble across": "偶然发现",
    "stumble upon": "无意中遇到或发现",
    "taper off": "逐渐减弱，逐步缩减",
    "tear down": "拆解剖析；推翻",
    "tone down": "语气放缓，降温",
    "trade off": "权衡取舍",
    "usher in": "开启，迎来（新时代/变革）",
    "ward off": "避开，挡住",
    "water down": "稀释，削弱（标准/内容）",
    "weed out": "淘汰，清除无用项",
    "zero in": "聚焦，瞄准关键",
    "zoom out": "拉远视角，从全局审视",
}

TWO_WORD_COLLOCATIONS: dict[str, str] = {
    "diminishing return": "边际收益递减",
    "silver bullet": "银弹，一招解决难题的万能方案",
    "rabbit hole": "兔子洞（越陷越深、令人着迷的探索坑）",
    "edge case": "边缘情况，极端特例",
    "first principle": "第一性原理，底层本质推演",
    "paradigm shift": "范式转移，根本性变革",
    "status quo": "现状，现有局面",
    "sanity check": "合理性检查，快速校验",
    "feedback loop": "反馈闭环",
    "rule of": "经验法则（rule of thumb 等常见搭配）",
    "north star": "北极星指标，核心指引目标",
    "slippery slope": "滑坡谬误；一旦开始就难以收手的恶性循环",
    "cognitive load": "认知负荷",
    "deep dive": "深度剖析，专题深潜",
    "pain point": "痛点",
    "game changer": "颠覆局面的关键事物",
    "straw man": "稻草人论证（歪曲对方观点后再反驳）",
    "steel man": "钢人论证（把对方观点补强到最佳状态后再讨论）",
    "zero sum": "零和博弈",
    "echo chamber": "信息茧房，回音室效应",
    "critical mass": "临界规模，质变门槛",
    "learning curve": "学习曲线，上手难度梯度",
    "silver lining": "一线希望，坏事中的积极面",
    "turning point": "转折点",
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
    "around",
    "about",
    "apart",
    "aside",
    "across",
    "forth",
    "from",
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
def load_extended_vocab_list() -> list[str]:
    """Extend the 3,500-word base list up to 25,000 deduplicated lemmas via wordfreq."""
    ranked = list(load_basic_vocab_list())
    seen = set(ranked)
    for token in top_n_list("en", 60000):
        low = token.lower()
        if len(low) < 2 or not (low.isascii() and low.isalpha()):
            continue
        lemma, _ = lemmatize_word(low)
        if len(lemma) < 2 or not (lemma.isascii() and lemma.isalpha()):
            continue
        if lemma not in seen:
            seen.add(lemma)
            ranked.append(lemma)
            if len(ranked) >= 25000:
                break
    return ranked


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
    *,
    sweet_low: float = 3.6,
    sweet_high: float = 5.1,
    sweet_center: float = 4.35,
) -> float:
    """
    Score candidate words according to the selected learner tier's Zipf sweet spot:
    Prioritizes words that recur in the user's tweets AND match the target proficiency band.
    """
    freq_bonus = min(corpus_count, 5) * 1.6
    if is_phrase:
        band_score = 4.2
    elif is_slang_seed:
        band_score = 3.5
    elif sweet_low <= zipf_score <= sweet_high:
        band_score = max(2.8, 4.5 - abs(zipf_score - sweet_center) * 0.8)
    elif (sweet_low - 0.8) <= zipf_score < sweet_low:
        band_score = 3.0
    elif sweet_high < zipf_score <= (sweet_high + 0.5):
        band_score = 2.4
    else:
        band_score = 1.4
    return round(freq_bonus + band_score, 2)


def _record_phrase_candidate(
    stats: dict[str, dict],
    *,
    phrase: str,
    surface: str,
    pos: str,
    hint: str,
    tweet: TweetItem,
) -> None:
    entry = stats[phrase]
    entry["surface_forms"].add(surface)
    entry["pos"] = pos
    entry["is_phrase"] = True
    entry["slang_hint"] = hint
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


def extract_candidates(
    tweets: list[TweetItem],
    filter_tier: str = "basic_2000",
    known_words: list[str] | None = None,
    ignored_words: list[str] | None = None,
    max_candidates: int = 80,
    include_slang: bool = True,
    custom_vocab_limit: int = 5500,
    custom_zipf_min: float = 1.8,
    custom_zipf_max: float = 5.0,
) -> list[CandidateWord]:
    profile = resolve_tier_profile(
        filter_tier,
        custom_vocab_limit=custom_vocab_limit,
        custom_zipf_min=custom_zipf_min,
        custom_zipf_max=custom_zipf_max,
    )
    limit = int(profile["limit"])
    zipf_min = float(profile["zipf_min"])
    zipf_max = float(profile["zipf_max"])
    sweet_low = float(profile["sweet_low"])
    sweet_high = float(profile["sweet_high"])
    sweet_center = float(profile["sweet_center"])
    proper_noun_floor = float(profile["proper_noun_floor"])

    ranked_basic = load_basic_vocab_list()
    if limit <= len(ranked_basic):
        basic_set = set(ranked_basic[:limit])
    else:
        basic_set = set(load_extended_vocab_list()[:limit])

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
                if not is_slang and (z < zipf_min or z > zipf_max):
                    continue
                # Skip likely standalone proper nouns (capitalized mid-sentence with very low zipf)
                if raw[0].isupper() and z < proper_noun_floor and not is_slang:
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

        # Phrasal verb & high-value 2-word collocation detection pass
        for idx in range(len(normalized_seq) - 1):
            raw1, lemma1, _ = normalized_seq[idx]
            raw2, lemma2, _ = normalized_seq[idx + 1]
            part = raw2.lower()
            if part in PARTICLES:
                phrase = f"{lemma1} {part}"
                if phrase in PHRASAL_VERBS and phrase not in skip_set:
                    _record_phrase_candidate(
                        stats,
                        phrase=phrase,
                        surface=f"{raw1} {raw2}",
                        pos="phrasal_verb",
                        hint=PHRASAL_VERBS[phrase],
                        tweet=tweet,
                    )
                    continue

            matched_colloc = next(
                (
                    candidate
                    for candidate in (
                        f"{lemma1} {lemma2}",
                        f"{lemma1} {part}",
                        f"{raw1.lower()} {lemma2}",
                        f"{raw1.lower()} {part}",
                    )
                    if candidate in TWO_WORD_COLLOCATIONS
                ),
                "",
            )
            if matched_colloc and matched_colloc not in skip_set:
                _record_phrase_candidate(
                    stats,
                    phrase=matched_colloc,
                    surface=f"{raw1} {raw2}",
                    pos="collocation",
                    hint=TWO_WORD_COLLOCATIONS[matched_colloc],
                    tweet=tweet,
                )

    candidates: list[CandidateWord] = []
    for lemma, entry in stats.items():
        z = zipf_frequency(lemma.split()[0], "en") if entry["is_phrase"] else zipf_frequency(lemma, "en")
        score = compute_sweet_spot_score(
            corpus_count=entry["count"],
            zipf_score=z,
            is_phrase=entry["is_phrase"],
            is_slang_seed=entry["is_slang_seed"],
            sweet_low=sweet_low,
            sweet_high=sweet_high,
            sweet_center=sweet_center,
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
