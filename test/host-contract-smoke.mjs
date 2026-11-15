// test/host-contract-smoke.mjs —— 接线层自测：用**假宿主**按 dsh-onebot-qq 契约 v1 模拟 bot，
// 验证 index.js 真的接得上（此前 13+8 项全都只测 lib/ 纯算法，接线一行没跑过）。
//
// 契约依据（YUsaltyfish/dsh-onebot-qq 的 contracts.js / index.js）：
//   · bot.cfg 每次回调现读（控制台热改原地替换同一对象）
//   · bot.on(stage, fn) → 'passive-tap' | 'before-turn' 等五阶段
//   · bot.registerTool(name, {description, parameters, execute})，内核会加 mcp__qq__ 前缀
//   · bot.registerCommand(name, {permission:'any'|'master', handler(ev, args)})，handler 自己 deliver
//   · bot.onAfterSend(rec) → rec = { target, text, ats, replyTo, mode, messageId, ... }
//   · ev.sender = { qq, name, card, isMaster }

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plugin from '../index.js';
import {
  createState, appendMemory, formatMemorySnapshot, configureLimits, currentLimits,
} from '../lib/memory.js';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '->', e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '->', e.message); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-host-'));

/** 按契约 v1 造一个假宿主 bot + 记录器 */
function makeBot(dir, overrides = {}) {
  const stages = new Map();
  const tools = new Map();
  const commands = new Map();
  const afterSend = [];
  const disposers = [];
  const delivered = [];
  const bot = {
    id: 'whale-memory',
    contractVersion: 1,
    cfg: {
      enabled: true, dir, injectMode: 'full', topicInjectDays: 3,
      maxImpressions: 50, recallEnabled: true, archiveDays: 90, ...overrides,
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    core: { dataDir: dir },
    on(stage, fn) {
      if (!stages.has(stage)) stages.set(stage, []);
      stages.get(stage).push(fn);
    },
    onAfterSend(fn) { afterSend.push(fn); return () => {}; },
    onOutbound() { return () => {}; },
    onDispose(fn) { disposers.push(fn); },
    registerTool(name, def) { tools.set(name, def); },
    registerCommand(name, def) { commands.set(name, def); },
    currentTurn: () => ({ chatKey: 'group:123456', wakeKind: 'at' }),
    deliver: async (target, text) => { delivered.push({ target, text }); return { target, text }; },
    _push(stage, ev) { for (const fn of stages.get(stage) || []) fn(ev); },
  };
  return { bot, tools, commands, afterSend, disposers, delivered, stages };
}

const mkEv = (over = {}) => ({
  chatKey: 'group:123456', isGroup: true, groupId: '123456',
  messageId: 1, time: Date.now(), text: '', hint: [], wake: { kind: 'at' },
  sender: { qq: 111111, name: '甲', card: null, isMaster: false },
  stopped: false, stopReason: '', _scratch: {}, ...over,
});

console.log('=== whale-memory 接线自测（契约 v1）===');

check('插件形状符合契约（id=目录名 / setup 函数 / order）', () => {
  assert.equal(plugin.id, 'whale-memory');
  assert.equal(typeof plugin.setup, 'function');
  assert.equal(plugin.title, '鲸鱼记忆');
  assert.ok(Number.isInteger(plugin.order));
  // configSchema：控制台只认这几种类型
  const allowed = new Set(['bool', 'int', 'float', 'str', 'enum', 'group']);
  for (const [k, def] of Object.entries(plugin.configSchema)) {
    assert.ok(allowed.has(def.type), `${k} 的类型 ${def.type} 契约不支持`);
    assert.ok('default' in def || def.type === 'group', `${k} 缺 default`);
  }
});

check('setup 注册了 5 个工具 + 1 个命令（名字避开内核保留名）', () => {
  const { bot, tools, commands } = makeBot(path.join(tmpRoot, 'a'));
  plugin.setup(bot);
  const names = [...tools.keys()].sort();
  assert.deepEqual(names, [
    'whale_diary_save', 'whale_memory_append', 'whale_memory_query',
    'whale_memory_remove', 'whale_search_history',
  ]);
  // ⚠️ 内核把 memory_append 留给后台任务（普通会话调用直接抛错），绝不能重名
  assert.ok(!tools.has('memory_append'), '不能注册内核保留名 memory_append');
  assert.ok(commands.has('memory'), '缺 /memory 命令');
  assert.equal(commands.get('memory').permission, 'master'); // 只认 any|master
});

check('工具参数是扁平属性映射（DSH defineTool 的形状）', () => {
  const { bot, tools } = makeBot(path.join(tmpRoot, 'b'));
  plugin.setup(bot);
  for (const [name, def] of tools) {
    assert.equal(typeof def.description, 'string', `${name} 缺 description`);
    assert.equal(typeof def.execute, 'function', `${name} 缺 execute`);
    assert.equal(typeof def.parameters, 'object');
    for (const [p, spec] of Object.entries(def.parameters)) {
      assert.equal(typeof spec.type, 'string', `${name}.${p} 缺 type`);
    }
  }
});

check('inbound 归档：ev.sender 是对象也入库为名字（不出现 [object Object]）', () => {
  const dir = path.join(tmpRoot, 'c');
  const { bot, tools, stages } = makeBot(dir);
  plugin.setup(bot);
  assert.ok(stages.has('passive-tap'), '没挂 passive-tap');
  bot._push('passive-tap', mkEv({ text: '今天去吃了热干面' }));
  const r = tools.get('whale_search_history').execute({ q: '热干面' });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1, `应搜到 1 条，实际 ${r.count}`);
  assert.equal(r.items[0].sender, '甲');
  assert.ok(!String(r.items[0].sender).includes('[object'), 'sender 被塞成对象字符串了');
});

