from __future__ import annotations

import io
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from app.models import VocabCard

STAGE_LABELS = {
    0: "新词",
    1: "学习中",
    2: "复习巩固",
    3: "重新记忆",
}

CATEGORY_LABELS = {
    "standard": "高频核心词",
    "collocation": "地道搭配",
    "slang": "X 网感俚语",
}

USER_NOTES_MARKER = "<!-- lex-user-notes -->"
SR_COMMENT_RE = re.compile(r"^<!--SR:.*?-->$", re.MULTILINE)


def _yaml_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").strip()
    return f'"{escaped}"'


def sanitize_note_filename(word: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]+', "-", word.strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return cleaned or "vocab-card"


def highlight_markdown_tweet(tweet: str, word: str) -> str:
    if not tweet or not word.strip():
        return tweet
    clean_word = word.strip()
    if " " in clean_word:
        parts = [re.escape(p) for p in clean_word.split()]
        parts[0] = f"{parts[0]}(?:s|es|ed|d|ing)?"
        pattern_src = r"\b(" + r"\s+(?:[a-zA-Z]+\s+)?".join(parts) + r")\b"
    else:
        stem = clean_word[:-1] if clean_word.endswith("e") and len(clean_word) > 3 else clean_word
        pattern_src = rf"\b({re.escape(clean_word)}|{re.escape(stem)}(?:e|es|s|ed|ing|er|ers|ly)?)\b"
    try:
        pattern = re.compile(pattern_src, re.IGNORECASE)
        return pattern.sub(r"==\1==", tweet)
    except re.error:
        return tweet


def _date_part(iso: str | None) -> str:
    if not iso:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return iso[:10] if len(iso) >= 10 else iso


def render_card_markdown(
    card: VocabCard,
    include_flashcards: bool = True,
    preserved_sr_comment: str = "",
    preserved_user_notes: str = "",
) -> str:
    author_clean = card.author_handle.lstrip("@").strip()
    author_link = f"[[@{author_clean}]]" if author_clean else "[[X 推文]]"
    stage_label = STAGE_LABELS.get(card.fsrs.state if card.fsrs else 0, "新词")
    due_date = _date_part(card.fsrs.due if card.fsrs else None)
    created_date = _date_part(card.created_at)
    cefr_tag = re.sub(r"[^a-zA-Z0-9_-]", "", card.cefr_level or "B1") or "B1"
    highlighted_tweet = highlight_markdown_tweet(card.sample_tweet, card.word)
    cat_label = CATEGORY_LABELS.get(card.category, "高频核心词")

    lines: list[str] = [
        "---",
        f"word: {_yaml_quote(card.word)}",
        f"ipa: {_yaml_quote(card.ipa)}",
        f"pos: {_yaml_quote(card.pos)}",
        f"category: {_yaml_quote(card.category)}",
        f"cefr: {_yaml_quote(card.cefr_level)}",
        f"author: {_yaml_quote(author_link)}",
        f"source_url: {_yaml_quote(card.tweet_url)}",
        f"fsrs_state: {_yaml_quote(stage_label)}",
        f"reps: {card.fsrs.reps if card.fsrs else 0}",
        f"next_review: {_yaml_quote(due_date)}",
        f"created: {_yaml_quote(created_date)}",
        "tags:",
        "  - x-vocab",
        f"  - x-vocab/{card.category}",
        f"  - cefr/{cefr_tag}",
        "---",
        "",
        f"# {card.word}",
        "",
    ]

    meta_bits = [b for b in [card.ipa, card.pos, cat_label, card.cefr_level] if b]
    if meta_bits:
        lines.append(" · ".join(f"`{bit}`" for bit in meta_bits))
        lines.append("")

    lines.extend(
        [
            "## 语境释义",
            f"**{card.meaning_zh}**",
            "",
        ]
    )

    if card.memory_tip_zh:
        lines.extend(
            [
                "> [!tip] 记忆技巧",
                f"> {card.memory_tip_zh}",
                "",
            ]
        )

    lines.append("## 原推文语境")
    if highlighted_tweet:
        lines.append(f"> {highlighted_tweet}")
    if card.sample_tweet_zh:
        lines.append(f"> \n> {card.sample_tweet_zh}")
    source_line = f"- 来源：{author_link}"
    if card.tweet_url:
        source_line += f" · [查看原推]({card.tweet_url})"
    lines.extend([source_line, ""])

    if include_flashcards:
        lines.extend(
            [
                "## 闪卡复习 #flashcards/x-vocab",
                "",
                f"**{card.word}** {card.ipa} {card.pos}".strip(),
            ]
        )
        if highlighted_tweet:
            lines.append(f"> {highlighted_tweet}")
        lines.extend(
            [
                "?",
                f"**{card.meaning_zh}**",
            ]
        )
        if card.memory_tip_zh:
            lines.append(f"- 记忆：{card.memory_tip_zh}")
        if card.sample_tweet_zh:
            lines.append(f"- 译文：{card.sample_tweet_zh}")
        if preserved_sr_comment:
            lines.append(preserved_sr_comment)
        lines.append("")

    lines.extend([USER_NOTES_MARKER, ""])
    if preserved_user_notes.strip():
        lines.append(preserved_user_notes.rstrip())
    else:
        lines.extend(["## 我的个人笔记", "", "- 在这里补充联想、同义词或自己造的句子…"])
    lines.append("")

    return "\n".join(lines)


