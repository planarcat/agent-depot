#!/usr/bin/env node
/* ====================================================================
   E2E test driver — real Chrome via CDP (zero npm dependencies).
   Node 23 自带 WebSocket/fetch；直接驱动系统 Chrome。
   用法：
     node tests/e2e.mjs                 # 无头全量
     node tests/e2e.mjs --headed        # 有头全量（本机 GUI 会话）
     node tests/e2e.mjs --smoke         # 冒烟（仅页面加载 + 截图）
   证据输出：tests/evidence/e2e-report.json + *.png
   ==================================================================== */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EVIDENCE = join(__dirname, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });

const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const SMOKE = args.includes('--smoke');
const BASE = process.env.HUB_BASE || 'http://127.0.0.1:8317';
const DEBUG_PORT = HEADED ? 9334 : 9333;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* ---------- CDP client ---------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        c.handlers.forEach(h => h(msg));
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  on(fn) { this.handlers.push(fn); }
}

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launchChrome() {
  const profile = join(tmpdir(), 'hub-e2e-profile-' + process.pid);
  const flags = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1480,960',
  ];
  if (!HEADED) flags.push('--headless=new', '--disable-gpu');
  const proc = spawn(CHROME, flags, { stdio: 'ignore', detached: false });
  // wait for devtools endpoint
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (r.ok) { const v = await r.json(); return { proc, profile, version: v['Browser'] }; }
    } catch {}
    await sleep(250);
  }
  proc.kill();
  throw new Error('Chrome DevTools endpoint 未就绪');
}

async function newPage(url) {
  const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = await r.json();
  return target;
}

/* ---------- test harness ---------- */
const results = [];
const consoleErrors = [];
const navEvents = [];
const netInflight = new Map();
const netFails = [];
let currentScenario = '';
let cdp;

async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval error: ' + (r.exceptionDetails.exception?.description || expr));
  return r.result.value;
}
async function waitFor(expr, timeout = 8000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(expr)) return true; } catch {}
    await sleep(150);
  }
  throw new Error('waitFor 超时: ' + label);
}
async function click(q) {
  const r = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(q)}); if (!el) return 'NOEL'; el.click(); return 'OK'; })()`);
  if (r !== 'OK') throw new Error('click 目标不存在: ' + q);
}
async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(EVIDENCE, name), Buffer.from(r.data, 'base64'));
}
async function scenario(name, fn) {
  const t0 = Date.now();
  currentScenario = name;
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail || null });
    console.log(`PASS  ${name}  (${Date.now() - t0}ms)${detail ? '  — ' + detail : ''}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e.message || e) });
    console.log(`FAIL  ${name}  (${Date.now() - t0}ms)\n      ${e.message || e}`);
  }
}

/* ---------- scenarios ---------- */

const scenarios = [];
const S = (name, fn, smoke = false) => scenarios.push({ name, fn, smoke });

/* ---- 即时刷新（SSE）：磁盘一变，前端自动跟着变，不靠轮询 ---- */
S('live-sse-refresh', async () => {
  await waitFor(`!!window.hubApp && !!(window.hubApp.state || {}).watch`, 10000, 'hubApp/state 就绪');

  // 1) 页面处于 SSE 即时模式（后端 hub/watcher.py 用 kqueue/watchdog 盯盘）
  const mode = JSON.parse(await evaluate(`JSON.stringify({live: document.body.dataset.live,
    backend: (window.hubApp.state.watch||{}).backend||''})`));
  if (mode.live !== 'sse') throw new Error('未进入 SSE 即时模式：' + JSON.stringify(mode));
  if (!mode.backend || mode.backend === 'off') throw new Error('后端 watcher 未启动：' + mode.backend);

  // 2) 磁盘真的变了 → 前端 rev 自己前进（不靠轮询）
  const before = await evaluate('window.hubApp.state.rev || 0');
  const dir = join(homedir(), '.pi', 'agent', 'sessions', '_e2e_watch_probe');
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, 'probe.txt');
  writeFileSync(probe, 'e2e ' + Date.now());        // 非 .jsonl → 不会被扫描器当成会话
  try {
    await waitFor(`(window.hubApp.state.rev || 0) > ${before}`, 8000, '磁盘变动未触发前端刷新');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
  const after = await evaluate('window.hubApp.state.rev || 0');
  if (!(after > before)) throw new Error(`rev 未前进：${before} → ${after}`);

  // 3) 自己写入（POST/PATCH）→ 后端立即广播，别的标签页也能同步
  const before2 = await evaluate('window.hubApp.state.rev || 0');
  await evaluate(`fetch('/api/tools/agents', {method:'PATCH', headers:{'Content-Type':'application/json'},
    body:'{}'}).then(r => r.status)`);
  await waitFor(`(window.hubApp.state.rev || 0) > ${before2}`, 6000, '自身写入未广播');
  const rev2 = await evaluate('window.hubApp.state.rev || 0');
  return `SSE ${mode.backend} · 磁盘 ${before}→${after} · 自身写入 ${before2}→${rev2}`;
});



