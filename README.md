# LearnEnglishFromX — 从真实 X (Twitter) 推文语境高效学英语

专为英语起步与四级以下（`< CET-4`）学习者打造的个人词汇学习工作台：直接采集你感兴趣的 **AI、科技、游戏、音乐、生活** 类 X 英文推文，通过本地零成本词频筛选保留“最值得学的高性价比日常与网感词汇”，用 **DeepSeek / Gemini** 生成贴合原推语境的中文释义卡片，并在浏览器/手机端使用 **FSRS 间隔重复记忆曲线**复习，支持 **Google Drive 跨设备同步**与 **Anki `.apkg` 一键导出**。

---

## 核心特性

1. **Chrome 插件零费用采集（含防风控温和自动滚动）**
   - 直接在你已登录的 `x.com` 页面工作，不走第三方付费爬虫 API。
   - **被动采集模式**：开启后正常刷 Timeline、List 或书签即自动收集英文推文。
   - **温和自动滚动**：设定目标条数（如 30 条），每次随机停顿 `1.8s ~ 3.4s` 模拟真人浏览并显示右下角进度浮窗。
   - **内置 14 位非政治入门精选博主**：涵盖 AI（Karpathy、Ethan Mollick、Simon Willison）、科技（MKBHD、WIRED）、游戏（PC Gamer、IGN、Geoff Keighley）、音乐（Pitchfork、Spotify、Genius）和生活（James Clear、Merriam-Webster、Bon Appétit）。
2. **分层词频过滤（针对四级以下学习者优化）**
   - 内置 `strict_1200` / `basic_2000`（默认）/ `cet4_3500` 三档基础核心词过滤表，并集成词形还原（`simplemma` + `lemminflect`）、68 组高频短语动词匹配（如 `figure out` / `hold up` / `scale down`）与 X 网感俚语词库（`ngl` / `tbh` / `nerf` / `buff` / `slop` 等）。
3. **DeepSeek / Gemini 双模语境词卡生成**
   - 默认预置 **DeepSeek**（`https://api.deepseek.com/v1` + `deepseek-chat`）兼顾中文翻译地道与极低成本，同时完整支持 **Google Gemini API**（`gemini-2.5-flash`）及任意 OpenAI 兼容端点。
4. **类 Anki FSRS 记忆曲线 + Google Drive 云同步 + `.apkg` / Obsidian 导出**
   - 前端基于 `ts-fsrs` 实现 **忘记 / 困难 / 记得 / 很简单** 4 档间隔预览、快捷键（`Space` 翻卡、`1-4` 评分、`R` 朗读发音）与原推词高亮。
   - 数据默认保存在浏览器本地 IndexedDB（离线立即可用），绑定个人 Google Cloud OAuth Client ID 后即可同步至您的 Google Drive `LearnEnglishFromX_Data/vocab_state.json`。
   - 支持一键导出 `.apkg` 牌组导入 **AnkiDroid / Anki**，或连接 **Obsidian** 知识库（直写本机 Vault / 导出 `.zip`，附带 `[[@博主]]` 双链、Dataview 属性与 Spaced Repetition 闪卡）。

---

## 目录结构

