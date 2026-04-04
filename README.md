# 🤖 Claude 大神 Bot

A personal AI assistant powered by Claude, running on Telegram. Features a 4-layer memory system, bounty automation, code tools, web search and image recognition. Gets smarter the more you use it — memory persists across restarts.

一个接入 Claude AI 的 Telegram 私人助理。带四层记忆系统、赏金自动化、代码工具、网络搜索和图片识别。越用越聪明，重启不丢失记忆。

Built by [@0xKingsKuan](https://twitter.com/0xKingsKuan)

-----

## One-Click Deploy / 一键部署

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

Click the button → Fill in your variables → Done 🚀

点击按钮 → 填入你的变量 → 部署完成 🚀

-----

## Features / 功能

- **Smart Conversation** — Fully powered by Claude Opus, answers anything
- **Auto-Learning Memory** — 4-layer system: soul / projects / tasks / notes
- **Bounty Pipeline** — Auto-scans 6 platforms nightly, scores & executes bounties
- **Vibe Coding** — Send a bounty link → Claude builds the project → pushes to GitHub
- **Code Tools** — Fix, explain, review, test, version control
- **Image Generation** — `/imagine` powered by Gemini 2.5 Flash
- **File Analysis** — PDF, ZIP, DOCX, XLSX, images, code files, logs
- **Mixed File Upload** — Send photos + files together, analyzed as one
- **Crypto Prices** — `/price BTC` real-time via CoinGecko
- **Reminders** — `/remind 30m` timed alerts
- **Web Search** — Auto-searches when needed via Tavily
- **Daily Briefing** — BTC/ETH/SOL prices every morning at 7 AM

智能对话 · 自动记忆 · 赏金自动化 · Vibe 建项目 · 代码工具 · 图片生成 · 文件分析 · 混发支持 · 加密价格 · 定时提醒 · 网络搜索 · 每日简报

-----

## Commands / 命令

### 💬 Conversation / 对话

|Command                   |Description                    |
|--------------------------|-------------------------------|
|`/translate [lang] [text]`|Translate to any language / 翻译 |
|`/improve [text]`         |Polish & rewrite / 润色改写        |
|`/brainstorm [topic]`     |Structured brainstorming / 头脑风暴|
|`/summarize`              |Compress conversation / 压缩对话   |
|`/export`                 |Export chat history / 导出记录     |

### 💰 Crypto & Bounties / 加密与赏金

|Command               |Description                              |
|----------------------|-----------------------------------------|
|`/price [coin]`       |Real-time price / 实时价格                   |
|`/vibe`               |Build project + push GitHub / 建项目推 GitHub|
|`/deploy [GitHub URL]`|Deploy to Railway / 部署到 Railway          |
|`/pipeline`           |Manual bounty scan / 手动扫描赏金              |
|`/pipelinestatus`     |Pipeline status / Pipeline 状态            |

### 💻 Code / 代码

|Command       |Description               |
|--------------|--------------------------|
|`/fix`        |Modify code file / 修改代码文件 |
|`/explain`    |Explain code logic / 解释代码 |
|`/review`     |Code review + score / 审查评分|
|`/test`       |Generate test cases / 生成测试|
|`/save [name]`|Save version / 保存版本       |
|`/versions`   |List versions / 查看版本      |
|`/load [name]`|Load version / 加载版本       |

### 🎨 Creation / 创作

|Command          |Description                  |
|-----------------|-----------------------------|
|`/imagine [desc]`|AI image generation / AI 图片生成|
|`/weekly`        |Weekly summary / 本周总结        |

### 🧠 Memory / 记忆

|Command                     |Description                |
|----------------------------|---------------------------|
|`/memory`                   |Full memory overview / 记忆总览|
|`/soul` / `/setsoul`        |Personal profile / 个人档案    |
|`/projects` / `/setprojects`|Projects / 项目              |
|`/tasks` / `/settasks`      |Tasks / 任务                 |
|`/notes` / `/note [text]`   |Notes / 笔记                 |

### ⚙️ Utilities / 工具

|Command                     |Description                  |
|----------------------------|-----------------------------|
|`/remind [30m/2h/1d] [text]`|Timed reminder / 定时提醒        |
|`/template save/use/list`   |Prompt templates / 模板管理      |
|`/stats`                    |Token usage & cost / Token 统计|
|`/help`                     |Full command list / 完整命令     |
|`/forget` / `/reset`        |Clear history / 清除记录         |

-----

## Environment Variables / 环境变量

```env
BOT_TOKEN=
ANTHROPIC_API_KEY=
WEBHOOK_URL=https://your-app.up.railway.app
SUPABASE_URL=
SUPABASE_KEY=                # service_role key, disable RLS
TAVILY_API_KEY=
VOYAGE_API_KEY=
GITHUB_TOKEN=
RAILWAY_API_TOKEN=
GEMINI_API_KEY=

```

-----

## Tech Stack / 技术栈

|             |                      |
|-------------|----------------------|
|Bot          |Telegraf (Node.js)    |
|AI Main      |Claude Opus           |
|AI Fast      |Claude Haiku          |
|Image Gen    |Gemini 2.5 Flash Image|
|Database     |Supabase              |
|Search       |Tavily                |
|Vector Memory|Voyage AI             |
|Deploy       |Railway               |

-----

## Supabase Setup

Disable RLS on all tables. Run `supabase_setup.sql` to create:
`conversations` · `user_docs` · `conversation_summaries` · `memories` (vector 1024)

-----

*Claude 大神 v10.0 — Built with ❤️ by [@0xKingsKuan](https://twitter.com/0xKingsKuan)
