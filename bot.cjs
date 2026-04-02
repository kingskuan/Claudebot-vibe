const { Telegraf } = require("telegraf");
const Anthropic = require("@anthropic-ai/sdk").default;
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAIN_MODEL = process.env.AI_MODEL || "claude-opus-4-5";
const FAST_MODEL = process.env.AI_FAST_MODEL || "claude-haiku-4-5-20251001";
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !ANTHROPIC_API_KEY) {
  console.error("Missing BOT_TOKEN or ANTHROPIC_API_KEY");
  process.exit(1);
}


// Debug logging
console.log("=== ENV CHECK ===");
console.log("SUPABASE_URL:", SUPABASE_URL ? SUPABASE_URL.substring(0, 30) + "..." : "NOT SET");
console.log("SUPABASE_KEY:", SUPABASE_KEY ? SUPABASE_KEY.substring(0, 20) + "..." : "NOT SET");
console.log("Supabase client:", SUPABASE_URL && SUPABASE_KEY ? "WILL INIT" : "SKIPPED - missing vars");
console.log("================");
const bot = new Telegraf(BOT_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
if (supabase) {
  supabase.from("user_docs").select("count", { count: "exact", head: true }).then(function(res) {
    if (res.error) { console.error("Supabase TEST FAILED:", res.error.message); }
    else { console.log("Supabase TEST OK - connected successfully"); }
  }).catch(function(err) { console.error("Supabase ERROR:", err.message); });
} else { console.log("Supabase NOT initialized - check SUPABASE_URL and SUPABASE_KEY"); }

const memoryStore = new Map();
const docsStore = new Map();
const summaryStore = new Map();
const vectorStore = new Map();
const processingLock = new Map(); // prevent concurrent processing per user
const mediaGroupCache = new Map(); // cache files from same media group
const MEDIA_GROUP_WAIT_MS = 1500; // wait 1.5s to collect all files in group
const docsCache = new Map(); // cache docs for 60 seconds
const CACHE_TTL = 60000;

function getCachedDoc(userId, docType) {
  const key = userId + "_" + docType;
  const cached = docsCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.value;
  return null;
}

function setCachedDoc(userId, docType, value) {
  docsCache.set(userId + "_" + docType, { value, ts: Date.now() });
}

function invalidateDocCache(userId, docType) {
  docsCache.delete(userId + "_" + docType);
}

async function withLock(userId, fn) {
  if (processingLock.get(userId)) {
    return null; // skip if already processing
  }
  processingLock.set(userId, true);
  try {
    return await fn();
  } finally {
    processingLock.delete(userId);
  }
}

const RECENT_MESSAGES = 20; // keep last 20 messages max
const MAX_SUMMARIES = 8;
const SUMMARIZE_EVERY = 20;
const TOP_MEMORIES = 12;

// ── 对话记录 ──────────────────────────────────────────────────────────────────
async function getHistory(userId) {
  if (supabase) {
    try {
      const { data } = await supabase
        .from("conversations")
        .select("role, content")
        .eq("user_id", userId)
        .not("role", "eq", "stats")
        .order("created_at", { ascending: false })
        .limit(RECENT_MESSAGES);
      return (data || []).filter(function(m) { return m.role === "user" || m.role === "assistant"; }).reverse();
    } catch (err) { console.error("getHistory error:", err.message); }
  }
  const h = memoryStore.get(userId) || [];
  return h.slice(-RECENT_MESSAGES);
}

async function saveMessage(userId, role, content) {
  if (supabase) {
    try {
      const uid = parseInt(userId);
      await supabase.from("conversations").insert({ user_id: uid, role, content });
      // Auto-delete messages beyond RECENT_MESSAGES limit
      const { data: oldMsgs } = await supabase
        .from("conversations")
        .select("id")
        .eq("user_id", uid)
        .order("created_at", { ascending: false })
        .range(RECENT_MESSAGES, RECENT_MESSAGES + 100);
      if (oldMsgs && oldMsgs.length > 0) {
        const ids = oldMsgs.map(function(r) { return r.id; });
        await supabase.from("conversations").delete().in("id", ids);
      }
      return;
    } catch (err) { console.error("saveMessage error:", err.message); }
  }
  if (!memoryStore.has(userId)) memoryStore.set(userId, []);
  const h = memoryStore.get(userId);
  h.push({ role, content });
  if (h.length > RECENT_MESSAGES) h.splice(0, h.length - RECENT_MESSAGES);
}

async function countMessages(userId) {
  if (supabase) {
    try {
      const { count } = await supabase
        .from("conversations")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId);
      return count || 0;
    } catch (err) { return 0; }
  }
  return (memoryStore.get(userId) || []).length;
}

async function clearHistory(userId) {
  if (supabase) {
    try {
      await supabase.from("conversations").delete().eq("user_id", userId);
      await supabase.from("conversation_summaries").delete().eq("user_id", userId);
      await supabase.from("memories").delete().eq("user_id", userId);
      return;
    } catch (err) { console.error("clearHistory error:", err.message); }
  }
  memoryStore.delete(userId);
  summaryStore.delete(userId);
  vectorStore.delete(userId);
}

// ── .md 文件操作 ──────────────────────────────────────────────────────────────
async function getDoc(userId, docType) {
  const cached = getCachedDoc(userId, docType);
  if (cached !== null) return cached;
  if (supabase) {
    try {
      const uid = parseInt(userId);
      const { data, error } = await supabase
        .from("user_docs")
        .select("content", { count: "exact" })
        .eq("user_id", uid)
        .eq("doc_type", docType);
      if (error) { console.error("getDoc error:", docType, error.message); return null; }
      const value = (data && data.length > 0) ? data[0].content : null;
      setCachedDoc(userId, docType, value);
      return value;
    } catch (err) {
      console.error("getDoc exception:", err.message);
      return null;
    }
  }
  return docsStore.get(userId + "_" + docType) || null;
}

async function setDoc(userId, docType, content) {
  console.log("setDoc called - userId:", userId, "docType:", docType);
  if (supabase) {
    try {
      const result = await supabase.from("user_docs").upsert(
        { user_id: parseInt(userId), doc_type: docType, content: content, updated_at: new Date().toISOString() },
        { onConflict: "user_id,doc_type" }
      );
      if (result.error) {
        console.error("setDoc upsert error:", JSON.stringify(result.error));
      } else {
        console.log("setDoc SUCCESS - userId:", userId, "docType:", docType);
      invalidateDocCache(userId, docType);
      }
      return;
    } catch (err) { console.error("setDoc exception:", err.message); }
  } else {
    console.log("setDoc - supabase not available, using memory");
  }
  docsStore.set(userId + "_" + docType, content);
}

async function getAllDocs(userId) {
  const types = ["soul", "projects", "tasks", "notes"];
  const docs = {};
  for (const t of types) {
    const content = await getDoc(userId, t);
    if (content) docs[t] = content;
  }
  return docs;
}

// ── 摘要操作 ──────────────────────────────────────────────────────────────────
async function getSummaries(userId) {
  if (supabase) {
    try {
      const { data } = await supabase
        .from("conversation_summaries")
        .select("summary")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(MAX_SUMMARIES);
      return (data || []).map(function(d) { return d.summary; }).reverse();
    } catch (err) { return []; }
  }
  return summaryStore.get(userId) || [];
}

async function saveSummary(userId, summary) {
  if (supabase) {
    try {
      await supabase.from("conversation_summaries").insert({ user_id: userId, summary: summary });
      const { data } = await supabase
        .from("conversation_summaries")
        .select("id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (data && data.length > MAX_SUMMARIES) {
        const toDelete = data.slice(MAX_SUMMARIES).map(function(d) { return d.id; });
        await supabase.from("conversation_summaries").delete().in("id", toDelete);
      }
      return;
    } catch (err) { console.error("saveSummary error:", err.message); }
  }
  if (!summaryStore.has(userId)) summaryStore.set(userId, []);
  const s = summaryStore.get(userId);
  s.push(summary);
  if (s.length > MAX_SUMMARIES) s.splice(0, s.length - MAX_SUMMARIES);
}

// ── 向量记忆 ──────────────────────────────────────────────────────────────────
async function embedText(text) {
  if (!VOYAGE_API_KEY) return null;
  try {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + VOYAGE_API_KEY },
      body: JSON.stringify({ model: "voyage-3", input: [text] })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.data && data.data[0] ? data.data[0].embedding : null;
  } catch (err) { return null; }
}

async function saveMemory(userId, content, memoryType) {
  const embedding = await embedText(content);
  if (supabase && embedding) {
    try {
      await supabase.from("memories").insert({
        user_id: userId,
        content: content,
        memory_type: memoryType || "general",
        embedding: JSON.stringify(embedding)
      });
      return;
    } catch (err) { console.error("saveMemory error:", err.message); }
  }
  if (!vectorStore.has(userId)) vectorStore.set(userId, []);
  vectorStore.get(userId).push({ content, memoryType, embedding });
}

async function searchMemories(userId, query) {
  // 如果向量功能不可用，直接返回空（不崩溃）
  if (!VOYAGE_API_KEY) return [];
  const queryEmbedding = await embedText(query);
  if (!queryEmbedding) return [];

  if (supabase) {
    try {
      // 用原始 SQL 查询代替 RPC 函数，更可靠
      const embeddingStr = JSON.stringify(queryEmbedding);
      const { data, error } = await supabase
        .from("memories")
        .select("content")
        .eq("user_id", userId)
        .limit(TOP_MEMORIES);
      if (error) throw error;
      return (data || []).map(function(d) { return d.content; });
    } catch (err) {
      console.error("searchMemories error:", err.message);
      return [];
    }
  }

  // 内存 fallback
  const memories = vectorStore.get(userId) || [];
  if (memories.length === 0) return [];

  function cosine(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
  }

  return memories
    .filter(function(m) { return m.embedding; })
    .map(function(m) { return { content: m.content, score: cosine(queryEmbedding, m.embedding) }; })
    .sort(function(a, b) { return b.score - a.score; })
    .slice(0, TOP_MEMORIES)
    .map(function(m) { return m.content; });
}

// ── 自动学习 ──────────────────────────────────────────────────────────────────



// ── Token 使用追踪 ────────────────────────────────────────────────────────────
const tokenUsage = new Map(); // userId → { input, output, calls, saved }

function trackTokens(userId, inputTokens, outputTokens) {
  const existing = tokenUsage.get(userId) || { input: 0, output: 0, calls: 0 };
  tokenUsage.set(userId, {
    input: existing.input + (inputTokens || 0),
    output: existing.output + (outputTokens || 0),
    calls: existing.calls + 1
  });
}

// Auto-optimize based on usage patterns
function autoOptimize(userId) {
  const usage = tokenUsage.get(userId);
  if (!usage || usage.calls < 5) return null;
  const avgOutput = usage.output / usage.calls;
  const tips = [];
  if (avgOutput > 4000) tips.push("回复很长 — 对话中多用 /forget 清历史减少 context");
  if (usage.calls > 50) tips.push("使用频繁 — 代码任务尽量用 /fix 修改而非重新生成");
  if (usage.input / usage.calls > 5000) tips.push("system prompt 太大 — 发 /soul 检查是否过长");
  return tips.length > 0 ? tips : null;
}

function estimateCost(input, output) {
  // Claude Opus 4: $15/M input, $75/M output
  const inputCost = (input / 1000000) * 15;
  const outputCost = (output / 1000000) * 75;
  return (inputCost + outputCost).toFixed(4);
}

// ── AutoCompact: 自动上下文压缩 ──────────────────────────────────────────────
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
const autoCompactFailures = new Map(); // userId → failure count

async function autoCompact(userId) {
  const failures = autoCompactFailures.get(userId) || 0;
  if (failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    console.log("autoCompact disabled for user " + userId + " after " + failures + " failures");
    return false;
  }

  try {
    const history = await getHistory(userId);
    if (history.length < 10) return false; // not enough to compact

    const totalChars = history.reduce(function(sum, m) { return sum + (m.content || "").length; }, 0);
    if (totalChars < 15000) return false; // not big enough to bother

    // Compress history into a structured summary
    const historyText = history.map(function(m) {
      return m.role.toUpperCase() + ": " + (m.content || "").substring(0, 500);
    }).join("\n");

    const res = await anthropic.messages.create({
      model: FAST_MODEL, max_tokens: 1000,
      messages: [{ role: "user", content: "Compress this conversation history into a concise summary that preserves:\n1. Key decisions made\n2. Code/projects discussed\n3. Tasks assigned\n4. Important facts\n\nHistory:\n" + historyText + "\n\nReturn a concise summary in Chinese (max 800 chars):" }]
    });

    const summary = (res.content[0] || {}).text || "";
    if (!summary || summary.length < 50) throw new Error("Empty summary");

    // Save as summary and clear old history
    await saveSummary(userId, "[AutoCompact] " + summary);
    await clearHistory(userId);

    autoCompactFailures.set(userId, 0); // reset failures
    console.log("autoCompact success for user " + userId + ": " + totalChars + " chars → " + summary.length + " chars");
    return true;

  } catch (err) {
    const newFailures = (autoCompactFailures.get(userId) || 0) + 1;
    autoCompactFailures.set(userId, newFailures);
    console.error("autoCompact failed (" + newFailures + "/" + MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES + "):", err.message);
    return false;
  }
}

// ── autoDream: 后台记忆整理系统 ────────────────────────────────────────────────
const autoDreamLastRun = new Map();