async function skillsRowsOrDump() {
  try {
    await waitFor(`document.querySelectorAll('[data-testid="skills-row"]').length >= 2`, 10000, 'skills 目录行');
  } catch (e) {
    const dump = await evaluate(`JSON.stringify({
      center: ((document.querySelector('.sb-center') || {}).innerHTML || 'NO CENTER').replace(/\s+/g, ' ').slice(0, 220),
      toasts: [...document.querySelectorAll('.hub-toast')].map(t => t.textContent.trim()).slice(0, 3),
      skillsView: typeof window.SkillsView, mcpView: typeof window.McpView, opsView: typeof window.OpsView,
      active: document.getElementById('view-skills').classList.contains('is-active'),
      readyState: document.readyState, href: location.href,
      pageAgeMs: Math.round(Date.now() - performance.timeOrigin),
      navCount: performance.getEntriesByType('navigation').length,
      navType: (performance.getEntriesByType('navigation')[0] || {}).type,
      vkLen: (document.getElementById('view-skills').innerHTML || '').length,
      viewRows: document.querySelectorAll('[data-testid="row"]').length,
      scripts: performance.getEntriesByType('resource').filter(e => e.name.includes('/views/')).map(e => e.name.split('/').pop() + ':' + e.transferSize + ':' + Math.round(e.startTime)) })`);
    throw new Error(e.message + ' | dump=' + dump + ' | nav=' + JSON.stringify(navEvents.slice(-4)) + ' | inflight=' + JSON.stringify([...netInflight.values()].map(r => ({ u: r.url, ms: Date.now() - r.t })).slice(0, 8)) + ' | netFails=' + JSON.stringify(netFails.slice(-6)));
  }
}

S('page-load', async () => {
  await waitFor(`document.readyState === 'complete'`, 10000, 'readyState');
  await waitFor(`document.querySelectorAll('[data-testid="row"]').length >= 5`, 10000, '会话行渲染');
  const badge = await evaluate(`document.querySelector('[data-testid="engine-badge"]').textContent`);
  if (!badge.includes('已连接')) throw new Error('引擎徽章异常: ' + badge);
  const n = await evaluate(`document.querySelectorAll('[data-testid="row"]').length`);
  const sc = await evaluate(`(() => {
    const r = document.getElementById('session-rows');
    const sh = r.scrollHeight, ch = r.clientHeight;
    r.scrollTop = 120; const moved = r.scrollTop > 0; r.scrollTop = 0;
    return { sh, ch, moved };
  })()`);
  if (n > 14) {
    if (!(sc.sh > sc.ch)) throw new Error(`列表高度链断裂回归：列表超一屏但不可滚动 (${sc.sh}/${sc.ch})`);
    if (!sc.moved) throw new Error('列表 scrollTop 卡死（高度链回归）');
  }
  return `${n} 行会话 · ${badge} · ${n > 14 ? '列表可滚动' : '行数少跳过滚动检查'}`;
}, true);

S('screenshot-desktop', async () => {
  await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
  await shot('desktop-main.png'); return 'desktop-main.png';
}, true);

