from __future__ import annotations

import asyncio
import io
import re
import time
import zipfile
from contextlib import nullcontext
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import quote

import httpx

from app.models import ObsidianRestTestResponse, ObsidianSrLaunchResponse, VocabCard

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

SR_SUBDECK_LABELS = {
    "standard": "高频核心词",
    "collocation": "地道搭配",
    "slang": "X网感俚语",
}

ObsidianSrCardStyle = Literal["multiline", "bidirectional", "inline"]
TtsAccent = Literal["en-US", "en-GB"]

USER_NOTES_MARKER = "<!-- lex-user-notes -->"
SR_COMMENT_RE = re.compile(r"^<!--SR:.*?-->$", re.MULTILINE)
SR_ENTRY_RE = re.compile(r"!(\d{4}-\d{2}-\d{2}),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)")
YAML_SR_DUE_RE = re.compile(r"^sr-due:\s*(\d{4}-\d{2}-\d{2})\s*$", re.MULTILINE)
YAML_SR_INTERVAL_RE = re.compile(r"^sr-interval:\s*(\d+)\s*$", re.MULTILINE)
YAML_SR_EASE_RE = re.compile(r"^sr-ease:\s*(\d+)\s*$", re.MULTILINE)
YAML_WORD_RE = re.compile(r'^word:\s*"(.+)"\s*$', re.MULTILINE)
H1_WORD_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)


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