async function autoDream(userId) {
  const now = Date.now();
  const last = autoDreamLastRun.get(userId) || 0;
  if (now - last < 60 * 60 * 1000) return; // max once per hour
  autoDreamLastRun.set(userId, now);
  try {
    const docs = await getAllDocs(userId);
    if (!docs.notes && !docs.soul && !docs.projects) return;

    const combined = [
      docs.soul ? "SOUL:\n" + docs.soul : "",
      docs.projects ? "PROJECTS:\n" + docs.projects : "",
      docs.tasks ? "TASKS:\n" + docs.tasks : "",
      docs.notes ? "NOTES:\n" + docs.notes : ""
    ].filter(Boolean).join("\n\n");

    if (combined.length < 200) return; // Not enough to consolidate

    const res = await anthropic.messages.create({
      model: FAST_MODEL, max_tokens: 2000,
      messages: [{ role: "user", content: "Clean up and consolidate this user memory. Rules:\n1. Remove duplicates\n2. Remove contradictions (keep latest)\n3. Remove info that can be inferred (e.g. dont store 'user uses Railway' if already in soul)\n4. Keep ONLY facts, decisions, and preferences\n5. Be ruthlessly concise\n\nMemory:\n" + combined + "\n\nReturn ONLY the cleaned version in same format (SOUL:, PROJECTS:, TASKS:, NOTES: sections). If a section has nothing useful, return empty string for it." }]
    });

    const cleaned = (res.content[0] || {}).text || "";
    if (cleaned.length < 50) return;

    // Parse and save back
    const soulMatch = cleaned.match(/SOUL:\n([\s\S]*?)(?=\n(?:PROJECTS|TASKS|NOTES):|$)/);
    const projMatch = cleaned.match(/PROJECTS:\n([\s\S]*?)(?=\n(?:SOUL|TASKS|NOTES):|$)/);
    const taskMatch = cleaned.match(/TASKS:\n([\s\S]*?)(?=\n(?:SOUL|PROJECTS|NOTES):|$)/);
    const noteMatch = cleaned.match(/NOTES:\n([\s\S]*?)(?=\n(?:SOUL|PROJECTS|TASKS):|$)/);

    if (soulMatch && soulMatch[1].trim()) await setDoc(userId, "soul", soulMatch[1].trim());
    if (projMatch && projMatch[1].trim()) await setDoc(userId, "projects", projMatch[1].trim());
    if (taskMatch && taskMatch[1].trim()) await setDoc(userId, "tasks", taskMatch[1].trim());
    if (noteMatch && noteMatch[1].trim()) await setDoc(userId, "notes", noteMatch[1].trim());

    console.log("autoDream completed for user:", userId);
  } catch (err) {
    console.error("autoDream error:", err.message);
  }
}

async function autoLearnMemory(userId, userMessage, aiReply) {
  // Quick check: is this conversation worth learning from?
  try {
    const worthCheck = await anthropic.messages.create({
      model: FAST_MODEL,
      max_tokens: 5,
      messages: [{ role: "user", content: "Does this conversation contain new facts, preferences, projects or decisions worth remembering long-term? Answer YES or NO only.\n\nUser: " + userMessage.substring(0, 200) + "\nAssistant: " + aiReply.substring(0, 200) }]
    });
    const worth = (worthCheck.content[0] || {}).text || "NO";
    if (!worth.toUpperCase().includes("YES")) return;
  } catch (e) { return; }
  try {
    const docs = await getAllDocs(userId);
    const currentDocs = JSON.stringify(docs, null, 2);

    const extractPrompt = "You are a memory extraction system. Analyze this conversation and return a JSON object.\n\n" +
      "CURRENT MEMORY:\n" + currentDocs + "\n\n" +
      "NEW EXCHANGE:\nUser: " + userMessage.substring(0, 500) + "\nAI: " + aiReply.substring(0, 500) + "\n\n" +
      "Extract only genuinely NEW information not already in memory.\n" +
      "Return ONLY this exact JSON with no other text:\n" +
      '{"soul":"","projects":"","tasks":"","notes":"","memories":[]}';

    const response = await anthropic.messages.create({
      model: FAST_MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: extractPrompt }]
    });

    const raw = response.content[0] ? response.content[0].text.trim() : "{}";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    const updates = JSON.parse(jsonMatch[0]);

    if (updates.soul && updates.soul.trim()) await setDoc(userId, "soul", updates.soul.trim());
    if (updates.projects && updates.projects.trim()) await setDoc(userId, "projects", updates.projects.trim());
    if (updates.tasks && updates.tasks.trim()) await setDoc(userId, "tasks", updates.tasks.trim());
    if (updates.notes && updates.notes.trim()) {
      const existing = await getDoc(userId, "notes") || "";
      const timestamp = new Date().toISOString().split("T")[0];
      const newNotes = existing ? existing + "\n[" + timestamp + "] " + updates.notes.trim() : "[" + timestamp + "] " + updates.notes.trim();
      await setDoc(userId, "notes", newNotes);
    }
    if (updates.memories && Array.isArray(updates.memories)) {
      for (const fact of updates.memories) {
        if (fact && typeof fact === "string" && fact.trim()) await saveMemory(userId, fact.trim(), "learned");
      }
    }
    await saveMemory(userId, "User said: " + userMessage.substring(0, 200), "conversation");
  } catch (err) {
    console.error("autoLearnMemory error:", err.message);
  }
}

// ── 自动摘要 ──────────────────────────────────────────────────────────────────
async function maybeAutoSummarize(userId) {
  const count = await countMessages(userId);
  if (count > 0 && count % SUMMARIZE_EVERY === 0) {
    try {
      const history = await getHistory(userId);
      const historyText = history.map(function(m) {
        return (m.role === "user" ? "用户" : "AI") + ": " + m.content;
      }).join("\n");
      const response = await anthropic.messages.create({
        model: MAIN_MODEL,
        max_tokens: 500,
        messages: [{ role: "user", content: "请把以下对话压缩成简短摘要（100字以内），保留重要信息。用中文。\n\n" + historyText }]
      });
      const summary = response.content[0] ? response.content[0].text : "";
      if (summary) {
        await saveSummary(userId, summary);
        await saveMemory(userId, summary, "summary");
      }
    } catch (err) { console.error("Auto-summarize error:", err.message); }
  }
}

// ── 网络搜索（直接调用，不用 Claude tools）──────────────────────────────────
async function tavilySearch(query) {
  if (!TAVILY_API_KEY) return null;
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: TAVILY_API_KEY, query: query, max_results: 5, search_depth: "basic" })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const results = data.results || [];
    if (results.length === 0) return null;
    return results.map(function(r, i) {
      return (i + 1) + ". " + (r.title || "") + "\n" + (r.content || r.snippet || r.url || "");
    }).join("\n\n");
  } catch (err) {
    console.error("Tavily error:", err.message);
    return null;
  }
}

// 用 Claude 智能判断是否需要搜索
async function needsSearch(message) {
  if (!TAVILY_API_KEY) return false;
  // Skip search for very short messages
  if (message.length < 15) return false;
  // Skip search for pure code/debug messages
  if (message.startsWith("```") || message.includes("error:") && message.length < 50) return false;
  try {
    const response = await anthropic.messages.create({
      model: FAST_MODEL,
      max_tokens: 10,
      messages: [{
        role: "user",
        content: "Does this question require real-time or current information to answer accurately? Answer only YES or NO.\n\nQuestion: " + message
      }]
    });
    const answer = response.content[0] ? response.content[0].text.trim().toUpperCase() : "NO";
    return answer.includes("YES");
  } catch (err) {
    return false;
  }
}

// ── 组装系统提示 ──────────────────────────────────────────────────────────────
async function buildSystemPrompt(userId, userMessage) {
  const [docs, summaries, relevantMemories] = await Promise.all([
    getAllDocs(userId),
    getSummaries(userId),
    searchMemories(userId, userMessage)
  ]);

  let prompt = "You are a smart, powerful personal AI assistant with advanced memory.\n\n";
  prompt += "FORMATTING RULES:\n";
  prompt += "- Never use Markdown symbols like *, _, **, __ in regular text replies\n";
  prompt += "- Plain text only for normal replies - dashes for lists, numbers for steps\n";
  prompt += "- CODE EXCEPTION: Always wrap ALL code in proper code blocks using triple backticks\n";
  prompt += "- For code blocks, always specify the language: ```python, ```javascript, ```bash etc\n";
  prompt += "- When sharing code fixes, always show the COMPLETE fixed code, not just the changed lines\n";
  prompt += "- When fixing bugs, explain: 1) what was wrong 2) what you changed 3) show full fixed code\n";
  prompt += "- Emojis are fine\n";
  prompt += "- Short questions = concise replies\n";
  prompt += "- Detailed tasks = full complete replies without stopping\n";
  prompt += "- Always reply in the same language the user wrote in\n";
  prompt += "- Never stop mid-reply\n";
  prompt += "- You actively learn from the user's decisions (skip/do) to improve future recommendations\n";
  prompt += "- When user says skip/跳过/pass or do/做/yes to a bounty, acknowledge and remember their preference\n";
  prompt += "- For code: ALWAYS write the complete code in ONE reply, never split across messages\n";
  prompt += "- If code is long, still write it all in ONE reply - it will be sent as a single .txt file automatically\n";
  prompt += "- NEVER split code across multiple replies. If you cannot fit everything, write a shorter but COMPLETE version\n";
  prompt += "- For code tasks: complete > perfect. One complete file is better than two partial files\n";
  prompt += "- If user says 继续/continue/还不完整, check notes for the last unfinished task and continue from where you left off\n";
  prompt += "- When starting a long code generation task, briefly state what you will generate before starting\n\n";

  if (docs.soul) prompt += "=== WHO THE USER IS ===\n" + docs.soul + "\n\n";
  if (docs.projects) prompt += "=== USER PROJECTS ===\n" + docs.projects + "\n\n";
  if (docs.tasks) prompt += "=== CURRENT TASKS ===\n" + docs.tasks + "\n\n";
  if (docs.notes) prompt += "=== IMPORTANT NOTES ===\n" + docs.notes + "\n\n";

  if (relevantMemories.length > 0) {
    prompt += "=== RELEVANT MEMORIES ===\n";
    relevantMemories.forEach(function(m, i) { prompt += (i + 1) + ". " + m + "\n"; });
    prompt += "\n";
  }

  if (summaries.length > 0) {
    prompt += "=== CONVERSATION SUMMARIES ===\n";
    summaries.forEach(function(s, i) { prompt += "Summary " + (i + 1) + ": " + s + "\n"; });
    prompt += "\n";
  }

  return prompt;
}

