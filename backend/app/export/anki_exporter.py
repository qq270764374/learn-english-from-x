from __future__ import annotations

import hashlib
import html
import re
import tempfile
from pathlib import Path

import genanki

from app.models import VocabCard

# Deterministic 31-bit positive model ID so Anki updates note templates cleanly
LEARN_X_MODEL_ID = 1984052017

CARD_CSS = """
.card {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif;
  font-size: 17px;
  line-height: 1.6;
  color: #181a1f;
  background-color: #faf8f5;
  padding: 24px 20px;
  max-width: 640px;
  margin: 0 auto;
  text-align: left;
}
.badge-row {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 12px;
  font-weight: 600;
}
.badge {
  padding: 2px 10px;
  border-radius: 999px;
  background: #ece7df;
  color: #494238;
}
.word {
  font-size: 34px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #14181f;
  margin-bottom: 4px;
}
.meta {
  font-size: 15px;
  color: #5b6270;
  margin-bottom: 18px;
}
.context-box {
  background: #ffffff;
  border: 1px solid #e3ddd3;
  border-radius: 10px;
  padding: 14px 16px;
  font-size: 16px;
  color: #1f242d;
}
.target-hi {
  background: #fde68a;
  color: #14181f;
  padding: 0 3px;
  border-radius: 4px;
  font-weight: 600;
}
.divider {
  border: none;
  border-top: 1px solid #e3ddd3;
  margin: 18px 0;
}
.meaning {
  font-size: 20px;
  font-weight: 700;
  color: #b44322;
  margin-bottom: 10px;
}
.translation {
  font-size: 15px;
  color: #363d49;
  margin-bottom: 10px;
}
.tip {
  background: #f1ede4;
  border-left: 3px solid #b44322;
  padding: 10px 12px;
  font-size: 14px;
  color: #433d33;
  border-radius: 4px;
}
.source {
  margin-top: 12px;
  font-size: 12px;
  color: #6b7280;
}
"""

LEARN_X_MODEL = genanki.Model(
    LEARN_X_MODEL_ID,
    "LearnEnglishFromX Card",
    fields=[
        {"name": "Word"},
        {"name": "IPA"},
        {"name": "POS"},
        {"name": "CategoryLabel"},
        {"name": "CEFR"},
        {"name": "ContextHTML"},
        {"name": "MeaningZH"},
        {"name": "TweetZH"},
        {"name": "MemoryTip"},
        {"name": "Author"},
        {"name": "TweetURL"},
    ],
    templates=[
        {
            "name": "X Context Card",
            "qfmt": """
<div class="badge-row">
  <span class="badge">{{CategoryLabel}}</span>
  <span class="badge">{{CEFR}}</span>
</div>
<div class="word">{{Word}}</div>
<div class="meta">{{POS}} &nbsp; {{IPA}}</div>
<div class="context-box">{{ContextHTML}}</div>
""",
            "afmt": """
{{FrontSide}}
<hr class="divider" />
<div class="meaning">{{MeaningZH}}</div>
<div class="translation">{{TweetZH}}</div>
{{#MemoryTip}}<div class="tip">💡 {{MemoryTip}}</div>{{/MemoryTip}}
<div class="source">来自 @{{Author}} &nbsp; {{#TweetURL}}<a href="{{TweetURL}}">查看原推文</a>{{/TweetURL}}</div>
""",
        }
    ],
    css=CARD_CSS,
)


def _deterministic_deck_id(deck_name: str) -> int:
    digest = hashlib.sha256(deck_name.encode("utf-8")).hexdigest()[:8]
    return int(digest, 16) % (2**31 - 1) or 1984052018


def _highlight_target_in_tweet(tweet: str, word: str) -> str:
    escaped_tweet = html.escape(tweet)
    escaped_word = re.escape(html.escape(word))
    if not escaped_word:
        return escaped_tweet
    pattern = re.compile(rf"\b({escaped_word}\w*)\b", re.IGNORECASE)
    return pattern.sub(r'<span class="target-hi">\1</span>', escaped_tweet)


CATEGORY_ZH = {
    "standard": "通用高频",
    "collocation": "地道短语",
    "slang": "网络俚语",
}


def build_apkg_bytes(cards: list[VocabCard], deck_name: str = "LearnEnglishFromX") -> bytes:
    deck_id = _deterministic_deck_id(deck_name)
    deck = genanki.Deck(deck_id, deck_name)

    for card in cards:
        cat_label = CATEGORY_ZH.get(card.category, "通用高频")
        context_html = _highlight_target_in_tweet(card.sample_tweet, card.word)
        note = genanki.Note(
            model=LEARN_X_MODEL,
            fields=[
                html.escape(card.word),
                html.escape(card.ipa),
                html.escape(card.pos),
                html.escape(cat_label),
                html.escape(card.cefr_level),
                context_html,
                html.escape(card.meaning_zh),
                html.escape(card.sample_tweet_zh),
                html.escape(card.memory_tip_zh),
                html.escape(card.author_handle or "X"),
                html.escape(card.tweet_url),
            ],
            tags=[f"x_{card.category}", f"cefr_{card.cefr_level.lower()}"],
            guid=genanki.guid_for(card.word.lower(), card.sample_tweet[:48]),
        )
        deck.add_note(note)

    package = genanki.Package(deck)
    with tempfile.NamedTemporaryFile(suffix=".apkg", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        package.write_to_file(str(tmp_path))
        return tmp_path.read_bytes()
    finally:
        tmp_path.unlink(missing_ok=True)
