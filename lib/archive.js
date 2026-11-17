// lib/archive.js —— 消息归档 + FTS5 全文检索 + 分级降级 + 自动回忆触发。
//
// 复刻 qq-bridge 的 chat-archive + archive.db 检索，但把 dsh 指出的两个坑从设计上规避：
//   ① keywords 与 text 一起进 FTS5 索引 —— 90 天后正文清空，关键词仍能搜到；
//   ② 触发词收窄 —— 不用「那个/有没有/是不是」这类日常词，避免每句都触发检索。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// node:sqlite 是 Node 22.5 才有的实验特性。写成静态 import 的话，老 Node 在**模块加载期**
// 就抛错，index.js 那圈「归档库打不开也不影响记忆」的 try/catch 根本轮不到，整个插件都装不上。
// 改成惰性 require：拿不到就把 DatabaseSync 留空，openArchive 抛一条能看懂的错。
let DatabaseSync = null;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch { DatabaseSync = null; }

const DAY = 24 * 60 * 60 * 1000;
const TEXT_MAX = 300;          // 每条消息正文截断
const FULL_CHARS = 90;         // 0–30 天：回忆最多 90 字
const FADED_CHARS = 18;        // 30–90 天：回忆打折到 18 字
const FADE_DAYS = 30;          // 30 天后回忆打折
const COMPACT_DAYS = 90;       // 90 天后正文清空，只留关键词

// 收窄后的回忆触发词（不含「那个/有没有/是不是」）
const RECALL_CUE_RE = /上次|之前|那次|以前|记得|回忆|说过|聊过|提到|问过|昨天|昨晚|昨夜|前天|上周|上个星期/;
const DAY_OFFSET_RE = { 前天: 2, 上周: 7, 上个星期: 7 };

