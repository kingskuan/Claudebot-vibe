# Claude 大神 Telegram Bot

一个接入 Claude AI 的 Telegram 私人助理。带四层记忆系统、自动学习、网络搜索、图片识别。越用越聪明，重启不丢失记忆。

Built by [@0xKingsKuan](https://x.com/0xKingsKuan)

-----

## 一键部署

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/deploy/hi0iqD?referralCode=ztkI8u)

点击按钮 → 填入你的变量 → 部署完成 🚀

需要准备的变量见下方表格。

-----

## 功能

- 智能对话 - 全 Claude AI 驱动，回答任何问题
- 自动学习记忆 - 每次对话后自动更新记忆档案，越用越了解你
- 四层记忆架构:
  - soul.md - 你是谁（永久）
  - projects.md - 你的项目（永久）
  - tasks.md - 当前任务（自动更新）
  - notes.md - 重要笔记（自动更新）
  - 向量记忆 - 语义搜索历史信息
  - 对话摘要 - 自动压缩长对话
- 智能网络搜索 - Claude 自动判断是否需要搜索最新资讯
- 图片识别 - 发图片直接分析
- PDF 支持 - 发 PDF 文件直接分析/总结，可加说明如”找合同关键条款”
- 长内容输出 - 不会中途停止
- 多语言 - 你说什么语言它就回什么语言
- 24/7 云端运行

-----

## 需要准备

|服务                   |用途            |费用         |
|---------------------|--------------|-----------|
|Telegram @BotFather  |Bot Token     |免费         |
|console.anthropic.com|Claude API Key|需充值        |
|supabase.com         |数据库存记忆        |免费         |
|tavily.com           |网络搜索          |免费（每月1000次）|
|voyageai.com         |向量记忆          |免费         |

-----

## 快速部署（推荐）

### 第一步 - 获取所有 API Keys

**Telegram Bot Token**

1. 搜索 @BotFather -> /newbot
1. 取名字和用户名（用户名以 bot 结尾）
1. 复制 Token

**Anthropic API Key**

1. console.anthropic.com -> API Keys -> Create Key

**Supabase**

1. supabase.com 注册，新建项目
1. SQL Editor -> New query -> 粘贴以下内容 -> Run：

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

1. Settings -> API -> 复制：
- Project URL -> SUPABASE_URL
- service_role key（重要：不是 anon key）-> SUPABASE_KEY

**Tavily（可选，网络搜索）**

1. tavily.com 注册 -> 复制 API Key

**Voyage（可选，向量记忆）**

1. voyageai.com 注册 -> 复制 API Key

-----

### 第二步 - 一键部署

点击上方 Deploy on Railway 按钮，填入以下变量：

|变量名              |说明                                          |必填              |
|-----------------|--------------------------------------------|----------------|
|BOT_TOKEN        |Telegram Bot Token                          |必填              |
|ANTHROPIC_API_KEY|Anthropic API Key                           |必填              |
|SUPABASE_URL     |Supabase Project URL                        |强烈建议            |
|SUPABASE_KEY     |Supabase service_role key                   |强烈建议            |
|TAVILY_API_KEY   |Tavily API Key                              |可选              |
|VOYAGE_API_KEY   |Voyage API Key                              |可选              |
|GITHUB_TOKEN     |GitHub Personal Access Token                |Vibe Coding 功能需要|
|RAILWAY_API_TOKEN|Railway API Token（Account Settings → Tokens）|自动部署功能需要        |

重要：SUPABASE_KEY 必须用 service_role key，不能用 anon public key。

-----

### 第三步 - 设置 Webhook

部署完成后：

1. Railway -> Settings -> Networking -> Generate Domain
1. 复制网址（https://xxx.railway.app）
1. Railway -> Variables -> 添加 WEBHOOK_URL = 你的网址（结尾不要加 /）
1. Railway 自动重新部署

-----

### 第四步 - 开始使用

搜索你的 Bot -> 发 /start

建议第一件事：

```
/setsoul 你的名字和背景
/setprojects 你的项目列表
/settasks 当前最重要的任务
```

-----

## 命令列表

查看记忆：

- /memory - 完整记忆总览
- /soul - 查看 soul.md
- /projects - 查看项目
- /tasks - 查看任务
- /notes - 查看笔记
- /summaries - 查看对话摘要

手动更新（Bot 会自动学习，通常不需要）：

- /setsoul [内容]
- /setprojects [内容]
- /settasks [内容]
- /note [内容] - 添加笔记
- /clearnotes - 清空笔记
- /summarize - 立即压缩摘要

Vibe Coding：

- /vibe - 启动 AI 辅助建项目（自动生成代码 + 推送 GitHub）
- /vibestop - 退出 Vibe Coding 模式
- /deploy [GitHub链接] - 自动部署到 Railway（可附带环境变量）

管理：

- /forget - 清除对话历史（保留记忆档案）
- /reset - 清除所有内容
- /help - 查看所有命令

-----

## 记忆系统

Bot 有四层记忆，全部自动运作：

- 第一层：soul.md + projects.md（永久身份）
- 第二层：tasks.md + notes.md（动态知识，自动更新）
- 第三层：向量记忆（语义搜索，只调取最相关的记忆）
- 第四层：对话摘要（每 20 条自动压缩）

每次对话后自动分析，提取重要信息写入档案。越用越聪明，越用越了解你。

-----

## 常见问题

Bot 没反应 - 检查 BOT_TOKEN、ANTHROPIC_API_KEY、WEBHOOK_URL 是否都填了

Something went wrong - 检查 ANTHROPIC_API_KEY 是否正确，账号是否有余额

记忆显示 Not set yet - SUPABASE_KEY 必须用 service_role key，不能用 anon key

搜索没用 - 确认 TAVILY_API_KEY 正确

部署失败 - 确认 repo 里没有多余的 index.js

-----

## 文件结构

```
Claudebot-vibe/
├── bot.cjs          主程序
├── package.json     依赖配置
├── railway.json     Railway 部署配置
├── .gitignore       忽略敏感文件
└── README.md        说明文档
```

-----

## License

MIT - 随意使用、修改、分享。

如果这个项目对你有帮助，欢迎 Star ⭐ 和 Fork！
