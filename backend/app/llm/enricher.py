from __future__ import annotations

import ipaddress
import json
import re
import time
import uuid
from typing import Any, Literal
from urllib.parse import urlparse

import httpx

from app.config import settings
from app.models import (
    CandidateWord,
    LLMOverrideConfig,
    LLMTestResponse,
    VocabCard,
    utc_now_iso,
)

TIER_PROMPT_PROFILES: dict[str, tuple[str, str]] = {
    "strict_1200": (
        "面向英语零基础或初中级（约 1200 词起步）的中文学习者",
        "给初学者的超直观记忆技巧、基础词根拆解或易混点提醒，语言通俗好懂",
    ),
    "basic_2000": (
        "面向大学英语四级（CET-4）以下（约 2000 词起步）的中国英语学习者",
        "给四级以下学习者的一句话记忆技巧、搭配用法或注意提示",
    ),
    "cet4_3500": (
        "面向已具备大学英语四级（CET-4）基础、向六级进阶的中文学习者",
        "重点说明该词在真实语境下的延伸义、常用固定搭配或近义词区别（避免过于基础的解释）",
    ),
    "cet6_5500": (
        "面向具备大学英语六级（CET-6 / CEFR B2）水平、常态阅读英文长推的学习者",
        "跳过入门铺垫，重点点出 B2–C1 语境精确义、熟词僻义、常用搭配及正式/口语色彩",
    ),
    "ielts_8000": (
        "面向考研高分 / 雅思 7+ / 托福 100+ 水平（约 8000 词起步）的中高阶学习者",
        "重点分析 C1 精准替换表达、熟词僻义、句中语气与语域差异（register），勿写基础记忆口诀",
    ),
    "advanced_12000": (
        "面向 12000+ 词汇量（CEFR C1–C2 与母语者深度阅读）的高阶英语使用者",
        "深入拆解 C1–C2 罕见词或地道表达的微妙语差（nuance）、修辞隐喻、母语者近义替换与语用边界",
    ),
}


def build_system_prompt(filter_tier: str = "basic_2000", custom_vocab_limit: int = 5500) -> str:
    """Build an LLM system prompt tailored to the learner's vocabulary proficiency tier."""
    resolved_tier = filter_tier
    if filter_tier == "custom":
        if custom_vocab_limit <= 2500:
            resolved_tier = "basic_2000"
        elif custom_vocab_limit <= 4500:
            resolved_tier = "cet4_3500"
        elif custom_vocab_limit <= 7000:
            resolved_tier = "cet6_5500"
        elif custom_vocab_limit <= 10500:
            resolved_tier = "ielts_8000"
        else:
            resolved_tier = "advanced_12000"

    audience_desc, tip_guidance = TIER_PROMPT_PROFILES.get(
        resolved_tier,
        TIER_PROMPT_PROFILES["basic_2000"],
    )
    return f"""你是一位{audience_desc}的资深英语词汇教练。
用户正在通过阅读 X（Twitter）上科技、AI、游戏、音乐、生活及深度观点类的真实英文推文来积累高价值词汇与地道表达。

请根据给定的候选英文词/短语及其出现的原推文语境，输出严格合法的 JSON 对象，结构如下：
{{
  "items": [
    {{
      "word": "候选词原形（必须与输入完全一致）",
      "ipa": "美式音标，例如 /ˈsʌtəl/",
      "pos": "在例句中的词性简写，如 n. / v. / adj. / adv. / phr.",
      "category": "只能是 standard | collocation | slang | ignore 之一",
      "cefr_level": "A2 | B1 | B2 | C1 | C2 | slang",
      "meaning_zh": "贴合该原推文语境的精准简明中文释义（如有熟词僻义，重点写出此处含义）",
      "memory_tip_zh": "{tip_guidance}",
      "sample_tweet_zh": "所选原推文的自然流畅中文整句翻译"
    }}
  ]
}}

分类规则：
- standard：正经通用、高阶书面或常见专业高频词（值得主动记忆和复用）
- collocation：短语动词、固定搭配、高阶习语或熟词僻义表达（如 figure out, diminishing returns, ship a product）
- slang：网络俚语、缩写或游戏/AI/社媒黑话（如 ngl, tbh, nerf, slop, copium，看懂即可）
- ignore：纯人名、品牌名、无实际学习价值的拼写错误或乱码"""


