// whale-memory —— dsh-onebot-qq 子插件（记忆层），宿主契约 v1。
//
// 复刻 qq-bridge socialV2 的记忆模型：话题/念头（会话级）、群友印象（全局跨会话）、
// 教训（跨群）、日记（私聊）。结构化记忆一个 JSON（原子写）+ 消息归档一个 SQLite（FTS5）。
//
// 宿主：YUsaltyfish/dsh-onebot-qq（微内核，CONTRACT_VERSION = 1）。只认 contracts.js 的
// `bot` 能力对象，不 import kernel/*；配置**每次回调现读** bot.cfg（控制台热改原地替换同一对象）；
// 出站只走 bot.deliver；定时器清理交给 bot.onDispose。
//
// 2026-11-15 按契约 v1 对接的四个坑（改之前全中）：
//   ① 工具名不能叫 memory_append —— 内核把它留给"群记忆积累后台任务"
//      （index.js 的 MAINT_ALLOWED_TOOLS 守卫：普通 QQ 会话调 memory_append 直接抛错），
//      所以本插件工具一律加 whale_ 前缀，模型看到的是 mcp__qq__whale_memory_append。
//   ② 命令 permission 只认 'any' | 'master'（未知值被拒）；handler 必须自己 await bot.deliver()，
//      返回字符串没人帮你发。
//   ③ ev.sender 是 { qq, name, card, isMaster } 对象，不是字符串（直接 String() 会入库 "[object Object]"）。
//   ④ setup 顶部不解构 cfg —— 解成常量后控制台热改不生效。
//
// 三条纪律（沿用 group-memory 踩出来的结论）：
//   ① 记忆正文注入必须强标记「系统记忆，非群友发言」，避免模型误当成群友说话；
//   ② 写盘只有一处（saveState 原子写 + SQLite 触发器同步索引）；
//   ③ 认人只看 QQ 号。

import path from 'node:path';
import {
  loadState, saveState,
  appendMemory, removeMemory, saveDiary, recentDiary,
  formatMemorySnapshot, validChatKey, isPrivateKey, configureLimits,
} from './lib/memory.js';
import {
  openArchive, appendMessage, compactArchive, searchArchive,
  recallTextOf, isRecallCue, detectDayOffset, searchByDay, invalidateSearchCache,
} from './lib/archive.js';