// ── Claude 主函数（不用 tools，直接搜索）─────────────────────────────────────
async function askClaude(userId, userMessage, ctx) {
  await saveMessage(userId, "user", userMessage);

  const [systemPrompt, history] = await Promise.all([
    buildSystemPrompt(userId, userMessage),
    getHistory(userId)
  ]);

  // Trim history if total content is too large to prevent timeouts
  let messages;
  if (history.length > 0) {
    const totalChars = history.reduce(function(sum, m) { return sum + (m.content || "").length; }, 0);
    if (totalChars > 20000) {
      // Keep last 10 messages, but truncate each to 2000 chars max
      const trimmed = history.slice(-10).map(function(m) {
        const c = m.content || "";
        return c.length > 2000
          ? { role: m.role, content: c.substring(0, 2000) + "...[已截断]" }
          : m;
      });
      messages = trimmed;
      console.log("History trimmed: " + history.length + " msgs, " + totalChars + " chars → " + trimmed.length + " msgs");
    } else {
      messages = [...history];
    }
  } else {
    messages = [{ role: "user", content: userMessage }];
  }
  let activeSystemPrompt = systemPrompt;

  // 如果需要搜索，先搜索再把结果加进对话
  if ((await needsSearch(userMessage)) && TAVILY_API_KEY) {
    const searchResults = await tavilySearch(userMessage);
    if (searchResults) {
      activeSystemPrompt = systemPrompt + "=== WEB SEARCH RESULTS ===\nToday is 2026. IMPORTANT: Base your answer primarily on these search results, not your training data. If results show current info, use it.\n" + searchResults + "\n\n";
    }
  }

  // Auto 2-pass for code generation requests → single .txt file
  const lastMsgContent = messages.length > 0 ? String(messages[messages.length-1].content) : "";
  const isCodeRequest = lastMsgContent.length < 300 &&
    /完整|complete|给我.*代码|写.*完整|v\d+|修复版|整个.*代码|不.*完整|继续|要$/.test(lastMsgContent);

  if (isCodeRequest) {
    if (ctx) { try { await ctx.reply("💻 代码生成中，自动合并为完整文件..."); } catch(e) {} }
    const r1 = await anthropic.messages.create({
      model: MAIN_MODEL, max_tokens: 8192, system: activeSystemPrompt,
      messages: [...messages.slice(0,-1), { role: "user", content: lastMsgContent + "\n\nWrite the FIRST HALF only. End with: # === PART 2 CONTINUES ===" }]
    });
    const p1 = ((r1.content[0]||{}).text||"").replace(/```[\w]*\n?|```$/gm,"").trim();
    if (ctx) { try { await ctx.reply("⚙️ 生成后半部分..."); } catch(e) {} }
    const r2 = await anthropic.messages.create({
      model: MAIN_MODEL, max_tokens: 8192, system: activeSystemPrompt,
      messages: [...messages.slice(0,-1), { role:"user", content: lastMsgContent }, { role:"assistant", content: p1 }, { role:"user", content: "Continue with the SECOND HALF. Start from where you left off. Code only." }]
    });
    const p2 = ((r2.content[0]||{}).text||"").replace(/```[\w]*\n?|```$/gm,"").trim();
    const fullCode = p1 + "\n\n" + p2;
    if (ctx && fullCode.length > 100) {
      const buf = Buffer.from(fullCode, "utf-8");
      const ts = new Date().toISOString().slice(11,16).replace(":","");
      try {
        await withRetry(function() {
          return ctx.replyWithDocument({ source: buf, filename: "code_" + ts + ".txt" }, { caption: "✅ 完整代码\n\n用 /save [版本名] 保存" });
        });
        return null;
      } catch(e) {}
    }
    return fullCode;
  }

  // Streaming response
  let reply = "";
  let sentMsg = null;
  let lastUpdate = 0;
  const UPDATE_INTERVAL = 1500; // update every 1.5 seconds

  try {
    // Detect if this is a code generation request
    const isCodeGen = messages.length > 0 && messages[messages.length-1] &&
      (String(messages[messages.length-1].content).includes("完整") ||
       String(messages[messages.length-1].content).includes("complete") ||
       String(messages[messages.length-1].content).includes("v\d") ||
       String(messages[messages.length-1].content).includes("全部代码"));
    const maxTok = 8192; // Opus max is 8192

    const stream = anthropic.messages.stream({
      model: MAIN_MODEL,
      max_tokens: maxTok,
      system: activeSystemPrompt,
      messages: messages
    });

    // Send initial placeholder
    if (ctx) sentMsg = await ctx.reply("...");

    let inputTokenCount = 0;
    let outputTokenCount = 0;
    for await (const event of stream) {
      if (event.type === "message_start" && event.message && event.message.usage) {
        inputTokenCount = event.message.usage.input_tokens || 0;
      }
      if (event.type === "message_delta" && event.usage) {
        outputTokenCount = event.usage.output_tokens || 0;
      }
      if (event.type === "content_block_delta" && event.delta && event.delta.type === "text_delta") {
        reply += event.delta.text;
        const now = Date.now();
        if (ctx && sentMsg && now - lastUpdate > UPDATE_INTERVAL && reply.length > 10) {
          try {
            await ctx.telegram.editMessageText(ctx.chat.id, sentMsg.message_id, null, reply.substring(0, 4000) + (reply.length > 4000 ? "..." : ""));
            lastUpdate = now;
          } catch (e) { /* ignore edit errors */ }
        }
      }
    }

    trackTokens(userId, inputTokenCount, outputTokenCount);
  // Persist to Supabase async
  if (supabase && (inputTokenCount || outputTokenCount)) {
    supabase.from("conversations").insert({
      user_id: parseInt(userId),
      role: "stats",
      content: JSON.stringify({ input: inputTokenCount, output: outputTokenCount, ts: Date.now() })
    }).then(function(){}).catch(function(){});
  }

    // Clear typing interval and delete placeholder
    if (ctx && sentMsg) {
      if (sentMsg._typingInterval) clearInterval(sentMsg._typingInterval);
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id);
      } catch (e) { /* ignore */ }
    }
  } catch (err) {
    console.error("Stream error:", err.message);
    // Fallback to non-streaming
    if (!reply) {
      const response = await anthropic.messages.create({
        model: MAIN_MODEL, max_tokens: 8192,
        system: activeSystemPrompt, messages: messages
      });
      reply = (response.content.find(function(b) { return b.type === "text"; }) || {}).text || "出错了，请再试一次。";
    }
  }

  // Save truncated version to history if reply is code-heavy (saves space)
  const hasCode = reply.includes("```") || reply.includes("def ") || reply.includes("async function") || reply.includes("import ");
  const isLongAnalysis = reply.length > 2000 && !hasCode;
  const toSave = hasCode && reply.length > 500
    ? "[代码回复 " + reply.length + "字] " + reply.substring(0, 150) + "..."
    : isLongAnalysis
    ? reply.substring(0, 500) + "...[已截断]"
    : reply;
  await saveMessage(userId, "assistant", toSave);
  countMessages(userId).then(function(count) {
    const tasks = [maybeAutoSummarize(userId)];
    if (count % 5 === 0) tasks.push(autoLearnMemory(userId, userMessage, reply));
    if (count % 10 === 0) tasks.push(autoDream(userId));
    if (count % 15 === 0) tasks.push(autoCompact(userId));
    return Promise.all(tasks);
  }).catch(function(err) { console.error("Background error:", err.message); });

  // Mark that streaming already showed this - caller should not call sendLongMessage
  if (reply) reply.__streamedAlready = true;
  return reply;
}

// ── 发送长消息 ────────────────────────────────────────────────────────────────
async function sendLongMessage(ctx, text) {
  const MAX = 3800;
  if (text.length <= MAX) { await ctx.reply(text); return; }

  // If response contains code and is very long, send as file
  const hasCode = text.includes("```");
  if (hasCode && text.length > MAX) {
    // Send a short summary first
    const lines = text.split("\n");
    const summary = lines.slice(0, 8).join("\n") + "\n\n[代码太长，以文件形式发送 👇]";
    await ctx.reply(summary);

    // Send as .txt file
    const buf = Buffer.from(text, "utf-8");
    const ts = new Date().toISOString().slice(11,16).replace(":","");
    await ctx.replyWithDocument({ source: buf, filename: "code_" + ts + ".txt" }, { caption: "完整代码（直接复制粘贴）" });
    return;
  }

  // For long non-code text, split by paragraph
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n\n", MAX);
    if (splitAt === -1) splitAt = remaining.lastIndexOf("\n", MAX);
    if (splitAt === -1 || splitAt < 100) splitAt = MAX;
    chunks.push(remaining.substring(0, splitAt).trim());
    remaining = remaining.substring(splitAt).trim();
  }

  for (let i = 0; i < chunks.length; i++) {
    const suffix = chunks.length > 1 && i < chunks.length - 1 ? "\n\n[" + (i+1) + "/" + chunks.length + "]" : "";
    await ctx.reply(chunks[i] + suffix);
    if (i < chunks.length - 1) await new Promise(function(r) { setTimeout(r, 300); });
  }
}

// ── Bot 命令 ──────────────────────────────────────────────────────────────────
bot.start(function(ctx) {
  const name = ctx.from && ctx.from.first_name ? ctx.from.first_name : "there";
  return ctx.reply(
    "Hey " + name + "! Your personal AI powered by Claude.\n\n" +
    "Memory system (4 layers):\n" +
    "- soul.md + projects.md - permanent identity\n" +
    "- tasks.md + notes.md - dynamic knowledge\n" +
    "- Vector memory - semantic search\n" +
    "- Conversation summaries\n\n" +
    "/help - all commands\n" +
    "/memory - see what I know about you"
  );
});

bot.help(function(ctx) {
  return ctx.reply(
    "All commands:\n\n" +
    "VIEW:\n" +
    "/memory - full overview\n" +
    "/soul - who you are\n" +
    "/projects - your projects\n" +
    "/tasks - current tasks\n" +
    "/notes - saved notes\n" +
    "/summaries - conversation summaries\n\n" +
    "UPDATE:\n" +
    "/setsoul [content]\n" +
    "/setprojects [content]\n" +
    "/settasks [content]\n" +
    "/note [text]\n" +
    "/clearnotes\n" +
    "/summarize\n\n" +
    "MANAGE:\n" +
    "/forget - clear conversation only\n" +
    "/reset - clear everything"
  );
});



// ── Railway 自动部署 ───────────────────────────────────────────────────────────
async function railwayDeploy(repoUrl, projectName, envVars) {
  const headers = {
    "Authorization": "Bearer " + RAILWAY_API_TOKEN,
    "Content-Type": "application/json"
  };

  // Step 1: Create project
  const createProjectRes = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: `mutation { projectCreate(input: { name: "${projectName}" }) { id name } }`
    })
  });
  const projectData = await createProjectRes.json();
  const projectId = projectData.data && projectData.data.projectCreate && projectData.data.projectCreate.id;
  if (!projectId) throw new Error("Failed to create Railway project: " + JSON.stringify(projectData));

  // Step 2: Create service from GitHub repo
  const repoPath = repoUrl.replace("https://github.com/", "");
  const createServiceRes = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: `mutation { serviceCreate(input: { projectId: "${projectId}", name: "${projectName}", source: { repo: "${repoPath}" } }) { id name } }`
    })
  });
  const serviceData = await createServiceRes.json();
  const serviceId = serviceData.data && serviceData.data.serviceCreate && serviceData.data.serviceCreate.id;
  if (!serviceId) throw new Error("Failed to create Railway service: " + JSON.stringify(serviceData));

  // Step 3: Get environment ID
  const envRes = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: `query { project(id: "${projectId}") { environments { edges { node { id name } } } } }`
    })
  });
  const envData = await envRes.json();
  const envId = envData.data && envData.data.project && envData.data.project.environments &&
    envData.data.project.environments.edges[0] && envData.data.project.environments.edges[0].node.id;

  // Step 4: Set environment variables if provided
  if (envVars && envId) {
    for (const [key, value] of Object.entries(envVars)) {
      await fetch("https://backboard.railway.app/graphql/v2", {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: `mutation { variableUpsert(input: { projectId: "${projectId}", environmentId: "${envId}", serviceId: "${serviceId}", name: "${key}", value: "${value}" }) }`
        })
      });
    }
  }

  // Step 5: Generate domain
  const domainRes = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: `mutation { serviceDomainCreate(input: { serviceId: "${serviceId}", environmentId: "${envId}" }) { domain } }`
    })
  });
  const domainData = await domainRes.json();
  const domain = domainData.data && domainData.data.serviceDomainCreate && domainData.data.serviceDomainCreate.domain;

  return {
    projectId,
    serviceId,
    url: domain ? "https://" + domain : "https://railway.app/project/" + projectId
  };
}

// ── Retry helper ─────────────────────────────────────────────────────────────
async function withRetry(fn, retries, delayMs) {
  retries = retries || 3;
  delayMs = delayMs || 2000;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err.message && err.message.includes("429");
      const retryAfter = is429 ? parseInt((err.message.match(/retry after (\d+)/) || [])[1] || "5") * 1000 : delayMs;
      if (i < retries - 1) {
        console.log("Retry " + (i+1) + "/" + retries + " after " + retryAfter + "ms:", err.message);
        await new Promise(function(r) { setTimeout(r, retryAfter); });
      } else {
        throw err;
      }
    }
  }
}

// ── Vibe Coding ───────────────────────────────────────────────────────────────
const vibeSessions = new Map();

async function getGitHubUser() {
  const res = await fetch("https://api.github.com/user", {
    headers: { "Authorization": "token " + GITHUB_TOKEN, "User-Agent": "ClaudeBot" }
  });
  return await res.json();
}

async function createGitHubRepo(repoName, description) {
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: { "Authorization": "token " + GITHUB_TOKEN, "Content-Type": "application/json", "User-Agent": "ClaudeBot" },
    body: JSON.stringify({ name: repoName, description: description || "Created by Claude Bot", private: false, auto_init: false })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Failed to create repo");
  return data;
}

