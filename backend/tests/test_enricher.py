import json
import pytest
import respx
import httpx

from app.llm.enricher import enrich_candidates
from app.models import CandidateWord, LLMOverrideConfig, SampleContext


def _make_candidates() -> list[CandidateWord]:
    return [
        CandidateWord(
            lemma="subtle",
            surface_forms=["subtle"],
            pos="adj",
            corpus_count=2,
            zipf_score=4.2,
            sweet_spot_score=7.6,
            sample_tweets=[
                SampleContext(
                    tweet_id="t1",
                    author_handle="karpathy",
                    url="https://x.com/karpathy/status/1",
                    text="The difference is subtle at first.",
                )
            ],
        ),
        CandidateWord(
            lemma="karpathy",
            surface_forms=["Karpathy"],
            pos="noun",
            corpus_count=1,
            zipf_score=2.5,
            sweet_spot_score=2.0,
            sample_tweets=[],
        ),
    ]


@pytest.mark.anyio
async def test_enrich_candidates_deepseek_openai_compatible():
    cands = _make_candidates()
    mock_payload = {
        "choices": [
            {
                "message": {
                    "content": json.dumps(
                        {
                            "items": [
                                {
                                    "word": "subtle",
                                    "ipa": "/ˈsʌtəl/",
                                    "pos": "adj.",
                                    "category": "standard",
                                    "cefr_level": "B2",
                                    "meaning_zh": "微妙的",
                                    "memory_tip_zh": "字母 b 不发音",
                                    "sample_tweet_zh": "起初差别很微妙。",
                                },
                                {
                                    "word": "karpathy",
                                    "ipa": "",
                                    "pos": "n.",
                                    "category": "ignore",
                                    "cefr_level": "C1",
                                    "meaning_zh": "人名",
                                    "memory_tip_zh": "",
                                    "sample_tweet_zh": "",
                                },
                            ]
                        },
                        ensure_ascii=False,
                    )
                }
            }
        ]
    }

    with respx.mock:
        route = respx.post("https://api.deepseek.com/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=mock_payload)
        )
        cards, ignored = await enrich_candidates(
            cands,
            override=LLMOverrideConfig(
                provider="openai_compatible",
                api_key="test-key",
                base_url="https://api.deepseek.com/v1",
                model="deepseek-chat",
            ),
        )

    assert route.called
    assert len(cards) == 1
    assert cards[0].word == "subtle"
    assert cards[0].meaning_zh == "微妙的"
    assert cards[0].author_handle == "karpathy"
    assert ignored == ["karpathy"]


@pytest.mark.anyio
async def test_enrich_candidates_gemini():
    cands = _make_candidates()[:1]
    mock_payload = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "text": json.dumps(
                                {
                                    "items": [
                                        {
                                            "word": "subtle",
                                            "ipa": "/ˈsʌtəl/",
                                            "pos": "adj.",
                                            "category": "standard",
                                            "cefr_level": "B2",
                                            "meaning_zh": "微妙的",
                                            "memory_tip_zh": "b 不发音",
                                            "sample_tweet_zh": "起初差别很微妙。",
                                        }
                                    ]
                                },
                                ensure_ascii=False,
                            )
                        }
                    ]
                }
            }
        ]
    }

    with respx.mock:
        route = respx.post(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        ).mock(return_value=httpx.Response(200, json=mock_payload))
        cards, ignored = await enrich_candidates(
            cands,
            override=LLMOverrideConfig(
                provider="gemini",
                api_key="gem-key",
                model="gemini-2.5-flash",
            ),
        )

    assert route.called
    assert len(cards) == 1
    assert ignored == []


@pytest.mark.anyio
async def test_enrich_candidates_local_self_hosted_deepseek_without_api_key_and_think_tags():
    cands = _make_candidates()[:1]
    think_wrapped_content = (
        "<think>\nLet's reason about subtle with {example} json format.\n</think>\n"
        "```json\n"
        + json.dumps(
            {
                "items": [
                    {
                        "word": "subtle",
                        "ipa": "/ˈsʌtəl/",
                        "pos": "adj.",
                        "category": "standard",
                        "cefr_level": "B2",
                        "meaning_zh": "微妙的",
                        "memory_tip_zh": "字母 b 不发音",
                        "sample_tweet_zh": "起初差别很微妙。",
                    }
                ]
            },
            ensure_ascii=False,
        )
        + "\n```"
    )
    mock_payload = {"choices": [{"message": {"content": think_wrapped_content}}]}

    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        assert "Authorization" not in request.headers
        body = json.loads(request.content.decode("utf-8"))
        if call_count == 1:
            assert body.get("response_format") == {"type": "json_object"}
            return httpx.Response(400, json={"error": "response_format unsupported"})
        assert "response_format" not in body
        return httpx.Response(200, json=mock_payload)

    with respx.mock:
        route = respx.post("http://localhost:11434/v1/chat/completions").mock(side_effect=handler)
        cards, ignored = await enrich_candidates(
            cands,
            override=LLMOverrideConfig(
                provider="openai_compatible",
                api_key=None,
                base_url="http://localhost:11434/v1",
                model="deepseek-r1:7b",
            ),
        )

    assert route.called
    assert call_count == 2
    assert len(cards) == 1
    assert cards[0].word == "subtle"
    assert cards[0].meaning_zh == "微妙的"
    assert ignored == []