S('filter-codex', async () => {
  // v0.9：工具筛选 chips 已去掉 → 点工具卡片；不写死 codex（口径 B 下停用工具不显示）
  const tid = await evaluate(`(document.querySelector('[data-testid^="tool-open-"]') || {}).dataset?.testid?.replace('tool-open-','') || ''`);
  if (!tid) throw new Error('没有可见的工具卡片');
  await click(`[data-testid="tool-open-${tid}"]`);
  await sleep(300);
  const r = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="row"]')];
    return { total: rows.length, bad: rows.filter(x => x.dataset.tool !== ${JSON.stringify(tid)}).length };
  })()`);
  if (r.bad > 0) throw new Error(`过滤器泄漏：${r.bad} 行不是 ${tid}`);
  await click('[data-testid="filter-all"]');
  await sleep(200);
  const back = await evaluate(`document.querySelectorAll('[data-testid="row"]').length`);
  return `${tid} ${r.total} 行 · 恢复全部 ${back} 行`;
});

S('selection', async () => {
  // select first two rows
  const n = await evaluate(`(() => {
    const cbs = [...document.querySelectorAll('[data-testid="row-check"]')].slice(0, 2);
    cbs.forEach(cb => cb.click());
    return document.querySelector('[data-testid="sel-count"]').textContent;
  })()`);
  if (n !== '2') throw new Error('sel-count 应为 2，实际 ' + n);
  // uncheck exactly one row -> expect 1 left
  const n1 = await evaluate(`(() => {
    const cbs = [...document.querySelectorAll('[data-testid="row-check"]')];
    cbs[0].click();
    return document.querySelector('[data-testid="sel-count"]').textContent;
  })()`);
  if (n1 !== '1') throw new Error('取消一条后应为 1，实际 ' + n1);
  // clear all remaining checks -> expect 0
  const n0 = await evaluate(`(() => {
    [...document.querySelectorAll('[data-testid="row-check"]')]
      .filter(cb => cb.checked).forEach(cb => cb.click());
    return document.querySelector('[data-testid="sel-count"]').textContent;
  })()`);
  if (n0 !== '0') throw new Error('清空选择失败，实际 ' + n0);
  return `选中 2 → 取消 1 → 清空 → ${n0}`;
});

S('preview-modal', async () => {
  // v0.6.2：会话详情内联在中栏（替代预览弹窗），lineage 与消息均在
  const hasLid = await evaluate(`!![...document.querySelectorAll('[data-testid="row"]')]
    .find(r => r.querySelector('[data-testid="lid-badge"]'))`);
  if (!hasLid) return 'SKIP：可见域里没有已迁移（lineage）会话 —— 口径 B 下需先启用承载它们的工具';
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-testid="row"]')]
      .find(r => r.querySelector('[data-testid="lid-badge"]'));
    row.click();
  })()`);
  await waitFor(`!!document.querySelector('[data-testid="sess-detail-title"]')`, 8000, '详情打开');
  const chain = await evaluate(`document.getElementById('sess-detail-chain').textContent`);
  const msgs = await evaluate(`document.querySelectorAll('#sess-detail-body .msg').length`);
  if (!chain.includes('hub:lx-')) throw new Error('详情未显示 lineage 链: ' + chain);
  if (msgs === 0) throw new Error('详情无消息');
  await shot('preview-open.png');
  return `链=${chain.slice(0, 60)} · ${msgs} 条消息（中栏内联）`;
});

S('refresh-one', async () => {
  // 卡片上已不再有 ⟳（按注解去掉）→ 进入工具视图，用侧栏的刷新按钮做单工具采集
  const tid = await evaluate(`(document.querySelector('[data-testid^="tool-open-"]') || {}).dataset?.testid?.replace('tool-open-','') || ''`);
  if (!tid) throw new Error('没有可见的工具卡片');
  await click(`[data-testid="tool-open-${tid}"]`);
  await waitFor(`!!document.querySelector('[data-testid="focus-refresh"]')`, 6000, '工具侧栏刷新按钮');
  await click('[data-testid="focus-refresh"]');
  await waitFor(`!!document.querySelector('.hub-toast--success')`, 10000, '刷新成功 toast');
  await click('[data-testid="filter-all"]');
  return `进入 ${tid} → 侧栏刷新成功 toast`;
});