export function openArchive(dataDir) {
  if (!DatabaseSync) throw new Error('当前 Node 不支持 node:sqlite（需 ≥22.5），归档与检索功能不可用');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'archive.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS msg (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      t INTEGER NOT NULL,
      self INTEGER DEFAULT 0,
      sender TEXT,
      text TEXT,
      keywords TEXT,
      compacted INTEGER DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
      text, keywords, content='msg', content_rowid='id', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS msg_ai AFTER INSERT ON msg BEGIN
      INSERT INTO msg_fts(rowid, text, keywords) VALUES (new.id, new.text, new.keywords);
    END;
    CREATE TRIGGER IF NOT EXISTS msg_ad AFTER DELETE ON msg BEGIN
      INSERT INTO msg_fts(msg_fts, rowid, text, keywords) VALUES('delete', old.id, old.text, old.keywords);
    END;
    CREATE TRIGGER IF NOT EXISTS msg_au AFTER UPDATE ON msg BEGIN
      INSERT INTO msg_fts(msg_fts, rowid, text, keywords) VALUES('delete', old.id, old.text, old.keywords);
      INSERT INTO msg_fts(rowid, text, keywords) VALUES (new.id, new.text, new.keywords);
    END;
  `);
  return db;
}

// ── 写入：每条消息正文截断 300 字，同步进 FTS 索引（text + keywords）────────
export function appendMessage(db, { key, t, self, sender, text }) {
  const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
  if (!body) return null;
  const r = db.prepare('INSERT INTO msg (key, t, self, sender, text) VALUES (?,?,?,?,?)')
    .run(String(key), Number(t) || Date.now(), self ? 1 : 0, String(sender || ''), body);
  invalidateSearchCache(); // 新消息入库，清掉旧检索缓存
  return Number(r.lastInsertRowid);
}

// ── 关键词提取（简单 2-gram 频率，压缩时用；不追求分词精度，够存档用）──────
export function extractKeywords(text, n = 4) {
  const t = String(text || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
  const freq = new Map();
  for (let i = 0; i + 1 < t.length; i++) {
    const g = t.slice(i, i + 2);
    if (/[\u4e00-\u9fff]{2}/.test(g)) freq.set(g, (freq.get(g) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

// ── 压缩：超过 N 天（默认 90）的消息正文清空，只留关键词（关键词仍进 FTS，可搜）──
export function compactArchive(db, now = Date.now(), compactDays = COMPACT_DAYS) {
  const days = Math.max(1, Math.min(3650, Number(compactDays) || COMPACT_DAYS));
  const cutoff = now - days * DAY;
  const rows = db.prepare('SELECT id, text FROM msg WHERE compacted = 0 AND t < ?').all(cutoff);
  const upd = db.prepare('UPDATE msg SET text = ?, keywords = ?, compacted = 1 WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const kw = extractKeywords(r.text, 4);
    // 抽不出关键词（纯标点 / 表情 / 单个字母）也要标 compacted=1：
    // 否则它每天都被重新选中、正文永远压不掉，全表扫描也永远省不下。
    upd.run('', kw.join(' '), r.id);
    n++;
  }
  return n;
}

// ── 检索：FTS5（≥3 字）→ 2-gram IDF 打分兜底（2 字）──────────────────
// ── 检索辅助：2-gram 提取（复刻 qq-bridge，含英文词）──────────────────
function toGrams(text) {
  const t = String(text || '').toLowerCase().replace(/[\s\p{P}]/gu, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2));
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []) set.add(w);
  return set;
}

// 把用户整句消息切成可检索 token（≥2 字，长词优先）
function tokenize(query) {
  return [...new Set(
    String(query || '').split(/[^\u4e00-\u9fffa-zA-Z0-9]+/).filter((x) => x.length >= 2),
  )].sort((a, b) => b.length - a.length).slice(0, 8);
}

// text 与 keywords 各自独立 2-gram，避免 keywords 空格拼接后产生跨边界伪 gram
function gramsOf(e) {
  const set = toGrams(e.text || '');
  if (e.keywords) {
    for (const kw of String(e.keywords).split(/\s+/)) {
      if (!kw) continue;
      for (const g of toGrams(kw)) set.add(g);
    }
  }
  return set;
}

// 进程内检索缓存（30 秒 TTL）：同会话高频触发时避免重复全量打分
const _searchCache = new Map();
function cacheGet(ck) {
  const h = _searchCache.get(ck);
  if (h && Date.now() - h.t < 30000) return h.hits;
  return null;
}
function cacheSet(ck, hits) {
  _searchCache.set(ck, { t: Date.now(), hits });
  if (_searchCache.size > 300) _searchCache.delete(_searchCache.keys().next().value);
}
export function invalidateSearchCache() {
  _searchCache.clear();
}

// 打分兜底：排除最近 N 条（避免把刚说的话当旧话注入），并按 t 倒序限量（避免全量扫描堵 DSH 主进程）
const SKIP_RECENT = 40;
const POOL_LIMIT = 2000;

// 2-gram IDF 打分（同会话检索与跨群检索共用一份，避免两处阈值漂移）
function gramRank(pool, q, qGrams, gramsCache, df, qWords = new Set()) {
  const idf = (x) => Math.log(1 + pool.length / (1 + (df.get(x) || 0)));
  const fuzzy = /上次|之前|那次|以前/.test(q); // 收窄：不含「那个」
  // 分数门槛不能是绝对值：IDF 随候选池大小缩水，池子里只有 1 条消息时
  // 单个 gram 最高只能得 ln2≈0.69，固定门槛 0.6 会把它判死（以前靠字面 LIKE 兜着）。
  // 取「理论最高分的一半」与基础门槛的较小值，小池子自动放宽，大池子不变。
  const maxScore = [...qGrams].reduce((s) => s + Math.log(1 + pool.length), 0);
  const need = Math.min(
    Math.min((fuzzy ? 1 : 2) * 1.2, qGrams.size * 0.6),
    maxScore * 0.5,
  );
  // 以前的毛病：2 字查询只有 1 个 bigram，门槛 min(2.4, 0.6)=0.6，
  // 比「这个 bigram 条条消息都有」时的 idf 下限 ln2≈0.69 还低 —— 于是命中任何一条，
  // 「我们」「那个」这种词能把一堆不相干的旧话拖进回忆。
  // 这里不按覆盖率卡（长句查询往往只有一两个片段能对上，卡覆盖率会误杀），
  // 而是要求至少有一个匹配到的 gram 是**有区分度**的：出现 ≥3 次且覆盖不超过半个候选池；
  // 2 字查询再严到 30%——它只有这一个 gram，全靠它撑。
  const shortQuery = qGrams.size === 1;
  const isInformative = (x) => {
    const n = df.get(x) || 0;
    if (n < 3) return true; // 只出现过一两次，谈不上「常见」
    const ratio = n / pool.length;
    if (ratio > 0.5) return false;
    return !(shortQuery && ratio > 0.3);
  };
  const scored = [];
  for (const e of pool) {
    const g = gramsCache.get(e);
    if (!g) continue;
    let score = 0;
    let useful = 0;
    for (const x of qGrams) {
      if (!g.has(x)) continue;
      score += idf(x);
      if (isInformative(x)) useful += 1;
    }
    if (!useful) continue;
    if (qWords.size) {
      const lower = `${e.text || ''} ${e.keywords || ''}`.toLowerCase();
      for (const w of qWords) if (lower.includes(w)) score += 3;
    }
    if (score >= need) scored.push({ e, score });
  }
  return scored;
}

// ── 检索：token 切分 → FTS OR（≥3字）→ 2-gram IDF 打分（唯一兜底）────
export function searchArchive(db, key, query, limit = 3) {
  const q = String(query || '').trim();
  if (!q) return [];
  const limitN = Math.max(1, Math.min(20, limit));
  const ck = `${key}\u0000${q}\u0000${limitN}`;
  const cached = cacheGet(ck);
  if (cached) return cached;
  const hits = _search(db, key, q, limitN);
  cacheSet(ck, hits);
  return hits;
}

function _search(db, key, q, limitN) {
  const tokens = tokenize(q);
  if (!tokens.length) return [];

  // ① FTS OR：≥3 字 token 走 trigram 倒排（整句「上次我们去吃热干面那个店」能拆出「热干面」命中）
  const ftsTokens = tokens.filter((t) => t.length >= 3);
  if (ftsTokens.length) {
    const match = ftsTokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    try {
      const rows = db.prepare(
        `SELECT m.id, m.key, m.t, m.self, m.sender, m.text, m.keywords, m.compacted FROM msg_fts f
         JOIN msg m ON m.id = f.rowid WHERE msg_fts MATCH ? AND m.key = ?
         ORDER BY bm25(msg_fts) LIMIT ?`,
      ).all(match, String(key), limitN);
      if (rows.length) return rows;
    } catch { /* 语法错误走兜底 */ }
  }

  // ② 2-gram IDF 打分兜底：整句 query 与每条消息做二元组重叠加权（keywords 也参与）
  // skipRecent 排除刚说的话；LIMIT 限量避免全量扫描堵 DSH 主进程
  const all = db.prepare(
    'SELECT id, key, t, self, sender, text, keywords, compacted FROM msg WHERE key = ? ORDER BY t DESC LIMIT ?',
  ).all(String(key), POOL_LIMIT);
  const pool = all.slice(Math.min(SKIP_RECENT, Math.max(0, all.length - 5))); // 排除最近 40 条，但至少保留 5 条
  const qGrams = toGrams(q);
  if (qGrams.size >= 1 && pool.length) {
    const df = new Map();
    const gramsCache = new Map();
    for (const e of pool) {
      const g = gramsOf(e);
      if (g.size < 1) continue;
      gramsCache.set(e, g);
      for (const x of qGrams) if (g.has(x)) df.set(x, (df.get(x) || 0) + 1);
    }
    const qWords = new Set(String(q).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
    const scored = gramRank(pool, q, qGrams, gramsCache, df, qWords);
    scored.sort((a, b) => b.score - a.score || b.e.t - a.e.t);
    const seen = new Set();
    const out = [];
    for (const { e } of scored) {
      const sig = `${e.sender}|${(e.text || e.keywords || '').slice(0, 20)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(e);
      if (out.length >= limitN) break;
    }
    if (out.length) return out;
    // 池子非空却一条都没过线：命中的 gram 全是「遍地都是」的，就此打住。
    // 不再往后走字面 LIKE —— LIKE 覆盖的是同一批消息（2-gram 包含关系），
    // 只会把刚被拒掉的短查询原样捞回来，还会把 SKIP_RECENT 特意排除的最近几条带出来。
    return [];
  }

  return [];
}