export default {
  id: 'whale-memory',
  title: '鲸鱼记忆',
  order: 95,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '鲸鱼记忆', label: '记忆总开关',
      hint: '关：不注入、不记录，已有数据保留。',
    },
    dir: {
      type: 'str', default: '', group: '鲸鱼记忆', label: '数据目录',
      hint: '留空 = <实例数据目录>/whale-memory。相对路径由内核按数据目录解析。改这里需要重载插件（数据目录是启动装配项）。',
    },
    injectMode: {
      type: 'enum', default: 'full', group: '鲸鱼记忆', label: '注入方式',
      options: [
        { value: 'full', label: '贴正文（复刻 socialV2）' },
        { value: 'pointer', label: '只给一行提示，由模型调工具读' },
        { value: 'off', label: '不注入，只靠工具手动查' },
      ],
      hint: '若发现模型把记忆误当成群友刚说的话，切到「只给提示」。',
    },
    topicInjectDays: {
      type: 'int', default: 3, min: 1, max: 30, group: '鲸鱼记忆', label: '话题注入天数',
      hint: '超过 N 天没再提的话题不再注入（数据仍保留）。',
    },
    maxImpressions: {
      type: 'int', default: 50, min: 10, max: 200, step: 5, group: '鲸鱼记忆', label: '群友印象上限',
      hint: '超了优先淘汰「只见过一面且 7 天未出现」的人。',
    },
    recallEnabled: {
      type: 'bool', default: true, group: '鲸鱼记忆', label: '自动回忆',
      hint: '消息出现回忆词（上次/之前/记得/昨天…）或印象里的人名时，自动检索旧话注入。',
    },
    archiveDays: {
      type: 'int', default: 90, min: 7, max: 365, group: '鲸鱼记忆', label: '原文保留天数',
      hint: '超过 N 天的消息正文清空、只留关键词（关键词仍参与检索）。',
    },
  },

  setup(bot) {
    const log = bot.log || console;
    const cfgOf = () => bot.cfg || {};
    const on = () => cfgOf().enabled !== false;

    // 数据目录是启动装配项：改了要重载插件（其余配置热改即生效）
    const dataDirOf = () => {
      const configured = String(cfgOf().dir || '').trim();
      return configured || path.join(String(bot.core?.dataDir || '.'), 'whale-memory');
    };
    const memDir = dataDirOf();

    // 把控制台的两个上限同步进记忆核心（默认值与旧行为一致）
    const syncLimits = () => {
      const c = cfgOf();
      return configureLimits({ topicDays: c.topicInjectDays, impressionCap: c.maxImpressions });
    };
    syncLimits();

    let state = loadState(memDir);
    const persist = () => {
      try { saveState(memDir, state); }
      catch (e) { log.error(`[鲸鱼记忆] 写盘失败：${e?.message ?? e}`); }
    };

    // 归档 + FTS5 全文索引（keywords 与 text 一起进索引，压缩后仍可搜）
    let db = null;
    try { db = openArchive(memDir); }
    catch (e) { log.error(`[鲸鱼记忆] 归档库打开失败（记忆仍可用，检索功能停用）：${e?.message ?? e}`); }

    const compactNow = (why) => {
      if (!db) return;
      try {
        const days = Number(cfgOf().archiveDays) || 90;
        const n = compactArchive(db, Date.now(), days);
        if (n) {
          invalidateSearchCache();
          log.info(`[鲸鱼记忆] ${why}压缩 ${n} 条（>${days} 天：正文清空、关键词留索引）`);
        }
      } catch (e) { log.error(`[鲸鱼记忆] 压缩失败：${e?.message ?? e}`); }
    };
    // 每日压缩一次；启动 1 分钟后补一次（迁移进来的老数据不必等一整天）
    const compactTimer = setInterval(() => compactNow('每日'), 24 * 60 * 60 * 1000);
    const bootCompact = setTimeout(() => compactNow('启动'), 60 * 1000);
    try {
      bot.onDispose?.(() => {
        clearInterval(compactTimer);
        clearTimeout(bootCompact);
        // Windows 下不关句柄，插件重载/删目录会 EPERM（文件被占用）
        try { db?.close(); } catch { /* 已关闭 */ }
        db = null;
      });
    } catch { /* 老内核没有 onDispose 也不影响主体 */ }

    // ── 会话标识（认人只看 QQ 号；chatKey 由内核给出）───────────────────
    const lineKeyOf = (ev) => {
      if (!ev) return null;
      const key = String(ev.chatKey || '');
      if (validChatKey(key)) return key;
      if (ev.isGroup && /^\d{4,12}$/.test(String(ev.groupId || ''))) return `group:${ev.groupId}`;
      return null;
    };
    // ev.sender 是对象：{ qq, name, card, isMaster }
    const senderNameOf = (ev) => {
      const s = ev?.sender || {};
      if (typeof s === 'string') return s; // 兼容极端情况
      return String(s.card || s.name || s.qq || '');
    };

    // ── 归档：passive-tap 收每条入站消息（旁路，不影响回复）──────────────
    bot.on('passive-tap', (ev) => {
      try {
        if (!db || !on()) return;
        const key = lineKeyOf(ev);
        const text = String(ev?.text || '').trim();
        if (!key || !text) return;
        appendMessage(db, { key, t: Number(ev.time) || Date.now(), self: 0, sender: senderNameOf(ev), text });
      } catch (e) { log.warn(`[鲸鱼记忆] 归档失败：${e?.message ?? e}`); }
    });

    // ── 归档：onAfterSend 收机器人自己说的话（否则「我上次说过什么」永远想不起来）──
    // rec = { target, text, ats, replyTo, mode, messageId, hits, wire, turnCtx }
    try {
      const off = bot.onAfterSend?.((rec) => {
        try {
          if (!db || !on()) return;
          const key = String(rec?.target || '');
          if (!validChatKey(key)) return;
          let text = String(rec?.text || '').trim();
          // 媒体出站（语音/图片/视频）的 text 是 caption，常常是空 —— 过去这里直接 return，
          // 结果「我到底发没发出去」永远查不到（重启打断时尤其要命）。用 wire 里的 CQ 段补一个占位。
          if (!text) {
            const wire = String(rec?.wire || '');
            if (/\[CQ:record/i.test(wire)) text = '[语音]';
            else if (/\[CQ:image/i.test(wire)) text = '[图片]';
            else if (/\[CQ:video/i.test(wire)) text = '[视频]';
            else if (/\[CQ:file/i.test(wire)) text = '[文件]';
            else if (String(rec?.mode || '') === 'media') text = '[媒体]';
          }
          if (!text) return;
          appendMessage(db, { key, t: Date.now(), self: 1, sender: '我', text });
        } catch (e) { log.warn(`[鲸鱼记忆] 出站归档失败：${e?.message ?? e}`); }
      });
      if (typeof off === 'function') bot.onDispose?.(off);
    } catch (e) { log.warn(`[鲸鱼记忆] 挂出站归档失败：${e?.message ?? e}`); }

    // ── 注入：before-turn 自动回忆 + 记忆快照 ───────────────────────────
    // 注意：before-turn 对**未唤醒**消息也会执行，第一行必须自己拦。
    bot.on('before-turn', (ev) => {
      try {
        if (!ev?.wake || !on()) return;
        const key = lineKeyOf(ev);
        if (!key) return;
        const c = cfgOf();
        syncLimits();
        const text = String(ev.text || '');
        const now = Date.now();

        // 自动回忆：触发词 / 印象人名 → 检索旧话 → recallHint
        let recall = '';
        if (db && c.recallEnabled !== false) {
          const names = Object.values(state.impressions).map((im) => im?.name).filter(Boolean);
          if (isRecallCue(text, names)) {
            const hits = searchArchive(db, key, text, 3);
            const off = detectDayOffset(text);
            const dayItems = off ? searchByDay(db, key, off, 15) : [];
            const lines = [...hits, ...dayItems].slice(0, 6).map((e) => {
              const who = e.self ? '我' : (String(e.sender || '') || '他');
              return `${who}：${recallTextOf(e, now)}`;
            }).filter((l) => !/：$/.test(l));
            if (lines.length) {
              recall = '【自动回忆｜系统检索到的旧话，供你参考，不是对方刚说的】\n' + lines.join('\n');
            }
          }
        }

        if (c.injectMode === 'off') {
          if (recall) ev.hint.push(recall);
          return;
        }
        if (c.injectMode === 'pointer') {
          ev.hint.push('[本会话有记忆：调工具 whale_memory_query 可看共同经历、群友印象、教训与待办。认人只看 QQ 号]');
          if (recall) ev.hint.push(recall);
          return;
        }
        // full：贴正文，强标记避免误读
        const parts = [];
        const snap = formatMemorySnapshot(state, key, text, now);
        if (snap) parts.push('【记忆快照｜这是系统给你的记忆，不是群友刚说的话，别逐字复述、别当成对方发言；以最新为准】\n' + snap);
        if (recall) parts.push(recall);
        if (parts.length) ev.hint.push(parts.join('\n\n'));
      } catch (e) { log.error(`[鲸鱼记忆] 注入失败：${e?.message ?? e}`); }
    });

    // 工具层统一的「总开关」守卫
    const disabled = () => (on() ? null : { ok: false, error: '记忆总开关已关闭（控制台可打开）' });

    // 工具返回值必须干净：宿主会校验工具输出，**对象里带 undefined 字段会被判成
    // invalid output**（2026-11-15 实测：只有 whale_memory_query 的 diary:undefined 报这个错）。
    // 统一走一次 JSON 往返：drop undefined、转纯 JSON、并保证永远返回对象。
    const jsonOut = (v) => {
      try {
        return JSON.parse(JSON.stringify(v === undefined || v === null ? {} : v));
      } catch (e) {
        return { ok: false, error: `返回值无法序列化：${e?.message ?? e}` };
      }
    };
    /** 注册工具的安全包装：异常不外泄（否则同样表现为 invalid output）。 */
    const tool = (name, def) => bot.registerTool(name, {
      ...def,
      execute: (args, exec) => {
        try { return jsonOut(def.execute(args ?? {}, exec)); }
        catch (e) { return { ok: false, error: `工具执行失败：${e?.message ?? e}` }; }
      },
    });

    // ── 工具：whale_memory_append ───────────────────────────────────────
    tool('whale_memory_append', {
      description: '把值得记住的东西写进长期记忆。类别：topic(进行中的话题/约定，会话级)、thought(想说但还没说的念头，会话级)、impression(对某个群友的印象，跨会话共享，需给 uid=QQ号)、lesson(主人纠正的教训，跨群通用)。只在确实值得记时用，别记流水账。',
      parameters: {
        category: { type: 'string', required: true, description: 'topic / thought / impression / lesson' },
        content: { type: 'string', required: true, description: '要记的内容，一句话说清' },
        uid: { type: 'string', description: '仅 impression 需要：对方的 QQ 号' },
        name: { type: 'string', description: '仅 impression：对方当前昵称' },
        ttlMs: { type: 'string', description: '仅 thought：多久后过期（毫秒），默认 24 小时' },
        target: { type: 'string', description: '会话目标 group:群号 / private:QQ号；不填默认本轮会话' },
      },
      execute(args = {}) {
        const bad = disabled();
        if (bad) return bad;
        syncLimits();
        const turn = bot.currentTurn?.() || null;
        const chatKey = validChatKey(String(args.target || '')) ? String(args.target) : (turn?.chatKey || '');
        const r = appendMemory(state, {
          category: String(args.category || ''),
          chatKey,
          content: args.content,
          extra: { uid: args.uid, name: args.name, ttlMs: Number(args.ttlMs) || undefined },
        }, Date.now());
        if (r.ok) persist();
        return r.ok ? { ok: true, ...r } : { ok: false, error: r.error };
      },
    });

    // 快照有 6000 字预算（按行截断），印象只列前 40 且可能被切尾 —— 所以给两条「查全」的路。
    const impressionList = (q = '', limit = 50) => {
      const needle = String(q || '').trim().toLowerCase();
      return Object.entries(state.impressions).map(([key, im]) => ({
        uid: String(im?.uid || key.replace(/^qq:/, '')),
        name: String(im?.name || ''),
        traits: Array.isArray(im?.traits) ? im.traits.map(String) : [],
        interactionCount: Number(im?.interactionCount) || 0,
        lastSeenAt: Number(im?.lastSeenAt) || 0,
      }))
        .filter((x) => !needle || [x.uid, x.name, ...x.traits].some((s) => String(s).toLowerCase().includes(needle)))
        .sort((a, b) => b.interactionCount - a.interactionCount || b.lastSeenAt - a.lastSeenAt)
        .slice(0, Math.max(1, limit));
    };

    // ── 工具：whale_memory_query ────────────────────────────────────────
    tool('whale_memory_query', {
      description: '查本会话（或指定会话）的记忆：进行中的话题、未说的念头、群友印象、主人的教训、最近的日记。记忆缺失不代表从未发生。认人只看 QQ 号。'
        + '**注意快照是按预算截断的**（印象这段只列前 40 个且可能被切尾）：要回答「总共有多少群友印象」看返回的 impressionCount；'
        + '要查某个具体的人，用 q 传昵称/QQ/标签片段拿完整记录；要看全部人名清单传 impressions="all"。',
      parameters: {
        target: { type: 'string', description: '会话目标 group:群号 或 private:QQ号；不填默认本轮会话' },
        q: { type: 'string', description: '按昵称 / QQ / 印象标签 过滤群友印象（**模糊匹配**：会连"标签里只是提到过她"的人也一起命中）→ 拿到结果后**先看 uid 认人**，别只看名字就下结论' },
        impressions: { type: 'string', description: '传 "all" 拿全部印象的紧凑清单（名字+QQ+互动次数，最多 200 条）' },
      },
      execute(args = {}) {
        syncLimits();
        const turn = bot.currentTurn?.() || null;
        const target = validChatKey(String(args.target || '')) ? String(args.target) : (turn?.chatKey || '');
        if (!validChatKey(target)) return { ok: false, error: '会话标识无效' };
        const impressionCount = Object.keys(state.impressions).length;

        // 模式 A：按条件查人（不贴整份快照，省 token）
        const wantAll = String(args.impressions || '').toLowerCase() === 'all';
        if (args.q || wantAll) {
          const list = impressionList(args.q, wantAll ? 200 : 50);
          return {
            ok: true, target, impressionCount,
            mode: wantAll ? 'impressions-all' : 'impressions-filter',
            q: args.q || undefined,
            matched: list.length,
            impressions: list.map((x) => ({
              name: x.name || undefined,
              uid: x.uid,
              traits: x.traits.length ? x.traits : undefined,
              interactionCount: x.interactionCount || undefined,
            })),
            hint: wantAll
              ? (impressionCount > list.length ? `共 ${impressionCount} 人，这里只列了 ${list.length}` : undefined)
              : (list.length ? undefined : '没匹配到人：换个更短的关键词（昵称片段或 QQ 号）再试'),
          };
        }

        // 模式 B：整份快照（默认）
        const snap = formatMemorySnapshot(state, target, '', Date.now());
        const diary = isPrivateKey(target) ? recentDiary(state) : [];
        return {
          ok: true, target,
          impressionCount,
          memory: snap || '（还没有记忆）',
          diary: diary.length ? diary : undefined,
        };
      },
    });

    // ── 工具：whale_search_history（按关键词翻旧话，全量档案）────────────
    tool('whale_search_history', {
      description: '按关键词翻本会话的历史原话（全文检索，想不起旧原话时用）。返回的是当时真实说过的话。',
      parameters: {
        q: { type: 'string', required: true, description: '要搜的关键词' },
        target: { type: 'string', description: '会话目标 group:群号 或 private:QQ号；不填默认本轮会话' },
        limit: { type: 'string', description: '最多返回几条，默认 3' },
      },
      execute(args = {}) {
        if (!db) return { ok: false, error: '归档库未启用' };
        const turn = bot.currentTurn?.() || null;
        const target = validChatKey(String(args.target || '')) ? String(args.target) : (turn?.chatKey || '');
        if (!validChatKey(target)) return { ok: false, error: '会话标识无效' };
        const lim = Math.max(1, Math.min(10, Number(args.limit) || 3));
        const hits = searchArchive(db, target, String(args.q || ''), lim);
        return {
          ok: true, target, q: args.q, count: hits.length,
          items: hits.map((e) => ({
            t: e.t, self: e.self, sender: e.sender, text: recallTextOf(e, Date.now()),
          })),
        };
      },
    });

    // ── 工具：whale_memory_remove ───────────────────────────────────────
    tool('whale_memory_remove', {
      description: '删除一条记忆。类别同 whale_memory_append。按 id 精确删，或按 content 全文匹配删。',
      parameters: {
        category: { type: 'string', required: true, description: 'topic / thought / impression / lesson' },
        content: { type: 'string', description: '要删的内容原文（或印象的 QQ号/昵称）' },
        id: { type: 'string', description: '条目 id（whale_memory_query 里可见）' },
      },
      execute(args = {}) {
        const bad = disabled();
        if (bad) return bad;
        const turn = bot.currentTurn?.() || null;
        const r = removeMemory(state, {
          category: String(args.category || ''),
          chatKey: turn?.chatKey || '',
          content: args.content,
          id: args.id,
        });
        if (r.ok) persist();
        return r.ok ? { ok: true, removed: r.removed } : { ok: false, error: r.error, candidates: r.candidates };
      },
    });

    // ── 工具：whale_diary_save ──────────────────────────────────────────
    tool('whale_diary_save', {
      description: '写一条私聊日记（只记值得长期留的，别写流水账）。日期 YYYY-MM-DD。',
      parameters: {
        date: { type: 'string', required: true, description: '日期 YYYY-MM-DD' },
        text: { type: 'string', required: true, description: '日记内容' },
      },
      execute(args = {}) {
        const bad = disabled();
        if (bad) return bad;
        const turn = bot.currentTurn?.() || null;
        if (turn?.chatKey && !isPrivateKey(turn.chatKey)) return { ok: false, error: '日记只写私聊，群聊不写' };
        const r = saveDiary(state, { date: args.date, text: args.text }, Date.now());
        if (r.ok) persist();
        return r;
      },
    });

    // ── 命令：/memory（主人查本会话记忆）────────────────────────────────
    // 契约：permission 只认 any|master；handler 必须自己 deliver，返回字符串没人发。
    try {
      bot.registerCommand?.('memory', {
        permission: 'master',
        description: '查本会话记忆快照（仅主人）',
        async handler(ev) {
          try {
            const key = lineKeyOf(ev);
            syncLimits();
            const snap = key ? formatMemorySnapshot(state, key, '', Date.now()) : '';
            await bot.deliver(ev.chatKey, `【鲸鱼记忆】\n${snap || '（还没有记忆 / 无法识别当前会话）'}`);
          } catch (e) {
            log.warn(`[鲸鱼记忆] /memory 回执失败：${e?.message ?? e}`);
          } finally {
            ev.stopped = true;
            ev.stopReason = 'whale-memory:cmd';
          }
        },
      });
    } catch (e) { log.warn(`[鲸鱼记忆] 注册 /memory 失败：${e?.message ?? e}`); }

    if (bot.contractVersion !== undefined && bot.contractVersion !== 1) {
      log.warn(`[鲸鱼记忆] 宿主契约版本 ${bot.contractVersion}（本插件按 v1 写的），个别字段可能不兼容`);
    }
    log.info(`[鲸鱼记忆] 已装配（数据目录 ${memDir}；注入 ${cfgOf().injectMode || 'full'}；`
      + `自动回忆 ${cfgOf().recallEnabled !== false ? '开' : '关'}；归档 ${db ? '就绪' : '不可用'}）`);
  },
};