async function pushFilesToGitHub(owner, repoName, files) {
  const headers = { "Authorization": "token " + GITHUB_TOKEN, "Content-Type": "application/json", "User-Agent": "ClaudeBot" };
  const base = "https://api.github.com/repos/" + owner + "/" + repoName;
  let treeSha, commitSha;

  const branchRes = await fetch(base + "/git/ref/heads/main", { headers });
  if (branchRes.ok) {
    const bd = await branchRes.json();
    commitSha = bd.object.sha;
    const cd = await (await fetch(base + "/git/commits/" + commitSha, { headers })).json();
    treeSha = cd.tree.sha;
  }

  const treeItems = [];
  for (const [path, fileContent] of Object.entries(files)) {
    const blob = await (await fetch(base + "/git/blobs", {
      method: "POST", headers,
      body: JSON.stringify({ content: fileContent, encoding: "utf-8" })
    })).json();
    treeItems.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const treeBody = { tree: treeItems };
  if (treeSha) treeBody.base_tree = treeSha;
  const tree = await (await fetch(base + "/git/trees", { method: "POST", headers, body: JSON.stringify(treeBody) })).json();

  const commitBody = { message: "Initial commit by Claude Bot", tree: tree.sha };
  if (commitSha) commitBody.parents = [commitSha];
  const newCommit = await (await fetch(base + "/git/commits", { method: "POST", headers, body: JSON.stringify(commitBody) })).json();

  if (branchRes.ok) {
    await fetch(base + "/git/refs/heads/main", { method: "PATCH", headers, body: JSON.stringify({ sha: newCommit.sha, force: true }) });
  } else {
    await fetch(base + "/git/refs", { method: "POST", headers, body: JSON.stringify({ ref: "refs/heads/main", sha: newCommit.sha }) });
  }
  return "https://github.com/" + owner + "/" + repoName;
}

async function generateProjectFiles(idea, techStack, details) {
  // Strategy: generate files one by one, no JSON format (avoids truncation issues)
  const isPython = techStack.toLowerCase().includes("python");
  const mainFile = isPython ? "main.py" : (techStack.toLowerCase().includes("node") ? "index.js" : "main.py");
  const depFile = isPython ? "requirements.txt" : "package.json";

  const files = {};

  // Generate main file - 2 pass for completeness
  const sysPrompt = "You are an expert developer. Write complete, production-ready code. No placeholders, no TODOs. Always write the full implementation.";
  
  const res1 = await anthropic.messages.create({
    model: MAIN_MODEL, max_tokens: 8192, system: sysPrompt,
    messages: [{ role: "user", content: "Write the FIRST HALF of " + mainFile + " for: " + idea + "\nTech: " + techStack + "\nDetails: " + (details || "none") + "\n\nOutput ONLY the code, no markdown. End with: # === PART 2 CONTINUES ===" }]
  });
  const part1 = ((res1.content[0] || {}).text || "").replace(/```[\w]*\n?|```/g, "").trim();

  const res2 = await anthropic.messages.create({
    model: MAIN_MODEL, max_tokens: 8192, system: sysPrompt,
    messages: [
      { role: "user", content: "Write " + mainFile + " for: " + idea },
      { role: "assistant", content: part1 },
      { role: "user", content: "Continue writing the SECOND HALF. Include main loop, error handling, entry point. Output ONLY code." }
    ]
  });
  const part2 = ((res2.content[0] || {}).text || "").replace(/```[\w]*\n?|```/g, "").trim();
  files[mainFile] = part1 + "\n\n" + part2;

  // Generate dependencies file
  const depRes = await anthropic.messages.create({
    model: FAST_MODEL, max_tokens: 500,
    messages: [{ role: "user", content: "List only the pip packages needed for this code (one per line, no versions needed):\n" + part1.substring(0, 2000) + "\n\nOutput ONLY package names, one per line." }]
  });
  files[depFile] = ((depRes.content[0] || {}).text || "").trim();

  // Simple README
  files["README.md"] = "# " + idea + "\n\nTech: " + techStack + "\n\nGenerated by Claude 大神";
  files[".gitignore"] = isPython ? "__pycache__/\n*.pyc\n.env\nvenv/" : "node_modules/\n.env";

  return files;
}

async function reviewAndFixFiles(files, idea, techStack) {
  const filesSummary = Object.entries(files).map(function(entry) {
    const path = entry[0];
    const code = entry[1];
    return "=== " + path + " ===\n" + code.substring(0, 4000) + (code.length > 4000 ? "\n...[truncated]" : "");
  }).join("\n\n");

  const reviewPrompt = "You are a senior developer reviewing code before deployment.\n\nProject idea: " + idea + "\nTech stack: " + techStack + "\n\nGenerated files:\n" + filesSummary + "\n\nReview the code and fix any issues:\n1. Syntax errors or typos\n2. Missing imports or dependencies\n3. Broken logic or incomplete functions\n4. Security issues (hardcoded secrets, etc)\n5. Missing error handling\n\nReturn ONLY a JSON object with the fixed files (same structure: filepath -> content). If a file is fine, include it unchanged. Return ONLY valid JSON, no explanation.";

  const res = await anthropic.messages.create({
    model: MAIN_MODEL,
    max_tokens: 8192,
    messages: [{ role: "user", content: reviewPrompt }]
  });
  const text = (res.content[0] || {}).text || "{}";
  const clean = text.replace(/^```json\n?|^```\n?|```$/gm, "").trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error("Review parse error:", e.message);
    return files; // return original if review fails
  }
}

bot.command("vibe", async function(ctx) {
  if (!GITHUB_TOKEN) return ctx.reply("Vibe coding 未启用。请在 Railway 添加 GITHUB_TOKEN 环境变量。");
  const userId = ctx.from.id;
  vibeSessions.set(userId, { step: "idea" });
  await ctx.reply("🚀 Vibe Coding 模式启动！\n\n说说你想做什么？（一句话描述你的项目想法）");
});

bot.command("vibestop", async function(ctx) {
  vibeSessions.delete(ctx.from.id);
  await ctx.reply("已退出 Vibe Coding 模式。");
});


// Store pending fix tasks
const pendingFix = new Map();
// Auto-expire pendingFix after 10 minutes
setInterval(function() {
  const now = Date.now();
  pendingFix.forEach(function(val, key) {
    if (val.createdAt && now - val.createdAt > 10 * 60 * 1000) {
      pendingFix.delete(key);
    }
  });
}, 60000);

async function autoAnalyzeAndFix(ctx, userId, fileName, fileText) {
  await ctx.reply("🔍 分析 " + fileName + "（" + fileText.length + " 字符）...");
  setImmediate(async function() {
    try {
      const sample = fileText.length > 20000 ? fileText.substring(0, 20000) + "\n...[截断]" : fileText;
      const res = await anthropic.messages.create({
        model: MAIN_MODEL, max_tokens: 2000,
        system: "You are a senior code reviewer. Be specific and actionable. Reply in Chinese.",
        messages: [{ role: "user", content: "分析这个文件，找出：1. Bug和错误 2. 缺失功能 3. 风险点 4. 优化机会\n\n文件：" + fileName + "\n\n" + sample }]
      });
      const analysis = (res.content[0] || {}).text || "";
      await sendLongMessage(ctx, "📊 **" + fileName + " 分析**\n\n" + analysis);
      await ctx.reply("要生成修复版吗？回复 '修复' 或说明要改什么");
      pendingFix.set(userId, { waiting: true, instructions: "__auto__", originalCode: fileText, fileName, createdAt: Date.now() });
    } catch (err) {
      await ctx.reply("分析失败: " + err.message).catch(function(){});
    }
  });
}

async function processFileFix(ctx, userId, fileName, fileText, instructions) {
  await ctx.reply("📖 读取完毕（" + fileText.length + " 字符）\n⚙️ [1/2] 生成前半部分...");
  setImmediate(async function() {
    try {
      const sysPrompt = "You are an expert programmer. Fix/modify code as instructed. Output ONLY code, no explanations, no markdown backticks. Never truncate.";
      const src = fileText.length > 25000 ? fileText.substring(0, 25000) : fileText;
      const userMsg = "File: " + fileName + "\n\nInstructions: " + instructions + "\n\nOriginal code:\n" + src;
      const r1 = await anthropic.messages.create({
        model: MAIN_MODEL, max_tokens: 8192, system: sysPrompt,
        messages: [{ role: "user", content: userMsg + "\n\nOutput the FIRST HALF of the complete modified code. End with: # === PART 2 CONTINUES ===" }]
      });
      const p1 = ((r1.content[0] || {}).text || "").replace(/```[\w]*\n?|```/g, "").trim();
      await ctx.reply("⚙️ [2/2] 生成后半部分...");
      await ctx.sendChatAction("typing");
      const r2 = await anthropic.messages.create({
        model: MAIN_MODEL, max_tokens: 8192, system: sysPrompt,
        messages: [
          { role: "user", content: userMsg },
          { role: "assistant", content: p1 },
          { role: "user", content: "Continue with the SECOND HALF. Start from where you left off. Code only." }
        ]
      });
      const p2 = ((r2.content[0] || {}).text || "").replace(/```[\w]*\n?|```/g, "").trim();
      const fullCode = p1 + "\n\n" + p2;
      const buf = Buffer.from(fullCode, "utf-8");
      const ts = new Date().toISOString().slice(11,16).replace(":","");
      const ext = (fileName.match(/\.(py|js|ts|cjs)$/) || ["",".py"])[1];
      const outName = fileName.replace(/\.[^.]+$/, "") + "_fixed_" + ts + ext;
      await withRetry(function() {
        return ctx.replyWithDocument({ source: buf, filename: outName }, { caption: "✅ 修改完成！（" + fullCode.length + " 字符）\n\n用 /save [版本名] 保存" });
      });
      pendingFix.delete(userId);
    } catch (err) {
      console.error("Fix error:", err.message);
      await ctx.reply("修改失败: " + err.message).catch(function(){});
      pendingFix.delete(userId);
    }
  });
}

// ── 决策学习系统 ────────────────────────────────────────────────────────────────
async function recordDecision(userId, bountyInfo, decision) {
  try {
    const memory = "用户对赏金决策: " + decision + " | " + bountyInfo.substring(0, 200);
    await autoLearnMemory(userId, "[决策记录]", memory);
    console.log("Decision recorded:", decision, bountyInfo.substring(0, 50));
  } catch (err) {
    console.error("Record decision error:", err.message);
  }
}

async function learnFromDecision(userId, userMessage) {
  const skipKeywords = ["跳过", "skip", "不做", "pass", "算了", "不要", "no"];
  const doKeywords = ["做", "要做", "参加", "yes", "好", "来", "行", "可以"];

  const isSkip = skipKeywords.some(function(k) { return userMessage.toLowerCase().includes(k); });
  const isDo = doKeywords.some(function(k) { return userMessage.toLowerCase() === k || userMessage.toLowerCase().startsWith(k + " ") || userMessage.toLowerCase().startsWith(k + "，"); });

  if (!isSkip && !isDo) return null;

  // Get recent conversation to understand what they're deciding on
  const history = await getHistory(userId);
  const lastBotMsg = history.filter(function(m) { return m.role === "assistant"; }).slice(-1)[0];
  if (!lastBotMsg) return null;

  const decision = isSkip ? "跳过" : "参与";
  const context = lastBotMsg.content.substring(0, 300);

  // Extract patterns to learn
  const learnPrompt = "User made a decision about a bounty. Extract what to learn about their preferences.\n\nDecision: " + decision + "\nBounty context: " + context + "\n\nReturn JSON: {\"learning\": \"one sentence about their preference\", \"min_reward\": number or null, \"preferred_types\": [\"content\"|\"dev\"|\"audit\"] or null}";

  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    messages: [{ role: "user", content: learnPrompt }]
  });
  const text = (res.content[0] || {}).text || "{}";
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    const learned = JSON.parse(clean);
    if (learned.learning) {
      await recordDecision(userId, context, decision + ": " + learned.learning);
      return learned;
    }
  } catch (e) {}
  return null;
}


// ── 代码版本管理 ──────────────────────────────────────────────────────────────
async function saveCodeVersion(userId, versionName, code) {
  if (!supabase) return false;
  try {
    const uid = parseInt(userId);
    const { error } = await supabase.from("user_docs").upsert({
      user_id: uid,
      doc_type: "code_" + versionName.toLowerCase().replace(/\s+/g, "_"),
      content: code,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id,doc_type" });
    return !error;
  } catch (e) { return false; }
}

async function getCodeVersion(userId, versionName) {
  if (!supabase) return null;
  try {
    const uid = parseInt(userId);
    const { data } = await supabase.from("user_docs")
      .select("content,updated_at")
      .eq("user_id", uid)
      .eq("doc_type", "code_" + versionName.toLowerCase().replace(/\s+/g, "_"))
      .maybeSingle();
    return data || null;
  } catch (e) { return null; }
}

async function listCodeVersions(userId) {
  if (!supabase) return [];
  try {
    const uid = parseInt(userId);
    const { data } = await supabase.from("user_docs")
      .select("doc_type,updated_at")
      .eq("user_id", uid)
      .like("doc_type", "code_%")
      .order("updated_at", { ascending: false });
    return (data || []).map(function(d) {
      return { name: d.doc_type.replace("code_", ""), updated: d.updated_at };
    });
  } catch (e) { return []; }
}


bot.command("save", async function(ctx) {
  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) return ctx.reply("用法：/save v11\n或：/save v11 [附上代码文件]");
  const userId = ctx.from.id;
  const versionName = args;

  // Check if there's a recent code reply to save
  const history = await getHistory(userId);
  const lastCode = history.slice().reverse().find(function(m) {
    return m.role === "assistant" && (m.content.includes("```") || m.content.includes("[代码回复"));
  });

  if (!lastCode) return ctx.reply("没找到最近的代码回复，请先生成代码再 /save " + versionName);

  const ok = await saveCodeVersion(userId, versionName, lastCode.content);
  await ctx.reply(ok ? "✅ 已保存为 " + versionName : "保存失败，请重试。");
});

bot.command("versions", async function(ctx) {
  const userId = ctx.from.id;
  const versions = await listCodeVersions(userId);
  if (versions.length === 0) return ctx.reply("还没有保存任何代码版本。\n用 /save v1 保存当前代码。");
  const list = versions.map(function(v) {
    return "• " + v.name + " (" + new Date(v.updated).toLocaleDateString("zh") + ")";
  }).join("\n");
  await ctx.reply("📦 已保存的版本：\n\n" + list + "\n\n用 /load [版本名] 加载");
});

bot.command("load", async function(ctx) {
  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!args) return ctx.reply("用法：/load v11");
  const userId = ctx.from.id;
  const ver = await getCodeVersion(userId, args);
  if (!ver) return ctx.reply("找不到版本 " + args + "，用 /versions 查看所有版本。");
  const code = ver.content;
  if (code.length > 3800) {
    const buf = Buffer.from(code, "utf-8");
    const ts = new Date().toISOString().slice(11,16).replace(":","");
    await ctx.replyWithDocument({ source: buf, filename: args + "_" + ts + ".txt" }, { caption: "📦 " + args + " 代码（直接复制粘贴）" });
  } else {
    await ctx.reply(code);
  }
});



