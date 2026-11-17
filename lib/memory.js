// whale-memory 记忆核心 —— 纯逻辑，无 dsh-onebot-qq 依赖，便于单测与移植。
//
// 复刻 qq-bridge socialV2 的记忆模型，落到单个 JSON 文件（原子写）：
//   话题（会话级，3 天不注入）、念头（会话级，过期）、
//   群友印象（全局跨会话，50 条上限）、教训（跨群）、日记（私聊）。
//
// 会话标识 chatKey：group:<群号> / private:<QQ号>，与 dsh-onebot-qq 一致。

import fs from 'node:fs';
import path from 'node:path';

// ── 常量 ────────────────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;
const IMPRESSION_STALE_MS = 7 * DAY_MS; // 印象淘汰：只见过一面且 7 天未出现

// 可调上限：默认值即旧行为；由宿主（子插件 setup / 热改）通过 configureLimits 覆盖，
// 这样控制台里「话题注入天数」「群友印象上限」不再是点了没反应的假开关。
// 后四个以前硬编码在各函数里（话题 12 / 念头 20 / 教训 50 / 每人标签 8），
// 想调只能改代码——现在一起走配置，默认值不变。
const LIMITS = {
  topicDays: 3, impressionCap: 50,
  topicCap: 12, thoughtCap: 20, lessonCap: 50, traitCap: 8,
};

/** 覆盖可调上限（幂等，返回生效值）。非法值忽略，保持上一次的有效值。 */
export function configureLimits(next = {}) {
  const td = Number(next.topicDays);
  if (Number.isFinite(td) && td >= 1) LIMITS.topicDays = Math.min(30, Math.round(td));
  const cap = Number(next.impressionCap);
  if (Number.isFinite(cap) && cap >= 10) LIMITS.impressionCap = Math.min(200, Math.round(cap));
  const tc = Number(next.topicCap);
  if (Number.isFinite(tc) && tc >= 1) LIMITS.topicCap = Math.min(50, Math.round(tc));
  const thc = Number(next.thoughtCap);
  if (Number.isFinite(thc) && thc >= 1) LIMITS.thoughtCap = Math.min(50, Math.round(thc));
  const lc = Number(next.lessonCap);
  if (Number.isFinite(lc) && lc >= 5) LIMITS.lessonCap = Math.min(200, Math.round(lc));
  const trc = Number(next.traitCap);
  if (Number.isFinite(trc) && trc >= 1) LIMITS.traitCap = Math.min(20, Math.round(trc));
  return { ...LIMITS };
}

export function currentLimits() {
  return { ...LIMITS };
}

const topicWindowMs = () => LIMITS.topicDays * DAY_MS;

const CHATKEY_RE = /^(group|private):\d{4,12}$/;
const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

// ── 状态工厂 ────────────────────────────────────────────────────────
export function createState() {
  return {
    version: 1,
    topics: {}, // chatKey -> [{id,text,lastMentionAt,pendingQuestion}]
    thoughts: {}, // chatKey -> [{id,text,motivation,createdAt,expiresAt}]
    impressions: {}, // qq:<uid> -> {uid,name,aliases,traits,interactionCount,lastSeenAt}
    lessons: [], // [{id,text,at,key}]
    diary: {}, // 'YYYY-MM-DD' -> {text,savedAt}
  };
}

export function normalizeState(raw) {
  const s = createState();
  if (!raw || typeof raw !== 'object') return s;
  if (raw.topics && typeof raw.topics === 'object') s.topics = raw.topics;
  if (raw.thoughts && typeof raw.thoughts === 'object') s.thoughts = raw.thoughts;
  if (raw.impressions && typeof raw.impressions === 'object') s.impressions = raw.impressions;
  if (Array.isArray(raw.lessons)) s.lessons = raw.lessons;
  if (raw.diary && typeof raw.diary === 'object') s.diary = raw.diary;
  return s;
}

