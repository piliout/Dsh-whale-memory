// migrate.mjs —— 把 qq-bridge 的 socialV2 记忆迁移到 whale-memory 的 whale-memory.json。
//
// 用法：
//   node migrate.mjs <qq-bridge-state目录> <输出whale-memory.json路径>
//   默认数据目录（不配 dir 时）：<DSH_HOME>/dsh-onebot-qq/whale-memory/
//   node migrate.mjs "D:/AI-deepseek/qq-bridge/state" "C:/Users/<你>/.dsh/dsh-onebot-qq/whale-memory/whale-memory.json"
//   若在控制台把「数据目录」配成别的路径，把第二参数指到那个目录下的 whale-memory.json。
//
// 迁移映射：
//   social-v2.json 里每个会话的 activeTopics  -> topics[chatKey]
//                    pendingThoughts          -> thoughts[chatKey]
//   member-impressions.json members          -> impressions (键 qq:<uid>)
//   lessons.json lessons                      -> lessons
//   只读：本脚本不写回 qq-bridge 任何文件。

import fs from 'node:fs';
import path from 'node:path';
import { openArchive } from './lib/archive.js';

const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

function readJson(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function main() {
  const [srcDir, outFile] = process.argv.slice(2);
  if (!srcDir || !outFile) {
    console.error('用法：node migrate.mjs <qq-bridge/state目录> <输出json路径>');
    process.exit(1);
  }

  const state = { version: 1, topics: {}, thoughts: {}, impressions: {}, lessons: [], diary: {} };
  const now = Date.now();
  let count = 0;

  // ① 会话级话题 / 念头（social-v2.json）
  const sv2 = readJson(path.join(srcDir, 'social-v2.json'));
  if (sv2?.conversations) {
    for (const [chatKey, conv] of Object.entries(sv2.conversations)) {
      if (!/^(group|private):\d{4,12}$/.test(chatKey)) continue;
      const topics = Array.isArray(conv.activeTopics) ? conv.activeTopics : [];
      const thoughts = Array.isArray(conv.pendingThoughts) ? conv.pendingThoughts : [];
      if (topics.length) {
        state.topics[chatKey] = topics
          .filter((t) => t?.text)
          .slice(-12)
          .map((t) => ({
            id: newId(), text: String(t.text).slice(0, 400),
            lastMentionAt: Number(t.lastMentionAt) || now,
            pendingQuestion: t.pendingQuestion ? String(t.pendingQuestion).slice(0, 200) : undefined,
          }));
        count += state.topics[chatKey].length;
      }
      if (thoughts.length) {
        state.thoughts[chatKey] = thoughts
          .filter((t) => t?.text)
          .slice(-20)
          .map((t) => ({
            id: newId(), text: String(t.text).slice(0, 400),
            motivation: t.motivation ? String(t.motivation).slice(0, 80) : undefined,
            createdAt: Number(t.createdAt) || now,
            expiresAt: Number(t.expiresAt) || now + 24 * 60 * 60 * 1000,
          }));
        count += state.thoughts[chatKey].length;
      }
    }
    console.log(`话题/念头：迁移自 ${Object.keys(sv2.conversations).length} 个会话`);
  }

  // ② 全局群友印象（member-impressions.json）
  const mi = readJson(path.join(srcDir, 'member-impressions.json'));
  const members = mi?.members && typeof mi.members === 'object' ? mi.members : {};
  for (const [k, v] of Object.entries(members)) {
    if (!v || typeof v !== 'object') continue;
    const uid = String(v.uid || '').trim() || (/^qq:(\d+)$/.test(k) ? RegExp.$1 : '');
    if (!/^\d{4,12}$/.test(uid)) continue;
    state.impressions[`qq:${uid}`] = {
      uid,
      name: v.name ? String(v.name).slice(0, 40) : '',
      aliases: Array.isArray(v.aliases) ? v.aliases.map(String).slice(0, 10) : [],
      traits: Array.isArray(v.traits) ? v.traits.map(String).slice(-8) : [],
      interactionCount: Number(v.interactionCount) || 0,
      lastSeenAt: Number(v.lastSeenAt) || now,
    };
  }
  count += Object.keys(state.impressions).length;
  console.log(`群友印象：迁移 ${Object.keys(state.impressions).length} 人`);

  // ③ 教训（lessons.json）
  const lessons = readJson(path.join(srcDir, 'lessons.json'));
  if (Array.isArray(lessons?.lessons)) {
    state.lessons = lessons.lessons
      .filter((l) => l?.text)
      .slice(-50)
      .map((l) => ({ id: newId(), text: String(l.text).slice(0, 400), at: Number(l.at) || now, key: String(l.key || '') }));
    count += state.lessons.length;
  }
  console.log(`教训：迁移 ${state.lessons.length} 条`);

  // ④ 日记：递归月份子目录（<dir>/YYYY-MM/YYYY-MM-DD-*.md）
  //    真实路径优先读 config.json 的 socialV2.diary.dir，回退 state/diary；也可命令行第 3 参显式指定
  let diaryDir = path.join(srcDir, 'diary');
  const cfg = readJson(path.join(srcDir, '..', 'config.json'));
  if (cfg?.socialV2?.diary?.dir && fs.existsSync(String(cfg.socialV2.diary.dir))) {
    diaryDir = String(cfg.socialV2.diary.dir);
  }
  if (process.argv[3] && fs.existsSync(process.argv[3])) diaryDir = process.argv[3];
  let diaryCount = 0;
  const walkDiary = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walkDiary(p); continue; }
      const m = /^(\d{4}-\d{2}-\d{2}).*\.(?:md|json|txt)$/.exec(e.name);
      if (!m) continue;
      const body = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
      if (!body) continue;
      state.diary[m[1]] = { text: body.slice(0, 4000), savedAt: now };
      diaryCount++;
    }
  };
  walkDiary(diaryDir);
  count += diaryCount;
  console.log(`日记：迁移 ${diaryCount} 篇（目录 ${diaryDir}）`);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(state, null, 2), 'utf8');
  console.log(`\n✅ 结构化记忆 ${count} 条 → ${outFile}`);

  // ⑤ 归档迁移（chat-archive.jsonl → archive.db，keywords 一并进 FTS 索引）
  const archiveFile = path.join(srcDir, 'chat-archive.jsonl');
  if (fs.existsSync(archiveFile)) {
    try {
      const db = openArchive(path.dirname(outFile));
      const ins = db.prepare('INSERT INTO msg (key,t,self,sender,text,keywords,compacted) VALUES (?,?,?,?,?,?,?)');
      db.exec('BEGIN');
      let n = 0;
      for (const line of fs.readFileSync(archiveFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          const keywords = Array.isArray(e.keywords) ? e.keywords.join(' ') : '';
          const text = String(e.text || '').slice(0, 300);
          ins.run(String(e.key || ''), Number(e.t) || now, e.self ? 1 : 0, String(e.sender || ''), text, keywords, e.compacted ? 1 : 0);
          n++;
        } catch { /* 跳过坏行 */ }
      }
      db.exec('COMMIT');
      console.log(`✅ 归档 ${n} 条消息 → archive.db（关键词已入索引，90 天后仍可搜）`);
      db.close();
    } catch (e) {
      console.error('归档迁移失败：', e?.message ?? e);
    }
  } else {
    console.log('（未找到 chat-archive.jsonl，跳过归档迁移）');
  }
  console.log('   目标目录 = 子插件的数据目录（默认 <DSH_HOME>/dsh-onebot-qq/whale-memory）；控制台改过「数据目录」就放到那个目录下。');
}

main();