// ── 跨会话检索（私聊翻群记录），同样走 token 切分 + 打分兜底 ──────────
export function searchArchiveAny(db, query, limit = 3, excludeKey = '') {
  const q = String(query || '').trim();
  if (!q) return [];
  const limitN = Math.max(1, Math.min(20, limit));
  const tokens = tokenize(q);
  if (!tokens.length) return [];

  const ftsTokens = tokens.filter((t) => t.length >= 3);
  if (ftsTokens.length) {
    const match = ftsTokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    try {
      const rows = db.prepare(
        `SELECT m.id, m.key, m.t, m.self, m.sender, m.text, m.keywords, m.compacted FROM msg_fts f
         JOIN msg m ON m.id = f.rowid WHERE msg_fts MATCH ? AND m.key != ?
         ORDER BY bm25(msg_fts) LIMIT ?`,
      ).all(match, excludeKey, limitN);
      if (rows.length) return rows;
    } catch { /* ignore */ }
  }

  const all = db.prepare('SELECT id, key, t, self, sender, text, keywords, compacted FROM msg WHERE key != ? ORDER BY t DESC LIMIT ?').all(excludeKey, POOL_LIMIT);
  const pool = all.slice(Math.min(SKIP_RECENT, Math.max(0, all.length - 5)));
  const qGrams = toGrams(q);
  if (qGrams.size >= 1 && pool.length) {
    const df = new Map();
    const gramsCache = new Map();
    for (const e of pool) {
      const g = gramsOf(e);
      if (g.size < 1) continue;
      gramsCache.set(e, g);
      for (const x of qGrams) if (g.has(x)) df.set(x, (df.get(x) || 0) + 1);
    }
    const scored = gramRank(pool, q, qGrams, gramsCache, df);
    scored.sort((a, b) => b.score - a.score || b.e.t - a.e.t);
    return scored.slice(0, limitN).map((s) => s.e);
  }

  // 与 searchArchive 同理：字面 LIKE 覆盖的仍是同一批消息，跑它只会把
  // 「命中但太常见」的短查询原样捞回来，还会带出 SKIP_RECENT 排除的最近几条。
  return [];
}