check('outbound 归档：机器人自己说的话也进档案（onAfterSend）', () => {
  const dir = path.join(tmpRoot, 'd');
  const { bot, tools, afterSend } = makeBot(dir);
  plugin.setup(bot);
  assert.equal(afterSend.length, 1, '没挂 onAfterSend');
  afterSend[0]({ target: 'group:123456', text: '我明天要考试', mode: 'plain', messageId: 9 });
  const r = tools.get('whale_search_history').execute({ q: '考试' });
  assert.equal(r.count, 1);
  assert.equal(r.items[0].self, 1, '自己说的话应标 self=1');
});

check('before-turn：未唤醒不注入（契约要求第一行自己拦）', () => {
  const dir = path.join(tmpRoot, 'e');
  const { bot, tools } = makeBot(dir);
  plugin.setup(bot);
  tools.get('whale_memory_append').execute({ category: 'topic', content: '我们约了周末去狼山', target: 'group:123456' });
  const ev = mkEv({ wake: null, hint: [] });
  bot._push('before-turn', ev);
  assert.equal(ev.hint.length, 0, '未唤醒却注入了');
});

check('before-turn：唤醒时注入记忆快照，且带「系统记忆，非群友发言」强标记', () => {
  const dir = path.join(tmpRoot, 'f');
  const { bot, tools } = makeBot(dir);
  plugin.setup(bot);
  tools.get('whale_memory_append').execute({ category: 'topic', content: '我们约了周末去狼山', target: 'group:123456' });
  const ev = mkEv({ text: '在吗', hint: [] });
  bot._push('before-turn', ev);
  assert.equal(ev.hint.length, 1);
  assert.ok(ev.hint[0].includes('狼山'), '快照里没有话题');
  assert.ok(ev.hint[0].includes('系统给你的记忆'), '缺强标记');
});

check('injectMode=pointer 只给一行提示（不贴正文）', () => {
  const dir = path.join(tmpRoot, 'g');
  const { bot, tools } = makeBot(dir, { injectMode: 'pointer' });
  plugin.setup(bot);
  tools.get('whale_memory_append').execute({ category: 'topic', content: '我们约了周末去狼山', target: 'group:123456' });
  const ev = mkEv({ text: '在吗', hint: [] });
  bot._push('before-turn', ev);
  assert.equal(ev.hint.length, 1);
  assert.ok(ev.hint[0].includes('whale_memory_query'), 'pointer 模式应指向工具名');
  assert.ok(!ev.hint[0].includes('狼山'), 'pointer 模式不该贴正文');
});

check('配置热改生效：setup 后改 bot.cfg 立即影响行为（不能解构成常量）', () => {
  const dir = path.join(tmpRoot, 'h');
  const { bot, tools } = makeBot(dir);
  plugin.setup(bot);
  tools.get('whale_memory_append').execute({ category: 'topic', content: '我们约了周末去狼山', target: 'group:123456' });
  const ev1 = mkEv({ text: '在吗', hint: [] });
  bot._push('before-turn', ev1);
  assert.equal(ev1.hint.length, 1, '默认应注入');
  bot.cfg.injectMode = 'off'; // 控制台热改
  const ev2 = mkEv({ text: '在吗', hint: [] });
  bot._push('before-turn', ev2);
  assert.equal(ev2.hint.length, 0, '热改 injectMode=off 后仍注入了');
  bot.cfg.enabled = false;
  const r = tools.get('whale_memory_append').execute({ category: 'topic', content: 'x' });
  assert.equal(r.ok, false, '总开关关闭后仍写入了');
  assert.ok(String(r.error).includes('总开关'));
});

