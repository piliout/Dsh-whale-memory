import assert from 'node:assert';
import {
  createState, normalizeState, appendMemory, removeMemory,
  saveDiary, recentDiary, formatMemorySnapshot, capImpressions, validChatKey,
} from '../lib/memory.js';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '->', e.message); }
}

console.log('=== whale-memory 自测 ===');

check('createState 结构完整', () => {
  const s = createState();
  assert.ok(s.topics && s.thoughts && s.impressions && s.lessons && s.diary);
});

check('normalizeState 容错脏数据', () => {
  const s = normalizeState(null);
  assert.ok(s.topics);
  const s2 = normalizeState({ topics: { 'group:123456': [{ text: 'x' }] } });
  assert.equal(s2.topics['group:123456'].length, 1);
});

check('validChatKey 校验', () => {
  assert.ok(validChatKey('group:123456'));
  assert.ok(validChatKey('private:123456789'));
  assert.ok(!validChatKey('bad:123'));
  assert.ok(!validChatKey('../etc'));
});

check('appendMemory 话题（会话级 + 上限12）', () => {
  const s = createState();
  for (let i = 0; i < 15; i++) appendMemory(s, { category: 'topic', chatKey: 'group:123456', content: `话题${i}` }, 1000 + i);
  assert.equal(s.topics['group:123456'].length, 12);
});

check('appendMemory 印象（全局 + 按QQ归档）', () => {
  const s = createState();
  appendMemory(s, { category: 'impression', chatKey: 'group:123456', content: '爱发图', extra: { uid: '123456', name: '五' } }, 1000);
  assert.ok(s.impressions['qq:123456']);
  assert.equal(s.impressions['qq:123456'].name, '五');
  appendMemory(s, { category: 'impression', chatKey: 'private:999999', content: '嘴很皮', extra: { uid: '123456', name: '五改' } }, 2000);
  assert.equal(s.impressions['qq:123456'].traits.length, 2);
  assert.equal(s.impressions['qq:123456'].interactionCount, 2);
});

check('appendMemory 教训（跨群）', () => {
  const s = createState();
  appendMemory(s, { category: 'lesson', chatKey: 'group:10001', content: '别学坏' });
  appendMemory(s, { category: 'lesson', chatKey: 'private:20002', content: '要说清' });
  assert.equal(s.lessons.length, 2);
});

check('念头过期不注入', () => {
  const s = createState();
  appendMemory(s, { category: 'thought', chatKey: 'private:10001', content: '想说' }, 0);
  s.thoughts['private:10001'][0].expiresAt = 1000; // 手动改成已过期
  const snap = formatMemorySnapshot(s, 'private:10001', '', 5000);
  assert.ok(!snap.includes('想说'));
});

check('话题超过3天不注入但保留', () => {
  const s = createState();
  appendMemory(s, { category: 'topic', chatKey: 'group:10001', content: '老话题' }, Date.now() - 4 * 24 * 3600 * 1000);
  const snap = formatMemorySnapshot(s, 'group:10001', '', Date.now());
  assert.ok(!snap.includes('老话题'));
  assert.equal(s.topics['group:10001'].length, 1); // 数据还在
});

check('formatMemorySnapshot 含四块标记', () => {
  const s = createState();
  appendMemory(s, { category: 'topic', chatKey: 'group:10001', content: '新话题' }, Date.now());
  appendMemory(s, { category: 'lesson', chatKey: 'group:10001', content: '教训一条' });
  appendMemory(s, { category: 'impression', chatKey: 'group:10001', content: '印象', extra: { uid: '111111', name: '甲' } });
  const snap = formatMemorySnapshot(s, 'group:10001', '甲', Date.now());
  assert.ok(snap.includes('对群友的印象'));
  assert.ok(snap.includes('进行中的话题'));
  assert.ok(snap.includes('主人的教训'));
  // 提到的人排最前
  assert.ok(snap.indexOf('甲') < snap.indexOf('进行中的话题') || snap.includes('甲（QQ 111）'));
});

check('私聊注入群近况', () => {
  const s = createState();
  appendMemory(s, { category: 'topic', chatKey: 'group:888888', content: '群里在聊梗' }, Date.now());
  const snap = formatMemorySnapshot(s, 'private:10001', '', Date.now());
  assert.ok(snap.includes('群里的近况'));
});

check('capImpressions 淘汰只见过一面且7天未出现', () => {
  const s = createState();
  const now = Date.now();
  for (let i = 1; i <= 51; i++) {
    const interactionCount = i === 51 ? 5 : 1;
    const lastSeenAt = i === 51 ? now : now - 8 * 24 * 3600 * 1000;
    s.impressions[`qq:${1000 + i}`] = { uid: String(1000 + i), traits: ['x'], interactionCount, lastSeenAt };
  }
  capImpressions(s, now);
  assert.equal(Object.keys(s.impressions).length, 50);
  assert.ok(s.impressions['qq:1051']); // 互动5次的保留
});

check('日记 saveDiary + recentDiary', () => {
  const s = createState();
  saveDiary(s, { date: '2026-11-15', text: '今天很好' });
  const recent = recentDiary(s);
  assert.equal(recent[0].date, '2026-11-15');
});

check('removeMemory 按内容删除', () => {
  const s = createState();
  appendMemory(s, { category: 'topic', chatKey: 'group:10001', content: '要删的' });
  const r = removeMemory(s, { category: 'topic', chatKey: 'group:10001', content: '要删的' });
  assert.equal(r.removed, 1);
  assert.equal(s.topics['group:10001'].length, 0);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