SYSTEM_PROMPT = build_system_prompt("basic_2000")

THINK_TAG_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
PLACEHOLDER_API_KEYS = {"your_deepseek_api_key_here"}


def _clean_api_key(value: str | None) -> str:
    key = (value or "").strip()
    return "" if key in PLACEHOLDER_API_KEYS else key


def _build_openai_chat_endpoint(base_url: str) -> str:
    normalized = base_url.strip().rstrip("/")
    if normalized.endswith("/chat/completions"):
        return normalized
    return f"{normalized}/chat/completions"


def _build_openai_models_endpoint(base_url: str) -> str:
    normalized = base_url.strip().rstrip("/")
    if normalized.endswith("/chat/completions"):
        normalized = normalized[: -len("/chat/completions")]
    return f"{normalized}/models"


def _build_openai_headers(api_key: str) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"
    return headers


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


def _resolve_llm_config(
    override: LLMOverrideConfig | None,
) -> tuple[Literal["openai_compatible", "gemini"], str, str, str]:
    """Resolve effective provider, API key, base URL, and model from override or env defaults."""
    raw_provider = (override.provider if override and override.provider else None) or settings.llm_provider
    provider: Literal["openai_compatible", "gemini"] = "gemini" if raw_provider == "gemini" else "openai_compatible"

    if provider == "gemini":
        api_key = (
            _clean_api_key(override.api_key if override else None)
            or _clean_api_key(settings.gemini_api_key)
            or _clean_api_key(settings.llm_api_key)
        )
        model = ((override.model or "").strip() if override else "") or settings.gemini_model
        return provider, api_key, "https://generativelanguage.googleapis.com/v1beta", model

    override_base = (override.base_url or "").strip() if override else ""
    base_url = override_base or settings.llm_base_url.strip()
    model = ((override.model or "").strip() if override else "") or settings.llm_model
    override_key = _clean_api_key(override.api_key if override else None)

    if override_key:
        api_key = override_key
    elif (
        override_base
        and override_base.rstrip("/") != settings.llm_base_url.strip().rstrip("/")
        and _is_local_or_private_endpoint(base_url)
    ):
        # Avoid leaking a cloud API key from .env to an explicitly overridden local endpoint.
        api_key = ""
    else:
        api_key = _clean_api_key(settings.llm_api_key)

    return provider, api_key, base_url, model


def _extract_error_detail(resp: httpx.Response) -> str:
    try:
        data = resp.json()
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict) and err.get("message"):
                return str(err["message"])
            if isinstance(err, str) and err:
                return err
            if data.get("detail"):
                return str(data["detail"])
            if data.get("message"):
                return str(data["message"])
    except Exception:
        pass
    text = (resp.text or "").strip()
    return text[:200] if text else f"HTTP {resp.status_code}"


async def _fetch_openai_models(
    client: httpx.AsyncClient,
    base_url: str,
    headers: dict[str, str],
) -> list[str]:
    try:
        resp = await client.get(_build_openai_models_endpoint(base_url), headers=headers, timeout=5.0)
        if resp.status_code != 200:
            return []
        data = resp.json()
        items = data.get("data") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return []
        return [str(m["id"]) for m in items if isinstance(m, dict) and m.get("id")]
    except Exception:
        return []


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
    system_prompt: str = SYSTEM_PROMPT,
) -> dict[str, Any]:
    endpoint = _build_openai_chat_endpoint(base_url)
    headers = _build_openai_headers(api_key)

    body: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
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
    system_prompt: str = SYSTEM_PROMPT,
) -> dict[str, Any]:
    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    params = {"key": api_key}
    body = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
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


