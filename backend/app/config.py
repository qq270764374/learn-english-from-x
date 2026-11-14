from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Default to DeepSeek (OpenAI-compatible) for high cost-effectiveness; Gemini also supported.
    llm_provider: str = "openai_compatible"  # "openai_compatible" | "gemini"
    llm_api_key: str = ""
    llm_base_url: str = "https://api.deepseek.com/v1"
    llm_model: str = "deepseek-chat"

    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"

    # Extraction defaults: strict_1200 | basic_2000 | cet4_3500 | cet6_5500 | ielts_8000 | advanced_12000 | custom
    default_filter_tier: str = "basic_2000"
    zipf_min: float = 2.4
    zipf_max: float = 5.6

    # Optional Obsidian integration defaults
    obsidian_vault_dir: str = ""
    obsidian_subfolder: str = "X-Vocab"
    obsidian_rest_url: str = ""
    obsidian_rest_api_key: str = ""

    data_dir: Path = Path(__file__).resolve().parent.parent / "data"
    host: str = "127.0.0.1"
    port: int = 8765


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