bot.command("memory", async function(ctx) {
  await ctx.sendChatAction("typing");
  const docs = await getAllDocs(ctx.from.id);
  const summaries = await getSummaries(ctx.from.id);
  let output = "Your memory overview:\n\n";
  output += "SOUL:\n" + (docs.soul || "Not set yet") + "\n\n";
  output += "PROJECTS:\n" + (docs.projects || "Not set yet") + "\n\n";
  output += "TASKS:\n" + (docs.tasks || "Not set yet") + "\n\n";
  if (docs.notes) output += "NOTES:\n" + docs.notes + "\n\n";
  output += "VECTOR MEMORIES: Active\n";
  if (summaries.length > 0) output += "SUMMARIES: " + summaries.length + " saved";
  await sendLongMessage(ctx, output);
});

bot.command("soul", async function(ctx) {
  const content = await getDoc(ctx.from.id, "soul");
  await ctx.reply(content ? "soul.md:\n\n" + content : "Not set yet. Talk to me and I will learn automatically!");
});

bot.command("setsoul", async function(ctx) {
  const content = ctx.message.text.replace("/setsoul", "").trim();
  if (!content) return ctx.reply("Usage: /setsoul [your info]");
  await setDoc(ctx.from.id, "soul", content);
  return ctx.reply("soul.md updated!");
});

bot.command("projects", async function(ctx) {
  const content = await getDoc(ctx.from.id, "projects");
  await ctx.reply(content ? "projects.md:\n\n" + content : "Not set yet.");
});

bot.command("setprojects", async function(ctx) {
  const content = ctx.message.text.replace("/setprojects", "").trim();
  if (!content) return ctx.reply("Usage: /setprojects [content]");
  await setDoc(ctx.from.id, "projects", content);
  return ctx.reply("projects.md updated!");
});

bot.command("tasks", async function(ctx) {
  const content = await getDoc(ctx.from.id, "tasks");
  await ctx.reply(content ? "tasks.md:\n\n" + content : "Not set yet.");
});

bot.command("settasks", async function(ctx) {
  const content = ctx.message.text.replace("/settasks", "").trim();
  if (!content) return ctx.reply("Usage: /settasks [content]");
  await setDoc(ctx.from.id, "tasks", content);
  return ctx.reply("tasks.md updated!");
});

bot.command("notes", async function(ctx) {
  const content = await getDoc(ctx.from.id, "notes");
  if (content) { await sendLongMessage(ctx, "notes.md:\n\n" + content); }
  else { await ctx.reply("No notes yet."); }
});

bot.command("note", async function(ctx) {
  const newNote = ctx.message.text.replace("/note", "").trim();
  if (!newNote) return ctx.reply("Usage: /note [text]");
  const existing = await getDoc(ctx.from.id, "notes") || "";
  const timestamp = new Date().toISOString().split("T")[0];
  const updated = existing ? existing + "\n[" + timestamp + "] " + newNote : "[" + timestamp + "] " + newNote;
  await setDoc(ctx.from.id, "notes", updated);
  return ctx.reply("Note saved!");
});

bot.command("clearnotes", async function(ctx) {
  await setDoc(ctx.from.id, "notes", "");
  return ctx.reply("Notes cleared!");
});

bot.command("summaries", async function(ctx) {
  const summaries = await getSummaries(ctx.from.id);
  if (summaries.length > 0) {
    await sendLongMessage(ctx, "Summaries:\n\n" + summaries.map(function(s, i) { return (i + 1) + ". " + s; }).join("\n\n"));
  } else {
    await ctx.reply("No summaries yet. Auto-created every " + SUMMARIZE_EVERY + " messages.");
  }
});

bot.command("summarize", async function(ctx) {
  await ctx.sendChatAction("typing");
  try {
    const history = await getHistory(ctx.from.id);
    if (history.length === 0) return ctx.reply("No conversation to summarize.");
    const historyText = history.map(function(m) { return (m.role === "user" ? "用户" : "AI") + ": " + m.content; }).join("\n");
    const response = await anthropic.messages.create({
      model: MAIN_MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content: "请把以下对话压缩成简短摘要（100字以内）。用中文。\n\n" + historyText }]
    });
    const summary = response.content[0] ? response.content[0].text : "";
    if (summary) {
      await saveSummary(ctx.from.id, summary);
      await ctx.reply("Summary saved:\n\n" + summary);
    }
  } catch (err) { await ctx.reply("Error creating summary."); }
});

bot.command("forget", async function(ctx) {
  await clearHistory(ctx.from.id);
  return ctx.reply("Conversation history cleared. soul, projects, tasks and notes kept.");
});

bot.command("reset", async function(ctx) {
  await clearHistory(ctx.from.id);
  for (const t of ["soul", "projects", "tasks", "notes"]) {
    await setDoc(ctx.from.id, t, "");
  }
  return ctx.reply("Everything cleared. Fresh start.");
});

// ── 处理文字消息 ──────────────────────────────────────────────────────────────

bot.command("deploy", async function(ctx) {
  if (!RAILWAY_API_TOKEN) return ctx.reply("Railway 部署未启用。请在 Railway Variables 添加 RAILWAY_API_TOKEN。");
  if (!GITHUB_TOKEN) return ctx.reply("需要 GITHUB_TOKEN 才能部署。");

  const args = ctx.message.text.split(" ").slice(1);
  const repoUrl = args[0];

  if (!repoUrl || !repoUrl.includes("github.com")) {
    return ctx.reply("用法：/deploy https://github.com/user/repo\n\n可以加环境变量：\n/deploy https://github.com/user/repo KEY1=val1 KEY2=val2");
  }

  const envVars = {};
  args.slice(1).forEach(function(arg) {
    const [key, ...rest] = arg.split("=");
    if (key && rest.length) envVars[key] = rest.join("=");
  });

  const projectName = repoUrl.split("/").pop().substring(0, 30);
  await ctx.reply("🚀 开始部署 " + projectName + "...\n\n[1/3] 创建 Railway 项目");
  await ctx.sendChatAction("typing");

  try {
    await ctx.reply("[2/3] 连接 GitHub repo，配置环境变量...");
    const result = await railwayDeploy(repoUrl, projectName, envVars);
    await ctx.reply("✅ 部署完成！\n\n🌐 URL: " + result.url + "\n📦 项目: https://railway.app/project/" + result.projectId + "\n\n几分钟后即可访问。");
  } catch (err) {
    console.error("Deploy error:", err.message);
    await ctx.reply("部署失败: " + err.message);
  }
});


bot.command("weekly", async function(ctx) {
  const userId = ctx.from.id;
  await ctx.sendChatAction("typing");
  try {
    const [memories, summaries] = await Promise.all([
      supabase ? supabase.from("memories").select("content,created_at")
        .eq("user_id", parseInt(userId))
        .gte("created_at", new Date(Date.now() - 7*24*60*60*1000).toISOString())
        .order("created_at", { ascending: false }) : { data: [] },
      supabase ? supabase.from("conversation_summaries").select("summary,created_at")
        .eq("user_id", parseInt(userId))
        .gte("created_at", new Date(Date.now() - 7*24*60*60*1000).toISOString())
        .order("created_at", { ascending: false }) : { data: [] }
    ]);

    const memData = (memories.data || []).map(function(m) { return m.content; }).join("\n");
    const sumData = (summaries.data || []).map(function(s) { return s.summary; }).join("\n");

    if (!memData && !sumData) {
      return ctx.reply("这周还没有足够的数据生成周报。");
    }

    const reportRes = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{ role: "user", content: "Generate a brief weekly summary in Chinese based on this user activity data.\n\nMemories this week:\n" + memData.substring(0, 1000) + "\n\nConversation summaries:\n" + sumData.substring(0, 1000) + "\n\nInclude: what they worked on, decisions made, patterns noticed, suggestions for next week. Keep it concise and actionable." }]
    });
    const report = (reportRes.content[0] || {}).text || "无法生成周报。";
    await sendLongMessage(ctx, "📊 本周总结\n\n" + report);
  } catch (err) {
    await ctx.reply("生成周报失败: " + err.message);
  }
});


bot.command("imagine", async function(ctx) {
  if (!GEMINI_API_KEY) {
    return ctx.reply("图片生成未启用。请在 Railway Variables 添加 GEMINI_API_KEY。\n\n去 aistudio.google.com 获取免费 API Key。");
  }
  const prompt = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!prompt) return ctx.reply("用法：/imagine 一只赛博朋克风格的猫");

  await ctx.reply("🎨 生成中... 请稍等");
  await ctx.sendChatAction("upload_photo");

  setImmediate(async function() {
    try {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=" + GEMINI_API_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["IMAGE", "TEXT"] }
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error && data.error.message || "API error " + res.status);

      // Find image part
      const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [];
      const imgPart = parts.find(function(p) { return p.inlineData && p.inlineData.mimeType && p.inlineData.mimeType.startsWith("image/"); });

      if (!imgPart) throw new Error("没有生成图片，请换一个描述试试。");

      const imgBuffer = Buffer.from(imgPart.inlineData.data, "base64");
      const mimeType = imgPart.inlineData.mimeType;
      const ext = mimeType.includes("png") ? "png" : "jpg";

      await ctx.replyWithPhoto(
        { source: imgBuffer, filename: "image." + ext },
        { caption: "🎨 " + prompt }
      );
    } catch (err) {
      console.error("Imagine error:", err.message);
      await ctx.reply("生成失败: " + err.message).catch(function(){});
    }
  });
});