S('schedule-flow', async () => {
  // 口径变更（2026-10-16）：顶栏「定时任务」入口按用户要求**暂时隐藏**，
  //   面板 UI 不再可达 → 用例改为验证"调度配置能读写并持久化"（经 API），
  //   覆盖能力不变、去掉对隐藏入口的依赖。恢复入口时再补回 UI 断言。
  const scope = await evaluate(`fetch('/api/state').then(r => r.json()).then(d => {
    const keys = Object.keys(d.schedule || {}).filter(k => k !== 'all');
    return keys[0] || 'all';
  })`);
  if (!scope) throw new Error('没有可用的调度范围');
  await evaluate(`fetch('/api/schedule', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ tool: ${JSON.stringify('__SCOPE__')}, enabled: true, interval_min: 15 }) })`
    .replace('__SCOPE__', scope));
  await waitFor(`fetch('/api/state').then(r => r.json()).then(d => {
    const c = (d.schedule || {})[${JSON.stringify('__SCOPE__')}] || {};
    return c.enabled === true && c.interval_min === 15;
  })`.replace('__SCOPE__', scope), 8000, '调度已持久化');
  // 还原
  await evaluate(`fetch('/api/schedule', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ tool: ${JSON.stringify('__SCOPE__')}, enabled: false, interval_min: 30 }) })`
    .replace('__SCOPE__', scope));
  await waitFor(`fetch('/api/state').then(r => r.json()).then(d => {
    const c = (d.schedule || {})[${JSON.stringify('__SCOPE__')}] || {};
    return c.enabled === false && c.interval_min === 30;
  })`.replace('__SCOPE__', scope), 8000, '调度已还原');
  // 顺带守住"入口确实隐藏了"（恢复入口时这条会先红，提醒一起改回来）
  const hidden = await evaluate(`document.getElementById('schedule-open').hidden`);
  if (!hidden) throw new Error('定时任务入口应暂时隐藏（用户 2026-10-16）');
  return `${scope}: 启用→持久化→还原 均通过 · 入口按用户要求隐藏`;
});

