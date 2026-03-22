# Claude 大神 Telegram Bot

一个接入 Claude AI 的 Telegram 私人助理。会自动学习、记住你、越用越聪明。

Built by [@0xKingsKuan](https://x.com/0xKingsKuan)

-----

## 功能

- 智能对话 - 全 Claude AI 驱动，回答任何问题
- 自动学习记忆 - 每次对话后自动更新你的记忆档案，越用越了解你
- 三层记忆架构 - soul.md、projects.md、tasks.md、notes.md + 对话摘要
- 永久记忆 - 用 Supabase 存储，重启不丢失
- 网络搜索 - 接入 Tavily，实时搜索最新资讯
- 图片识别 - 发图片给它，它能看懂并分析
- 长内容输出 - 写文案、写脚本一次输出完，不会中断
- 多语言 - 你用什么语言说话，它就用什么语言回答
- 24/7 运行 - 部署在云端，随时可用

-----

## 记忆系统说明

Bot 有三层记忆，全部自动运作：

第一层 - 永久身份（不变）

- soul.md - 你是谁、你的背景、偏好、沟通风格
- projects.md - 你所有的项目

第二层 - 动态知识（自动更新）

- tasks.md - 当前任务和进度
- notes.md - 重要笔记和决定

第三层 - 对话摘要（自动压缩）

- 每 20 条对话自动压缩成摘要
- 保留最近 5 段摘要
- 每次对话带最近 15 条消息

每次对话结束后，Bot 会自动分析内容并更新对应的记忆档案，完全不需要手动操作。

-----

## 你需要准备的

- Telegram Bot Token（从 @BotFather 获取，免费）
- Anthropic API Key（从 console.anthropic.com 获取，需充值）
- GitHub 账号（免费）
- Railway 账号（免费，不需要信用卡）
- Supabase 账号（免费，存储记忆用）
- Tavily 账号（免费，网络搜索用）

-----

## 部署步骤

### 第一步 - 获取 Telegram Bot Token

1. 打开 Telegram，搜索 @BotFather
1. 发送 /newbot
1. 给 Bot 取名字和用户名（用户名必须以 bot 结尾）
1. 复制保存 Token

### 第二步 - 获取 Anthropic API Key

1. 打开 https://console.anthropic.com
1. 注册或登录
1. 左侧菜单点 API Keys -> Create Key
1. 复制保存

### 第三步 - 建 Supabase 数据库

1. 打开 https://supabase.com，注册并新建项目
1. 左边菜单点 SQL Editor -> New query
1. 粘贴以下 SQL，点 Run：

```sql
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

alter table public.conversations enable row level security;
alter table public.user_docs enable row level security;
alter table public.conversation_summaries enable row level security;
```

1. 看到 Success 后，左边菜单点 Settings -> API
1. 复制 Project URL 和 anon public key

### 第四步 - 获取 Tavily API Key

1. 打开 https://tavily.com，注册（免费，每月 1000 次）
1. 复制 API Key

### 第五步 - 部署到 Railway

1. 打开 https://railway.app，用 GitHub 账号登录
1. 点 New Project -> Deploy from GitHub repo
1. 选择这个 repo
1. Railway 自动开始构建

### 第六步 - 填入环境变量

Railway -> 你的项目 -> Variables，添加以下变量：

|变量名              |填什么                     |是否必填|
|-----------------|------------------------|----|
|BOT_TOKEN        |Telegram Bot Token      |必填  |
|ANTHROPIC_API_KEY|Anthropic API Key       |必填  |
|WEBHOOK_URL      |先留空，第七步填                |必填  |
|SUPABASE_URL     |Supabase Project URL    |强烈建议|
|SUPABASE_KEY     |Supabase anon public key|强烈建议|
|TAVILY_API_KEY   |Tavily API Key          |可选  |

没有 Supabase 也能跑，但记忆重启后会清空。没有 Tavily 则搜索功能关闭。

### 第七步 - 设置 Webhook

1. Railway -> Settings -> Networking -> Generate Domain
1. 复制生成的网址（格式：https://xxx.railway.app）
1. 回到 Variables，填入 WEBHOOK_URL（结尾不要加 /）
1. Railway 自动重新部署

### 第八步 - 测试

打开 Telegram，搜索你的 Bot，发送 /start，开始对话！

建议第一件事：告诉 Bot 你是谁，它会自动学习并记住：

```
我是 [你的名字]，[你的身份]。
在做 [你的项目]。
我喜欢 [你的偏好]。
```

-----

## Bot 命令

查看记忆：

- /memory - 完整记忆总览
- /soul - 查看 soul.md
- /projects - 查看项目列表
- /tasks - 查看当前任务
- /notes - 查看笔记
- /summaries - 查看对话摘要

手动更新（通常不需要，Bot 会自动学）：

- /setsoul [内容] - 手动更新 soul.md
- /setprojects [内容] - 手动更新项目
- /settasks [内容] - 手动更新任务
- /note [内容] - 手动添加笔记
- /clearnotes - 清空笔记
- /summarize - 立即压缩摘要

管理：

- /forget - 清除对话历史（保留记忆档案）
- /reset - 清除所有内容（完全重置）
- /help - 查看所有命令

-----

## 文件结构

```
telegram-claude-bot/
├── bot.cjs          主程序
├── package.json     依赖配置
├── railway.json     Railway 部署配置
├── .gitignore       忽略敏感文件
└── README.md        说明文档
```

-----

## 常见问题

Bot 没反应 - 检查 Railway Logs，确认三个必填变量都填了

Something went wrong - 检查 ANTHROPIC_API_KEY 是否正确，账号是否有余额

记忆没有保存 - 确认 Supabase 三张表都建好了，URL 和 KEY 填对了

搜索没有用 - 确认 TAVILY_API_KEY 填了，Tavily 账号有剩余额度

部署失败 - 确认 repo 里有 bot.cjs 和 package.json，没有多余的 index.js

-----

## 想改 Bot 的性格？

打开 bot.cjs，找到 SYSTEM_PROMPT 这段，改成你想要的人设。

-----

## License

MIT - 随意使用、修改、分享。

-----

如果这个项目对你有帮助，欢迎 Star 和 Fork！
