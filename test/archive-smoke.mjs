import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openArchive, appendMessage, compactArchive, searchArchive,
  recallTextOf, isRecallCue, detectDayOffset, extractKeywords,
} from '../lib/archive.js';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '->', e.message); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-archive-'));

console.log('=== whale-memory 归档自测 ===');

check('appendMessage 写入并可按词检索', () => {
  const db = openArchive(path.join(tmp, 'a1'));
  appendMessage(db, { key: 'group:123456', t: Date.now(), self: 0, sender: '甲', text: '我们去了狼山看支云塔' });
  const hits = searchArchive(db, 'group:123456', '狼山', 5);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].text.includes('狼山'));
  db.close();
});

check('整句查询能拆出关键词命中（dsh 实测的打不响问题）', () => {
  const db = openArchive(path.join(tmp, 'a1b'));
  const now = Date.now();
  const fillers = ['今天天气不错', '中午吃了米饭', '下午开会到很晚', '晚上要加班',
    '周末去爬山', '最近在学做饭', '地铁上人很多', '买了新手机', '看了一部电影', '明天去图书馆'];
  // 49 条 filler（now-1min ~ now-49min）+ 热干面写最早（now-50min，落在 skipRecent 之外）
  for (let i = 1; i <= 49; i++) {
    appendMessage(db, { key: 'group:123456', t: now - i * 60000, self: 0, sender: '乙', text: fillers[i % 10] });
  }
  appendMessage(db, { key: 'group:123456', t: now - 50 * 60000, self: 0, sender: '甲', text: '今天去吃了热干面，还喝了蛋酒' });
  // 旧版把整句当 MATCH 查询串 → 0；新版应拆出「热干面」命中
  assert.equal(searchArchive(db, 'group:123456', '上次我们说去吃热干面那个店', 5).length, 1);
  assert.equal(searchArchive(db, 'group:123456', '说说热干面', 5).length, 1);
  // 2 字词走打分/LIKE 兜底
  assert.equal(searchArchive(db, 'group:123456', '蛋酒', 5).length, 1);
  db.close();
});

check('skipRecent 排除刚说的话', () => {
  const db = openArchive(path.join(tmp, 'a1c'));
  const now = Date.now();
  // 更早的热干面（60min 前）+ 50 条 filler + 刚说的热干面（1min 前，应被 skipRecent 排除）
  appendMessage(db, { key: 'group:123456', t: now - 60 * 60000, self: 0, sender: '甲', text: '上次说的热干面那家店很好吃' });
  for (let i = 1; i <= 50; i++) {
    appendMessage(db, { key: 'group:123456', t: now - 60 * 60000 + i * 60000, self: 0, sender: '乙', text: '随便聊聊第' + i + '句' });
  }
  appendMessage(db, { key: 'group:123456', t: now - 60000, self: 0, sender: '甲', text: '刚说的热干面' });
  // 用整句查询（FTS phrase 打不响 → 走打分兜底，skipRecent 排除刚说的）
  const hits = searchArchive(db, 'group:123456', '上次我们去吃热干面', 5);
  assert.ok(hits.length >= 1);
  assert.ok(!hits.some((h) => h.t === now - 60000)); // 不包含 1 分钟前刚说的
  db.close();
});

check('3 字查询命中压缩行（keywords 参与 2-gram 打分）', () => {
  const db = openArchive(path.join(tmp, 'a1d'));
  const now = Date.now();
  appendMessage(db, { key: 'private:10001', t: now - 100 * 24 * 3600 * 1000, self: 0, sender: '他', text: '去支云塔看日落' });
  for (let i = 1; i <= 5; i++) {
    appendMessage(db, { key: 'private:10001', t: now - i * 60000, self: 0, sender: '我', text: '今天第' + i + '条消息' });
  }
  compactArchive(db, now); // 90 天前那条被压缩，正文清空只留关键词
  const hits = searchArchive(db, 'private:10001', '支云塔', 5);
  assert.ok(hits.length >= 1);
  db.close();
});

check('2 字词回退 LIKE 兜底', () => {
  const db = openArchive(path.join(tmp, 'a2'));
  appendMessage(db, { key: 'group:123456', t: Date.now(), self: 0, sender: '乙', text: '今天加班到很晚' });
  const hits = searchArchive(db, 'group:123456', '加班', 5);
  assert.equal(hits.length, 1);
  db.close();
});

check('压缩后 keywords 仍可搜（dsh 方案 A）', () => {
  const db = openArchive(path.join(tmp, 'a3'));
  appendMessage(db, { key: 'private:10001', t: Date.now() - 100 * 24 * 3600 * 1000, self: 0, sender: '他', text: '狼山支云塔江边日落那天很开心' });
  const n = compactArchive(db, Date.now());
  assert.equal(n, 1);
  // 正文已清空
  const row = db.prepare('SELECT text, keywords, compacted FROM msg').get();
  assert.equal(row.text, '');
  assert.equal(row.compacted, 1);
  assert.ok(row.keywords.length > 0);
  // 关键词仍能搜到（这是 dsh 指出的缺口，现在补上）
  const kw = row.keywords.split(' ')[0];
  const hits = searchArchive(db, 'private:10001', kw, 5);
  assert.equal(hits.length, 1);
  db.close();
});

check('recallTextOf 三段降级', () => {
  const now = Date.now();
  const full = recallTextOf({ text: 'A'.repeat(200), t: now - 10 * 24 * 3600 * 1000 }, now);
  assert.equal(full.length, 90); // 0-30天截到90字
  const faded = recallTextOf({ text: 'B'.repeat(200), t: now - 50 * 24 * 3600 * 1000 }, now);
  assert.ok(faded.includes('记不清细节')); // 30-90天打折
  const compacted = recallTextOf({ compacted: 1, keywords: '狼山 支云塔' }, now);
  assert.ok(compacted.includes('狼山')); // 90天后只留关键词
});

check('isRecallCue 收窄触发词', () => {
  assert.ok(isRecallCue('你还记得上次那个吗', []));
  assert.ok(isRecallCue('昨天我们去哪了', []));
  assert.ok(!isRecallCue('那个', [])); // 收窄：不含「那个」
  assert.ok(!isRecallCue('有没有空', [])); // 收窄：不含「有没有」
  assert.ok(!isRecallCue('是不是这样', [])); // 收窄：不含「是不是」
  assert.ok(!isRecallCue('随便聊聊', [])); // 无回忆词不触发
  assert.ok(isRecallCue('布奇酱最近怎么样', ['布奇酱'])); // 印象人名触发（≥2字）
});

check('detectDayOffset 时间词', () => {
  assert.equal(detectDayOffset('昨天干了啥'), 1);
  assert.equal(detectDayOffset('前天那个'), 2);
  assert.equal(detectDayOffset('上周的事'), 7);
  assert.equal(detectDayOffset('今天吃啥'), 0);
});

check('extractKeywords 提取中文 2-gram', () => {
  const kw = extractKeywords('狼山支云塔江边日落', 3);
  assert.ok(kw.length >= 2);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