def render_index_markdown(cards: list[VocabCard], include_flashcards: bool = True) -> str:
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines: list[str] = [
        "---",
        'title: "LearnEnglishFromX 词库总览"',
        f"total_cards: {len(cards)}",
        f"updated: {_yaml_quote(now_str)}",
        "tags:",
        "  - x-vocab",
        "  - moc",
        "---",
        "",
        "# LearnEnglishFromX 词库总览",
        "",
        f"共收录 **{len(cards)}** 个 X 推文实用词汇与表达（最近同步：{now_str}）。",
        "",
    ]

    if include_flashcards:
        lines.extend(
            [
                "> [!info] 已开启 Spaced Repetition 闪卡兼容",
                "> 若您在 Obsidian 安装了 **Spaced Repetition** 插件，直接在插件侧边栏打开 `#flashcards/x-vocab` 即可刷卡片，系统会自动保留您的复习注释和个人笔记。",
                "",
            ]
        )

    grouped: dict[str, list[VocabCard]] = {"standard": [], "collocation": [], "slang": []}
    for card in cards:
        grouped.setdefault(card.category, []).append(card)

    for cat_key in ("standard", "collocation", "slang"):
        items = grouped.get(cat_key, [])
        if not items:
            continue
        lines.append(f"## {CATEGORY_LABELS.get(cat_key, cat_key)}（{len(items)}）")
        lines.append("")
        for card in items:
            note_name = sanitize_note_filename(card.word)
            author_tag = f"（[[@{card.author_handle.lstrip('@')}]]）" if card.author_handle else ""
            lines.append(f"- [[{note_name}]] — {card.meaning_zh} {author_tag}".rstrip())
        lines.append("")

    lines.extend(
        [
            "## Dataview 动态看板（可选插件）",
            "",
            "```dataview",
            'TABLE ipa as "音标", pos as "词性", cefr as "难度", author as "博主", next_review as "下次复习"',
            "FROM #x-vocab",
            "WHERE word",
            "SORT next_review ASC",
            "```",
            "",
        ]
    )
    return "\n".join(lines)


def build_obsidian_zip_bytes(
    cards: list[VocabCard],
    subfolder: str = "X-Vocab",
    include_flashcards: bool = True,
) -> bytes:
    clean_folder = sanitize_note_filename(subfolder).replace(" ", "-") or "X-Vocab"
    buf = io.BytesIO()
    seen_names: set[str] = set()

    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        index_md = render_index_markdown(cards, include_flashcards=include_flashcards)
        zf.writestr(f"{clean_folder}/_X-Vocab 词库总览.md", index_md.encode("utf-8"))

        for card in cards:
            base = sanitize_note_filename(card.word)
            name = base
            counter = 2
            while name.lower() in seen_names:
                name = f"{base}-{counter}"
                counter += 1
            seen_names.add(name.lower())

            md = render_card_markdown(card, include_flashcards=include_flashcards)
            zf.writestr(f"{clean_folder}/{name}.md", md.encode("utf-8"))

    return buf.getvalue()


def write_obsidian_vault(
    cards: list[VocabCard],
    vault_path: str,
    subfolder: str = "X-Vocab",
    include_flashcards: bool = True,
) -> tuple[Path, list[str]]:
    raw_vault = vault_path.strip()
    if not raw_vault:
        raise ValueError("请先填写您本机的 Obsidian Vault 文件夹路径。")

    vault_dir = Path(raw_vault).expanduser().resolve()
    if not vault_dir.exists() or not vault_dir.is_dir():
        raise ValueError(f"找不到目录：{vault_dir}。请确认填写的是您本机已存在的 Obsidian 仓库文件夹。")

    clean_sub = sanitize_note_filename(subfolder).replace(" ", "-") or "X-Vocab"
    target_dir = vault_dir if vault_dir.name.lower() == clean_sub.lower() else vault_dir / clean_sub
    target_dir.mkdir(parents=True, exist_ok=True)

    written_files: list[str] = []
    seen_names: set[str] = set()

    index_path = target_dir / "_X-Vocab 词库总览.md"
    index_path.write_text(
        render_index_markdown(cards, include_flashcards=include_flashcards),
        encoding="utf-8",
    )
    written_files.append(index_path.name)

    for card in cards:
        base = sanitize_note_filename(card.word)
        name = base
        counter = 2
        while name.lower() in seen_names:
            name = f"{base}-{counter}"
            counter += 1
        seen_names.add(name.lower())

        note_path = target_dir / f"{name}.md"
        preserved_sr = ""
        preserved_notes = ""

        if note_path.exists():
            old_text = note_path.read_text(encoding="utf-8")
            sr_match = SR_COMMENT_RE.search(old_text)
            if sr_match:
                preserved_sr = sr_match.group(0)
            if USER_NOTES_MARKER in old_text:
                preserved_notes = old_text.split(USER_NOTES_MARKER, 1)[1].lstrip("\r\n")

        new_text = render_card_markdown(
            card,
            include_flashcards=include_flashcards,
            preserved_sr_comment=preserved_sr,
            preserved_user_notes=preserved_notes,
        )
        note_path.write_text(new_text, encoding="utf-8")
        written_files.append(note_path.name)

    return target_dir, written_files
