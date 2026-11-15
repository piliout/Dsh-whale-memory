// build-graph.mjs —— 独立 CLI：读 whale-memory.json，生成自包含的可视化记忆网络 memory-graph.html。
//
// 生成逻辑已抽到 lib/graph.js 的 buildGraphHTML()（插件内部也用它，吃内存 state）。
// 这个脚本只是"离线手动跑"的入口：
//   node build-graph.mjs <whale-memory.json路径> <输出html路径>
//
// 插件里更常用的入口是 QQ 命令 `/memory-graph`（文件落在 <数据目录>/whale-memory/memory-graph.html）。
import fs from 'node:fs';
import path from 'node:path';
import { buildGraphHTML } from './lib/graph.js';

const [dataFile, outFile] = process.argv.slice(2);
if (!dataFile || !outFile) {
  console.error('用法：node build-graph.mjs <whale-memory.json> <输出html>');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(dataFile, 'utf8').replace(/^\uFEFF/, ''));
const html = buildGraphHTML(state);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html, 'utf8');

const n = (o) => Object.keys(o || {}).length;
console.log(`✅ 生成 ${outFile}`);
console.log(`   群友 ${n(state.impressions)} 人 / 话题会话 ${n(state.topics)} / 日记 ${n(state.diary)} / 教训 ${(state.lessons || []).length}`);