```text
learn-english-from-x/
├── backend/                        # FastAPI + 本地 NLP 词频筛选 + DeepSeek/Gemini + Anki/Obsidian 导出
│   ├── app/
│   │   ├── data/                   # 基础 3500 词阶梯表、X 俚语种子词库、14 位入门博主、示例推文与词卡
│   │   ├── export/
│   │   │   ├── anki_exporter.py    # Anki .apkg 牌组打包器
│   │   │   └── obsidian_exporter.py# Obsidian Vault 直写、Markdown ZIP 与 Spaced Repetition 兼容导出
│   │   ├── llm/enricher.py         # DeepSeek / OpenAI 兼容 & Gemini 批量词卡解析
│   │   ├── nlp/extractor.py        # 离线词形还原、短语动词识别与 Zipf 甜点评分
│   │   ├── storage/local_store.py  # 本地 JSON 推文与状态存储
│   │   ├── config.py               # 服务与模型默认配置
│   │   ├── main.py                 # FastAPI 路由入口
│   │   └── models.py               # Pydantic 数据契约
│   ├── tests/                      # 后端 pytest 单元测试（含 Obsidian 导出测试）
│   ├── .env.example                # DeepSeek / Gemini / Obsidian 环境变量模板
│   └── pyproject.toml              # Python 依赖清单（uv）
├── chrome-extension/               # Chrome MV3 扩展：被动采集、温和防风控自动滚动、推荐博主目录
│   ├── icons/                      # 扩展图标 (16/48/128px)
│   ├── background.js               # 推文去重入队、推送后端与 JSON 导出
│   ├── content.js                  # x.com DOM 监听与随机停顿滚动采集
│   ├── manifest.json               # MV3 清单
│   ├── popup.html / popup.css / popup.js
│   └── starter_creators.js         # 14 位非政治入门博主快速导航
├── web/                            # React + TypeScript + ts-fsrs + Google Drive 同步 PWA 前端
│   ├── public/                     # PWA manifest 与图标
│   └── src/
│       ├── __tests__/              # Vitest + Testing Library 单元测试
│       ├── components/             # StudyView / IngestConsole / StatsAndExport / SettingsModal
│       ├── data/starterCreators.ts # 离线示范推文与博主兜底数据
│       ├── services/               # srs.ts / googleDrive.ts / localDb.ts / api.ts
│       ├── types/vocab.ts          # 前后端一致类型定义
│       └── utils/textHelpers.ts    # 原推词高亮与 Web Speech 朗读
├── .gitignore                      # 忽略 .env / .venv / node_modules / 运行时数据
├── start.sh                        # 一键启动前后端服务脚本
└── README.md
```

---

## 快速开始

### 1. 克隆并启动本地应用

确保本机已安装 **Python 3.11+**（建议同时安装 `uv`）与 **Node.js 18+**：

```bash
git clone https://github.com/qq270764374/learn-english-from-x.git
cd learn-english-from-x
chmod +x start.sh
./start.sh
```

`start.sh` 会自动安装前后端所需依赖并启动服务，随后在浏览器访问：**http://localhost:5173**。  
进入「今日复习」页面后，可点击 **「一键加载 7 张示例词卡」** 零配置直接体验 FSRS 记忆卡片与语音朗读。

### 2. 安装 Chrome 采集插件

1. 打开 Chrome 浏览器地址栏输入 `chrome://extensions/`。
2. 打开右上角 **开发者模式（Developer mode）**。
3. 点击 **加载已解压的扩展程序（Load unpacked）**，选择本项目的 `chrome-extension/` 文件夹。
4. 点击浏览器右上角插件图标，切到 **「推荐博主」** 标签页打开任意推荐账号（或在 X.com 中将其整理为私密 List），开启采集开关或点击 **「开始滚动」**，采集完成后点 **「推送到本地学习工具」**（或 **「导出 JSON」** 拖入网页导入）。

### 3. 配置大模型 API Key 或本地自建模型（生成新词卡时使用）

点击网页右上角 **设置按钮**（或编辑 `backend/.env`）：
- **DeepSeek 云端（默认推荐）**：接口地址 `https://api.deepseek.com/v1`，模型 `deepseek-chat`，填入您的 API Key。
- **本地自建 DeepSeek（Ollama / vLLM / LM Studio / SGLang，免 API Key）**：
  - 例如 Ollama：点击设置里的 **「本地自建 DeepSeek (Ollama)」** 预设，接口地址 `http://localhost:11434/v1`、模型 `deepseek-r1:7b`（或您本地拉取的模型名如 `deepseek-v3` / `deepseek-r1:14b`），**API Key 留空即可**。
  - vLLM / LM Studio 同理，分别填入 `http://127.0.0.1:8000/v1` 或 `http://127.0.0.1:1234/v1` 与对应模型名即可（系统会自动绕过代理、剥离 `<think>` 推理标签并兼容本地 OpenAI 接口）。