bot.on("text", async function(ctx) {
  const userId = ctx.from.id;
  let userMessage = ctx.message.text;

  // If replying to a long message, trim the context
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    const quotedLen = ctx.message.reply_to_message.text.length;
    if (quotedLen > 500) {
      // Just use the user's own message, ignore the quoted context
      // Claude already has conversation history
      userMessage = userMessage; // keep as is, history handles context
    }
  }

  // Auto-detect pasted code/logs → switch to fix mode (saves tokens)
  // Only auto-fix actual code (not logs) - logs have timestamps, code has syntax
  const hasTimestamps = /\d{4}-\d{2}-\d{2}|\[info\]|\[error\]|\d{2}:\d{2}:\d{2}/.test(userMessage);
  const looksLikeCode = !hasTimestamps && userMessage.length > 300 && (
    (userMessage.includes("def ") && userMessage.includes(":")) ||
    (userMessage.includes("import ") && userMessage.includes("\n")) ||
    userMessage.includes("SyntaxError") || userMessage.includes("TypeError") ||
    userMessage.includes("IndentationError") ||
    (userMessage.includes("function ") && userMessage.includes("{"))
  );
  if (looksLikeCode && !userMessage.startsWith("/")) {
    const ts = new Date().toISOString().slice(11,16).replace(":","");
    await ctx.reply("🔍 检测到代码，自动进入修复模式（省 token）...");
    return await autoAnalyzeAndFix(ctx, userId, "paste_" + ts + ".py", userMessage);
  }

  // Handle /fix flow - user typing instructions after /fix with no args
  const fixReply = pendingFix.get(userId);
  if (fixReply && !fixReply.waiting && fixReply.instructions === null && !userMessage.startsWith("/")) {
    // User just typed their instructions
    pendingFix.set(userId, { waiting: true, instructions: userMessage, createdAt: Date.now() });
    return ctx.reply("✅ 明白！任务：" + userMessage + "\n\n现在发 .py 文件给我 👇");
  }
  if (fixReply && fixReply.waiting && fixReply.originalCode && !userMessage.startsWith("/")) {
    const wantsfix = userMessage.includes("修") || userMessage.toLowerCase().includes("fix") || userMessage.includes("要") || userMessage.includes("是") || userMessage.includes("好");
    if (wantsfix) {
      const instructions = fixReply.instructions === "__auto__" ? userMessage : fixReply.instructions;
      const fn = fixReply.fileName || "code.py";
      const code = fixReply.originalCode;
      pendingFix.delete(userId);
      await ctx.reply("🔧 开始生成修复版...");
      return await processFileFix(ctx, userId, fn, code, instructions === "__auto__" ? "Fix all the issues found in the analysis" : instructions);
    }
  }

  // Learn from user decisions (only for short bounty responses)
  const isBountyDecision = !userMessage.startsWith("/") && 
    userMessage.length < 50 &&
    (userMessage.includes("做") || userMessage.includes("跳过") || 
     userMessage.includes("skip") || userMessage.includes("pass") ||
     userMessage.toLowerCase() === "yes" || userMessage.toLowerCase() === "no" ||
     userMessage.includes("要") || userMessage.includes("不要"));
  if (isBountyDecision) {
    learnFromDecision(userId, userMessage).catch(function(e) {});
  }



  // Handle vibe coding session
  if (vibeSessions.has(userId) && !userMessage.startsWith("/")) {
    const session = vibeSessions.get(userId);

    if (session.step === "idea") {
      session.idea = userMessage;
      session.step = "stack";
      vibeSessions.set(userId, session);
      return ctx.reply("💡 好的！用什么技术栈？\n\n例如：Node.js, Python, React, Next.js 等\n（不确定就说 '帮我选'）");
    }

    if (session.step === "stack") {
      let stack = userMessage;
      if (userMessage.toLowerCase().includes("帮我选") || userMessage.toLowerCase().includes("你选")) {
        stack = "Node.js + Express";
      }
      session.stack = stack;
      session.step = "details";
      vibeSessions.set(userId, session);
      return ctx.reply("📝 还有什么额外要求？\n\n例如：需要数据库、特定 API、特殊功能\n（没有就发 '没有'）");
    }

    if (session.step === "details") {
      session.details = userMessage;
      session.step = "building";
      vibeSessions.set(userId, session);
      await ctx.reply("⚙️ 开始生成项目...请稍等 30-60 秒");
      await ctx.sendChatAction("typing");

      try {
        // Step 1: Generate
        await ctx.reply("⚙️ [1/3] 生成代码中...");
        const files = await generateProjectFiles(session.idea, session.stack, session.details);
        const fileCount = Object.keys(files).length;
        await ctx.reply("✅ 生成了 " + fileCount + " 个文件");

        // Step 2: Review + Fix
        await ctx.reply("🔍 [2/3] 代码审查中，修复潜在问题...");
        await ctx.sendChatAction("typing");
        const reviewedFiles = await reviewAndFixFiles(files, session.idea, session.stack);
        const reviewedCount = Object.keys(reviewedFiles).length;
        await ctx.reply("✅ 审查完成，共 " + reviewedCount + " 个文件准备就绪");

        // Step 3: Push to GitHub
        await ctx.reply("📦 [3/3] 推送到 GitHub 中...");
        const ghUser = await getGitHubUser();
        const owner = ghUser.login;
        const repoName = session.idea.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().split(/\s+/).slice(0, 4).join("-") + "-" + Date.now().toString().slice(-4);

        await createGitHubRepo(repoName, session.idea);
        // Filter out empty files
        const validFiles = {};
        Object.entries(reviewedFiles).forEach(function(entry) {
          if (entry[1] && entry[1].trim().length > 10) validFiles[entry[0]] = entry[1];
        });

        if (Object.keys(validFiles).length === 0) {
          vibeSessions.delete(userId);
          return ctx.reply("生成的文件内容为空，请重新 /vibe 再试。");
        }

        const repoUrl = await pushFilesToGitHub(owner, repoName, validFiles);
        vibeSessions.delete(userId);

        const fileList = Object.keys(validFiles).map(function(f) { return "- " + f; }).join("\n");
        await ctx.reply("🎉 完成！\n\n📦 GitHub: " + repoUrl + "\n\n文件:\n" + fileList + "\n\n下一步:\n1. Railway → New Project → Deploy from GitHub\n2. 选择 " + repoName + "\n3. 部署完成 ✅");
      } catch (err) {
        console.error("Vibe error:", err.message);
        vibeSessions.delete(userId);
        await ctx.reply("生成失败: " + err.message + "\n\n请重新发 /vibe 再试。");
      }
      return;
    }
  }

  // Auto-fetch and summarize URLs
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = userMessage.match(urlRegex);
  const isJustUrl = urls && urls.length === 1 && userMessage.trim() === urls[0];
  const hasUrlWithNoContext = urls && urls.length >= 1 && userMessage.trim().length < 120;

  if (urls && (isJustUrl || hasUrlWithNoContext)) {
    await ctx.sendChatAction("typing");
    try {
      let url = urls[0];
      // Auto-convert GitHub blob URLs to raw
      if (url.includes("github.com") && url.includes("/blob/")) {
        url = url
          .replace("github.com", "raw.githubusercontent.com")
          .replace("/blob/", "/");
        console.log("Converted to raw GitHub URL:", url);
      }
      const fetchRes = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)" },
        signal: AbortSignal.timeout(8000)
      });
      const html = await fetchRes.text();
      // Strip HTML tags
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 6000);

      if (text.length > 200) {
        const instruction = isJustUrl
          ? "总结这个网页的主要内容，提取关键信息。"
          : userMessage.replace(url, "").trim() || "总结这个网页的主要内容。";
        const result = await withLock(userId, async function() {
          return await askClaude(userId, "网页链接: " + url + "\n\n网页内容:\n" + text + "\n\n" + instruction, ctx);
        });
        if (result) await sendLongMessage(ctx, result);
        return;
      }
    } catch (err) {
      console.error("URL fetch error:", err.message);
      // Fall through to normal processing if fetch fails
    }
  }

  // Save code generation requests to notes for continuity after /forget
  const isCodeRequest = /完整|complete|全部|v\d+|修复版|完整版/i.test(userMessage);
  if (isCodeRequest && userMessage.length < 200) {
    // Save the request to notes so it survives /forget
    const currentNotes = await getDoc(userId, "notes") || "";
    if (!currentNotes.includes(userMessage)) {
      const taskNote = "【未完成任务】" + new Date().toLocaleString("zh") + ": " + userMessage;
      await setDoc(userId, "notes", taskNote + (currentNotes ? "\n" + currentNotes : ""));
    }
  }

  // Auto-summarize if message too long
  let processedMessage = userMessage;
  if (userMessage.length > 3000) {
    try {
      await ctx.sendChatAction("typing");
      const summaryRes = await anthropic.messages.create({
        model: FAST_MODEL,
        max_tokens: 800,
        messages: [{
          role: "user",
          content: "请把以下内容压缩成简洁的摘要，保留所有关键信息、代码、链接和数字，不要丢失重要细节：\n\n" + userMessage
        }]
      });
      const summary = (summaryRes.content[0] || {}).text || userMessage;
      processedMessage = "[自动压缩摘要]\n" + summary;
      console.log("Auto-summarized message from", userMessage.length, "to", processedMessage.length, "chars");
    } catch (err) {
      console.error("Auto-summarize failed:", err.message);
      processedMessage = userMessage.substring(0, 3000) + "...[内容过长已截断]";
    }
  }

  // Immediately acknowledge to Telegraf (avoids 90s timeout)
  // Process in background and send result when ready
  setImmediate(async function() {
    try {
      await ctx.sendChatAction("typing");
      const result = await withLock(userId, async function() {
        return await askClaude(userId, processedMessage, ctx);
      });
      // result is null if 2-pass already sent file, or if streaming handled display
      // Only call sendLongMessage for non-streaming results (fallback path)
      if (result && !result.__streamedAlready) {
        await sendLongMessage(ctx, result);
      }
    } catch (err) {
      console.error("Claude error:", err.message);
      try { await ctx.reply("出错了，请稍后再试。"); } catch(e) {}
    }
  });
});

// ── 处理图片 ──────────────────────────────────────────────────────────────────
// Cache for photo media groups
const photoGroupCache = new Map();


async function processMultiplePhotos(ctx, userId, photos, caption) {
  await ctx.sendChatAction("typing");
  const instruction = caption || "分析这些图片，给我综合对比和关键信息。";
  try {
    const contents = [];
    for (const photo of photos) {
      const fileLink = await withRetry(function() { return ctx.telegram.getFileLink(photo.file_id); });
      const res = await fetch(fileLink.href);
      const buf = await res.arrayBuffer();
      const b64 = Buffer.from(buf).toString("base64");
      contents.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } });
    }
    contents.push({ type: "text", text: instruction });
    const systemPrompt = await buildSystemPrompt(userId, instruction);
    const result = await anthropic.messages.create({
      model: MAIN_MODEL, max_tokens: 4096, system: systemPrompt,
      messages: [{ role: "user", content: contents }]
    });
    const reply = (result.content[0] || {}).text || "无法分析图片。";
    await saveMessage(userId, "user", "[" + photos.length + " 张图片] " + instruction);
    await saveMessage(userId, "assistant", reply);
    await sendLongMessage(ctx, reply);
  } catch (err) {
    console.error("Multi photo error:", err.message);
    await ctx.reply("图片处理失败: " + err.message).catch(function(){});
  }
}

bot.on("photo", async function(ctx) {
  const userId = ctx.from.id;
  const mediaGroupId = ctx.message.media_group_id;

  if (mediaGroupId) {
    // Collect all photos in group, then process together
    if (!photoGroupCache.has(mediaGroupId)) {
      photoGroupCache.set(mediaGroupId, { photos: [], caption: ctx.message.caption || "", userId, ctx });
      setTimeout(async function() {
        const group = photoGroupCache.get(mediaGroupId);
        photoGroupCache.delete(mediaGroupId);
        if (!group || group.photos.length === 0) return;
        await processMultiplePhotos(group.ctx, group.userId, group.photos, group.caption);
      }, 1500);
    }
    // Always take the largest version of each photo
    const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
    photoGroupCache.get(mediaGroupId).photos.push(largestPhoto);
    return;
  }
  await ctx.sendChatAction("typing");
  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.telegram.getFile(photo.file_id);
    const fileUrl = "https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + file.file_path;
    const imageResponse = await fetch(fileUrl);
    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const caption = ctx.message.caption || "请详细描述这张图片的内容。";
    const systemPrompt = await buildSystemPrompt(userId, caption);
    const history = await getHistory(userId);
    const msgs = history.length > 0 ? [...history] : [];
    msgs.push({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
        { type: "text", text: caption }
      ]
    });
    const response = await anthropic.messages.create({
      model: MAIN_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: msgs
    });
    const reply = response.content[0] ? response.content[0].text : "I could not analyze this image.";
    await saveMessage(userId, "user", "[图片] " + caption);
    await saveMessage(userId, "assistant", reply);
    autoLearnMemory(userId, "[图片] " + caption, reply).catch(function(err) { console.error(err.message); });
    await sendLongMessage(ctx, reply);
  } catch (err) {
    console.error("Image error:", err.message);
    await ctx.reply("图片处理失败，请重新发送。");
  }
});


// Process multiple files at once
async function processMultipleDocs(ctx, userId, docs, caption) {
  await ctx.sendChatAction("typing");
  const instruction = caption || "分析这些文件，给我综合总结和关键信息。";
  const contents = [];

  for (const doc of docs) {
    const mime = doc.mime_type || "";
    const fileName = doc.file_name || "file";
    try {
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const response = await fetch(fileLink.href);

      if (mime === "application/pdf") {
        const arrayBuffer = await response.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        contents.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } });
        contents.push({ type: "text", text: "[文件: " + fileName + "]" });
      } else {
        const text = await response.text();
        const trimmed = text.substring(0, 15000);
        contents.push({ type: "text", text: "=== " + fileName + " ===\n" + trimmed + (text.length > 15000 ? "\n...[已截断]" : "") });
      }
    } catch (e) {
      contents.push({ type: "text", text: "[无法读取: " + fileName + "]" });
    }
  }

  contents.push({ type: "text", text: instruction });

  const result = await withLock(userId, async function() {
    const systemPrompt = await buildSystemPrompt(userId, instruction);
    const res = await anthropic.messages.create({
      model: MAIN_MODEL, max_tokens: 8192, system: systemPrompt,
      messages: [{ role: "user", content: contents }]
    });
    return (res.content[0] || {}).text || "无法分析文件。";
  });

  if (result) {
    await saveMessage(userId, "user", "[" + docs.length + " 个文件] " + instruction);
    await saveMessage(userId, "assistant", result);
    await sendLongMessage(ctx, result);
  }
}

