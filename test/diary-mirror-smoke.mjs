// test/diary-mirror-smoke.mjs —— 日记另存 md 的回归用例。
//
// 为什么单独一个文件：这套逻辑只存在于「线上合并版」，仓库主线曾在重构时整块丢掉，
// 一丢就是 17 篇日记不再落盘（D:/工作区/鲸宝日记 停在 11-16）。这组用例只盯三件事：
//   ① 落盘路径与文件名（<dir>/YYYY-MM/YYYY-MM-DD-私聊.md）
//   ② frontmatter 齐全、正文不重复带旧 frontmatter
//   ③ 补齐只写缺的那几天，已有文件绝不被覆盖（用户手改过）

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createState, saveDiary, recentDiary,
  diaryMirrorPath, diaryMarkdown, mirrorDiaryFile, mirrorDiaryFiles,
} from '../lib/memory.js';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '->', e.message); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-diary-'));

console.log('=== 日记另存 md 自测 ===');

check('路径规范：<dir>/YYYY-MM/YYYY-MM-DD-私聊.md', () => {
  const p = diaryMirrorPath(tmp, '2026-11-16');
  assert.equal(p, path.join(tmp, '2026-11', '2026-11-16-私聊.md'));
  assert.equal(diaryMirrorPath('', '2026-11-16'), ''); // 没配目录 = 不落文件
  assert.equal(diaryMirrorPath(tmp, '2026/11/16'), ''); // 日期不合规
});

check('saveDiary 存下 key，markdown 里带 frontmatter', () => {
  const s = createState();
  const r = saveDiary(s, { date: '2026-11-16', text: '今天把待审队列修完了', key: 'private:1262975733' }, Date.now());
  assert.ok(r.ok);
  const md = diaryMarkdown('2026-11-16', s.diary['2026-11-16']);
  assert.match(md, /^---\ndate: 2026-11-16\n/);
  assert.match(md, /key: private:1262975733/);
  assert.match(md, /今天把待审队列修完了/);
});

check('老正文自带 frontmatter 时不写两份', () => {
  const entry = { text: '---\ndate: 2026-11-12\nwrittenAt: 1762900000000\n---\n\n正文只有这一句', savedAt: 1 };
  const md = diaryMarkdown('2026-11-12', entry);
  assert.equal(md.match(/^---/gm).length, 2); // 只有一对 ---
  assert.match(md, /writtenAt: 1762900000000/);
  assert.match(md, /正文只有这一句/);
  assert.doesNotMatch(md, /date: 2026-11-12\ndate:/);
});

check('落盘 + 补齐只写缺的，不覆盖手改', () => {
  const s = createState();
  saveDiary(s, { date: '2026-11-10', text: '第一天' }, Date.now());
  saveDiary(s, { date: '2026-11-11', text: '第二天' }, Date.now());
  const one = mirrorDiaryFile(tmp, '2026-11-10', s.diary['2026-11-10']);
  assert.ok(one.ok && fs.existsSync(one.file));
  const mark = '# 手改过的，别覆盖\n';
  fs.writeFileSync(one.file, mark, 'utf8');
  const out = mirrorDiaryFiles(tmp, s, { onlyMissing: true });
  assert.equal(out.written, 1); // 只补 11-11
  assert.equal(out.skipped, 1); // 11-10 已有，跳过
  assert.equal(fs.readFileSync(one.file, 'utf8'), mark);
  assert.ok(fs.existsSync(path.join(tmp, '2026-11', '2026-11-11-私聊.md')));
});

check('recentDiary 取最近 30 篇（别回退成 7）', () => {
  const s = createState();
  for (let i = 1; i <= 40; i++) {
    const d = `2026-09-${String(i).padStart(2, '0')}`;
    if (i > 30) continue;
    s.diary[d] = { text: `第${i}天`, savedAt: i };
  }
  for (let i = 1; i <= 12; i++) s.diary[`2026-10-${String(i).padStart(2, '0')}`] = { text: `十月${i}`, savedAt: 100 + i };
  const recent = recentDiary(s);
  assert.equal(recent.length, 30);
  assert.equal(recent[0].date, '2026-10-12'); // 倒序，最新在前
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
