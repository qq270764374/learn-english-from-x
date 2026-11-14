from __future__ import annotations

import ipaddress
import json
import re
import uuid
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import settings
from app.models import CandidateWord, LLMOverrideConfig, VocabCard, utc_now_iso

SYSTEM_PROMPT = """你是一位面向中国英语初学者的资深英语词汇教练。
用户目前的英语水平在大学英语四级（CET-4）以下，正在通过阅读 X（Twitter）上科技、AI、游戏、音乐、生活类的真实英文推文来积累高频实用词汇。

请根据给定的候选英文词/短语及其出现的原推文语境，输出严格合法的 JSON 对象，结构如下：
{
  "items": [
    {
      "word": "候选词原形（必须与输入完全一致）",
      "ipa": "美式音标，例如 /ˈsʌtəl/",
      "pos": "在例句中的词性简写，如 n. / v. / adj. / adv. / phr.",
      "category": "只能是 standard | collocation | slang | ignore 之一",
      "cefr_level": "A2 | B1 | B2 | C1 | slang",
      "meaning_zh": "贴合该原推文语境的精准简明中文释义（如有熟词僻义，重点写出此处含义）",
      "memory_tip_zh": "给四级以下学习者的一句话记忆技巧、搭配用法或注意提示",
      "sample_tweet_zh": "所选原推文的自然流畅中文整句翻译"
    }
  ]
}

分类规则：
- standard：正经通用或常见专业高频词（值得主动记忆和复用）
- collocation：短语动词、固定搭配或熟词僻义表达（如 figure out, ship a product, scale down）
- slang：网络俚语、缩写或游戏/社媒黑话（如 ngl, tbh, nerf, slop，看懂即可）
- ignore：纯人名、品牌名、无实际学习价值的拼写错误或乱码"""

THINK_TAG_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def _is_local_or_private_endpoint(base_url: str) -> bool:
    host = (urlparse(base_url).hostname or "").strip().lower()
    if not host:
        return False
    if host in {"localhost", "0.0.0.0", "host.docker.internal"} or host.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_loopback or ip.is_private
    except ValueError:
        return False


def _build_user_prompt(batch: list[CandidateWord]) -> str:
    payload = []
    for c in batch:
        sample = c.sample_tweets[0].text if c.sample_tweets else ""
        payload.append(
            {
                "word": c.lemma,
                "surface_forms": c.surface_forms[:4],
                "hint": c.slang_hint,
                "sample_tweet": sample,
            }
        )
    return (
        "请为以下候选英文词汇生成语境学习卡片（只返回 JSON，不要包含 Markdown 代码块之外的多余文字）：\n"
        + json.dumps(payload, ensure_ascii=False, indent=2)
    )


def _extract_json_object(raw_text: str) -> dict[str, Any]:
    text = THINK_TAG_RE.sub("", raw_text).strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
        if text.startswith("json"):
            text = text[4:].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start : end + 1])
        raise ValueError(f"大模型未返回合法 JSON：{raw_text[:200]}")


def _create_async_client(bypass_proxy: bool = False, timeout: float = 60.0) -> httpx.AsyncClient:
    if bypass_proxy:
        return httpx.AsyncClient(timeout=timeout, trust_env=False)
    try:
        return httpx.AsyncClient(timeout=timeout)
    except httpx.InvalidURL:
        import os

        proxy = (
            os.environ.get("HTTPS_PROXY")
            or os.environ.get("https_proxy")
            or os.environ.get("HTTP_PROXY")
            or os.environ.get("http_proxy")
        )
        return httpx.AsyncClient(timeout=timeout, proxy=proxy, trust_env=False)


async def _call_openai_compatible(
    batch: list[CandidateWord],
    api_key: str,
    base_url: str,
    model: str,
) -> dict[str, Any]:
    endpoint = base_url.rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"

    body: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _build_user_prompt(batch)},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }
    is_local = _is_local_or_private_endpoint(base_url)
    timeout = 180.0 if is_local else 60.0

    async with _create_async_client(bypass_proxy=is_local, timeout=timeout) as client:
        resp = await client.post(endpoint, headers=headers, json=body)
        if resp.status_code in (400, 422):
            # Some self-hosted runtimes / reasoning models reject response_format=json_object
            fallback_body = {k: v for k, v in body.items() if k != "response_format"}
            resp = await client.post(endpoint, headers=headers, json=fallback_body)
        if resp.status_code == 401:
            raise ValueError("API Key 无效或已过期（HTTP 401），请检查 DeepSeek / OpenAI 密钥配置。")
        resp.raise_for_status()
        data = resp.json()
    content = data["choices"][0]["message"]["content"]
    return _extract_json_object(content)