def _single_line(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def _format_blockquote(text: str | None) -> list[str]:
    cleaned = (text or "").strip()
    if not cleaned:
        return []
    return [f"> {line}".rstrip() if line.strip() else ">" for line in cleaned.splitlines()]


def normalize_sr_deck_tag(tag: str | None) -> str:
    """Normalize an Obsidian Spaced Repetition deck tag so it starts with `#` and has no spaces."""
    raw = re.sub(r"\s+", "-", (tag or "").strip())
    raw = raw.lstrip("#").strip("/")
    return f"#{raw}" if raw else "#flashcards/x-vocab"


def resolve_card_sr_tag(
    card: VocabCard,
    *,
    sr_deck_tag: str = "#flashcards/x-vocab",
    sr_subdeck_by_category: bool = False,
) -> str:
    """Resolve the Spaced Repetition tag for a card, optionally segmented by category."""
    base = normalize_sr_deck_tag(sr_deck_tag)
    if not sr_subdeck_by_category:
        return base
    sub = SR_SUBDECK_LABELS.get(card.category, card.category)
    return base if base.endswith(f"/{sub}") else f"{base}/{sub}"


def format_fsrs_as_sr_comment(
    card: VocabCard,
    *,
    sr_card_style: ObsidianSrCardStyle = "multiline",
) -> str:
    """Encode web FSRS review state into an initial Obsidian Spaced Repetition comment."""
    if not card.fsrs or card.fsrs.reps <= 0:
        return ""
    due_date = _date_part(card.fsrs.due)
    interval = max(1, int(round(card.fsrs.scheduled_days or card.fsrs.stability or 1)))
    difficulty = float(card.fsrs.difficulty or 5.0)
    ease = max(130, min(300, int(round(310 - difficulty * 15))))
    entry = f"!{due_date},{interval},{ease}"
    if sr_card_style == "bidirectional":
        return f"<!--SR:{entry}{entry}-->"
    return f"<!--SR:{entry}-->"


def build_obsidian_audio_url(word: str, tts_accent: TtsAccent = "en-US") -> str:
    """Build an external dictionary pronunciation URL (zero local vault storage)."""
    clean_word = word.strip()
    if not clean_word:
        return ""
    voice_type = "1" if tts_accent == "en-GB" else "2"
    return f"https://dict.youdao.com/dictvoice?audio={quote(clean_word, safe='')}&type={voice_type}"


def _render_audio_tag(
    word: str,
    *,
    tts_accent: TtsAccent = "en-US",
    autoplay: bool = False,
) -> str:
    url = build_obsidian_audio_url(word, tts_accent=tts_accent)
    if not url:
        return ""
    attrs = "controls autoplay" if autoplay else 'controls preload="none"'
    return f'<audio {attrs} src="{url}"></audio>'


def _render_flashcard_block(
    card: VocabCard,
    *,
    highlighted_tweet: str,
    resolved_tag: str,
    sr_card_style: ObsidianSrCardStyle,
    effective_sr: str,
    sr_include_audio: bool = False,
    sr_audio_autoplay: bool = False,
    tts_accent: TtsAccent = "en-US",
) -> list[str]:
    effective_autoplay = sr_audio_autoplay and sr_card_style != "bidirectional"
    flashcard_audio_tag = (
        _render_audio_tag(card.word, tts_accent=tts_accent, autoplay=effective_autoplay)
        if sr_include_audio
        else ""
    )

    if sr_card_style == "inline":
        front = " ".join(
            part for part in [f"**{card.word}**", card.ipa, card.pos, flashcard_audio_tag] if part
        )
        back_parts = [f"**{_single_line(card.meaning_zh)}**"]
        if card.memory_tip_zh:
            back_parts.append(f"记忆：{_single_line(card.memory_tip_zh)}")
        if card.sample_tweet_zh:
            back_parts.append(f"译文：{_single_line(card.sample_tweet_zh)}")
        block = [
            f"## 闪卡复习 {resolved_tag}",
            "",
            f"{front} :: {' · '.join(back_parts)}",
        ]
        if effective_sr:
            block.append(effective_sr)
        block.append("")
        return block

    separator = "??" if sr_card_style == "bidirectional" else "?"
    block = [
        f"## 闪卡复习 {resolved_tag}",
        "",
        f"**{card.word}** {card.ipa} {card.pos}".strip(),
    ]
    if flashcard_audio_tag:
        block.append(flashcard_audio_tag)
    block.extend(_format_blockquote(highlighted_tweet))
    block.extend([separator, f"**{_single_line(card.meaning_zh)}**"])
    if card.memory_tip_zh:
        block.append(f"- 记忆：{_single_line(card.memory_tip_zh)}")
    if card.sample_tweet_zh:
        block.append(f"- 译文：{_single_line(card.sample_tweet_zh)}")
    if effective_sr:
        block.append(effective_sr)
    block.append("")
    return block


def render_card_markdown(
    card: VocabCard,
    include_flashcards: bool = True,
    preserved_sr_comment: str = "",
    preserved_user_notes: str = "",
    *,
    sr_deck_tag: str = "#flashcards/x-vocab",
    sr_card_style: ObsidianSrCardStyle = "multiline",
    sr_subdeck_by_category: bool = False,
    seed_sr_from_fsrs: bool = False,
    sr_include_audio: bool = False,
    sr_audio_autoplay: bool = False,
    tts_accent: TtsAccent = "en-US",
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

    if sr_include_audio:
        note_audio_tag = _render_audio_tag(card.word, tts_accent=tts_accent, autoplay=False)
        if note_audio_tag:
            lines.extend([note_audio_tag, ""])

    lines.extend(
        [
            "## 语境释义",
            f"**{card.meaning_zh}**",
            "",
        ]
    )

    if card.memory_tip_zh:
        lines.append("> [!tip] 记忆技巧")
        lines.extend(_format_blockquote(card.memory_tip_zh))
        lines.append("")

    lines.append("## 原推文语境")
    lines.extend(_format_blockquote(highlighted_tweet))
    if card.sample_tweet_zh:
        lines.append(">")
        lines.extend(_format_blockquote(card.sample_tweet_zh))
    source_line = f"- 来源：{author_link}"
    if card.tweet_url:
        source_line += f" · [查看原推]({card.tweet_url})"
    lines.extend([source_line, ""])

    if include_flashcards:
        resolved_tag = resolve_card_sr_tag(
            card,
            sr_deck_tag=sr_deck_tag,
            sr_subdeck_by_category=sr_subdeck_by_category,
        )
        effective_sr = preserved_sr_comment or (
            format_fsrs_as_sr_comment(card, sr_card_style=sr_card_style) if seed_sr_from_fsrs else ""
        )
        lines.extend(
            _render_flashcard_block(
                card,
                highlighted_tweet=highlighted_tweet,
                resolved_tag=resolved_tag,
                sr_card_style=sr_card_style,
                effective_sr=effective_sr,
                sr_include_audio=sr_include_audio,
                sr_audio_autoplay=sr_audio_autoplay,
                tts_accent=tts_accent,
            )
        )

    lines.extend([USER_NOTES_MARKER, ""])
    if preserved_user_notes.strip():
        lines.append(preserved_user_notes.rstrip())
    else:
        lines.extend(["## 我的个人笔记", "", "- 在这里补充联想、同义词或自己造的句子…"])
    lines.append("")

    return "\n".join(lines)


def render_index_markdown(
    cards: list[VocabCard],
    include_flashcards: bool = True,
    *,
    sr_deck_tag: str = "#flashcards/x-vocab",
    sr_card_style: ObsidianSrCardStyle = "multiline",
) -> str:
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    clean_tag = normalize_sr_deck_tag(sr_deck_tag)
    style_hint = {"multiline": "`?` 单向问答卡", "bidirectional": "`??` 双向互测卡", "inline": "`::` 单行速刷卡"}.get(
        sr_card_style,
        "`?` 多行卡片",
    )
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
                f"> 若您在 Obsidian 安装了 **Spaced Repetition** 插件，直接在插件侧边栏打开 `{clean_tag}`（当前模式：{style_hint}）即可刷卡片，系统会自动保留您的复习注释和个人笔记。",
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


def assign_card_filenames(cards: list[VocabCard]) -> list[tuple[VocabCard, str]]:
    """Assign unique sanitized `<word>.md` filenames for a list of cards."""
    seen_names: set[str] = set()
    assigned: list[tuple[VocabCard, str]] = []
    for card in cards:
        base = sanitize_note_filename(card.word)
        name = base
        counter = 2
        while name.lower() in seen_names:
            name = f"{base}-{counter}"
            counter += 1
        seen_names.add(name.lower())
        assigned.append((card, f"{name}.md"))
    return assigned


def extract_preserved_note_parts(existing_markdown: str) -> tuple[str, str]:
    """Extract existing Spaced Repetition comments and user notes block from markdown."""
    preserved_sr = ""
    preserved_notes = ""
    sr_match = SR_COMMENT_RE.search(existing_markdown)
    if sr_match:
        preserved_sr = sr_match.group(0)
    if USER_NOTES_MARKER in existing_markdown:
        preserved_notes = existing_markdown.split(USER_NOTES_MARKER, 1)[1].lstrip("\r\n")
    return preserved_sr, preserved_notes


def sanitize_rest_subfolder(subfolder: str) -> str:
    """Normalize a vault-relative subfolder path (supports nested `/` folders)."""
    parts = [
        sanitize_note_filename(seg).replace(" ", "-")
        for seg in re.split(r"[/\\]+", (subfolder or "").strip())
        if seg.strip()
    ]
    clean_parts = [p for p in parts if p and p not in {".", ".."}]
    return "/".join(clean_parts) or "X-Vocab"


def normalize_obsidian_rest_url(api_url: str) -> str:
    """Validate and normalize an Obsidian Local REST API base URL."""
    clean = (api_url or "").strip().rstrip("/")
    if not clean:
        raise ValueError(
            "请先填写 Obsidian Local REST API 地址（例如 https://127.0.0.1:27124 或 http://127.0.0.1:27123）。"
        )
    if not (clean.startswith("http://") or clean.startswith("https://")):
        raise ValueError("Obsidian REST API 地址需以 http:// 或 https:// 开头。")
    return clean


def _encode_vault_path(rel_path: str) -> str:
    return "/".join(quote(segment, safe="") for segment in rel_path.split("/") if segment)


def _obsidian_auth_headers(api_key: str) -> dict[str, str]:
    clean_key = (api_key or "").strip()
    if not clean_key:
        return {}
    return {"Authorization": f"Bearer {clean_key}"}


def _resolve_target_vault_dir(vault_path: str, subfolder: str = "X-Vocab") -> Path:
    raw_vault = vault_path.strip()
    if not raw_vault:
        raise ValueError("请先填写您本机的 Obsidian Vault 文件夹路径。")

    vault_dir = Path(raw_vault).expanduser().resolve()
    if not vault_dir.exists() or not vault_dir.is_dir():
        raise ValueError(f"找不到目录：{vault_dir}。请确认填写的是您本机已存在的 Obsidian 仓库文件夹。")

    clean_sub = sanitize_note_filename(subfolder).replace(" ", "-") or "X-Vocab"
    return vault_dir if vault_dir.name.lower() == clean_sub.lower() else vault_dir / clean_sub


def build_obsidian_zip_bytes(
    cards: list[VocabCard],
    subfolder: str = "X-Vocab",
    include_flashcards: bool = True,
    *,
    sr_deck_tag: str = "#flashcards/x-vocab",
    sr_card_style: ObsidianSrCardStyle = "multiline",
    sr_subdeck_by_category: bool = False,
    seed_sr_from_fsrs: bool = False,
    sr_include_audio: bool = False,
    sr_audio_autoplay: bool = False,
    tts_accent: TtsAccent = "en-US",
) -> bytes:
    clean_folder = sanitize_note_filename(subfolder).replace(" ", "-") or "X-Vocab"
    buf = io.BytesIO()

    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        index_md = render_index_markdown(
            cards,
            include_flashcards=include_flashcards,
            sr_deck_tag=sr_deck_tag,
            sr_card_style=sr_card_style,
        )
        zf.writestr(f"{clean_folder}/_X-Vocab 词库总览.md", index_md.encode("utf-8"))

        for card, filename in assign_card_filenames(cards):
            md = render_card_markdown(
                card,
                include_flashcards=include_flashcards,
                sr_deck_tag=sr_deck_tag,
                sr_card_style=sr_card_style,
                sr_subdeck_by_category=sr_subdeck_by_category,
                seed_sr_from_fsrs=seed_sr_from_fsrs,
                sr_include_audio=sr_include_audio,
                sr_audio_autoplay=sr_audio_autoplay,
                tts_accent=tts_accent,
            )
            zf.writestr(f"{clean_folder}/{filename}", md.encode("utf-8"))

    return buf.getvalue()


def write_obsidian_vault(
    cards: list[VocabCard],
    vault_path: str,
    subfolder: str = "X-Vocab",
    include_flashcards: bool = True,
    *,
    sr_deck_tag: str = "#flashcards/x-vocab",
    sr_card_style: ObsidianSrCardStyle = "multiline",
    sr_subdeck_by_category: bool = False,
    seed_sr_from_fsrs: bool = False,
    sr_include_audio: bool = False,
    sr_audio_autoplay: bool = False,
    tts_accent: TtsAccent = "en-US",
) -> tuple[Path, list[str]]:
    target_dir = _resolve_target_vault_dir(vault_path, subfolder)
    target_dir.mkdir(parents=True, exist_ok=True)

    written_files: list[str] = []

    index_path = target_dir / "_X-Vocab 词库总览.md"
    index_path.write_text(
        render_index_markdown(
            cards,
            include_flashcards=include_flashcards,
            sr_deck_tag=sr_deck_tag,
            sr_card_style=sr_card_style,
        ),
        encoding="utf-8",
    )
    written_files.append(index_path.name)

    for card, filename in assign_card_filenames(cards):
        note_path = target_dir / filename
        preserved_sr = ""
        preserved_notes = ""

        if note_path.exists():
            old_text = note_path.read_text(encoding="utf-8")
            preserved_sr, preserved_notes = extract_preserved_note_parts(old_text)

        new_text = render_card_markdown(
            card,
            include_flashcards=include_flashcards,
            preserved_sr_comment=preserved_sr,
            preserved_user_notes=preserved_notes,
            sr_deck_tag=sr_deck_tag,
            sr_card_style=sr_card_style,
            sr_subdeck_by_category=sr_subdeck_by_category,
            seed_sr_from_fsrs=seed_sr_from_fsrs,
            sr_include_audio=sr_include_audio,
            sr_audio_autoplay=sr_audio_autoplay,
            tts_accent=tts_accent,
        )
        note_path.write_text(new_text, encoding="utf-8")
        written_files.append(note_path.name)

    return target_dir, written_files


async def test_obsidian_rest_connection(
    api_url: str,
    api_key: str = "",
    *,
    client: httpx.AsyncClient | None = None,
) -> ObsidianRestTestResponse:
    """Probe Obsidian Local REST API reachability and Bearer API key authentication."""
    try:
        clean_url = normalize_obsidian_rest_url(api_url)
    except ValueError as exc:
        return ObsidianRestTestResponse(
            ok=False,
            url=(api_url or "").strip(),
            message=str(exc),
        )

    headers = {"Accept": "application/json", **_obsidian_auth_headers(api_key)}
    started = time.perf_counter()

    cm = (
        nullcontext(client)
        if client is not None
        else httpx.AsyncClient(verify=False, trust_env=False, timeout=8.0)
    )
    try:
        async with cm as http:
            resp = await http.get(f"{clean_url}/", headers=headers)
    except httpx.TimeoutException:
        latency_ms = int((time.perf_counter() - started) * 1000)
        return ObsidianRestTestResponse(
            ok=False,
            url=clean_url,
            latency_ms=latency_ms,
            message=f"连接 Obsidian Local REST API 超时（{clean_url}），请检查 Obsidian 是否开启以及端口号是否正确。",
        )
    except httpx.HTTPError as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        return ObsidianRestTestResponse(
            ok=False,
            url=clean_url,
            latency_ms=latency_ms,
            message=(
                f"无法连接到 {clean_url}（{exc}）。请确认 Obsidian 桌面端已运行、已启用 Local REST API 插件，"
                "且若从 WSL/浏览器访问，建议确认端口 27124（HTTPS）或 27123（HTTP）已监听。"
            ),
        )

    latency_ms = int((time.perf_counter() - started) * 1000)
    plugin_version = ""
    obsidian_version = ""
    authenticated = False
    try:
        payload = resp.json()
        if isinstance(payload, dict):
            authenticated = bool(payload.get("authenticated", False))
            versions = payload.get("versions")
            if isinstance(versions, dict):
                plugin_version = str(versions.get("self") or "")
                obsidian_version = str(versions.get("obsidian") or "")
    except ValueError:
        payload = None

    if resp.status_code in (401, 403) or (resp.status_code == 200 and not authenticated):
        return ObsidianRestTestResponse(
            ok=False,
            url=clean_url,
            status_code=resp.status_code,
            authenticated=False,
            latency_ms=latency_ms,
            plugin_version=plugin_version,
            obsidian_version=obsidian_version,
            message="已连接到 Obsidian Local REST API 服务，但 Bearer API Key 未通过认证，请检查并粘贴插件设置中的 API Key。",
        )

    if resp.status_code != 200:
        return ObsidianRestTestResponse(
            ok=False,
            url=clean_url,
            status_code=resp.status_code,
            authenticated=authenticated,
            latency_ms=latency_ms,
            plugin_version=plugin_version,
            obsidian_version=obsidian_version,
            message=f"Obsidian Local REST API 返回异常状态码 HTTP {resp.status_code}。",
        )

    ver_note = f"（插件 v{plugin_version}）" if plugin_version else ""
    return ObsidianRestTestResponse(
        ok=True,
        url=clean_url,
        status_code=resp.status_code,
        authenticated=True,
        latency_ms=latency_ms,
        plugin_version=plugin_version,
        obsidian_version=obsidian_version,
        message=f"连通成功{ver_note}，Obsidian Local REST API 认证通过，可直接同步词卡。",
    )


async def sync_obsidian_rest_api(
    cards: list[VocabCard],
    api_url: str,
    api_key: str,
    subfolder: str = "X-Vocab",
    include_flashcards: bool = True,
    *,
    sr_deck_tag: str = "#flashcards/x-vocab",
    sr_card_style: ObsidianSrCardStyle = "multiline",
    sr_subdeck_by_category: bool = False,
    seed_sr_from_fsrs: bool = False,
    sr_include_audio: bool = False,
    sr_audio_autoplay: bool = False,
    tts_accent: TtsAccent = "en-US",
    client: httpx.AsyncClient | None = None,
) -> tuple[str, list[str]]:
    """Create or update index + vocabulary markdown notes via Obsidian Local REST API."""
    clean_url = normalize_obsidian_rest_url(api_url)
    clean_key = (api_key or "").strip()
    if not clean_key:
        raise ValueError("请先填写 Obsidian Local REST API Key（可在 Obsidian 插件设置页复制）。")

    clean_sub = sanitize_rest_subfolder(subfolder)
    auth_headers = _obsidian_auth_headers(clean_key)

    cm = (
        nullcontext(client)
        if client is not None
        else httpx.AsyncClient(verify=False, trust_env=False, timeout=15.0)
    )

    async def _put_markdown(http: httpx.AsyncClient, rel_path: str, markdown: str) -> None:
        endpoint = f"{clean_url}/vault/{_encode_vault_path(rel_path)}"
        resp = await http.put(
            endpoint,
            headers={**auth_headers, "Content-Type": "text/markdown; charset=utf-8"},
            content=markdown.encode("utf-8"),
        )
        if resp.status_code in (401, 403):
            raise ValueError("Obsidian Local REST API 认证失败（401/403），请核对插件 API Key。")
        if resp.status_code not in (200, 201, 204):
            raise ValueError(f"写入 {rel_path} 失败（HTTP {resp.status_code}）：{resp.text[:160]}")

    async def _get_existing_markdown(http: httpx.AsyncClient, rel_path: str) -> str | None:
        endpoint = f"{clean_url}/vault/{_encode_vault_path(rel_path)}"
        resp = await http.get(
            endpoint,
            headers={**auth_headers, "Accept": "text/markdown"},
        )
        if resp.status_code == 200:
            return resp.text
        if resp.status_code == 404:
            return None
        if resp.status_code in (401, 403):
            raise ValueError("Obsidian Local REST API 认证失败（401/403），请核对插件 API Key。")
        raise ValueError(f"读取 {rel_path} 失败（HTTP {resp.status_code}）：{resp.text[:160]}")

    async with cm as http:
        index_name = "_X-Vocab 词库总览.md"
        index_rel = f"{clean_sub}/{index_name}"
        await _put_markdown(
            http,
            index_rel,
            render_index_markdown(
                cards,
                include_flashcards=include_flashcards,
                sr_deck_tag=sr_deck_tag,
                sr_card_style=sr_card_style,
            ),
        )

        semaphore = asyncio.Semaphore(6)
        assigned = assign_card_filenames(cards)

        async def _sync_card(card: VocabCard, filename: str) -> str:
            rel_path = f"{clean_sub}/{filename}"
            async with semaphore:
                existing = await _get_existing_markdown(http, rel_path)
                preserved_sr, preserved_notes = (
                    extract_preserved_note_parts(existing) if existing is not None else ("", "")
                )
                new_text = render_card_markdown(
                    card,
                    include_flashcards=include_flashcards,
                    preserved_sr_comment=preserved_sr,
                    preserved_user_notes=preserved_notes,
                    sr_deck_tag=sr_deck_tag,
                    sr_card_style=sr_card_style,
                    sr_subdeck_by_category=sr_subdeck_by_category,
                    seed_sr_from_fsrs=seed_sr_from_fsrs,
                    sr_include_audio=sr_include_audio,
                    sr_audio_autoplay=sr_audio_autoplay,
                    tts_accent=tts_accent,
                )
                await _put_markdown(http, rel_path, new_text)
                return filename

        card_filenames = await asyncio.gather(
            *(_sync_card(card, filename) for card, filename in assigned)
        )

    return f"{clean_url} ({clean_sub})", [index_name, *card_filenames]


def parse_obsidian_sr_metadata(markdown: str) -> dict[str, object] | None:
    """Extract due date, interval, ease, and optional word identifier from an Obsidian note."""
    entries: list[tuple[str, int, int]] = []
    for comment_match in SR_COMMENT_RE.finditer(markdown):
        comment = comment_match.group(0)
        for m in SR_ENTRY_RE.finditer(comment):
            due_str = m.group(1)
            interval = max(1, int(round(float(m.group(2)))))
            ease = max(130, int(round(float(m.group(3)))))
            entries.append((due_str, interval, ease))

    if not entries:
        yaml_due = YAML_SR_DUE_RE.search(markdown)
        if yaml_due:
            yaml_int = YAML_SR_INTERVAL_RE.search(markdown)
            yaml_ease = YAML_SR_EASE_RE.search(markdown)
            entries.append(
                (
                    yaml_due.group(1),
                    max(1, int(yaml_int.group(1))) if yaml_int else 1,
                    max(130, int(yaml_ease.group(1))) if yaml_ease else 250,
                )
            )

    if not entries:
        return None

    # For bidirectional cards (`??`) with multiple tuples, surface earliest due date first.
    due_str, interval, ease = min(entries, key=lambda item: item[0])
    word = ""
    word_match = YAML_WORD_RE.search(markdown)
    if word_match:
        word = word_match.group(1).replace('\\"', '"').replace("\\\\", "\\").strip()
    else:
        h1_match = H1_WORD_RE.search(markdown)
        if h1_match:
            word = h1_match.group(1).strip()

    return {
        "due": due_str,
        "interval": interval,
        "ease": ease,
        "word": word,
    }


def apply_obsidian_sr_to_cards(
    cards: list[VocabCard],
    notes: list[tuple[str, str]],
) -> tuple[int, int, list[VocabCard], list[str]]:
    """Merge newer Obsidian Spaced Repetition progress from notes back into VocabCards."""
    by_word: dict[str, int] = {}
    by_stem: dict[str, int] = {}
    for idx, card in enumerate(cards):
        by_word.setdefault(card.word.strip().lower(), idx)
        by_stem.setdefault(sanitize_note_filename(card.word).lower(), idx)

    updated_map: dict[int, VocabCard] = {}
    notes_with_sr = 0
    now_iso = datetime.now(timezone.utc).isoformat()

    for note_name, markdown in notes:
        parsed = parse_obsidian_sr_metadata(markdown)
        if parsed is None:
            continue
        notes_with_sr += 1

        word_key = str(parsed["word"]).strip().lower()
        stem_key = Path(note_name).stem.strip().lower()
        card_idx = by_word.get(word_key)
        if card_idx is None:
            card_idx = by_stem.get(stem_key)
        if card_idx is None:
            continue

        card = updated_map.get(card_idx, cards[card_idx])
        obs_due = str(parsed["due"])
        interval = int(parsed["interval"])
        ease = int(parsed["ease"])

        try:
            inferred_review = (date.fromisoformat(obs_due) - timedelta(days=interval)).isoformat()
        except ValueError:
            continue

        web_last_review = _date_part(card.fsrs.last_review) if card.fsrs.last_review else ""
        web_due = _date_part(card.fsrs.due) if card.fsrs.due else ""
        if (
            card.fsrs.reps > 0
            and obs_due == web_due
            and interval == card.fsrs.scheduled_days
        ):
            continue

        should_update = (
            card.fsrs.reps == 0
            or not web_last_review
            or inferred_review > web_last_review
            or (inferred_review == web_last_review and obs_due > web_due)
        )
        if not should_update:
            continue

        is_lapse = interval <= 1 and card.fsrs.reps > 0
        difficulty = round(min(10.0, max(1.0, (310.0 - ease) / 15.0)), 2)
        next_fsrs = card.fsrs.model_copy(
            update={
                "due": f"{obs_due}T09:00:00+00:00",
                "scheduled_days": interval,
                "stability": float(max(0.5, interval)),
                "difficulty": difficulty,
                "reps": card.fsrs.reps + 1,
                "lapses": card.fsrs.lapses + (1 if is_lapse else 0),
                "state": 3 if is_lapse else 2,
                "last_review": f"{inferred_review}T09:00:00+00:00",
            }
        )
        updated_map[card_idx] = card.model_copy(
            update={"fsrs": next_fsrs, "updated_at": now_iso}
        )

    ordered_indices = sorted(updated_map.keys())
    updated_cards = [updated_map[i] for i in ordered_indices]
    updated_words = [updated_map[i].word for i in ordered_indices]
    return len(notes), notes_with_sr, updated_cards, updated_words


def pull_obsidian_vault_sr_progress(
    cards: list[VocabCard],
    vault_path: str,
    subfolder: str = "X-Vocab",
) -> tuple[int, int, list[VocabCard], list[str]]:
    """Read notes from a local Obsidian Vault subfolder and merge SR progress into cards."""
    target_dir = _resolve_target_vault_dir(vault_path, subfolder)
    if not target_dir.exists() or not target_dir.is_dir():
        return 0, 0, [], []

    notes: list[tuple[str, str]] = []
    for md_path in sorted(target_dir.glob("*.md")):
        if md_path.name == "_X-Vocab 词库总览.md":
            continue
        notes.append((md_path.name, md_path.read_text(encoding="utf-8")))

    return apply_obsidian_sr_to_cards(cards, notes)


async def pull_obsidian_rest_sr_progress(
    cards: list[VocabCard],
    api_url: str,
    api_key: str,
    subfolder: str = "X-Vocab",
    *,
    client: httpx.AsyncClient | None = None,
) -> tuple[int, int, list[VocabCard], list[str]]:
    """Fetch notes from Obsidian Local REST API subfolder and merge SR progress into cards."""
    clean_url = normalize_obsidian_rest_url(api_url)
    clean_key = (api_key or "").strip()
    if not clean_key:
        raise ValueError("请先填写 Obsidian Local REST API Key。")

    clean_sub = sanitize_rest_subfolder(subfolder)
    auth_headers = _obsidian_auth_headers(clean_key)

    cm = (
        nullcontext(client)
        if client is not None
        else httpx.AsyncClient(verify=False, trust_env=False, timeout=15.0)
    )

    async with cm as http:
        dir_endpoint = f"{clean_url}/vault/{_encode_vault_path(clean_sub)}/"
        dir_resp = await http.get(dir_endpoint, headers={**auth_headers, "Accept": "application/json"})
        if dir_resp.status_code in (401, 403):
            raise ValueError("Obsidian Local REST API 认证失败（401/403），请核对插件 API Key。")
        if dir_resp.status_code == 404:
            return 0, 0, [], []

        rel_paths: list[str] = []
        if dir_resp.status_code == 200:
            try:
                payload = dir_resp.json()
                raw_files = payload.get("files") if isinstance(payload, dict) else None
                if isinstance(raw_files, list):
                    for item in raw_files:
                        name = str(item).strip("/")
                        if not name.endswith(".md") or name.endswith("_X-Vocab 词库总览.md"):
                            continue
                        rel_paths.append(name if name.startswith(f"{clean_sub}/") else f"{clean_sub}/{name}")
            except ValueError:
                rel_paths = []

        if not rel_paths:
            rel_paths = [f"{clean_sub}/{filename}" for _, filename in assign_card_filenames(cards)]

        semaphore = asyncio.Semaphore(6)

        async def _fetch_note(rel_path: str) -> tuple[str, str] | None:
            endpoint = f"{clean_url}/vault/{_encode_vault_path(rel_path)}"
            async with semaphore:
                resp = await http.get(endpoint, headers={**auth_headers, "Accept": "text/markdown"})
                if resp.status_code == 200:
                    return (Path(rel_path).name, resp.text)
                if resp.status_code == 404:
                    return None
                if resp.status_code in (401, 403):
                    raise ValueError("Obsidian Local REST API 认证失败（401/403），请核对插件 API Key。")
                raise ValueError(f"读取 {rel_path} 失败（HTTP {resp.status_code}）。")

        fetched = await asyncio.gather(*(_fetch_note(rel_path) for rel_path in rel_paths))

    notes = [item for item in fetched if item is not None]
    return apply_obsidian_sr_to_cards(cards, notes)


async def launch_obsidian_sr_command(
    api_url: str,
    api_key: str,
    command_id: str | None = None,
    *,
    client: httpx.AsyncClient | None = None,
) -> ObsidianSrLaunchResponse:
    """Locate and trigger the Obsidian Spaced Repetition review command via Local REST API."""
    clean_url = normalize_obsidian_rest_url(api_url)
    clean_key = (api_key or "").strip()
    if not clean_key:
        raise ValueError("请先填写 Obsidian Local REST API Key。")

    auth_headers = _obsidian_auth_headers(clean_key)
    cm = (
        nullcontext(client)
        if client is not None
        else httpx.AsyncClient(verify=False, trust_env=False, timeout=10.0)
    )

    async with cm as http:
        chosen_id = (command_id or "").strip()
        chosen_name = ""
        if not chosen_id:
            cmd_resp = await http.get(
                f"{clean_url}/commands/",
                headers={**auth_headers, "Accept": "application/json"},
            )
            if cmd_resp.status_code in (401, 403):
                raise ValueError("Obsidian Local REST API 认证失败（401/403），请核对插件 API Key。")
            if cmd_resp.status_code != 200:
                raise ValueError(f"查询 Obsidian 命令列表失败（HTTP {cmd_resp.status_code}）。")

            commands_data = cmd_resp.json().get("commands", []) if cmd_resp.text else []
            sr_cmds = [
                c
                for c in commands_data
                if isinstance(c, dict) and str(c.get("id", "")).startswith("obsidian-spaced-repetition:")
            ]
            if not sr_cmds:
                raise ValueError(
                    "未在 Obsidian 中检测到 Spaced Repetition 插件命令，请确认已在 Obsidian 安装并启用「Spaced Repetition」插件。"
                )

            def _score_cmd(cmd: dict[str, object]) -> int:
                cid = str(cmd.get("id", "")).lower()
                if "review-flashcards" in cid and "note" not in cid:
                    return 0
                if "open-flashcard" in cid or "srs-open" in cid:
                    return 1
                if "flashcard" in cid and "cram" not in cid:
                    return 2
                return 3

            best = min(sr_cmds, key=_score_cmd)
            chosen_id = str(best.get("id", ""))
            chosen_name = str(best.get("name", ""))

        exec_resp = await http.post(
            f"{clean_url}/commands/{quote(chosen_id, safe='')}/",
            headers=auth_headers,
        )
        if exec_resp.status_code in (401, 403):
            raise ValueError("Obsidian Local REST API 认证失败（401/403），请核对插件 API Key。")
        if exec_resp.status_code not in (200, 204):
            raise ValueError(f"触发命令 {chosen_id} 失败（HTTP {exec_resp.status_code}）。")

    label = chosen_name or chosen_id
    return ObsidianSrLaunchResponse(
        ok=True,
        command_id=chosen_id,
        command_name=chosen_name,
        message=f"已在 Obsidian 中唤醒 Spaced Repetition（{label}）。",
    )
