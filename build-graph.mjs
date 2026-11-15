// build-graph.mjs —— 读 whale-memory.json，生成自包含的可视化记忆网络 memory-graph.html。
//
// 用法：
//   node build-graph.mjs <whale-memory.json路径> <输出html路径>
//
// 视觉：三维神经元星云网络 —— 群友（金黄）分布在 3D 球壳上，话题（青蓝）、重要事件/教训
// （橙红）三色分类，中心「鲸」周期性放电，透视投影（近大远小、发光光晕、星云背景），
// 支持滚轮缩放 + 鼠标拖拽旋转。下半部分为折叠式列表：按「群友」分组，展开看该人的印象与话题。
// 纯 Canvas 2D，无外部依赖，双击即看。

import fs from 'node:fs';
import path from 'node:path';

const [dataFile, outFile] = process.argv.slice(2);
if (!dataFile || !outFile) {
  console.error('用法：node build-graph.mjs <whale-memory.json> <输出html>');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8').replace(/^\uFEFF/, ''));

function shortLabel(text, max) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^[^：:]{0,26}[：:]\s*/, '');
  if (t.length > max) t = t.slice(0, max) + '…';
  return t;
}

// 主人 QQ：从私聊会话 key（private:<QQ>）推断
const ownerQQ = (() => {
  const pk = Object.keys(raw.topics || {}).find((k) => /^private:\d{4,12}$/.test(k));
  return pk ? pk.split(':')[1] : '';
})();

const people = Object.values(raw.impressions || {})
  .map((im) => {
    const uid = String(im.uid || '').trim();
    return {
      uid,
      name: im.name || '?',
      interaction: Number(im.interactionCount) || 0,
      lastSeen: Number(im.lastSeenAt) || 0,
      traits: (im.traits || []).slice(0, 4),                                   // 全文（折叠列表用）
      memories: (im.traits || []).slice(0, 2).map((t) => shortLabel(t, 16)).filter(Boolean), // 短标签（图用）
      isOwner: !!ownerQQ && uid === ownerQQ,
    };
  })
  .sort((a, b) => b.interaction - a.interaction);

function matchPerson(text) {
  for (let i = 0; i < people.length; i++) {
    const n = people[i].name;
    if (n && n.length >= 2 && text.includes(n)) return i;
  }
  return -1;
}

const groupTopicsRaw = Object.entries(raw.topics || {})
  .filter(([k]) => k.startsWith('group:'))
  .flatMap(([, arr]) => arr.map((t) => t.text || '').filter(Boolean))
  .slice(-12);

const privateTopicsRaw = Object.entries(raw.topics || {})
  .filter(([k]) => k.startsWith('private:'))
  .flatMap(([, arr]) => arr.map((t) => t.text || '').filter(Boolean))
  .slice(-12);

const lessonsRaw = (raw.lessons || []).map((l) => l.text || '').filter(Boolean);
const diary = Object.entries(raw.diary || {})
  .map(([date, d]) => ({ date, text: String(d.text || '').replace(/^---[\s\S]*?---\s*/, '').trim().slice(0, 200) }))
  .reverse();