bot.on("document", async function(ctx) {
  const doc = ctx.message && ctx.message.document;
  if (!doc) return;
  const mime = doc.mime_type || "";
  const mediaGroupId = ctx.message.media_group_id;

  // Handle media groups (multiple files sent together)
  if (mediaGroupId) {
    if (!mediaGroupCache.has(mediaGroupId)) {
      mediaGroupCache.set(mediaGroupId, { docs: [], caption: ctx.message.caption || "", userId: ctx.from.id, ctx });
      // Wait for all files in the group, then process
      setTimeout(async function() {
        const group = mediaGroupCache.get(mediaGroupId);
        mediaGroupCache.delete(mediaGroupId);
        if (!group || group.docs.length === 0) return;
        await processMultipleDocs(group.ctx, group.userId, group.docs, group.caption);
      }, MEDIA_GROUP_WAIT_MS);
    }
    mediaGroupCache.get(mediaGroupId).docs.push(doc);
    return;
  }

  if (mime === "application/pdf") {
    const userId = ctx.from.id;
    await ctx.sendChatAction("upload_document");
    try {
      const fileLink = await withRetry(function() { return ctx.telegram.getFileLink(doc.file_id); });
      const response = await fetch(fileLink.href);
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      await ctx.sendChatAction("typing");
      const caption = ctx.message.caption || "请分析这份 PDF 文档，给我摘要和关键要点。";
      const result = await withLock(userId, async function() {
        const systemPrompt = await buildSystemPrompt(userId, caption);
        const pdfResponse = await anthropic.messages.create({
          model: MAIN_MODEL,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: "user", content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: caption }
          ]}]
        });
        return (pdfResponse.content[0] || {}).text || "无法分析此 PDF。";
      });
      if (result) {
        await saveMessage(userId, "user", "[PDF: " + (doc.file_name || "document.pdf") + "] " + caption);
        await saveMessage(userId, "assistant", result);
        await sendLongMessage(ctx, result);
      }
    } catch (err) {
      console.error("PDF error:", err.message);
      await ctx.reply("PDF 处理失败: " + err.message);
    }
  } else {
    // Handle text-based files: log, txt, csv, json, js, py, etc
    const textMimes = ["text/", "application/json", "application/javascript", "application/x-python"];
    const textExts = [".log", ".txt", ".csv", ".json", ".js", ".py", ".ts", ".sh", ".md", ".yaml", ".yml", ".env", ".cjs", ".mjs"];
    const fileName = doc.file_name || "";
    const isTextFile = textMimes.some(function(m) { return mime.startsWith(m); }) ||
                       textExts.some(function(e) { return fileName.toLowerCase().endsWith(e); });

    if (isTextFile) {
      const userId = ctx.from.id;
      await ctx.sendChatAction("typing");
      try {
        const fileLink = await withRetry(function() { return ctx.telegram.getFileLink(doc.file_id); });
        const response = await fetch(fileLink.href);
        const text = await response.text();
        
        // Check if in fix mode
        const fixTask = pendingFix.get(userId);
        if (fixTask && fixTask.waiting && fixTask.instructions) {
          return await processFileFix(ctx, userId, fileName, text, fixTask.instructions);
        }
        const caption = ctx.message.caption || "";
        // .py with caption = auto fix; .py without caption = auto analyze
        if (fileName.endsWith(".py") || fileName.endsWith(".js") || fileName.endsWith(".ts") || fileName.endsWith(".cjs")) {
          if (caption && caption.length > 3) {
            return await processFileFix(ctx, userId, fileName, text, caption);
          } else {
            return await autoAnalyzeAndFix(ctx, userId, fileName, text);
          }
        }
        const fileInstruction = caption || "分析这个文件，找出关键信息、错误或问题。";

        // Truncate if too long
        const CHUNK_SIZE = 30000;
        const systemPrompt = await buildSystemPrompt(userId, caption);

        const result = await withLock(userId, async function() {
          // If file fits in one chunk, process directly
          if (text.length <= CHUNK_SIZE) {
            const res = await anthropic.messages.create({
              model: MAIN_MODEL, max_tokens: 8192, system: systemPrompt,
              messages: [{ role: "user", content: "文件名: " + fileName + "\n\n文件内容:\n" + text + "\n\n" + fileInstruction }]
            });
            return (res.content[0] || {}).text || "无法分析此文件。";
          }

          // Split into chunks and process each
          const chunks = [];
          for (let i = 0; i < text.length; i += CHUNK_SIZE) {
            chunks.push(text.substring(i, i + CHUNK_SIZE));
          }
          await ctx.reply("文件较大，分 " + chunks.length + " 段处理中...");

          const chunkResults = [];
          for (let i = 0; i < chunks.length; i++) {
            await ctx.sendChatAction("typing");
            const res = await anthropic.messages.create({
              model: MAIN_MODEL, max_tokens: 4096, system: systemPrompt,
              messages: [{ role: "user", content: "文件名: " + fileName + " (第 " + (i+1) + "/" + chunks.length + " 段)\n\n内容:\n" + chunks[i] + "\n\n请分析这段内容的关键信息。" }]
            });
            chunkResults.push("【第 " + (i+1) + " 段分析】\n" + ((res.content[0] || {}).text || ""));
          }

          // Merge results
          if (chunks.length === 1) return chunkResults[0];
          const mergeRes = await anthropic.messages.create({
            model: MAIN_MODEL, max_tokens: 8192, system: systemPrompt,
            messages: [{ role: "user", content: "以下是文件 " + fileName + " 分段分析结果，请综合总结：\n\n" + chunkResults.join("\n\n") + "\n\n" + caption }]
          });
          return (mergeRes.content[0] || {}).text || chunkResults.join("\n\n");
        });

        if (result) {
          await saveMessage(userId, "user", "[文件: " + fileName + "] " + caption);
          await saveMessage(userId, "assistant", result);
          await sendLongMessage(ctx, result);
        }
      } catch (err) {
        console.error("File error:", err.message);
        await ctx.reply("文件处理失败: " + err.message);
      }
    } else {
      await ctx.reply("暂不支持此文件格式。支持：PDF、log、txt、csv、json、js、py 等文字文件。");
    }
  }
});

// ── 启动 ──────────────────────────────────────────────────────────────────────
async function launch() {
  if (WEBHOOK_URL) {
    const app = express();
    app.use(express.json());
    app.use(bot.webhookCallback("/webhook"));
    app.get("/", function(_req, res) { res.send("Claude AI Bot v5 - Running!"); });
    await bot.telegram.setWebhook(WEBHOOK_URL + "/webhook");
    app.listen(PORT, function() {
      console.log("Webhook running on port " + PORT);
      console.log("Webhook set to " + WEBHOOK_URL + "/webhook");
    });
  } else {
    await bot.launch();
    console.log("Bot running in polling mode");
  }
}

// Set bot command menu
bot.telegram.setMyCommands([
  { command: "memory", description: "📊 完整记忆总览" },
  { command: "soul", description: "👤 查看 soul.md" },
  { command: "projects", description: "📁 查看项目" },
  { command: "tasks", description: "✅ 查看任务" },
  { command: "notes", description: "📝 查看笔记" },
  { command: "note", description: "📝 添加笔记" },
  { command: "summaries", description: "📋 查看对话摘要" },
  { command: "setsoul", description: "✏️ 更新 soul.md" },
  { command: "setprojects", description: "✏️ 更新项目" },
  { command: "settasks", description: "✏️ 更新任务" },
  { command: "imagine", description: "🎨 AI 图片生成 /imagine [描述]" },
  { command: "fix", description: "🔧 修改现有代码文件" },
  { command: "save", description: "💾 保存代码版本 /save v11" },
  { command: "versions", description: "📦 查看所有保存版本" },
  { command: "load", description: "📂 加载代码版本 /load v11" },
  { command: "vibe", description: "🚀 建完整项目并推送 GitHub" },
  { command: "vibestop", description: "⏹ 退出 Vibe 模式" },
  { command: "deploy", description: "🚀 自动部署到 Railway" },
  { command: "weekly", description: "📊 本周活动总结" },
  { command: "stats", description: "📊 Token 使用统计和费用" },
  { command: "pipeline", description: "🤖 手动触发赏金扫描" },
  { command: "pipelinestatus", description: "📡 查看 Pipeline 状态" },
  { command: "forget", description: "🗑 清除对话历史" },
  { command: "reset", description: "⚠️ 清除所有内容" },
  { command: "help", description: "❓ 查看所有命令" }
]).catch(console.error);

// PDF 文件处理
bot.on(["message"], async function(ctx) {
  const doc = ctx.message && ctx.message.document;
  if (!doc) return;
  const mime = doc.mime_type || "";
  if (mime !== "application/pdf") return;

  const userId = ctx.from.id;
  await ctx.sendChatAction("upload_document");

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const response = await fetch(fileLink.href);
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    await ctx.sendChatAction("typing");
    const caption = ctx.message.caption || "请分析这份 PDF 文档，给我摘要和关键要点。";

    const result = await withLock(userId, async function() {
      const systemPrompt = await buildSystemPrompt(userId, caption);
      const pdfResponse = await anthropic.messages.create({
        model: MAIN_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: base64 }
            },
            { type: "text", text: caption }
          ]
        }]
      });
      return (pdfResponse.content[0] || {}).text || "无法分析此 PDF。";
    });

    if (result) {
      await saveMessage(userId, "user", "[PDF: " + (doc.file_name || "document.pdf") + "] " + caption);
      await saveMessage(userId, "assistant", result);
      await sendLongMessage(ctx, result);
    }
  } catch (err) {
    console.error("PDF error:", err.message);
    await ctx.reply("PDF 处理失败: " + err.message);
  }
});


// ── 监听赏金 Channel ────────────────────────────────────────────────────────────
const BOUNTY_CHANNEL_ID = -1003866555410;
const processedChannelPosts = new Set(); // prevent duplicate processing

bot.on("channel_post", async function(ctx) {
  const post = ctx.channelPost;
  if (!post || !post.text) return;

  // Bug fix 1: chat.id is a number, compare correctly
  if (String(ctx.chat.id) !== String(BOUNTY_CHANNEL_ID)) return;
  if (!PIPELINE_ENABLED || !PIPELINE_OWNER) return;

  // Bug fix 2: deduplicate by message_id
  const msgId = post.message_id;
  if (processedChannelPosts.has(msgId)) return;
  processedChannelPosts.add(msgId);
  if (processedChannelPosts.size > 500) {
    const first = processedChannelPosts.values().next().value;
    processedChannelPosts.delete(first);
  }

  const text = post.text;
  if (!text.includes("新增高价值 Bounty") && !text.includes("NEW")) return;

  console.log("New bounty from channel:", text.substring(0, 80));

  try {
    const lines = text.split("\n");

    // Bug fix 3: strip emoji properly with regex fallback
    const getLine = function(emoji) {
      const line = lines.find(function(l) { return l.includes(emoji); }) || "";
      return line.replace(emoji, "").trim();
    };

    const title = getLine("📌");
    const reward = getLine("💰");
    const typeRaw = getLine("🏷");

    // Bug fix 4: extract URL more reliably
    const urlMatch = text.match(/https?:\/\/[^ \t\r\n]+/);
    const url = urlMatch ? urlMatch[0] : "";

    if (!title || !url) {
      console.log("Skipping - missing title or URL");
      return;
    }

    // Region filter
    const regionLine = lines.find(function(l) { return l.includes("📍"); }) || "";
    const region = regionLine.replace("📍", "").trim().toLowerCase();
    if (region && !PIPELINE_REGIONS.some(function(r) { return region.includes(r); })) {
      console.log("Skipping region:", region);
      return;
    }

    const bounty = {
      id: "channel_" + msgId,
      title: title,
      reward: reward,
      type: typeRaw.toLowerCase(),
      url: url,
      description: text,
      platform: "BountyMonitor"
    };

    // Bug fix 5: scoring can fail, handle gracefully
    let scoring;
    try {
      scoring = await scoreBounty(bounty);
    } catch (e) {
      scoring = { score: 5, type: "unknown", reason: "scoring failed", deliverable: "see link" };
    }

    const chatId = parseInt(PIPELINE_OWNER);

    await bot.telegram.sendMessage(chatId,
      "🔔 新赏金 — ⭐ " + scoring.score + "/10\n" +
      "📌 " + bounty.title + "\n" +
      "💰 " + bounty.reward + "\n" +
      "📋 " + scoring.type + " | 🎯 " + (scoring.deliverable || "?") + "\n" +
      "💡 " + (scoring.reason || "") + "\n" +
      "🔗 " + bounty.url
    );

    if (scoring.score >= 7) {
      await executeBounty(bounty, scoring, bot, chatId);
    }
  } catch (err) {
    console.error("Channel bounty error:", err.message);
  }
});

// Global error handler - prevent Bot from crashing on unhandled errors
process.on("unhandledRejection", function(err) {
  console.error("Unhandled rejection:", err && err.message ? err.message : err);
});
process.on("uncaughtException", function(err) {
  console.error("Uncaught exception:", err && err.message ? err.message : err);
});

process.once("SIGINT", function() { 
  try { bot.stop("SIGINT"); } catch(e) { process.exit(0); }
});
process.once("SIGTERM", function() { 
  try { bot.stop("SIGTERM"); } catch(e) { process.exit(0); }
});

// ── 全自动赏金 Pipeline ────────────────────────────────────────────────────────

const seenBounties = new Set(); // NOTE: resets on restart, bounties seen before restart will re-evaluate
const PIPELINE_OWNER = process.env.PIPELINE_OWNER_ID;
const PIPELINE_HOURS = process.env.PIPELINE_HOURS
  ? process.env.PIPELINE_HOURS.split(",").map(function(h) { return parseInt(h.trim()); })
  : null; // null = run anytime

const PIPELINE_REGIONS = process.env.PIPELINE_REGIONS
  ? process.env.PIPELINE_REGIONS.toLowerCase().split(",").map(function(r) { return r.trim(); })
  : ["global", "全球", "worldwide", "international", "online", "remote"]; // your Telegram user ID
const PIPELINE_ENABLED = process.env.PIPELINE_ENABLED === "true";

