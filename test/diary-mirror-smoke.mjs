import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createState, saveDiary, recentDiary, stripDiaryFrontmatter, diaryFrontmatterOf,
  diaryMarkdown, diaryMirrorPath, mirrorDiaryFile, mirrorDiaryFiles,
} from '../lib/memory.js';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '->', e.message); }
}

console.log('=== whale-memory 日记 md 镜像自测 ===');

check('stripDiaryFrontmatter 剥掉旧批次的 frontmatter', () => {
  const src = '---\ndate: 2026-11-14\nkey: private:1\ntopics: a、b\nwrittenAt: 123\n---\n\n正文第一段';
  assert.equal(stripDiaryFrontmatter(src), '正文第一段');
  assert.equal(stripDiaryFrontmatter('没有头部的正文'), '没有头部的正文');
});

check('diaryFrontmatterOf 读回字段', () => {
  const fm = diaryFrontmatterOf('---\ndate: 2026-11-14\nkey: private:1\n---\nx');
  assert.equal(fm.date, '2026-11-14');
  assert.equal(fm.key, 'private:1');
});

check('diaryMarkdown 生成 date/key/writtenAt，正文不重复', () => {
  const md = diaryMarkdown('2026-11-16', { text: '只有正文', savedAt: 1794843509274, key: 'private:10000001' });
  assert.ok(md.startsWith('---\ndate: 2026-11-16\nkey: private:10000001\n'));
  assert.ok(md.includes('writtenAt: 1794843509274'));
  assert.ok(md.includes('\n\n只有正文\n'));
  assert.equal((md.match(/^---$/gm) || []).length, 2);
});

check('旧条目（正文自带 frontmatter）不产生第二份头部', () => {
  const src = '---\ndate: 2026-11-14\nkey: private:9\ntopics: 甲、乙\nwrittenAt: 999\n---\n\n老正文';
  const md = diaryMarkdown('2026-11-14', { text: src, savedAt: 1000 });
  assert.equal((md.match(/^---$/gm) || []).length, 2);
  assert.ok(md.includes('topics: 甲、乙'));
  assert.ok(md.includes('writtenAt: 999'));
  assert.ok(!md.includes('date: 2026-11-14\ndate:'));
});

check('diaryMirrorPath 按年月分目录；非法日期返回空', () => {
  const p = diaryMirrorPath('D:/x', '2026-11-16');
  assert.ok(p.endsWith(path.join('2026-11', '2026-11-16-私聊.md')));
  assert.equal(diaryMirrorPath('D:/x', '2026/11/16'), '');
  assert.equal(diaryMirrorPath('', '2026-11-16'), '');
});

check('mirrorDiaryFile 落盘内容正确', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-diary-'));
  try {
    const r = mirrorDiaryFile(dir, '2026-11-16', { text: '今天的正文', savedAt: 1234, key: 'private:1' });
    assert.equal(r.ok, true);
    const text = fs.readFileSync(r.file, 'utf8');
    assert.ok(text.includes('date: 2026-11-16'));
    assert.ok(text.includes('今天的正文'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('mirrorDiaryFiles 只补缺的，不覆盖已有文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-diary-'));
  try {
    const state = createState();
    saveDiary(state, { date: '2026-11-14', text: '十四号' }, 1);
    saveDiary(state, { date: '2026-11-15', text: '十五号' }, 2);
    saveDiary(state, { date: '2026-11-16', text: '十六号' }, 3);
    // 预先放一份「手改过」的 14 号
    const f14 = diaryMirrorPath(dir, '2026-11-14');
    fs.mkdirSync(path.dirname(f14), { recursive: true });
    fs.writeFileSync(f14, 'HAND-EDITED', 'utf8');

    const r = mirrorDiaryFiles(dir, state, { onlyMissing: true });
    assert.equal(r.written, 2);
    assert.equal(r.skipped, 1);
    assert.equal(fs.readFileSync(f14, 'utf8'), 'HAND-EDITED');
    assert.ok(fs.existsSync(diaryMirrorPath(dir, '2026-11-15')));
    assert.ok(fs.existsSync(diaryMirrorPath(dir, '2026-11-16')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('空目录 = 不落文件（返回全零）', () => {
  const state = createState();
  saveDiary(state, { date: '2026-11-16', text: 'x' }, 1);
  const r = mirrorDiaryFiles('', state);
  assert.deepEqual(r, { written: 0, skipped: 0, failed: 0 });
});

check('saveDiary 记住 key（供 frontmatter 用）', () => {
  const state = createState();
  const r = saveDiary(state, { date: '2026-11-16', text: '正文', key: 'private:1262975733' }, 5);
  assert.equal(r.ok, true);
  assert.equal(state.diary['2026-11-16'].key, 'private:1262975733');
  assert.equal(state.diary['2026-11-16'].savedAt, 5);
});

check('recentDiary 取最近 30 篇（别回退成 7）', () => {
  const state = createState();
  for (let i = 1; i <= 30; i++) state.diary[`2026-09-${String(i).padStart(2, '0')}`] = { text: `九月${i}`, savedAt: i };
  for (let i = 1; i <= 12; i++) state.diary[`2026-10-${String(i).padStart(2, '0')}`] = { text: `十月${i}`, savedAt: 100 + i };
  const recent = recentDiary(state);
  assert.equal(recent.length, 30);
  assert.equal(recent[0].date, '2026-10-12');
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
