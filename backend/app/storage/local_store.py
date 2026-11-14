from __future__ import annotations

import json
from pathlib import Path

from app.models import SyncStateDocument, TweetItem, VocabCard, utc_now_iso


class LocalStore:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.tweets_path = self.data_dir / "tweets.json"
        self.state_path = self.data_dir / "state.json"

    def load_tweets(self) -> list[TweetItem]:
        if not self.tweets_path.exists():
            return []
        raw = json.loads(self.tweets_path.read_text(encoding="utf-8"))
        return [TweetItem.model_validate(item) for item in raw]

    def save_tweets(self, tweets: list[TweetItem]) -> None:
        self.tweets_path.write_text(
            json.dumps([t.model_dump() for t in tweets], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def ingest_tweets(self, incoming: list[TweetItem]) -> tuple[int, int]:
        existing = self.load_tweets()
        seen_ids = {t.id for t in existing}
        added = 0
        for item in incoming:
            if item.id not in seen_ids and item.text.strip():
                existing.append(item)
                seen_ids.add(item.id)
                added += 1
        if added > 0:
            self.save_tweets(existing)
        return added, len(existing)

    def load_state(self) -> SyncStateDocument:
        if not self.state_path.exists():
            return SyncStateDocument()
        raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        return SyncStateDocument.model_validate(raw)

    def save_state(self, state: SyncStateDocument) -> None:
        state.updated_at = utc_now_iso()
        self.state_path.write_text(
            json.dumps(state.model_dump(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def append_cards(self, new_cards: list[VocabCard], ignored: list[str] | None = None) -> SyncStateDocument:
        state = self.load_state()
        existing_words = {c.word.lower() for c in state.cards}
        for card in new_cards:
            if card.word.lower() not in existing_words:
                state.cards.append(card)
                existing_words.add(card.word.lower())
        if ignored:
            ignored_set = set(state.ignored_words)
            ignored_set.update(w.lower() for w in ignored)
            state.ignored_words = sorted(ignored_set)
        self.save_state(state)
        return state

    def merge_state(self, remote: SyncStateDocument) -> SyncStateDocument:
        local = self.load_state()

        card_map: dict[str, VocabCard] = {}
        for c in local.cards:
            card_map[c.word.lower()] = c
        for c in remote.cards:
            key = c.word.lower()
            if key not in card_map or c.updated_at > card_map[key].updated_at:
                card_map[key] = c

        known = sorted(set(w.lower() for w in local.known_words) | set(w.lower() for w in remote.known_words))
        ignored = sorted(set(w.lower() for w in local.ignored_words) | set(w.lower() for w in remote.ignored_words))
        processed = sorted(set(local.processed_tweet_ids) | set(remote.processed_tweet_ids))

        log_map = {(l.card_id, l.reviewed_at): l for l in local.review_logs}
        for l in remote.review_logs:
            log_map[(l.card_id, l.reviewed_at)] = l
        logs = sorted(log_map.values(), key=lambda x: x.reviewed_at)

        merged = SyncStateDocument(
            version=max(local.version, remote.version),
            updated_at=utc_now_iso(),
            cards=list(card_map.values()),
            known_words=known,
            ignored_words=ignored,
            processed_tweet_ids=processed,
            review_logs=logs,
        )
        self.save_state(merged)
        return merged