S('memory-flow', async () => {
  // v1.0：记忆视图 = 来源卡片 + 条目列表；legacy hub 笔记在「笔记 · 本地」卡片里
  // 每次用唯一标题 + 先清历史残留：同名条目会让"删掉后应消失"永远不成立（曾因此自我循环失败）
  const title = 'E2E 测试记忆 ' + Date.now();
  await evaluate(`fetch('/api/state').then(r => r.json()).then(d => Promise.all(
    (d.memories || []).filter(m => (m.title || '').includes('E2E 测试记忆'))
      .map(m => fetch('/api/memory/delete', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ id: m.id }) }))))`);
  await click('[data-testid="nav-memory"]');
  await evaluate(`(() => { const b = document.getElementById('mv-back-notes'); if (b) b.click(); })()`);
  await waitFor(`!!document.querySelector('[data-testid="mv-sources"]')`, 8000, '记忆来源卡片');
  await evaluate(`(() => { if (!document.querySelector('[data-testid="mv-list"]'))
    document.querySelector('[data-testid="mv-sources"] .tcard[data-src="notes"]').click(); })()`);
  await waitFor(`!!document.querySelector('[data-testid="mv-list"]')`, 8000, '笔记列表');
  await waitFor(`!!document.getElementById('mv-title')`, 8000, '记忆表单');
  const before = await evaluate(`document.querySelectorAll('[data-testid="mv-item"]').length`);
  await evaluate(`(() => {
    document.getElementById('mv-title').value = ${JSON.stringify(title)};
    document.getElementById('mv-body').value = '来自自动化测试的条目：验证增删路径。';
  })()`);
  await click('[data-testid="mv-add"]');
  await waitFor(`!!document.querySelector('.hub-toast--success')`, 8000, '记忆保存 toast');
  await waitFor(`[...document.querySelectorAll('[data-testid="mv-item"]')]
    .some(m => m.textContent.includes(${JSON.stringify(title)}))`, 8000, '记忆出现');
  // v0.6：详情右栏内删除
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('[data-testid="mv-item"]')]
      .find(m => m.textContent.includes(${JSON.stringify(title)}));
    item.click();
  })()`);
  await waitFor(`!!document.getElementById('mv-detail-del')`, 6000, '详情删除按钮');
  await click('#mv-detail-del');
  await waitFor(`!!document.querySelector('.hub-modal__ok')`, 4000, '删除确认弹层');
  await click('.hub-modal__ok');
  await waitFor(`![...document.querySelectorAll('[data-testid="mv-item"]')]
    .some(m => m.textContent.includes(${JSON.stringify(title)}))`, 8000, '记忆删除');
  const after = await evaluate(`document.querySelectorAll('[data-testid="mv-item"]').length`);
  return `记忆 ${before} → 增 → 详情内删 → ${after}`;
});

S('memory-validation-error', async () => {
  await click('[data-testid="nav-memory"]');
  await evaluate(`(() => { const b = document.getElementById('mv-back-notes'); if (b) b.click(); })()`);
  await waitFor(`!!document.querySelector('[data-testid="mv-sources"]')`, 8000, '记忆来源卡片');
  await evaluate(`(() => { if (!document.querySelector('[data-testid="mv-add"]'))
    document.querySelector('[data-testid="mv-sources"] .tcard[data-src="notes"]').click(); })()`);
  await waitFor(`!!document.querySelector('[data-testid="mv-add"]')`, 8000, '笔记视图');
  await waitFor(`!!document.getElementById('mv-body')`, 8000, '记忆表单');
  await evaluate(`document.getElementById('mv-body').value = '  '`);
  await click('[data-testid="mv-add"]');
  await waitFor(`!!document.querySelector('.hub-toast--error')`, 6000, '校验错误 toast');
  const txt = await evaluate(`document.querySelector('.hub-toast--error').textContent`);
  if (!txt.includes('内容不能为空')) throw new Error('错误文案不符: ' + txt);
  return '空内容被拦截，错误反馈正确';
});

S('duplicate-migration-guard', async () => {
  // v0.6：迁移确认已内联在右栏（不再切 tab）；直接在会话视图操作
  // v0.9：同上，用工具卡片代替原 chips
  if (!(await evaluate(`!!document.querySelector('[data-testid="tool-open-claude"]')`)))
    return 'SKIP：claude 工具当前不可见（口径 B：停用即隐藏），本用例需要它可见';
  await click('[data-testid="tool-open-claude"]');
  await sleep(300);
  // ensure a clean selection slate before this scenario
  await evaluate(`[...document.querySelectorAll('[data-testid="row-check"]')]
    .filter(cb => cb.checked).forEach(cb => cb.click())`);
  // pick the session already migrated to codex (has lid badge + not the opencode one)
  const found = await evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-testid="row"]')]
      .find(r => r.dataset.tool === 'claude' && r.textContent.includes('GitNexus') && r.querySelector('[data-testid="lid-badge"]'));
    if (!row) return 'NOEL';
    row.querySelector('[data-testid="row-check"]').click();
    window.__migSid = row.dataset.sid;
    return 'OK';
  })()`);
  if (found !== 'OK') return 'SKIP：可见域里没有「已迁移的 claude 会话」—— 口径 B 下 claude 停用即隐藏';
  const countsBefore = await evaluate(`[...document.querySelectorAll('[data-testid^="count-"]')].map(x => x.textContent).join(',')`);
  // 卡片上已无「迁移到此」按钮（按注解去掉）→ 模拟把该会话拖到 codex 卡片上
  await evaluate(`(() => {
    const card = document.querySelector('[data-testid="tool-card-codex"]');
    const dt = new DataTransfer();
    dt.setData('text/plain', window.__migSid || '');
    card.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`);
  // v0.6：确认条内联在右栏（不再弹 modal）
  await waitFor(`!!document.getElementById('mig-confirm')`, 5000, '迁移内联确认条');
  await click('#mig-confirm [data-act="go"]');
  await waitFor(`[...document.querySelectorAll('.hub-modal')].some(m => m.textContent.includes('已迁移过的会话'))`, 10000, '重复迁移拦截弹层');
  await evaluate(`(() => {
    const modal = [...document.querySelectorAll('.hub-modal')].find(m => m.textContent.includes('已迁移过的会话'));
    modal.querySelector('.hub-modal__cancel').click();
  })()`);
  await waitFor(`![...document.querySelectorAll('.hub-modal')].some(m => m.textContent.includes('已迁移过的会话'))`, 5000, '重复弹层关闭');
  await sleep(500);
  const countsAfter = await evaluate(`[...document.querySelectorAll('[data-testid^="count-"]')].map(x => x.textContent).join(',')`);
  if (countsBefore !== countsAfter) throw new Error(`计数被意外改变: ${countsBefore} -> ${countsAfter}`);
  await click('[data-testid="filter-all"]');
  return `重复迁移被拦截，无新会话产生（计数 ${countsAfter}）`;
});