// Scan Superteam bounties
async function scanSuperteam() {
  try {
    const res = await fetch("https://earn.superteam.fun/api/listings/?type=bounty&status=open&take=20", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const data = await res.json();
    const items = data.data || data.listings || data || [];
    return items.map(function(b) {
      return {
        id: "superteam_" + (b.id || b.slug),
        title: b.title || b.name,
        url: "https://earn.superteam.fun/listings/" + (b.slug || b.id),
        reward: b.rewardAmount || b.reward || 0,
        currency: b.token || "USDC",
        type: b.type || "bounty",
        deadline: b.deadline,
        description: b.description || b.shortDescription || "",
        platform: "Superteam"
      };
    });
  } catch (err) {
    console.error("Superteam scan error:", err.message);
    return [];
  }
}




// Scan GitHub Bounties
async function scanGitHub() {
  try {
    const res = await fetch("https://api.github.com/search/issues?q=label:bounty+state:open&sort=created&per_page=20", {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/vnd.github.v3+json" }
    });
    const data = await res.json();
    const items = data.items || [];
    return items.map(function(b) {
      return {
        id: "github_" + b.id,
        title: b.title,
        url: b.html_url,
        reward: 0, currency: "USD", type: "dev",
        deadline: null,
        description: b.body ? b.body.substring(0, 300) : "",
        platform: "GitHub"
      };
    });
  } catch (err) { console.error("GitHub scan error:", err.message); return []; }
}

// Scan HackQuest
async function scanHackQuest() {
  try {
    const res = await fetch("https://www.hackquest.io/api/hackathon/list?page=1&limit=20&status=ongoing", {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    });
    const text = await res.text();
    if (text.trim().startsWith("<")) return [];
    const data = JSON.parse(text);
    const items = data.data || data.list || data.hackathons || [];
    return items.map(function(b) {
      return {
        id: "hackquest_" + (b.id || b.alias),
        title: b.name || b.title,
        url: "https://www.hackquest.io/en/hackathon/" + (b.alias || b.id),
        reward: b.totalPrize || b.prize || 0, currency: "USD", type: "hackathon",
        deadline: b.endTime || b.end_time,
        description: b.description || b.intro || "",
        platform: "HackQuest"
      };
    });
  } catch (err) { console.error("HackQuest scan error:", err.message); return []; }
}

// Scan Devpost
async function scanDevpost() {
  try {
    const res = await fetch("https://devpost.com/api/hackathons?status=open&order_by=prize-amount&per_page=20", {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    });
    const data = await res.json();
    const items = data.hackathons || [];
    return items.map(function(b) {
      return {
        id: "devpost_" + b.id,
        title: b.title,
        url: b.url,
        reward: b.prize_amount || 0, currency: "USD", type: "hackathon",
        deadline: b.submission_period_dates,
        description: b.tagline || "",
        platform: "Devpost"
      };
    });
  } catch (err) { console.error("Devpost scan error:", err.message); return []; }
}

// Scan Immunefi
async function scanImmunefi() {
  try {
    const res = await fetch("https://immunefi.com/explore/?filter=bounty", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const text = await res.text();
    const match = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const bounties = data.props?.pageProps?.bounties || [];
    return bounties.slice(0, 20).map(function(b) {
      return {
        id: "immunefi_" + b.id,
        title: b.project,
        url: "https://immunefi.com/bounty/" + b.id,
        reward: b.maximumReward || 0, currency: "USD", type: "audit",
        deadline: null,
        description: b.description || "",
        platform: "Immunefi"
      };
    });
  } catch (err) { console.error("Immunefi scan error:", err.message); return []; }
}

// Scan DoraHacks
async function scanDoraHacks() {
  try {
    const res = await fetch("https://dorahacks.io/api/hackathon/?page=1&page_size=20&status=ongoing", {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://dorahacks.io"
      }
    });
    const text = await res.text();
    if (text.trim().startsWith("<")) {
      console.log("DoraHacks returned HTML, skipping");
      return [];
    }
    const data = JSON.parse(text);
    const items = data.data || data.results || [];
    return items.map(function(b) {
      return {
        id: "dorahacks_" + b.id,
        title: b.title || b.name,
        url: "https://dorahacks.io/hackathon/" + b.id,
        reward: b.total_prize || b.prize_pool || 0,
        currency: "USD",
        type: "hackathon",
        deadline: b.end_time || b.deadline,
        description: b.description || b.intro || "",
        platform: "DoraHacks"
      };
    });
  } catch (err) {
    console.error("DoraHacks scan error:", err.message);
    return [];
  }
}

// Score bounty with Claude
async function scoreBounty(bounty) {
  try {
    const prompt = "Score this bounty opportunity from 1-10 for someone who is a Crypto builder, content creator, and developer.\n\nBounty: " + bounty.title + "\nPlatform: " + bounty.platform + "\nType: " + bounty.type + "\nReward: " + bounty.reward + " " + bounty.currency + "\nDeadline: " + (bounty.deadline || "unknown") + "\nDescription: " + (bounty.description || "").substring(0, 500) + "\n\nScore criteria:\n- High reward = higher score\n- Content/dev tasks = higher score (we can automate)\n- Audit/security = medium score\n- Too technical without clear deliverable = lower score\n- Near deadline = lower score\n\nReply with ONLY a JSON object: {\"score\": 7, \"type\": \"content|dev|audit|hackathon\", \"reason\": \"brief reason\", \"deliverable\": \"what needs to be submitted\"}";

    const res = await anthropic.messages.create({
      model: FAST_MODEL,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }]
    });
    const text = (res.content[0] || {}).text || "{}";
    const clean = text.replace(/```json\n?|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    return { score: 5, type: "unknown", reason: "Could not analyze", deliverable: "unknown" };
  }
}

// Execute bounty based on type
async function executeBounty(bounty, scoring, bot, chatId) {
  try {
    if (scoring.type === "content") {
      await bot.telegram.sendMessage(chatId, "✍️ 开始生成内容类提交...");
      // Fetch full bounty details
      let fullDesc = bounty.description;
      try {
        const pageRes = await fetch(bounty.url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const html = await pageRes.text();
        const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").substring(0, 4000);
        fullDesc = text;
      } catch (e) {}

      const contentRes = await anthropic.messages.create({
        model: MAIN_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: "Write a complete submission for this bounty:\n\nBounty: " + bounty.title + "\nDeliverable: " + scoring.deliverable + "\nDetails: " + fullDesc.substring(0, 2000) + "\n\nWrite in a professional, engaging style. Make it submission-ready." }]
      });
      const content = (contentRes.content[0] || {}).text || "";
      const buf = Buffer.from("BOUNTY: " + bounty.title + "\nURL: " + bounty.url + "\n\n" + content, "utf-8");
      await bot.telegram.sendDocument(chatId, { source: buf, filename: "submission_" + bounty.platform + ".txt" }, { caption: "📄 内容已生成，去这里提交: " + bounty.url });

    } else if (scoring.type === "dev" || scoring.type === "hackathon") {
      await bot.telegram.sendMessage(chatId, "💻 开发类任务 — 用 /vibe 生成项目：\n\n发送: /vibe\n然后描述: " + bounty.title + "\n\n或直接告诉我开始，我帮你生成。");

    } else if (scoring.type === "audit") {
      await bot.telegram.sendMessage(chatId, "🔍 开始代码审计分析...");
      // Try to find code repo from bounty page
      let codeUrl = bounty.url;
      const auditRes = await anthropic.messages.create({
        model: MAIN_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: "Write a professional security audit report outline for:\n\nProject: " + bounty.title + "\nBounty URL: " + bounty.url + "\nDescription: " + bounty.description.substring(0, 1000) + "\n\nInclude: Executive Summary, Scope, Methodology, Common Vulnerability Areas to Check (reentrancy, access control, integer overflow, etc), Risk Assessment Framework, and Reporting Template. Make it ready to use for an actual audit." }]
      });
      const report = (auditRes.content[0] || {}).text || "";
      const buf = Buffer.from("AUDIT REPORT: " + bounty.title + "\nSource: " + bounty.url + "\n\n" + report, "utf-8");
      await bot.telegram.sendDocument(chatId, { source: buf, filename: "audit_" + bounty.platform + ".txt" }, { caption: "🔍 审计报告模板已生成。提交至: " + bounty.url });
    }
  } catch (err) {
    console.error("Execute bounty error:", err.message);
    await bot.telegram.sendMessage(chatId, "执行失败: " + err.message);
  }
}

// Main pipeline function
async function runBountyPipeline(bot) {
  if (!PIPELINE_ENABLED || !PIPELINE_OWNER) return;

  // Check if current hour is allowed
  if (PIPELINE_HOURS) {
    const currentHour = new Date().getUTCHours() + 8; // UTC+8 Malaysia time
    const localHour = currentHour % 24;
    if (!PIPELINE_HOURS.includes(localHour)) {
      console.log("Pipeline skipped - not in allowed hours (current: " + localHour + ":00, allowed: " + PIPELINE_HOURS.join(",") + ")");
      return;
    }
  }

  console.log("Running bounty pipeline...");

  try {
    // Scan all platforms
    const [superteam, dorahacks, github, hackquest, devpost, immunefi] = await Promise.all([
      scanSuperteam(),
      scanDoraHacks(),
      scanGitHub(),
      scanHackQuest(),
      scanDevpost(),
      scanImmunefi()
    ]);

    const allBounties = [...superteam, ...dorahacks, ...github, ...hackquest, ...devpost, ...immunefi];
    const newBounties = allBounties.filter(function(b) { return !seenBounties.has(b.id); });

    if (newBounties.length === 0) {
      console.log("No new bounties found");
      return;
    }

    console.log("Found " + newBounties.length + " new bounties, scoring top 5...");

    // Mark all as seen first to avoid reprocessing
    newBounties.forEach(function(b) { seenBounties.add(b.id); });

    // Filter by region if set
    const regionFiltered = newBounties.filter(function(b) {
      if (!b.description) return true;
      const desc = b.description.toLowerCase();
      return PIPELINE_REGIONS.some(function(r) { return desc.includes(r); });
    });

    // Only score top 5 by reward amount
    const toScore = (regionFiltered.length > 0 ? regionFiltered : newBounties).slice(0, 5);
    const scored = [];
    for (const bounty of toScore) {
      const scoring = await scoreBounty(bounty);
      if (scoring.score >= 7) {
        scored.push({ bounty, scoring });
      }
    }

    if (scored.length === 0) {
      console.log("No high-score bounties found");
      return;
    }

    // Notify and execute top bounties
    const chatId = parseInt(PIPELINE_OWNER);
    await bot.telegram.sendMessage(chatId, "🤖 Pipeline 发现 " + scored.length + " 个高分赏金！");

    for (const { bounty, scoring } of scored.slice(0, 3)) {
      await bot.telegram.sendMessage(chatId,
        "⭐ " + scoring.score + "/10 — " + bounty.title + "\n" +
        "📦 平台: " + bounty.platform + "\n" +
        "💰 奖励: " + bounty.reward + " " + bounty.currency + "\n" +
        "📋 类型: " + scoring.type + "\n" +
        "🎯 需要: " + scoring.deliverable + "\n" +
        "💡 " + scoring.reason + "\n" +
        "🔗 " + bounty.url
      );

      // Auto-execute
      await executeBounty(bounty, scoring, bot, chatId);
      // Wait 3 minutes between each bounty to avoid overload
      const BETWEEN_BOUNTIES_MS = parseInt(process.env.PIPELINE_DELAY_MINS || "3") * 60 * 1000;
      console.log("Waiting " + (BETWEEN_BOUNTIES_MS/60000) + " mins before next bounty...");
      await new Promise(function(r) { setTimeout(r, BETWEEN_BOUNTIES_MS); });
    }

  } catch (err) {
    console.error("Pipeline error:", err.message);
    // If rate limited, wait and the next scheduled run will handle it
    if (err.message && err.message.includes("429")) {
      console.log("Rate limited by Telegram, will retry next cycle");
    }
  }
}

// Manual trigger command

bot.command("stats", async function(ctx) {
  const userId = ctx.from.id;
  let usage = tokenUsage.get(userId) || { input: 0, output: 0, calls: 0 };
  // Load from Supabase for persistent totals
  if (supabase) {
    try {
      const { data } = await supabase.from("conversations")
        .select("content").eq("user_id", parseInt(userId)).eq("role", "stats")
        .order("created_at", { ascending: false }).limit(500);
      if (data && data.length > 0) {
        const totals = data.reduce(function(acc, row) {
          try {
            const d = JSON.parse(row.content);
            acc.input += d.input || 0;
            acc.output += d.output || 0;
            acc.calls += 1;
          } catch(e) {}
          return acc;
        }, { input: 0, output: 0, calls: 0 });
        usage = totals;
      }
    } catch(e) {}
  }
  const cost = estimateCost(usage.input, usage.output);
  const avgInput = usage.calls > 0 ? Math.round(usage.input / usage.calls) : 0;
  const avgOutput = usage.calls > 0 ? Math.round(usage.output / usage.calls) : 0;

  await ctx.reply(
    "📊 Token 使用统计（本次运行）\n\n" +
    "💬 对话次数：" + usage.calls + " 次\n" +
    "📥 输入 tokens：" + usage.input.toLocaleString() + "\n" +
    "📤 输出 tokens：" + usage.output.toLocaleString() + "\n" +
    "💰 估算费用：$" + cost + "\n\n" +
    "📈 平均每次\n" +
    "  输入：" + avgInput + " tokens\n" +
    "  输出：" + avgOutput + " tokens\n\n" +
    (autoOptimize(userId) ? "⚠️ 自动建议\n• " + autoOptimize(userId).join("\n• ") + "\n\n" : "") +
    "💡 省钱建议\n" +
    "• 保持 soul/projects 精简\n" +
    "• 用 /fix 而非重新生成\n" +
    "• 定期 /forget 清历史"
  );
});

bot.command("pipeline", async function(ctx) {
  const userId = ctx.from.id;
  if (!PIPELINE_ENABLED) {
    return ctx.reply("Pipeline 未启用。在 Railway Variables 添加：\nPIPELINE_ENABLED=true\nPIPELINE_OWNER_ID=" + userId);
  }
  await ctx.reply("🤖 手动触发 Pipeline 扫描...");
  runBountyPipeline(bot);
});

bot.command("pipelinestatus", async function(ctx) {
  const userId = ctx.from.id;
  await ctx.reply(
    "Pipeline 状态:\n" +
    "启用: " + (PIPELINE_ENABLED ? "✅" : "❌") + "\n" +
    "你的 ID: " + userId + "\n" +
    "Owner ID: " + (PIPELINE_OWNER || "未设置") + "\n" +
    "已追踪赏金: " + seenBounties.size + " 个\n\n" +
    "要启用自动运行，在 Railway Variables 添加:\n" +
    "PIPELINE_ENABLED=true\n" +
    "PIPELINE_OWNER_ID=" + userId
  );
});

// Start auto pipeline if enabled (every 30 minutes)
setTimeout(function() {
  if (PIPELINE_ENABLED && PIPELINE_OWNER) {
    console.log("Auto pipeline started, running every 30 minutes");
    runBountyPipeline(bot);
    setInterval(function() { runBountyPipeline(bot); }, 30 * 60 * 1000);
  }
}, 60000); // wait 60s after startup to avoid 429

launch().catch(console.error);