async def _test_openai_compatible_connection(
    api_key: str,
    base_url: str,
    model: str,
) -> LLMTestResponse:
    parsed_url = urlparse(base_url)
    is_local = _is_local_or_private_endpoint(base_url)
    endpoint = _build_openai_chat_endpoint(base_url) if base_url else ""

    if parsed_url.scheme not in ("http", "https") or not parsed_url.netloc:
        return LLMTestResponse(
            ok=False,
            provider="openai_compatible",
            model=model,
            endpoint=endpoint or base_url,
            latency_ms=0,
            is_local=is_local,
            message="Base URL 格式无效，请以 http:// 或 https:// 开头（例如 http://localhost:11434/v1）。",
        )
    if not model:
        return LLMTestResponse(
            ok=False,
            provider="openai_compatible",
            model="",
            endpoint=endpoint,
            latency_ms=0,
            is_local=is_local,
            message="请先填写模型名称（例如 deepseek-r1:7b 或 deepseek-chat）。",
        )
    if not api_key and not is_local:
        return LLMTestResponse(
            ok=False,
            provider="openai_compatible",
            model=model,
            endpoint=endpoint,
            latency_ms=0,
            is_local=False,
            message="尚未配置云端 API Key；若连接本地自建 DeepSeek，请将 Base URL 设为 http://localhost:11434/v1 等本地/局域网地址即可免 Key。",
        )

    headers = _build_openai_headers(api_key)
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with OK."}],
        "temperature": 0,
        "max_tokens": 64,
    }
    timeout = 60.0 if is_local else 30.0
    started = time.perf_counter()

    try:
        async with _create_async_client(bypass_proxy=is_local, timeout=timeout) as client:
            resp = await client.post(endpoint, headers=headers, json=body)
            latency_ms = int((time.perf_counter() - started) * 1000)

            if resp.status_code == 401:
                return LLMTestResponse(
                    ok=False,
                    provider="openai_compatible",
                    model=model,
                    endpoint=endpoint,
                    latency_ms=latency_ms,
                    is_local=is_local,
                    message="API Key 无效或未通过鉴权（HTTP 401），请检查密钥配置。",
                )

            if resp.status_code >= 400:
                available_models = (
                    await _fetch_openai_models(client, base_url, headers)
                    if resp.status_code in (400, 404, 422)
                    else []
                )
                detail = _extract_error_detail(resp)
                if resp.status_code == 404 and available_models and model not in available_models:
                    models_hint = "、".join(available_models[:8])
                    msg = f'模型 "{model}" 未找到（HTTP 404），当前服务可用模型：{models_hint}'
                elif resp.status_code == 404 and not base_url.strip().rstrip("/").endswith(("/v1", "/chat/completions")):
                    msg = (
                        f"接口返回 404（{endpoint}），请确认 Base URL 是否缺少 /v1"
                        "（例如 Ollama 默认为 http://localhost:11434/v1）。"
                    )
                else:
                    msg = f"模型接口返回错误（HTTP {resp.status_code}）：{detail}"
                return LLMTestResponse(
                    ok=False,
                    provider="openai_compatible",
                    model=model,
                    endpoint=endpoint,
                    latency_ms=latency_ms,
                    is_local=is_local,
                    message=msg,
                    available_models=available_models,
                )

            try:
                data = resp.json()
            except ValueError:
                return LLMTestResponse(
                    ok=False,
                    provider="openai_compatible",
                    model=model,
                    endpoint=endpoint,
                    latency_ms=latency_ms,
                    is_local=is_local,
                    message="接口返回了非 JSON 内容，请检查 Base URL 是否正确（如是否缺少 /v1）。",
                )
    except httpx.ConnectError:
        local_hint = (
            f"无法连接到本地服务 {endpoint}，请确认 Ollama / vLLM / LM Studio 已启动且端口正确"
            "（WSL2 环境若服务运行在 Windows 宿主机，请开启镜像网络或改用宿主机局域网 IP）。"
            if is_local
            else f"无法连接到接口地址 {endpoint}，请检查网络连通性或代理配置。"
        )
        return LLMTestResponse(
            ok=False,
            provider="openai_compatible",
            model=model,
            endpoint=endpoint,
            latency_ms=int((time.perf_counter() - started) * 1000),
            is_local=is_local,
            message=local_hint,
        )
    except httpx.TimeoutException:
        return LLMTestResponse(
            ok=False,
            provider="openai_compatible",
            model=model,
            endpoint=endpoint,
            latency_ms=int((time.perf_counter() - started) * 1000),
            is_local=is_local,
            message=f"请求模型 {model} 超时（>{int(timeout)}s），若本地首次加载大模型较慢可稍后重试。",
        )
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        return LLMTestResponse(
            ok=False,
            provider="openai_compatible",
            model=model,
            endpoint=endpoint,
            latency_ms=int((time.perf_counter() - started) * 1000),
            is_local=is_local,
            message=f"请求异常：{exc}",
        )

    if isinstance(data, dict) and data.get("error") and not data.get("choices"):
        err = data["error"]
        detail = err.get("message") if isinstance(err, dict) else str(err)
        return LLMTestResponse(
            ok=False,
            provider="openai_compatible",
            model=model,
            endpoint=endpoint,
            latency_ms=latency_ms,
            is_local=is_local,
            message=f"模型接口返回错误：{detail}",
        )

    choices = data.get("choices") if isinstance(data, dict) else None
    if not isinstance(choices, list) or not choices:
        return LLMTestResponse(
            ok=False,
            provider="openai_compatible",
            model=model,
            endpoint=endpoint,
            latency_ms=latency_ms,
            is_local=is_local,
            message="接口响应格式不符合 OpenAI Chat Completions 规范（缺少 choices 字段）。",
        )

    message_obj = choices[0].get("message") if isinstance(choices[0], dict) else {}
    raw_content = str((message_obj or {}).get("content") or "")
    reasoning_content = str((message_obj or {}).get("reasoning_content") or "")
    cleaned = THINK_TAG_RE.sub("", raw_content).strip()
    preview = cleaned[:80] if cleaned else ("（模型已响应推理输出）" if (raw_content or reasoning_content) else "（模型已响应）")

    scope_label = "本地模型" if is_local else "模型"
    return LLMTestResponse(
        ok=True,
        provider="openai_compatible",
        model=model,
        endpoint=endpoint,
        latency_ms=latency_ms,
        is_local=is_local,
        message=f"连通成功（耗时 {latency_ms} ms），{scope_label} {model} 响应正常。",
        reply_preview=preview,
    )


