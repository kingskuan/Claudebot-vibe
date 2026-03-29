# Claude 大神 Telegram Bot

A personal AI assistant powered by Claude, running on Telegram. Features a 4-layer memory system, auto-learning, web search, image recognition, and a full bounty automation pipeline. Gets smarter the more you use it — memory persists across restarts.

Built by [@0xKingsKuan](https://x.com/0xKingsKuan)

一个接入 Claude AI 的 Telegram 私人助理。带四层记忆系统、自动学习、网络搜索、图片识别和全自动赏金 Pipeline。越用越聪明，重启不丢失记忆。

-----

## One-Click Deploy / 一键部署

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/deploy/hi0iqD?referralCode=ztkI8u)

Click the button → Fill in your variables → Done 🚀

点击按钮 → 填入你的变量 → 部署完成 🚀

-----

## Features / 功能

- **Smart Conversation** — Fully powered by Claude AI, answers anything
- **Auto-Learning Memory** — Updates your memory profile after every chat, learns your preferences over time
- **4-Layer Memory System:**
  - `soul.md` — Who you are (permanent)
  - `projects.md` — Your projects (permanent)
  - `tasks.md` — Current tasks (auto-updated)
  - `notes.md` — Important notes (auto-updated)
  - Vector memory — Semantic search over past conversations
  - Conversation summaries — Auto-compresses long chats
- **Smart Web Search** — Claude decides when to search, skips short messages automatically
- **Image Recognition** — Send any image for instant analysis
- **PDF Support** — Send a PDF and get a summary or targeted analysis
- **File Analysis** — `.log` `.txt` `.csv` `.json` `.py` and more
- **Web Summarization** — Send any URL to get an instant summary
- **GitHub Raw Auto-Convert** — Paste a GitHub file link, Bot fetches the raw code
- **Decision Learning** — Say “do” or “skip” on bounties, Bot learns your preferences automatically
- **Streaming Replies** — Text appears as it’s generated, just like ChatGPT
- **Long Code as File** — Code that’s too long is sent as a downloadable file
- **Multilingual** — Replies in whatever language you write in
- **24/7 Cloud** — Always on, never sleeps

-----

- **智能对话** — Claude AI 驱动，回答任何问题
- **自动学习记忆** — 每次对话后自动更新记忆档案，越用越了解你
- **四层记忆架构** — soul / projects / tasks / notes + 向量记忆 + 对话摘要
- **智能网络搜索** — 自动判断是否需要搜索，短消息直接跳过
- **图片识别** — 发图片直接分析
- **PDF 支持** — 发 PDF 直接总结分析
- **文件分析** — .log .txt .csv .json .py 等格式
- **网页总结** — 发链接直接总结内容
- **GitHub 自动转换** — blob 链接自动转 raw，直接抓取代码
- **决策学习** — 对赏金说”做”或”跳过”，Bot 自动记住偏好，推荐越来越准
- **Streaming 回复** — 字一个个打出来，不用等
- **长代码发文件** — 超长代码自动发 .txt 文件
- **多语言** — 你说什么语言它就回什么语言

-----

## What You Need / 需要准备

|Service              |Purpose            |Cost             |
|---------------------|-------------------|-----------------|
|Telegram @BotFather  |Bot Token          |Free             |
|console.anthropic.com|Claude API Key     |Pay as you go    |
|supabase.com         |Database for memory|Free             |
|tavily.com           |Web search         |Free (1000/month)|
|voyageai.com         |Vector memory      |Free             |

-----

## Quick Deploy / 快速部署

### Step 1 — Get Your API Keys / 第一步 — 获取 API Keys

**Telegram Bot Token**

1. Search @BotFather → /newbot
1. Choose a name and username (username must end in `bot`)
1. Copy the token

**Anthropic API Key**

1. console.anthropic.com → API Keys → Create Key

**Supabase**

1. Sign up at supabase.com, create a new project
1. SQL Editor → New query → paste the following → Run:

```sql
create extension if not exists vector;

create table if not exists conversations (
  id serial primary key,
  user_id bigint not null,
  role text not null,
  content text not null,
  created_at timestamp default now()
);

create table if not exists user_docs (
  id serial primary key,
  user_id bigint not null,
  doc_type text not null,
  content text not null,
  updated_at timestamp default now(),
  unique(user_id, doc_type)
);

create table if not exists conversation_summaries (
  id serial primary key,
  user_id bigint not null,
  summary text not null,
  message_count int default 0,
  created_at timestamp default now()
);

create table if not exists memories (
  id serial primary key,
  user_id bigint not null,
  content text not null,
  memory_type text default 'general',
  embedding vector(1024),
  created_at timestamp default now()
);
```

1. Settings → API → Copy:
- Project URL → `SUPABASE_URL`
- `service_role` key (important: NOT the anon key) → `SUPABASE_KEY`
1. **Disable RLS** on all 4 tables: Table Editor → each table → RLS → Disable

**Tavily (optional — web search)**

1. tavily.com → Sign up → Copy API Key

**Voyage (optional — vector memory)**