- **Google Gemini**：切换协议为 `Google Gemini API`，模型 `gemini-2.5-flash`，填入 Gemini API Key。

---

## 5 步配置个人免费 Google Drive 同步（可选）

如果您希望在电脑与手机浏览器之间同步学习进度：

1. 前往 [Google Cloud Console](https://console.cloud.google.com/) 创建一个免费项目（无需绑定信用卡）。
2. 在左侧「API 和服务 → 启用 API 和服务」中搜索并启用 **Google Drive API**。
3. 进入 **「OAuth 同意屏幕」**：选择 **External（外部）**，填写应用名称（如 `LearnEnglishFromX`），并在 **测试用户（Test users）** 中添加您自己的 Gmail 邮箱。
4. 进入 **「凭据 → 创建凭据 → OAuth 客户端 ID」**：应用类型选择 **Web 应用**，在 **已获授权的 JavaScript 来源** 中添加：
   - `http://localhost:5173`
   - `http://127.0.0.1:5173`
5. 复制生成的 `*.apps.googleusercontent.com` Client ID，粘贴到本应用右上角 **设置 → Google Cloud OAuth Client ID** 中，即可点击顶部 **「同步 Drive」** 跨设备双向合并进度。

---

## 导出到 Android AnkiDroid / 桌面 Anki

1. 在网页顶部切换到 **「词库与同步」**。
2. 点击 **「导出 .apkg」** 下载词库牌组文件。
3. 将 `.apkg` 发送到手机，用 **AnkiDroid** 打开该文件即可直接导入，卡片正面高亮原推文与发音，背面展示精准语境释义与原推翻译。

---

## 连接 Obsidian 知识库（笔记沉淀 + Spaced Repetition 闪卡）

支持把 X 推文生词同步至您的 **Obsidian Vault**：一词一 `.md` 笔记 + 自动生成 `_X-Vocab 词库总览.md` 索引页。

### 两种同步导出方式
1. **一键直写本机 Obsidian Vault（推荐桌面端）**：
   - 在右上角 **设置 → Obsidian 知识库连接** 中填写您的本机仓库路径（如 `~/Documents/MyVault` 或 `D:\Notes\English`）与子目录名（默认 `X-Vocab`）；亦可勾选 **“AI 生成新词卡后自动同步写入 Vault”**。
   - 前往 **「词库与同步」** 点击 **「一键写入 Obsidian Vault」**（后端接口 `POST /api/export/obsidian-sync`），系统会安全保留每个文件里 `<!-- lex-user-notes -->` 下方的个人笔记以及 Spaced Repetition 插件写回的 `<!--SR:...-->` 复习调度注释。
2. **打包导出 Markdown `.zip` / 离线 `.md`（适配移动 Vault 或纯前端模式）**：
   - 在 **「词库与同步」** 点击 **「导出 Markdown (.zip)」**（后端接口 `POST /api/export/obsidian-zip`），解压放入任意 Obsidian 仓库即可（后端未启动时自动降级为单文件 `.md` 离线下载）。

### 推荐配合插件（可选）
- **Obsidian Spaced Repetition**：勾选 `#flashcards/x-vocab` 开关后，每张词卡自动附带多行问答块（正面展示单词/音标与 `==高亮原推文==`，`?` 下方展示中文释义与记忆技巧），可直接用社区 Spaced Repetition 插件在 Obsidian 内复习。
- **Dataview**：每张笔记均内置标准 YAML Frontmatter（`word` / `ipa` / `pos` / `category` / `cefr` / `author: "[[@handle]]"` / `source_url` / `fsrs_state` / `reps` / `next_review` / `created`），`_X-Vocab 词库总览.md` 已内置开箱即用的 Dataview 动态表格查询与 `[[@博主]]` 关系图谱双链。

---

## 测试验证命令

- **后端单元测试**：
  ```bash
  cd backend && uv run pytest -v
  ```
- **前端测试、代码检查与生产构建**：
  ```bash
  cd web && npm test && npm run lint && npm run build
  ```