async def _test_gemini_connection(api_key: str, model: str) -> LLMTestResponse:
    endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    if not model:
        return LLMTestResponse(
            ok=False,
            provider="gemini",
            model="",
            endpoint=endpoint,
            latency_ms=0,
            is_local=False,
            message="请先填写 Gemini 模型名称（例如 gemini-2.5-flash）。",
        )
    if not api_key:
        return LLMTestResponse(
            ok=False,
            provider="gemini",
            model=model,
            endpoint=endpoint,
            latency_ms=0,
            is_local=False,
            message="尚未配置 Gemini API Key，请先填写后再测试连通性。",
        )

    body = {
        "contents": [{"role": "user", "parts": [{"text": "Reply with OK."}]}],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 32},
    }
    started = time.perf_counter()
    try:
        async with _create_async_client(timeout=30.0) as client:
            resp = await client.post(endpoint, params={"key": api_key}, json=body)
            latency_ms = int((time.perf_counter() - started) * 1000)
            if resp.status_code >= 400:
                detail = _extract_error_detail(resp)
                return LLMTestResponse(
                    ok=False,
                    provider="gemini",
                    model=model,
                    endpoint=endpoint,
                    latency_ms=latency_ms,
                    is_local=False,
                    message=f"Gemini 接口返回异常（HTTP {resp.status_code}）：{detail}",
                )
            data = resp.json()
    except httpx.TimeoutException:
        return LLMTestResponse(
            ok=False,
            provider="gemini",
            model=model,
            endpoint=endpoint,
            latency_ms=int((time.perf_counter() - started) * 1000),
            is_local=False,
            message="连接 Gemini API 超时（>30s），请检查网络或代理设置。",
        )
    except (httpx.HTTPError, ValueError) as exc:
        return LLMTestResponse(
            ok=False,
            provider="gemini",
            model=model,
            endpoint=endpoint,
            latency_ms=int((time.perf_counter() - started) * 1000),
            is_local=False,
            message=f"连接 Gemini API 失败：{exc}",
        )

    candidates = data.get("candidates") if isinstance(data, dict) else None
    if not isinstance(candidates, list) or not candidates:
        return LLMTestResponse(
            ok=False,
            provider="gemini",
            model=model,
            endpoint=endpoint,
            latency_ms=latency_ms,
            is_local=False,
            message="Gemini 响应中未包含 candidates 字段。",
        )
    parts = ((candidates[0].get("content") or {}).get("parts") or []) if isinstance(candidates[0], dict) else []
    preview = str(parts[0].get("text", "")).strip()[:80] if parts and isinstance(parts[0], dict) else "（模型已响应）"
    return LLMTestResponse(
        ok=True,
        provider="gemini",
        model=model,
        endpoint=endpoint,
        latency_ms=latency_ms,
        is_local=False,
        message=f"连通成功（耗时 {latency_ms} ms），Gemini 模型 {model} 响应正常。",
        reply_preview=preview,
    )