1. voyageai.com → Sign up → Copy API Key

-----

### Step 2 — Deploy / 第二步 — 部署

Click the Deploy on Railway button above and fill in these variables:

|Variable         |Description                                        |Required                    |
|-----------------|---------------------------------------------------|----------------------------|
|BOT_TOKEN        |Telegram Bot Token                                 |✅ Required                  |
|ANTHROPIC_API_KEY|Anthropic API Key                                  |✅ Required                  |
|SUPABASE_URL     |Supabase Project URL                               |Strongly recommended        |
|SUPABASE_KEY     |Supabase **service_role** key                      |Strongly recommended        |
|TAVILY_API_KEY   |Tavily API Key                                     |Optional                    |
|VOYAGE_API_KEY   |Voyage API Key                                     |Optional                    |
|GITHUB_TOKEN     |GitHub Personal Access Token                       |For /vibe                   |
|RAILWAY_API_TOKEN|Railway API Token (Account Settings → Tokens)      |For /deploy                 |
|PIPELINE_ENABLED |Set to `true` to enable bounty pipeline            |Optional                    |
|PIPELINE_OWNER_ID|Your Telegram user ID (get it from /pipelinestatus)|Required if pipeline enabled|

⚠️ `SUPABASE_KEY` must be the `service_role` key, not the `anon` public key.

-----

### Step 3 — Set Webhook / 第三步 — 设置 Webhook

After deployment:

1. Railway → Settings → Networking → Generate Domain
1. Copy the URL (e.g. `https://xxx.railway.app`)
1. Railway → Variables → Add `WEBHOOK_URL = your URL` (no trailing slash)
1. Railway redeploys automatically

-----

### Step 4 — Start Using / 第四步 — 开始使用

Search your Bot → Send `/start`

Recommended first steps:

```
/setsoul Your name and background
/setprojects Your current projects
/settasks Your most important tasks right now
```

-----

## Commands / 命令列表

**Memory / 记忆**

- `/memory` — Full memory overview
- `/soul` — View soul.md
- `/projects` — View projects
- `/tasks` — View tasks
- `/notes` — View notes
- `/summaries` — View conversation summaries

**Update Memory / 更新记忆**

- `/setsoul [content]`
- `/setprojects [content]`
- `/settasks [content]`
- `/note [content]` — Add a note
- `/clearnotes` — Clear all notes
- `/summarize` — Force compress conversation

**Build & Deploy / 构建和部署**

- `/vibe` — Start AI-assisted project builder (generates code + pushes to GitHub)
- `/vibestop` — Exit Vibe Coding mode
- `/deploy [GitHub link]` — Auto-deploy to Railway (can include env vars)

**Analytics / 分析**

- `/weekly` — This week’s activity summary and bounty decision log

**Management / 管理**

- `/forget` — Clear conversation history (keeps memory profiles)
- `/reset` — Clear everything
- `/help` — All commands

-----

## Memory System / 记忆系统

The Bot has 4 layers of memory, all automatic:

1. `soul.md` + `projects.md` — Permanent identity layer
1. `tasks.md` + `notes.md` — Dynamic knowledge, auto-updated
1. Vector memory — Semantic search, pulls only the most relevant memories
1. Conversation summaries — Auto-compressed every 20 messages

After every conversation, the Bot analyzes and extracts important info into your profile. The more you use it, the smarter it gets.

-----

四层记忆，全部自动运作：

1. soul.md + projects.md（永久身份）
1. tasks.md + notes.md（动态知识，自动更新）
1. 向量记忆（语义搜索，只调取最相关的记忆）
1. 对话摘要（每 20 条自动压缩）

每次对话后自动分析，提取重要信息写入档案。越用越聪明，越用越了解你。

-----

## Troubleshooting / 常见问题

**Bot not responding** — Check BOT_TOKEN, ANTHROPIC_API_KEY, WEBHOOK_URL are all set

**Bot 没反应** — 检查 BOT_TOKEN、ANTHROPIC_API_KEY、WEBHOOK_URL 是否都填了

**“Something went wrong”** — Check ANTHROPIC_API_KEY is correct and account has credits

**Memory shows “Not set yet”** — SUPABASE_KEY must be service_role key, not anon key. Also check RLS is disabled on all tables.

**记忆显示 Not set yet** — SUPABASE_KEY 必须用 service_role key，同时确认四张表的 RLS 已关闭

**Search not working** — Confirm TAVILY_API_KEY is correct

**Deploy failed** — Make sure there’s no extra `index.js` in the repo

-----

## File Structure / 文件结构

```
Claudebot-vibe/
├── bot.cjs          Main program / 主程序
├── package.json     Dependencies / 依赖配置
├── railway.json     Railway config / 部署配置
├── .gitignore       Ignore sensitive files / 忽略敏感文件
└── README.md        This file / 说明文档
```

-----

## License

MIT — Use, modify, and share freely.

MIT — 随意使用、修改、分享。

如果这个项目对你有帮助，欢迎 Star ⭐ 和 Fork！

If this helped you, a Star ⭐ and Fork are appreciated!