// ── 回忆时的降级展示（复刻 dsh 的三段）──────────────────────────────────
export function recallTextOf(e, now = Date.now()) {
  if (e.compacted) {
    return e.keywords ? `（只记得这些关键词：${e.keywords}）` : '';
  }
  const age = now - Number(e.t);
  const body = String(e.text || '');
  if (age > FADE_DAYS * DAY) {
    const short = body.slice(0, FADED_CHARS);
    return short + '（记不清细节了）';
  }
  return body.slice(0, FULL_CHARS);
}

// ── 触发词判断（收窄版）───────────────────────────────────────────────
export function isRecallCue(text, impressionNames = []) {
  const t = String(text || '');
  if (RECALL_CUE_RE.test(t)) return true;
  // 提到印象里的人名（≥2 字）也算「在说某个人」
  return impressionNames.some((n) => n && n.length >= 2 && t.includes(n));
}

export function detectDayOffset(text) {
  const t = String(text || '');
  if (/前天/.test(t)) return 2;
  if (/昨天|昨晚|昨夜/.test(t)) return 1;
  if (/上周|上个星期/.test(t)) return 7;
  return 0;
}

// 按「昨天/前天/上周」取那一天的原话
export function searchByDay(db, key, daysAgo = 1, limit = 15) {
  const target = new Date();
  target.setHours(0, 0, 0, 0);
  target.setDate(target.getDate() - Math.max(0, Number(daysAgo) || 1));
  const start = target.getTime();
  const end = start + DAY;
  return db.prepare(
    `SELECT id, key, t, self, sender, text, keywords, compacted FROM msg
     WHERE key = ? AND t >= ? AND t < ? AND text != '' ORDER BY t ASC LIMIT ?`,
  ).all(String(key), start, end, Math.max(1, limit));
}