const payload = JSON.stringify({
  people: people.map((p) => ({ name: p.name, interaction: p.interaction, lastSeen: p.lastSeen, traits: p.traits, memories: p.memories, isOwner: p.isOwner })),
  groupTopics: groupTopicsRaw.map((t) => ({ short: shortLabel(t, 18), full: t, personIdx: matchPerson(t) })),
  privateTopics: privateTopicsRaw.map((t) => ({ short: shortLabel(t, 20), full: t })),
  lessons: lessonsRaw.map((l) => ({ short: shortLabel(l, 18), full: l })),
  diary,
});

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小鲸鱼记忆网络</title>
<style>
:root{--bg:#070b16;--panel:#0f1526;--panel2:#141c33;--text:#e8ecf5;--muted:#8a93a8;--cyan:#38c8d6;--gold:#f5b34c;--blue:#4dd6e0;--red:#ff6b81;--amber:#c9a86a}
*{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(1400px 800px at 50% -12%,#14203c,#070b16);color:var(--text);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh}
header{padding:20px 24px 8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
h1{font-size:19px;font-weight:600;letter-spacing:.5px}
h1 span{color:var(--cyan)}
.tabs{display:flex;gap:8px}
.tabs button{background:var(--panel);color:var(--muted);border:1px solid #26324d;padding:7px 16px;border-radius:999px;cursor:pointer;font-size:13px;transition:.2s}
.tabs button.active{background:linear-gradient(135deg,#1b4a5e,#1b3a6e);color:#fff;border-color:#2f6f8f}
main{padding:8px 24px 24px;max-width:1200px;margin:0 auto}
#graph-wrap{position:relative;background:var(--panel);border:1px solid #1c2740;border-radius:18px;overflow:hidden;cursor:grab;box-shadow:0 8px 40px rgba(0,0,0,.35)}
#graph-wrap:active{cursor:grabbing}
canvas{display:block;width:100%}
.legend{position:absolute;left:16px;bottom:12px;font-size:11px;color:var(--muted);line-height:1.9;pointer-events:none}
.legend i{font-style:normal;display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:-1px;box-shadow:0 0 6px currentColor}
.hint{position:absolute;right:14px;top:12px;font-size:11px;color:var(--muted);pointer-events:none}
.list{margin-top:18px}
.list h2{font-size:14px;font-weight:600;margin:0 0 10px;color:var(--cyan)}
/* 折叠式列表 */
.acc{border:1px solid #1c2740;border-radius:12px;margin-bottom:8px;overflow:hidden;background:var(--panel);transition:.2s}
.acc:hover{border-color:#2b3b60}
.acc-head{display:flex;align-items:center;gap:9px;padding:11px 14px;cursor:pointer;user-select:none}
.acc-head:hover{background:var(--panel2)}
.arrow{color:var(--muted);width:12px;flex:0 0 auto;font-size:11px;transition:transform .2s}
.dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 7px currentColor}
.nm{font-weight:600;font-size:13px}
.cnt{color:var(--muted);font-size:12px;margin-left:auto}
.acc-body{padding:0 14px 12px}
.sub{color:var(--blue);font-size:12px;margin:10px 0 6px;font-weight:600;letter-spacing:.5px}
.sub.red{color:var(--red)}
.card{background:var(--panel2);border:1px solid #1c2740;border-radius:10px;padding:11px 13px;margin-bottom:8px;font-size:13px;line-height:1.65}
.card .meta{color:var(--muted);font-size:12px;margin-top:4px}
.empty{color:var(--muted);font-size:13px;padding:20px;text-align:center}
[hidden]{display:none!important}
</style>
</head>
<body>
<header>
<h1><span>●</span> 小鲸鱼记忆网络</h1>
<div class="tabs">
<button id="btn-group" class="active" onclick="switchView('group')">群聊记忆</button>
<button id="btn-private" onclick="switchView('private')">私聊记忆</button>
</div>
</header>
<main>
<section id="view-group">
<div id="graph-wrap"><canvas id="graph"></canvas>
<div class="hint">滚轮缩放 · 拖拽旋转</div>
<div class="legend"><i style="color:#38c8d6;background:#38c8d6"></i>小鲸鱼（核心）　<i style="color:#4ade80;background:#4ade80"></i>主人　<i style="color:#f5b34c;background:#f5b34c"></i>群友　<i style="color:#4dd6e0;background:#4dd6e0"></i>话题　<i style="color:#c9a86a;background:#c9a86a"></i>印象　<i style="color:#ff6b81;background:#ff6b81"></i>★重要事件</div>
</div>
<div class="list"><h2>★ 重要事件（${lessonsRaw.length} 条）</h2><div id="lessons-list"></div></div>
<div class="list"><h2>群友记忆（${people.length} 人 · 点击展开）</h2><div id="people-list"></div></div>
</section>
<section id="view-private" hidden>
<div id="graph-wrap"><canvas id="graph2"></canvas>
<div class="hint">滚轮缩放 · 拖拽旋转</div>
<div class="legend"><i style="color:#38c8d6;background:#38c8d6"></i>小鲸鱼　<i style="color:#4dd6e0;background:#4dd6e0"></i>私聊话题　<i style="color:#d789c9;background:#d789c9"></i>日记　<i style="color:#ff6b81;background:#ff6b81"></i>★重要事件</div>
</div>
<div class="list"><h2>私聊话题（${privateTopicsRaw.length} 条）</h2><div id="private-topics"></div></div>
<div class="list"><h2>日记（${diary.length} 篇）</h2><div id="diary-list"></div></div>
</section>
</main>
<script>
const DATA = ${payload};

function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}

let curView='group', groupScene=null, privateScene=null;
let startTime=performance.now();
let rotY=0, rotX=0.42, userRY=0, userRX=0, zoom=1;
let dragging=false, lastMX=0, lastMY=0;

function switchView(v){
  curView=v;
  document.getElementById('btn-group').classList.toggle('active',v==='group');
  document.getElementById('btn-private').classList.toggle('active',v==='private');
  document.getElementById('view-group').hidden = v!=='group';
  document.getElementById('view-private').hidden = v!=='private';
  buildScenes();
}

// ── 折叠列表：群友（展开=印象+话题）────────────────────────────
function toggleFold(head){
  const body=head.nextElementSibling, arr=head.querySelector('.arrow');
  if(body.hidden){ body.hidden=false; arr.style.transform='rotate(90deg)'; }
  else { body.hidden=true; arr.style.transform='rotate(0deg)'; }
}
function buildFoldLists(){
  // 每个群友关联的话题
  const byPerson=[];
  DATA.people.forEach(function(p,i){
    const ts=DATA.groupTopics.filter(function(t){return t.personIdx===i;}).map(function(t){return t.full;});
    byPerson.push({p:p, topics:ts});
  });
  const unmatched=DATA.groupTopics.filter(function(t){return t.personIdx<0;}).map(function(t){return t.full;});
  const html=byPerson.map(function(o){
    const p=o.p, traits=p.traits||[], topics=o.topics;
    const cnt=[];
    if(traits.length) cnt.push('印象 '+traits.length);
    if(topics.length) cnt.push('话题 '+topics.length);
    let body='';
    if(traits.length) body+='<div class="sub">印象</div>'+traits.map(function(t){return '<div class="card">'+esc(t)+'</div>';}).join('');
    if(topics.length) body+='<div class="sub">话题</div>'+topics.map(function(t){return '<div class="card">'+esc(t)+'</div>';}).join('');
    if(!body) body='<div class="empty">（暂无）</div>';
    return '<div class="acc">'
      +'<div class="acc-head" onclick="toggleFold(this)"><span class="arrow">▶</span><i class="dot" style="color:'+(p.isOwner?'#4ade80':'#f5b34c')+';background:'+(p.isOwner?'#4ade80':'#f5b34c')+'"></i><span class="nm">'+esc(p.name)+'</span><span class="cnt">'+(cnt.join(' · '))+'</span></div>'
      +'<div class="acc-body" hidden>'+body+'</div></div>';
  }).join('');
  document.getElementById('people-list').innerHTML=html||'<div class="empty">（暂无）</div>';
  // 未归属话题
  let extra='';
  if(unmatched.length) extra='<div class="acc"><div class="acc-head" onclick="toggleFold(this)"><span class="arrow">▶</span><i class="dot" style="color:#4dd6e0;background:#4dd6e0"></i><span class="nm">其他话题</span><span class="cnt">'+unmatched.length+' 条</span></div><div class="acc-body" hidden><div class="sub">话题</div>'+unmatched.map(function(t){return '<div class="card">'+esc(t)+'</div>';}).join('')+'</div></div>';
  document.getElementById('people-list').insertAdjacentHTML('beforeend', extra);
  // 重要事件（教训）
  const lh=DATA.lessons.map(function(l){return '<div class="card">'+esc(l.full)+'</div>';}).join('');
  document.getElementById('lessons-list').innerHTML=DATA.lessons.length
    ? '<div class="acc"><div class="acc-head" onclick="toggleFold(this)"><span class="arrow">▶</span><i class="dot" style="color:#ff6b81;background:#ff6b81"></i><span class="nm">重要事件</span><span class="cnt">'+DATA.lessons.length+' 条</span></div><div class="acc-body" hidden><div class="sub red">教训</div>'+lh+'</div></div>'
    : '<div class="empty">（暂无）</div>';
}

// ── 3D 场景 ────────────────────────────────────────────────────────
function fibSphere(i, n, R, squash){
  const golden=Math.PI*(3-Math.sqrt(5));
  const t=n<=1?0:(i/(n-1));
  const yy=1-2*t, rr=Math.sqrt(Math.max(0,1-yy*yy)), th=i*golden;
  return {x:Math.cos(th)*rr*R, y:yy*R*(squash||1), z:Math.sin(th)*rr*R};
}
function mkStars(W,H){
  const a=[]; for(let i=0;i<110;i++) a.push({x:Math.random()*W,y:Math.random()*H,r:Math.random()*1.3+0.3,a:Math.random()*0.5+0.08,tw:Math.random()*6.28});
  return a;
}

function buildGroupScene(){
  const c=document.getElementById('graph');
  const wrap=c.parentElement, W=Math.max(320,wrap.clientWidth||800), H=Math.max(480,Math.min(680,W*0.8));
  const dpr=Math.min(2,window.devicePixelRatio||1);
  c.width=Math.round(W*dpr); c.height=Math.round(H*dpr); c.style.height=H+'px';
  const nodes=[], edges=[];
  nodes.push({kind:'core',x:0,y:0,z:0,r:20,color:'#38c8d6'});
  const people=DATA.people, n=people.length;
  const maxR=Math.min(W,H)*0.40, minR=maxR*0.45, pIdx=[];
  people.forEach(function(p,i){
    const ringF=1-Math.min(1,p.interaction/12)*0.45, R=minR+(maxR-minR)*ringF;
    const pos=fibSphere(i,Math.max(1,n),R,0.72);
    const rad=p.interaction>=8?7:(p.interaction>=4?5:3.5);
    const idx=nodes.length; pIdx[i]=idx;
    const color=p.isOwner?'#4ade80':'#f5b34c', rgb=p.isOwner?'74,222,128':'245,179,76';
    nodes.push({kind:'person',x:pos.x,y:pos.y,z:pos.z,r:rad,phase:Math.random()*6.28,color:color,rgb:rgb,isOwner:p.isOwner,name:p.name,interaction:p.interaction,lastSeen:p.lastSeen});
    edges.push({a:0,b:idx,bend:0.16,flow:1});
  });
  people.forEach(function(p,i){
    edges.push({a:pIdx[i],b:pIdx[(i+1)%n],bend:0.12,flow:0.7});
    if(i%2===0) edges.push({a:pIdx[i],b:pIdx[(i-1+n)%n],bend:-0.1,flow:0.7});
  });
  const hot=[]; people.forEach(function(p,i){ if(p.interaction>=8) hot.push(i); });
  for(let x=0;x<hot.length;x++) for(let y=x+1;y<hot.length;y++) edges.push({a:pIdx[hot[x]],b:pIdx[hot[y]],bend:0.2,flow:1.3});
  // 印象碎片挂在人物旁
  people.forEach(function(p,i){
    if(p.interaction<4 || !p.memories.length) return;
    const pn=nodes[pIdx[i]], R=Math.hypot(pn.x,pn.y,pn.z)||1;
    const dir={x:pn.x/R,y:pn.y/R,z:pn.z/R};
    p.memories.forEach(function(m,mi){
      const off=44+mi*16, idx=nodes.length;
      nodes.push({kind:'memory',x:pn.x+dir.x*off,y:pn.y+dir.y*off,z:pn.z+dir.z*off,r:2.4,phase:Math.random()*6.28,color:'#c9a86a',label:m});
      edges.push({a:pIdx[i],b:idx,bend:0.22,flow:0});
    });
  });
  // 话题（青蓝，未匹配）+ 重要事件（橙红）
  const outer=[];
  DATA.groupTopics.forEach(function(t){ if(t.personIdx<0) outer.push({short:t.short,lesson:false}); });
  DATA.lessons.forEach(function(l){ outer.push({short:l.short,lesson:true}); });
  const oR=maxR+72;
  outer.forEach(function(o,oi){
    const pos=fibSphere(oi,Math.max(1,outer.length),oR,0.6), idx=nodes.length;
    nodes.push({kind:o.lesson?'lesson':'topic',x:pos.x,y:pos.y,z:pos.z,r:o.lesson?4.8:3.2,phase:Math.random()*6.28,color:o.lesson?'#ff6b81':'#4dd6e0',label:(o.lesson?'★':'')+o.short});
    edges.push({a:0,b:idx,bend:-0.18,flow:o.lesson?1.2:0.6});
  });
  return {W,H,dpr,focal:Math.max(W,H)*0.95,maxR,nodes,edges,stars:mkStars(W,H)};
}

function buildPrivateScene(){
  const c=document.getElementById('graph2'), wrap=c.parentElement, W=Math.max(320,wrap.clientWidth||800), H=Math.max(400,Math.min(540,W*0.62));
  const dpr=Math.min(2,window.devicePixelRatio||1);
  c.width=Math.round(W*dpr); c.height=Math.round(H*dpr); c.style.height=H+'px';
  const nodes=[], edges=[];
  nodes.push({kind:'core',x:0,y:0,z:0,r:18,color:'#38c8d6'});
  const items=[];
  DATA.privateTopics.forEach(function(t){ items.push({label:t.short,color:'#4dd6e0'}); });
  DATA.diary.forEach(function(d){ items.push({label:'日记·'+d.date,color:'#d789c9'}); });
  DATA.lessons.forEach(function(l){ items.push({label:'★'+l.short,color:'#ff6b81'}); });
  const n=Math.max(1,items.length), R=Math.min(W,H)*0.38;
  items.forEach(function(it,i){
    const pos=fibSphere(i,n,R,0.7), idx=nodes.length;
    nodes.push({kind:'memory',x:pos.x,y:pos.y,z:pos.z,r:3.2,phase:Math.random()*6.28,color:it.color,label:it.label});
    edges.push({a:0,b:idx,bend:0.2,flow:0.8});
  });
  return {W,H,dpr,focal:Math.max(W,H)*0.95,maxR:R,nodes,edges,stars:mkStars(W,H)};
}

function buildScenes(){ groupScene=buildGroupScene(); privateScene=buildPrivateScene(); }

function project(nd,a,b,scene){
  const x1=nd.x*Math.cos(a)+nd.z*Math.sin(a), z1=-nd.x*Math.sin(a)+nd.z*Math.cos(a), y1=nd.y;
  const y2=y1*Math.cos(b)-z1*Math.sin(b), z2=y1*Math.sin(b)+z1*Math.cos(b);
  const s=scene.focal/(scene.focal+z2)*zoom;
  return {x:scene.W/2+x1*s, y:scene.H/2+y2*s, z:z2, s:s};
}
function curveCtrl(ax,ay,bx,by,bend){
  const mx=(ax+bx)/2,my=(ay+by)/2,dx=bx-ax,dy=by-ay,len=Math.hypot(dx,dy)||1;
  return {x:mx+(-dy/len)*bend*len, y:my+(dx/len)*bend*len};
}
function posOnCurve(ax,ay,bx,by,bend,t){
  const c1=curveCtrl(ax,ay,bx,by,bend), mt=1-t;
  return {x:mt*mt*ax+2*mt*t*c1.x+t*t*bx, y:mt*mt*ay+2*mt*t*c1.y+t*t*by};
}
// 光晕用多层同心圆模拟，替代 shadowBlur（shadowBlur 每帧每节点开销大，是发热主因）
function hexRgb(hex){ const h=String(hex||'#000').replace('#',''); const n=parseInt(h,16); return ((n>>16)&255)+','+((n>>8)&255)+','+(n&255); }
function glow(ctx,x,y,R,hex,alpha){
  const c=hexRgb(hex), ls=[[2.8,0.03],[2.0,0.06],[1.5,0.10]];
  for(let i=0;i<ls.length;i++){ ctx.beginPath(); ctx.arc(x,y,R*ls[i][0],0,6.29); ctx.fillStyle='rgba('+c+','+(ls[i][1]*alpha)+')'; ctx.fill(); }
}

function render(scene,t,canvas){
  const ctx=canvas.getContext('2d'), W=scene.W, H=scene.H, nodes=scene.nodes, edges=scene.edges;
  const DAY=86400000, now=Date.now();
  ctx.setTransform(scene.dpr,0,0,scene.dpr,0,0);
  ctx.clearRect(0,0,W,H);
  // 星云背景
  scene.stars.forEach(function(st){
    const tw=0.55+0.45*Math.sin(t*1.4+st.tw);
    ctx.fillStyle='rgba(170,205,245,'+(st.a*tw)+')';
    ctx.fillRect(st.x,st.y,st.r,st.r);
  });
  const a=rotY+userRY, b=rotX+userRX;
  const P=nodes.map(function(nd){ return project(nd,a,b,scene); });
  const firePeriod=6, ft=(t%firePeriod)/firePeriod;
  const waveR=scene.maxR*1.35*ft*zoom, waveA=(1-ft)*0.32, cx=scene.W/2, cy=scene.H/2;
  ctx.beginPath(); ctx.arc(cx,cy,waveR,0,6.29); ctx.strokeStyle='rgba(56,200,214,'+waveA+')'; ctx.lineWidth=1.4; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx,cy,waveR*0.86,0,6.29); ctx.strokeStyle='rgba(56,200,214,'+(waveA*0.5)+')'; ctx.lineWidth=0.8; ctx.stroke();
  // 边（按深度）
  edges.map(function(e,i){return {e:e,i:i,d:(P[e.a].z+P[e.b].z)/2};}).sort(function(u,v){return u.d-v.d;}).forEach(function(o){
    const e=o.e,ei=o.i,A=P[e.a],B=P[e.b],c1=curveCtrl(A.x,A.y,B.x,B.y,e.bend);
    ctx.strokeStyle='rgba(70,140,190,0.15)'; ctx.lineWidth=0.6;
    ctx.beginPath(); ctx.moveTo(A.x,A.y); ctx.quadraticCurveTo(c1.x,c1.y,B.x,B.y); ctx.stroke();
    if(e.flow){
      const sp=(t*(0.13+(ei%5)*0.013))%(e.flow*1.5)/1.5;
      for(let k=0;k<2;k++){
        const tt=Math.max(0,sp-k*0.06), p=posOnCurve(A.x,A.y,B.x,B.y,e.bend,tt);
        const al=(1-k*0.35)*(1-tt*0.4);
        ctx.beginPath(); ctx.arc(p.x,p.y,1.8-k*0.5,0,6.29); ctx.fillStyle='rgba(150,228,242,'+Math.max(0,al)+')'; ctx.fill();
      }
    }
  });
  // 节点（按深度，近大远小 + 光晕）
  nodes.map(function(nd,i){return {nd:nd,i:i,z:P[i].z};}).sort(function(u,v){return u.z-v.z;}).forEach(function(o){
    const nd=o.nd, p=P[o.i];
    if(nd.kind==='core'){
      const R=nd.r*(1+0.06*Math.sin(t*0.9));
      glow(ctx,p.x,p.y,R,'#38c8d6',0.85);
      ctx.beginPath(); ctx.arc(p.x,p.y,R,0,6.29); ctx.fillStyle='#38c8d6'; ctx.fill();
      ctx.fillStyle='#06222b'; ctx.font='bold 14px sans-serif';
      ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('鲸',p.x,p.y+1);
      return;
    }
    if(nd.kind==='person'){
      const stale=now-(nd.lastSeen||0)>7*DAY;
      const base=stale?0.16:(nd.interaction>=8?0.8:nd.interaction>=4?0.64:0.48);
      const dist3=Math.hypot(nd.x,nd.y,nd.z), d0=Math.abs(dist3-scene.maxR*1.35*ft);
      const waveHit=d0<scene.maxR*0.18? (1-d0/(scene.maxR*0.18))*0.3:0;
      const alpha=Math.min(1,(base+waveHit)*Math.min(1.25,p.s));
      const R=nd.r*p.s*(1+0.06*Math.sin(t*0.7+nd.phase));
      glow(ctx,p.x,p.y,R,nd.color,alpha);
      ctx.beginPath(); ctx.arc(p.x,p.y,R,0,6.29); ctx.fillStyle='rgba('+nd.rgb+','+alpha+')'; ctx.fill();
      if(nd.interaction>=6 && p.s>0.72){
        ctx.fillStyle='rgba(232,236,246,'+(stale?0.4:0.95)+')';
        ctx.font=(nd.interaction>=8?'12px':'11px')+' sans-serif';
        ctx.textAlign='center'; ctx.textBaseline='top'; ctx.fillText(nd.name,p.x,p.y+R+5);
      }
      return;
    }
    const R=nd.r*p.s*(1+0.06*Math.sin(t*0.6+nd.phase));
    glow(ctx,p.x,p.y,R,nd.color,0.7);
    ctx.beginPath(); ctx.arc(p.x,p.y,R,0,6.29); ctx.fillStyle=nd.color; ctx.fill();
    if(nd.label && p.s>0.7){
      ctx.fillStyle= nd.kind==='lesson'?'rgba(255,107,129,0.98)':'rgba(190,228,235,0.88)';
      ctx.font=(nd.kind==='lesson'?'10px':'9px')+' sans-serif';
      ctx.textAlign='left'; ctx.textBaseline='middle'; ctx.fillText(nd.label,p.x+R+5,p.y);
    }
  });
  ctx.textAlign='start'; ctx.textBaseline='alphabetic';
}

let lastFrame=0;
function frame(now){
  if(now-lastFrame<33){ requestAnimationFrame(frame); return; } // ~30fps 减负
  lastFrame=now;
  const dt=0.033;
  if(!dragging) rotY+=dt*0.06; // 转速更舒缓
  const t=now/1000;
  if(curView==='group' && groupScene) render(groupScene,t,document.getElementById('graph'));
  else if(privateScene) render(privateScene,t,document.getElementById('graph2'));
  requestAnimationFrame(frame);
}

function bindControls(id){
  const el=document.getElementById(id).parentElement;
  el.addEventListener('mousedown',function(ev){ dragging=true; lastMX=ev.clientX; lastMY=ev.clientY; });
  el.addEventListener('wheel',function(ev){ ev.preventDefault(); zoom*=ev.deltaY<0?1.1:0.9; zoom=Math.max(0.4,Math.min(4,zoom)); },{passive:false});
}
window.addEventListener('mousemove',function(ev){
  if(!dragging) return;
  userRY+=(ev.clientX-lastMX)*0.006; userRX+=(ev.clientY-lastMY)*0.006;
  userRX=Math.max(-1.2,Math.min(1.2,userRX)); lastMX=ev.clientX; lastMY=ev.clientY;
});
window.addEventListener('mouseup',function(){ dragging=false; });
bindControls('graph'); bindControls('graph2');

function cards(el,arr,fn){ el.innerHTML=arr.length? arr.map(fn).join(''):'<div class="empty">（暂无）</div>'; }
cards(document.getElementById('private-topics'), DATA.privateTopics, function(t){return '<div class="card">'+esc(t.full)+'</div>';});
cards(document.getElementById('diary-list'), DATA.diary, function(d){return '<div class="card">'+esc(d.text)+'<div class="meta">'+esc(d.date)+'</div></div>';});

buildFoldLists();
buildScenes();
if(location.hash==='#private') switchView('private');
requestAnimationFrame(frame);
window.addEventListener('resize',function(){ buildScenes(); });
</script>
</body>
</html>`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html, 'utf8');
console.log(`✅ 生成 ${outFile}`);
console.log(`   群友 ${people.length} 人 / 群话题 ${groupTopicsRaw.length} / 私聊话题 ${privateTopicsRaw.length} / 日记 ${diary.length} / 教训 ${lessonsRaw.length}`);