async def _call_gemini(
    batch: list[CandidateWord],
    api_key: str,
    model: str,
) -> dict[str, Any]:
    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    params = {"key": api_key}
    body = {
        "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": _build_user_prompt(batch)}]}],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json",
        },
    }
    async with _create_async_client() as client:
        resp = await client.post(endpoint, params=params, json=body)
        if resp.status_code in (400, 401, 403):
            raise ValueError(f"Gemini API 鉴权或请求异常（HTTP {resp.status_code}），请检查 Gemini API Key。")
        resp.raise_for_status()
        data = resp.json()
    content = data["candidates"][0]["content"]["parts"][0]["text"]
    return _extract_json_object(content)


async def enrich_candidates(
    candidates: list[CandidateWord],
    override: LLMOverrideConfig | None = None,
) -> tuple[list[VocabCard], list[str]]:
    if not candidates:
        return [], []

    provider = (override.provider if override and override.provider else None) or settings.llm_provider

    cards: list[VocabCard] = []
    skipped_ignored: list[str] = []
    candidate_map = {c.lemma.lower(): c for c in candidates}

    batch_size = 20
    for i in range(0, len(candidates), batch_size):
        batch = candidates[i : i + batch_size]

        if provider == "gemini":
            api_key = (override.api_key if override and override.api_key else None) or settings.gemini_api_key or settings.llm_api_key
            model = (override.model if override and override.model else None) or settings.gemini_model
            if not api_key:
                raise ValueError("尚未配置 Gemini API Key，请在“设置”中填写或在 backend/.env 配置 GEMINI_API_KEY。")
            parsed = await _call_gemini(batch, api_key=api_key, model=model)
        else:
            api_key = (override.api_key if override and override.api_key else None) or settings.llm_api_key
            base_url = (override.base_url if override and override.base_url else None) or settings.llm_base_url
            model = (override.model if override and override.model else None) or settings.llm_model
            if not api_key and not _is_local_or_private_endpoint(base_url):
                raise ValueError(
                    "尚未配置 DeepSeek / OpenAI 兼容 API Key，请在“设置”中填写或在 backend/.env 配置 LLM_API_KEY（若使用本地 Ollama/vLLM 等自建服务，请将 Base URL 设为 http://localhost:11434/v1 等本地地址即可免 Key）。"
                )
            parsed = await _call_openai_compatible(batch, api_key=api_key, base_url=base_url, model=model)

        now = utc_now_iso()
        for item in parsed.get("items", []):
            word = str(item.get("word", "")).strip()
            if not word:
                continue
            category = str(item.get("category", "standard")).strip().lower()
            if category == "ignore":
                skipped_ignored.append(word.lower())
                continue
            if category not in ("standard", "collocation", "slang"):
                category = "standard"

            cand = candidate_map.get(word.lower())
            sample_ctx = cand.sample_tweets[0] if cand and cand.sample_tweets else None

            cards.append(
                VocabCard(
                    id=f"card-{uuid.uuid4().hex[:12]}",
                    word=word,
                    ipa=str(item.get("ipa", "")).strip(),
                    pos=str(item.get("pos", cand.pos if cand else "")).strip(),
                    category=category,  # type: ignore[arg-type]
                    cefr_level=str(item.get("cefr_level", "B1")).strip(),
                    meaning_zh=str(item.get("meaning_zh", "")).strip(),
                    memory_tip_zh=str(item.get("memory_tip_zh", "")).strip(),
                    sample_tweet=sample_ctx.text if sample_ctx else "",
                    sample_tweet_zh=str(item.get("sample_tweet_zh", "")).strip(),
                    author_handle=sample_ctx.author_handle if sample_ctx else "",
                    tweet_url=sample_ctx.url if sample_ctx else "",
                    created_at=now,
                    updated_at=now,
                )
            )

    return cards, skipped_ignored