// ── 持久化（原子写：临时文件 + rename）───────────────────────────────
export function stateFile(dataDir) {
  return path.join(dataDir, 'whale-memory.json');
}

export function loadState(dataDir) {
  const file = stateFile(dataDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return createState(); // 文件不存在 = 首次运行，正常从空态开始
  }
  try {
    return normalizeState(JSON.parse(text));
  } catch (e) {
    // 解析失败不能静默清零：下一次 persist() 会把整份记忆覆盖成空，且没有第二份拷贝。
    // 先把坏文件改名留档（whale-memory.json.corrupt-<时间戳>），再以空态启动。
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* 改名失败就维持原样 */ }
    console.warn(`[whale-memory] 状态文件解析失败，已留档为 .corrupt-*，本次从空态启动：${e?.message ?? e}`);
    return createState();
  }
}

export function saveState(dataDir, state) {
  const file = stateFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  // 覆盖前留一份上一版（whale-memory.json.bak）：
  // loadState 的 .corrupt-* 只能救「读不出来」，救不了「读出来但是错的」——
  // 比如裁剪误删了一批印象、进程里拿着空态又写回去，原子写照样把好数据盖掉。
  // 每 10 分钟最多刷一次，这样连续写坏时 .bak 停在坏掉之前，而不是跟着一起烂。
  try {
    const bak = file + '.bak';
    let due = true;
    try { due = Date.now() - fs.statSync(bak).mtimeMs > 10 * 60 * 1000; } catch { due = true; }
    if (due && fs.existsSync(file)) fs.copyFileSync(file, bak);
  } catch { /* 备份失败不能挡住主写入 */ }
  fs.renameSync(tmp, file);
}

// ── 会话标识工具 ────────────────────────────────────────────────────
export function validChatKey(key) {
  return CHATKEY_RE.test(String(key || ''));
}
export function isPrivateKey(key) {
  return String(key || '').startsWith('private:');
}
export function lineIdOf(key) {
  const k = String(key || '');
  if (k.startsWith('private:')) return k.slice('private:'.length);
  if (k.startsWith('group:')) return k.slice('group:'.length);
  return k;
}

// ── 记忆 CRUD ───────────────────────────────────────────────────────
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));

export function appendMemory(state, { category, chatKey, content, extra = {} }, now = Date.now()) {
  const text = String(content || '').trim();
  if (!text) return { ok: false, error: '内容为空' };

  if (category === 'topic') {
    const key = String(chatKey || '');
    if (!validChatKey(key)) return { ok: false, error: '会话标识无效' };
    const arr = state.topics[key] || (state.topics[key] = []);
    arr.push({
      id: newId(),
      text: text.slice(0, 400),
      lastMentionAt: now,
      pendingQuestion: extra.pendingQuestion ? String(extra.pendingQuestion).slice(0, 200) : undefined,
    });
    // 上限走配置（默认 12）：超了按 lastMentionAt 升序淘汰最旧的
    if (arr.length > LIMITS.topicCap) arr.sort((a, b) => (a.lastMentionAt || 0) - (b.lastMentionAt || 0)).splice(0, arr.length - LIMITS.topicCap);
    return { ok: true, category, chatKey: key };
  }

  if (category === 'thought') {
    const key = String(chatKey || '');
    if (!validChatKey(key)) return { ok: false, error: '会话标识无效' };
    const arr = state.thoughts[key] || (state.thoughts[key] = []);
    // ttlMs 非法（NaN / ≤0）回默认 24h：以前会被 clamp 压成下限 1 分钟，念头立刻过期
    const ttlRaw = Number(extra.ttlMs);
    const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0
      ? clamp(ttlRaw, 60 * 1000, 30 * 24 * 60 * 60 * 1000)
      : 24 * 60 * 60 * 1000;
    arr.push({
      id: newId(),
      text: text.slice(0, 400),
      motivation: extra.motivation ? String(extra.motivation).slice(0, 80) : undefined,
      createdAt: now,
      expiresAt: now + ttl,
    });
    if (arr.length > LIMITS.thoughtCap) arr.splice(0, arr.length - LIMITS.thoughtCap);
    return { ok: true, category, chatKey: key };
  }

  if (category === 'impression') {
    // 印象全局：按 QQ 号归档，键 qq:<uid>
    const uid = String(extra.uid || '').trim();
    if (!/^\d{4,12}$/.test(uid)) return { ok: false, error: '印象需要有效 QQ 号（extra.uid）' };
    const key = `qq:${uid}`;
    const old = state.impressions[key] || {};
    const traits = Array.isArray(old.traits) ? old.traits.slice() : [];
    if (traits.length >= LIMITS.traitCap) traits.splice(0, traits.length - (LIMITS.traitCap - 1)); // 每人最多 traitCap 条标签
    traits.push(text.slice(0, 200));
    state.impressions[key] = {
      uid,
      name: extra.name ? String(extra.name).slice(0, 40) : (old.name || ''),
      aliases: Array.isArray(old.aliases) ? old.aliases : [],
      traits,
      interactionCount: (Number(old.interactionCount) || 0) + 1,
      lastSeenAt: now,
    };
    capImpressions(state, now);
    return { ok: true, category, key };
  }

  if (category === 'lesson') {
    state.lessons.push({ id: newId(), text: text.slice(0, 400), at: now, key: String(chatKey || '') });
    if (state.lessons.length > LIMITS.lessonCap) state.lessons.splice(0, state.lessons.length - LIMITS.lessonCap);
    return { ok: true, category };
  }

  return { ok: false, error: `未知类别：${category}` };
}