async def test_llm_connection(override: LLMOverrideConfig | None = None) -> LLMTestResponse:
    """Probe the configured LLM provider with a minimal completion request."""
    provider, api_key, base_url, model = _resolve_llm_config(override)
    if provider == "gemini":
        return await _test_gemini_connection(api_key=api_key, model=model)
    return await _test_openai_compatible_connection(api_key=api_key, base_url=base_url, model=model)


async def enrich_candidates(
    candidates: list[CandidateWord],
    override: LLMOverrideConfig | None = None,
    filter_tier: str = "basic_2000",
    custom_vocab_limit: int = 5500,
) -> tuple[list[VocabCard], list[str]]:
    if not candidates:
        return [], []

    provider, api_key, base_url, model = _resolve_llm_config(override)
    system_prompt = build_system_prompt(filter_tier=filter_tier, custom_vocab_limit=custom_vocab_limit)

    cards: list[VocabCard] = []
    skipped_ignored: list[str] = []
    candidate_map = {c.lemma.lower(): c for c in candidates}

    batch_size = 20
    for i in range(0, len(candidates), batch_size):
        batch = candidates[i : i + batch_size]

        if provider == "gemini":
            if not api_key:
                raise ValueError("尚未配置 Gemini API Key，请在“设置”中填写或在 backend/.env 配置 GEMINI_API_KEY。")
            parsed = await _call_gemini(
                batch,
                api_key=api_key,
                model=model,
                system_prompt=system_prompt,
            )
        else:
            if not api_key and not _is_local_or_private_endpoint(base_url):
                raise ValueError(
                    "尚未配置 DeepSeek / OpenAI 兼容 API Key，请在“设置”中填写或在 backend/.env 配置 LLM_API_KEY（若使用本地 Ollama/vLLM 等自建服务，请将 Base URL 设为 http://localhost:11434/v1 等本地地址即可免 Key）。"
                )
            parsed = await _call_openai_compatible(
                batch,
                api_key=api_key,
                base_url=base_url,
                model=model,
                system_prompt=system_prompt,
            )

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