await checkAsync('/memory 命令自己 deliver 并 stop（返回字符串没人发）', async () => {
  const dir = path.join(tmpRoot, 'i');
  const { bot, tools, commands, delivered } = makeBot(dir);
  plugin.setup(bot);
  tools.get('whale_memory_append').execute({ category: 'topic', content: '我们约了周末去狼山', target: 'group:123456' });
  const ev = mkEv();
  await commands.get('memory').handler(ev, []);
  assert.equal(delivered.length, 1, '命令没走 bot.deliver');
  assert.equal(delivered[0].target, 'group:123456');
  assert.ok(delivered[0].text.includes('狼山'));
  assert.equal(ev.stopped, true, '命令没设置 stopped（会继续进模型）');
});

check('工具 target 缺省取本轮会话；非法 target 回落到本轮（不串会话）', () => {
  const dir = path.join(tmpRoot, 'j');
  const { bot, tools } = makeBot(dir);
  plugin.setup(bot);
  const r = tools.get('whale_memory_append').execute({ category: 'topic', content: '默认会话' });
  assert.equal(r.ok, true);
  assert.equal(r.chatKey, 'group:123456');
  // 非法 target 不应原样透传（内核同样会把不一致的 target 纠正成本轮会话）
  const bad = tools.get('whale_memory_query').execute({ target: '../etc' });
  assert.equal(bad.target, 'group:123456');
});

check('日记只写私聊', () => {
  const dir = path.join(tmpRoot, 'k');
  const { bot, tools } = makeBot(dir);
  plugin.setup(bot);
  const r = tools.get('whale_diary_save').execute({ date: '2026-11-15', text: '今天很好' });
  assert.equal(r.ok, false, '群聊里不该允许写日记');
  bot.currentTurn = () => ({ chatKey: 'private:222222' });
  const ok = tools.get('whale_diary_save').execute({ date: '2026-11-15', text: '今天很好' });
  assert.equal(ok.ok, true);
});

check('onDispose 交了定时器清理（否则重载会叠实例）', () => {
  const dir = path.join(tmpRoot, 'l');
  const { bot, disposers } = makeBot(dir);
  plugin.setup(bot);
  assert.ok(disposers.length >= 1, '没注册任何 onDispose');
});

check('数据落到 dir 配置目录（不是进程 cwd）', () => {
  const dir = path.join(tmpRoot, 'm');
  const { bot, tools } = makeBot(dir);
  plugin.setup(bot);
  tools.get('whale_memory_append').execute({ category: 'topic', content: '落盘位置检查' });
  assert.ok(fs.existsSync(path.join(dir, 'whale-memory.json')), 'whale-memory.json 没落到 dir 配置目录');
  assert.ok(fs.existsSync(path.join(dir, 'archive.db')), 'archive.db 没落到 dir 配置目录');
});

check('configSchema 的上限真的生效（话题注入天数 / 印象上限）', () => {
  const s = createState();
  const old = appendMemory(s, { category: 'topic', chatKey: 'group:10001', content: '两天前的话题' }, Date.now() - 2 * 24 * 3600 * 1000);
  assert.equal(old.ok, true);
  configureLimits({ topicDays: 3 });
  assert.ok(formatMemorySnapshot(s, 'group:10001', '', Date.now()).includes('两天前的话题'), '3 天窗口应保留');
  configureLimits({ topicDays: 1 });
  assert.ok(!formatMemorySnapshot(s, 'group:10001', '', Date.now()).includes('两天前的话题'), '1 天窗口应过滤');
  configureLimits({ topicDays: 3 }); // 复位，别影响其他用例
  const before = currentLimits().impressionCap;
  configureLimits({ impressionCap: 20 });
  assert.equal(currentLimits().impressionCap, 20);
  configureLimits({ impressionCap: before });
});

// Windows 下 SQLite 句柄释放有延迟，删临时目录失败不算测试失败
try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
catch { console.log('（临时目录清理跳过：文件仍被占用）'); }
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