export function removeMemory(state, { category, chatKey, content, id }) {
  const findAndRemove = (list) => {
    if (!Array.isArray(list)) return { removed: 0, candidates: [] };
    const before = list.length;
    let after = list;
    if (id) {
      after = list.filter((x) => String(x?.id || '') !== String(id));
    } else if (content) {
      const t = String(content).trim();
      after = list.filter((x) => String(x?.text || '') !== t);
    }
    return { removed: before - after.length, candidates: after };
  };

  if (category === 'topic' || category === 'thought') {
    const key = String(chatKey || '');
    if (!validChatKey(key)) return { ok: false, error: '会话标识无效' };
    const bucket = category === 'topic' ? state.topics : state.thoughts;
    const arr = bucket[key];
    if (!arr) return { ok: true, removed: 0 };
    const r = findAndRemove(arr);
    if (!id && !content) return { ok: false, error: '需要 content 或 id' };
    if (r.removed === 0 && content) {
      // 文本没精确匹配时返回候选，不删
      const candidates = arr.filter((x) => String(x?.text || '').includes(String(content).trim()));
      return { ok: false, error: '没找到完全匹配的条目，可传 id 再删', candidates: candidates.map((x) => ({ id: x.id, text: x.text })) };
    }
    bucket[key] = r.candidates;
    return { ok: true, removed: r.removed };
  }

  if (category === 'impression') {
    // 按 qq:uid 或昵称匹配（id 优先，其次 content；以前包了一层 extra_target_of，多余）
    const target = String(id || content || '').trim();
    const keys = Object.keys(state.impressions);
    const hitKey = keys.find((k) => k === target || k === `qq:${target}`);
    let removed = 0;
    if (hitKey) {
      delete state.impressions[hitKey];
      removed = 1;
    } else {
      const nameHit = keys.find((k) => String(state.impressions[k]?.name || '') === target);
      if (nameHit) { delete state.impressions[nameHit]; removed = 1; }
    }
    if (!removed) return { ok: false, error: `没找到「${target}」这条印象` };
    return { ok: true, removed };
  }

  if (category === 'lesson') {
    const before = state.lessons.length;
    if (id) state.lessons = state.lessons.filter((x) => x.id !== id);
    else if (content) state.lessons = state.lessons.filter((x) => x.text !== String(content).trim());
    else return { ok: false, error: '需要 content 或 id' };
    return { ok: true, removed: before - state.lessons.length };
  }

  return { ok: false, error: `未知类别：${category}` };
}

