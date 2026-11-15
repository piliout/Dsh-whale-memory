// backfill-diary.mjs —— 只把 qq-bridge 的日记（15 篇）补迁进已运行的 whale-memory.json。
//
// 与 migrate.mjs 的区别：本脚本「只补日记、不动其他字段、不碰 archive.db」，
// 适用于 whale-memory 已上线运行后，把漏迁的日记补回来（不重复插归档）。
//
// 用法：
//   node backfill-diary.mjs <whale-memory.json路径> [日记目录]
//   日记目录缺省时，尝试从 qq-bridge config.json 的 socialV2.diary.dir 读；
//   再缺省则跳过。执行前会自动备份原 json 为 <同名>.bak-<时间戳>。

import fs from 'node:fs';
import path from 'node:path';

const [jsonFile, diaryArg] = process.argv.slice(2);
if (!jsonFile || !fs.existsSync(jsonFile)) {
  console.error('用法：node backfill-diary.mjs <whale-memory.json路径> [日记目录]');
  process.exit(1);
}

// 确定日记目录：命令行 > config.json 的 diary.dir > 默认空
let diaryDir = diaryArg || '';
if (!diaryDir) {
  // 尝试从 qq-bridge 目录推测 config.json（jsonFile 同级的 config.json，或 ../config.json）
  for (const cand of [
    path.join(path.dirname(jsonFile), 'config.json'),
    path.join(path.dirname(jsonFile), '..', 'config.json'),
    'D:/AI-deepseek/qq-bridge/config.json',
  ]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cand, 'utf8').replace(/^\uFEFF/, ''));
      const d = cfg?.socialV2?.diary?.dir;
      if (d && fs.existsSync(String(d))) { diaryDir = String(d); break; }
    } catch { /* ignore */ }
  }
}
if (!diaryDir || !fs.existsSync(diaryDir)) {
  console.error('未找到日记目录。请显式传入：node backfill-diary.mjs <json> "D:/工作区/鲸宝日记"');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8').replace(/^\uFEFF/, ''));
data.diary = data.diary && typeof data.diary === 'object' ? data.diary : {};

// 备份
const bak = `${jsonFile}.bak-${Date.now()}`;
fs.writeFileSync(bak, JSON.stringify(data, null, 2), 'utf8');

const before = Object.keys(data.diary).length;
let added = 0, skipped = 0;
const now = Date.now();
const walk = (dir) => {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const m = /^(\d{4}-\d{2}-\d{2}).*\.(?:md|json|txt)$/.exec(e.name);
    if (!m) continue;
    const body = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!body) continue;
    if (data.diary[m[1]]) { skipped++; continue; } // 不覆盖已有
    data.diary[m[1]] = { text: body.slice(0, 4000), savedAt: now };
    added++;
  }
};
walk(diaryDir);

fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2), 'utf8');
console.log(`✅ 日记补迁完成`);
console.log(`   目录：${diaryDir}`);
console.log(`   新增 ${added} 篇，跳过 ${skipped} 篇（已存在），补迁前 ${before} 篇 → 现在 ${Object.keys(data.diary).length} 篇`);
console.log(`   备份：${bak}`);