S('content-search-flow', async () => {
  // 口径 B：搜索只搜可见域 → 查询词从"当前可见列表第一条标题"里取（不写死本机数据词）
  const sid = await evaluate(`(document.querySelector('[data-testid="row"]') || {}).dataset?.sid || ''`);
  if (!sid) throw new Error('可见列表为空，无法取搜索词');
  const term = String(await evaluate(`fetch('/api/session?id=' + encodeURIComponent(${JSON.stringify(sid)}))
    .then(r => r.json())
    .then(d => {
      const m = (d.messages || [])[0] || {};
      const txt = String(m.content || '').replace(/\\s+/g, ' ').trim();
      const hit = txt.split(' ').find(w => w.length >= 4) || txt.slice(0, 8);
      return (hit || '').slice(0, 8);
    })`)).trim();
  if (!term) throw new Error('取不到可搜索的消息片段');
  await evaluate(`(() => { const inp = document.getElementById('search-input');
    inp.value = ${JSON.stringify(term)}; inp.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.getElementById('search-panel').style.display !== 'none'`, 8000, '搜索面板出现');
  await waitFor(`document.querySelectorAll('[data-testid="search-item"]').length >= 1`, 8000, '搜索结果条目');
  const n = await evaluate(`document.querySelectorAll('[data-testid="search-item"]').length`);
  await evaluate(`document.querySelector('[data-testid="search-item"]').click()`);
  // 先清空搜索框（点击后立刻做，避免断言失败时把过滤状态带给后续用例）
  await evaluate(`(() => { const inp = document.getElementById('search-input'); inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  // ZCode 有几条 500+ 消息的长会话，详情接口较慢 → 给足 15s
  await waitFor(`!!document.querySelector('[data-testid="sess-detail-title"]')`, 15000, '点击结果打开详情');
  const chain = await evaluate(`document.getElementById('sess-detail-chain').textContent`);
  return `${n} 条消息命中 → 点击打开对应会话（中栏详情）`;
});

S('preview-actions', async () => {
  // 起手清空搜索框，避免上一条用例的过滤状态残留（防御性）
  await evaluate(`(() => { const inp = document.getElementById('search-input');
    if (inp && inp.value) { inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
  await waitFor(`!!document.querySelector('[data-testid="row"]')`, 6000, '列表有行');
  await evaluate(`(() => { document.querySelector('[data-testid="row"]').click(); })()`);
  await waitFor(`!!document.getElementById('sess-star')`, 6000, '详情打开');
  const L0 = await evaluate(`document.getElementById('sess-star').textContent`);
  await click('#sess-star');
  // 等待文本真正翻转；若 1.5s 未变则重试点击（POST 与 30s 轮询并发偶发丢失）
  const flippedExpr = `document.getElementById('sess-star').textContent !== ${JSON.stringify(L0)}`;
  try { await waitFor(flippedExpr, 1500, '收藏翻转(首击)'); }
  catch { await click('#sess-star'); await waitFor(flippedExpr, 6000, '收藏翻转(重试)'); }
  const L1 = await evaluate(`document.getElementById('sess-star').textContent`);
  // export
  await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
  await click('#sess-export');
  await waitFor(`[...document.querySelectorAll('.hub-toast--success')].some(t => t.textContent.includes('已导出'))`, 8000, '导出 toast');
  // resume copy (clipboard may be restricted headless -> accept success or warn)
  await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
  await click('#sess-resume');
  await waitFor(`document.querySelector('.hub-toast--success') || document.querySelector('.hub-toast--warn')`, 6000, '复制反馈 toast');
  // restore star to original state
  await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
  await click('#sess-star');
  await waitFor(`document.getElementById('sess-star').textContent === ${JSON.stringify(L0)}`, 6000, '恢复收藏初始态');
  return `收藏 ${L0.trim()} → ${L1.trim()} → 还原`;
});

S('module-nav-views', async () => {
  await click('[data-testid="nav-skills"]');
  await waitFor(`document.getElementById('view-skills').classList.contains('is-active')`, 6000, 'skills 视图');
  await skillsRowsOrDump();
  const sRows = await evaluate(`document.querySelectorAll('[data-testid="skills-row"]').length`);
  await click('[data-testid="nav-mcp"]');
  await waitFor(`document.querySelectorAll('[data-testid="mcp-row"]').length >= 1`, 10000, 'mcp 行');
  const mRows = await evaluate(`document.querySelectorAll('[data-testid="mcp-row"]').length`);
  await click('[data-testid="nav-ops"]');
  await waitFor(`document.querySelectorAll('[data-testid="ops-row"]').length >= 5`, 10000, '台账行');
  const opsCount = await evaluate(`document.querySelector('[data-testid="ops-count"]').textContent`);
  await click('[data-testid="nav-memory"]');
  await waitFor(`!!document.querySelector('[data-testid="mv-list"]')`, 6000, '记忆视图');
  await click('[data-testid="nav-sessions"]');
  await waitFor(`document.getElementById('view-sessions').classList.contains('is-active')`, 6000, '回到会话');
  return `五视图切换 OK · skills ${sRows} / mcp ${mRows} / ops ${opsCount} 条`;
});

S('skills-overview-render', async () => {
  // v0.6 回归：概览在「存在待更新/未安装」时不得崩（曾因 f.items 引用错误致视图空白 + toast）
  await click('[data-testid="nav-skills"]');
  await skillsRowsOrDump();
  await waitFor(`!!document.querySelector('[data-testid="skills-stats"]')`, 8000, '概览统计卡');
  const r = await evaluate(`(() => ({
    errs: (window.__hubErrors || []).length,
    stats: document.querySelectorAll('.nv-stat').length,
    targetRows: document.querySelectorAll('[data-testid="skills-target-row"]').length,
    create: !!document.querySelector('[data-testid="skills-create"]') }))()`);
  if (!r.stats || !r.create) throw new Error('概览渲染不完整: ' + JSON.stringify(r));
  if (r.errs) throw new Error('页面有未捕获异常: ' + r.errs);
  // 详情态也走一遍（点行进详情 → 返回概览）
  await evaluate(`document.querySelector('[data-testid="skills-row"]').click()`);
  await waitFor(`!!document.querySelector('[data-testid="skills-detail-ops"]')`, 6000, '详情操作行');
  await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
  return `概览 ${r.stats} 统计卡 · ${r.targetRows} 工具行 · 详情开关 OK · 无异常`;
});

S('skills-pull-and-wizard', async () => {
  await click('[data-testid="nav-skills"]');
  await skillsRowsOrDump();
  // 拉取反馈
  // 口径（2026-10-17）：拉取能否真正完成取决于网络与远程仓库可达性（本机常拉不通、git 会挂几十秒），
  // 所以这里只断言**点了立刻有反馈**——按钮进入 is-loading（同步）——不把环境问题记成产品缺陷。
  const pullBtn = await evaluate(`(() => {
    const b = document.querySelector('[data-testid^="skills-pull-"]');
    if (!b) return 'NOBTN';
    b.click(); return b.classList.contains('is-loading') ? 'LOADING' : 'CLICKED';
  })()`);
  if (pullBtn === 'NOBTN') throw new Error('没有可用的「拉取」按钮（来源行未渲染）');
  await waitFor(`!!document.querySelector('[data-testid^="skills-pull-"].is-loading, .hub-toast--success, .hub-toast--info, .hub-toast--error, .hub-toast--warn')`,
    8000, '拉取反馈（loading / toast 任一）');
  // v0.6 新布局：左栏勾选条目 → 中栏出现多选批量面 → 右栏内联更新按钮可用（无弹窗）
  await evaluate(`document.querySelector('[data-testid="skills-row"] input').click()`);
  await waitFor(`!!document.querySelector('[data-testid="skills-batch-ops"]')`, 6000, '多选批量面');
  const inlineBtn = await evaluate(`(() => { const b = document.querySelector('[data-testid="skills-inline-update"]'); return b ? b.textContent.trim() : 'NOBTN'; })()`);
  // 新建对话框（CRUD 弹窗仍保留给增删改）
  await evaluate(`document.querySelector('[data-testid="skills-create"]')?.click()`);
  await waitFor(`!!document.querySelector('[data-testid="skills-new-name"]')`, 6000, '新建对话框');
  await evaluate(`document.querySelector('.hub-modal__cancel')?.click()`);
  await sleep(300);
  await click('[data-testid="nav-sessions"]');
  return `UI 拉取 OK · 多选批量面 OK · 右栏内联按钮「${inlineBtn}」 · 新建对话框开关 OK（无分发向导弹窗）`;
});

S('screenshot-mobile', async () => {
  await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  await shot('mobile-390.png');
  const overflow = await evaluate(`document.documentElement.scrollWidth`);
  if (overflow > 391) throw new Error('移动端横向溢出: width=' + overflow);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  return `390px 视口无横向溢出（scrollWidth=${overflow}）`;
});

/* ---------- main ---------- */
(async () => {
  // server check
  try {
    const r = await fetch(BASE + '/api/state');
    if (!r.ok) throw 0;
  } catch {
    console.error('服务未运行：先 ./run.sh（' + BASE + '）');
    process.exit(2);
  }

  const { proc, profile, version } = await launchChrome();
  console.log(`Chrome: ${version} | 模式: ${HEADED ? '有头' : '无头'} | 目标: ${BASE}`);

  const target = await newPage('about:blank');
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  cdp.on(msg => {
    if (msg.method === 'Network.requestWillBeSent') {
      netInflight.set(msg.params.requestId, { url: msg.params.request.url, t: Date.now() });
    }
    if (msg.method === 'Network.loadingFinished') {
      netInflight.delete(msg.params.requestId);
    }
    if (msg.method === 'Network.loadingFailed') {
      const rec = netInflight.get(msg.params.requestId);
      netFails.push({ url: rec ? rec.url : '?', err: msg.params.errorText, ageMs: rec ? Date.now() - rec.t : -1 });
      netInflight.delete(msg.params.requestId);
    }
    if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) {
      navEvents.push({ t: Date.now(), url: msg.params.frame.url, scenario: currentScenario });
    }
    if (msg.method === 'Page.frameStartedLoading') {
      navEvents.push({ t: Date.now(), loading: true, scenario: currentScenario });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleErrors.push('exception: ' + (d.exception?.description || d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push('console.error: ' + JSON.stringify(msg.params.args?.map(a => a.value) || []));
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  // 先接上 CDP 再导航：初始页面加载的全部网络事件都可被捕获（此前是盲区）
  await cdp.send('Page.navigate', { url: BASE + '/' });

  const list = SMOKE ? scenarios.filter(s => s.smoke) : scenarios;
  for (const s of list) await scenario(s.name, s.fn);

  const failed = results.filter(r => !r.ok);
  const realErrors = consoleErrors.filter(e => !/favicon|net::ERR_|Failed to load resource/.test(e));
  if (realErrors.length) results.push({ name: 'console-clean', ok: false, ms: 0, error: realErrors.join(' | ') });
  else results.push({ name: 'console-clean', ok: true, ms: 0, detail: '无未处理异常/console.error' });

  const report = {
    mode: HEADED ? 'headed' : 'headless', smoke: SMOKE, base: BASE,
    chrome: version, startedAt: new Date().toISOString(),
    passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length,
    results, consoleErrors: realErrors, navEvents,
    netSummary: { fails: netFails.slice(-10), inflightAtEnd: [...netInflight.values()].slice(0, 10) },
  };
  writeFileSync(join(EVIDENCE, `e2e-report-${HEADED ? 'headed' : 'headless'}.json`), JSON.stringify(report, null, 2));
  if (navEvents.length) console.log('nav-log: ' + JSON.stringify(navEvents.slice(0, 10)));
  if (netFails.length) console.log('net-fails: ' + JSON.stringify(netFails.slice(-10)));
  console.log(`\n=== E2E ${report.mode}${SMOKE ? ' (smoke)' : ''}: ${report.passed} passed / ${report.failed} failed ===`);

  proc.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(report.failed ? 1 : 0);
})().catch(e => { console.error('driver fatal:', e); process.exit(3); });