// ── 日记 ────────────────────────────────────────────────────────────
export function saveDiary(state, { date, text, key = '', topics = '' }, now = Date.now()) {
  const d = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: '日期需为 YYYY-MM-DD' };
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '日记内容为空' };
  state.diary[d] = {
    text: body.slice(0, 4000),
    savedAt: now,
    // 键与话题只用于「另存 md」时的 frontmatter，查库/注入不依赖它们
    ...(key ? { key: String(key) } : {}),
    ...(topics ? { topics: String(topics) } : {}),
  };
  return { ok: true, date: d };
}

// ── 日记另存 md（2026-11-16）：新系统只写 JSON，旧 qq-bridge 会落 md。
//    这里补回文件镜像：<dir>/<YYYY-MM>/<YYYY-MM-DD>-私聊.md，正文与库内一致。 ──

/** 12~14 号那批日记正文自带 YAML frontmatter，落 md 时要剥掉，避免出现两份 */
export function stripDiaryFrontmatter(text) {
  const s = String(text ?? '').replace(/^\uFEFF/, '');
  return /^---\r?\n[\s\S]*?\r?\n---/.test(s)
    ? s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
    : s.trim();
}

/** 从正文里读回旧的 frontmatter（date/key/topics/writtenAt） */
export function diaryFrontmatterOf(text) {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** 拼出与旧目录同规格的 md 文本 */
export function diaryMarkdown(date, entry = {}) {
  const fm = diaryFrontmatterOf(entry.text);
  const body = stripDiaryFrontmatter(entry.text);
  const key = String(entry.key || fm.key || '').trim();
  const topics = String(entry.topics || fm.topics || '').trim();
  // 老条目正文里的 writtenAt 是写作时间（回填时 savedAt 只是入库时间），优先用它
  const writtenAt = Number(fm.writtenAt) || Number(entry.savedAt) || 0;
  const head = ['---', `date: ${date}`];
  if (key) head.push(`key: ${key}`);
  if (topics) head.push(`topics: ${topics}`);
  if (writtenAt) head.push(`writtenAt: ${writtenAt}`);
  head.push('---', '');
  return `${head.join('\n')}\n${body}\n`;
}

/** 文件路径：<dir>/2026-11/2026-11-16-私聊.md */
export function diaryMirrorPath(dir, date) {
  const m = String(date || '').match(/^(\d{4})-(\d{2})-\d{2}$/);
  const base = String(dir || '').trim();
  if (!m || !base) return '';
  return path.join(base, `${m[1]}-${m[2]}`, `${date}-私聊.md`);
}

export function mirrorDiaryFile(dir, date, entry) {
  const file = diaryMirrorPath(dir, date);
  if (!file || !entry) return { ok: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, diaryMarkdown(date, entry), 'utf8');
  return { ok: true, file };
}

/** 补齐历史：只写还缺的那几天，不覆盖已有文件 */
export function mirrorDiaryFiles(dir, state, { onlyMissing = true } = {}) {
  const out = { written: 0, skipped: 0, failed: 0 };
  if (!String(dir || '').trim()) return out;
  for (const [date, entry] of Object.entries(state?.diary || {})) {
    try {
      const file = diaryMirrorPath(dir, date);
      if (!file) { out.failed += 1; continue; }
      if (onlyMissing && fs.existsSync(file)) { out.skipped += 1; continue; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, diaryMarkdown(date, entry), 'utf8');
      out.written += 1;
    } catch { out.failed += 1; }
  }
  return out;
}

export function recentDiary(state, now = Date.now()) {
  const dates = Object.keys(state.diary).sort().slice(-30); // 最近 30 篇（线上口径，别回退成 7）
  return dates.map((d) => {
    const it = state.diary[d] || {};
    const savedAt = Number(it.savedAt) || 0;
    return { date: d, savedAt: savedAt ? new Date(savedAt).toISOString() : null, text: it.text };
  }).reverse();
}

// ── 遗忘机制 ────────────────────────────────────────────────────────
export function capImpressions(state, now = Date.now()) {
  const entries = Object.entries(state.impressions);
  if (entries.length <= LIMITS.impressionCap) return 0;
  // 优先淘汰「只见过一面且 7 天未出现」，其次按 lastSeenAt 最旧
  entries.sort((a, b) => {
    const aStale = (Number(a[1]?.interactionCount) || 0) <= 1 && now - (Number(a[1]?.lastSeenAt) || 0) > IMPRESSION_STALE_MS ? 1 : 0;
    const bStale = (Number(b[1]?.interactionCount) || 0) <= 1 && now - (Number(b[1]?.lastSeenAt) || 0) > IMPRESSION_STALE_MS ? 1 : 0;
    if (aStale !== bStale) return bStale - aStale;
    return (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0);
  });
  const drop = entries.length - LIMITS.impressionCap;
  for (const [k] of entries.slice(0, drop)) delete state.impressions[k];
  return drop;
}

// ── 记忆快照（复刻 socialV2 formatMemoryV2 的四块分块注入）──────────
export function formatMemorySnapshot(state, chatKey, focusText = '', now = Date.now()) {
  if (!state) return '';
  const blocks = [];
  const focus = String(focusText || '');
  const key = String(chatKey || '');

  const mentioned = (name, im) => {
    if (!focus) return false;
    const uid = String(im?.uid || '').trim();
    if (uid.length >= 5 && new RegExp(`(^|\\D)${uid}(\\D|$)`).test(focus)) return true;
    const names = [im?.name, name].filter(Boolean).map(String);
    if (names.some((n) => n.length >= 2 && focus.includes(n))) return true;
    const aliases = Array.isArray(im?.aliases) ? im.aliases : [];
    return aliases.some((a) => String(a).length >= 2 && focus.includes(String(a)));
  };

  // ① 群友印象（全局，55%）
  const impNames = Object.keys(state.impressions).sort((a, b) => {
    const ma = mentioned(a, state.impressions[a]) ? 1 : 0;
    const mb = mentioned(b, state.impressions[b]) ? 1 : 0;
    if (ma !== mb) return mb - ma;
    const ia = Number(state.impressions[a]?.interactionCount) || 0;
    const ib = Number(state.impressions[b]?.interactionCount) || 0;
    if (ia !== ib) return ib - ia;
    return (Number(state.impressions[b]?.lastSeenAt) || 0) - (Number(state.impressions[a]?.lastSeenAt) || 0);
  });
  if (impNames.length) {
    const shown = impNames.slice(0, 40);
    // 迁移进来的印象是**整段描述**（不是短标签），一条就能吃掉 300 字 → 快照里必须裁剪，
    // 否则 3300 字预算只装得下六七个人（线上实测就是这么被截断的）。存储本身不动。
    const clipTrait = (s, n) => {
      const t = String(s || '').replace(/\s+/g, ' ').trim();
      return t.length > n ? t.slice(0, n) + '…' : t;
    };
    const lines = shown.map((name) => {
      const im = state.impressions[name] || {};
      const raw = Array.isArray(im.traits) ? im.traits : [];
      const traits = raw.slice(-3).map((t) => clipTrait(t, 36)); // 只取最近 3 条标签，每条 36 字
      const label = im.name ? (im.uid ? `${im.name}（QQ ${im.uid}）` : im.name) : (im.uid ? `QQ ${im.uid}` : name);
      return `- ${label}：${traits.length ? traits.join('、') : '暂无记录'}`;
    });
    // 标题里带上**总人数**：否则模型只能数到"被截断的那几个"，回答"总共多少人"永远差一截。
    const head = `【对群友的印象（跨会话共享｜共 ${impNames.length} 人`
      + (impNames.length > shown.length ? `，此处按相关度排前 ${shown.length}` : '')
      + '；每条只留最近 3 条短标签）】';
    // 截断时把"还有多少人没显示"说清楚，并指条查全的路（工具名由上层保证存在）
    const more = impNames.length > shown.length
      ? `\n…（其余 ${impNames.length - shown.length} 人未显示：用 mcp__qq__whale_memory_query 的 q 参数按昵称/QQ/标签查，或 impressions="all" 列全）`
      : '';
    blocks.push({ weight: 100, text: `${head}\n${lines.join('\n')}${more}` });
  }

  // ② 话题（会话级，3 天内，最近 10 条，25%）
  const allTopics = Array.isArray(state.topics[key]) ? state.topics[key].filter((t) => t?.text) : [];
  const topics = allTopics.filter((t) => !t.lastMentionAt || now - Number(t.lastMentionAt) <= topicWindowMs());
  if (topics.length) {
    const lines = topics.slice(-10).map((t) => `- ${t.text}${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
    blocks.push({ weight: 80, text: `【进行中的话题】\n${lines.join('\n')}` });
  }

  // ③ 念头（未过期，10%）
  const thoughts = Array.isArray(state.thoughts[key]) ? state.thoughts[key].filter((t) => t?.text && (!t.expiresAt || now < t.expiresAt)) : [];
  if (thoughts.length) {
    const lines = thoughts.slice(-10).map((t) => `- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
    blocks.push({ weight: 40, text: `【你想说但还没说的】\n${lines.join('\n')}` });
  }

  // ④ 教训（跨群，全局）
  if (state.lessons.length) {
    const lines = state.lessons.slice(-15).map((l) => `- ${l.text}`);
    blocks.push({ weight: 60, text: `【主人的教训（跨群通用）】\n${lines.join('\n')}` });
  }

  // ⑤ 群近况（仅私聊，10%）
  if (isPrivateKey(key)) {
    const groupLines = [];
    for (const [gk, arr] of Object.entries(state.topics)) {
      if (!String(gk).startsWith('group:') || !Array.isArray(arr)) continue;
      const live = arr.filter((t) => t?.text && (!t.lastMentionAt || now - Number(t.lastMentionAt) <= topicWindowMs()));
      if (!live.length) continue;
      groupLines.push(`- ${String(gk).replace('group:', '群')}：${live.slice(-3).map((t) => String(t.text).slice(0, 40)).join('；')}`);
    }
    if (groupLines.length) blocks.push({ weight: 20, text: `【群里的近况】\n${groupLines.join('\n')}` });
  }

  // 分块预算：印象 55% / 话题 25% / 教训 10% / 念头 5% / 群近况 5%（各块不互相借）
  // 比例合计必须 = 1：以前 40 与 20 两个权重各给 0.1，五块齐全时预算合计 1.1，
  // 6000 字的总预算实际能吃到 6600。低权重的两块各让 5% 出来，默认值下的观感不变。
  const share = { 100: 0.55, 80: 0.25, 60: 0.1, 40: 0.05, 20: 0.05 };
  const budget = 6000; // 约 6000 字总预算，防记忆吃光上下文
  // 按**行**截断：历史上是字符硬切，会把某条印象/话题切成半句（模型看到「第 7 条只到『隐』」就是这么来的）。
  const trim = (b) => {
    const limit = Math.floor(budget * (share[b.weight] || 0.1));
    if (b.text.length <= limit) return b.text;
    const cut = b.text.slice(0, limit);
    const nl = cut.lastIndexOf('\n');
    const kept = nl > 0 ? cut.slice(0, nl) : cut;
    const dropped = b.text.slice(kept.length).split('\n').filter((l) => l.trim()).length;
    return kept + `\n…（本块还有约 ${dropped} 行未显示，属条目级截断：用 mcp__qq__whale_memory_query 查全）`;
  };
  const order = [100, 80, 60, 40, 20];
  return blocks
    .sort((a, b) => order.indexOf(a.weight) - order.indexOf(b.weight))
    .map((b) => trim(b))
    .filter(Boolean)
    .join('\n\n');
}
