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
import { tmpdir } from 'node:os';
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

async function skillsRowsOrDump() {
  try {
    await waitFor(`document.querySelectorAll('[data-testid="skills-row"]').length >= 2`, 10000, 'skills 目录行');
  } catch (e) {
    const dump = await evaluate(`JSON.stringify({
      center: ((document.querySelector('.sb-center') || {}).innerHTML || 'NO CENTER').replace(/\s+/g, ' ').slice(0, 220),
      toasts: [...document.querySelectorAll('.hub-toast')].map(t => t.textContent.trim()).slice(0, 3),
      skillsView: typeof window.SkillsView,
      active: document.getElementById('view-skills').classList.contains('is-active') })`);
    throw new Error(e.message + ' | dump=' + dump);
  }
}

S('page-load', async () => {
  await waitFor(`document.readyState === 'complete'`, 10000, 'readyState');
  await waitFor(`document.querySelectorAll('[data-testid="row"]').length >= 5`, 10000, '会话行渲染');
  const badge = await evaluate(`document.querySelector('[data-testid="engine-badge"]').textContent`);
  if (!badge.includes('已连接')) throw new Error('引擎徽章异常: ' + badge);
  const n = await evaluate(`document.querySelectorAll('[data-testid="row"]').length`);
  return `${n} 行会话 · ${badge}`;
}, true);

S('screenshot-desktop', async () => {
  await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
  await shot('desktop-main.png'); return 'desktop-main.png';
}, true);

S('filter-codex', async () => {
  await click('[data-testid="filter-codex"]');
  await sleep(300);
  const r = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="row"]')];
    return { total: rows.length, bad: rows.filter(x => x.dataset.tool !== 'codex').length };
  })()`);
  if (r.bad > 0) throw new Error(`过滤器泄漏：${r.bad} 行不是 codex`);
  await click('[data-testid="filter-all"]');
  await sleep(200);
  const back = await evaluate(`document.querySelectorAll('[data-testid="row"]').length`);
  return `codex ${r.total} 行 · 恢复全部 ${back} 行`;
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
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-testid="row"]')]
      .find(r => r.querySelector('[data-testid="lid-badge"]'));
    if (!row) throw new Error('no row with lid badge');
    row.click();
  })()`);
  await waitFor(`document.getElementById('preview-overlay').classList.contains('is-open')`, 8000, '预览打开');
  const chain = await evaluate(`document.getElementById('preview-chain').textContent`);
  const msgs = await evaluate(`document.querySelectorAll('#preview-body .msg').length`);
  if (!chain.includes('hub:lx-')) throw new Error('预览未显示 lineage 链: ' + chain);
  if (msgs === 0) throw new Error('预览无消息');
  await shot('preview-open.png');
  await click('[data-testid="preview-close"]');
  await waitFor(`!document.getElementById('preview-overlay').classList.contains('is-open')`, 4000, '预览关闭');
  return `链=${chain.slice(0, 60)} · ${msgs} 条消息`;
});

S('refresh-one', async () => {
  await click('[data-testid="refresh-claude"]');
  await waitFor(`!!document.querySelector('.hub-toast--success')`, 10000, '刷新成功 toast');
  return '刷新成功 toast 出现';
});

S('schedule-flow', async () => {
  await click('[data-testid="schedule-open"]');
  await waitFor(`document.getElementById('sched-overlay').classList.contains('is-open')`, 4000, '调度面板');
  const rowN = await evaluate(`document.querySelectorAll('[data-testid^="sched-row-"]').length`);
  if (rowN < 4) throw new Error('调度范围应 ≥ 4，实际 ' + rowN);
  await click('[data-testid="sched-toggle-claude"]');
  await evaluate(`(() => { const s = document.querySelector('[data-testid="sched-interval-claude"]'); s.value = '15'; return true; })()`);
  await click('[data-testid="sched-save"]');
  await waitFor(`!!document.querySelector('.hub-toast--success')`, 8000, '保存成功 toast');
  await sleep(400);
  await click('[data-testid="schedule-open"]');
  await waitFor(`document.getElementById('sched-overlay').classList.contains('is-open')`, 4000, '重开调度面板');
  const state = await evaluate(`(() => ({
    on: document.querySelector('[data-testid="sched-toggle-claude"]').classList.contains('is-on'),
    iv: document.querySelector('[data-testid="sched-interval-claude"]').value }))()`);
  if (!state.on || state.iv !== '15') throw new Error('调度未持久化: ' + JSON.stringify(state));
  // restore
  await click('[data-testid="sched-toggle-claude"]');
  await evaluate(`(() => { const s = document.querySelector('[data-testid="sched-interval-claude"]'); s.value = '30'; return true; })()`);
  await click('[data-testid="sched-save"]');
  await waitFor(`!!document.querySelector('.hub-toast--success')`, 8000, '恢复保存 toast');
  return '启用→保存→重开校验→恢复，均通过';
});

S('memory-flow', async () => {
  await click('[data-testid="tab-memory"]');
  await sleep(200);
  const before = await evaluate(`document.querySelectorAll('[data-testid="memory-item"]').length`);
  await evaluate(`(() => {
    document.getElementById('memory-title').value = 'E2E 测试记忆';
    document.getElementById('memory-body').value = '来自自动化测试的条目：验证增删路径。';
  })()`);
  await click('[data-testid="memory-add"]');
  await waitFor(`!!document.querySelector('.hub-toast--success')`, 8000, '记忆保存 toast');
  await waitFor(`[...document.querySelectorAll('[data-testid="memory-item"]')]
    .some(m => m.textContent.includes('E2E 测试记忆'))`, 8000, '记忆出现');
  // delete it
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('[data-testid="memory-item"]')]
      .find(m => m.textContent.includes('E2E 测试记忆'));
    item.querySelector('[data-testid="memory-delete"]').click();
  })()`);
  await waitFor(`!!document.querySelector('.hub-modal__ok')`, 4000, '删除确认弹层');
  await click('.hub-modal__ok');
  await waitFor(`![...document.querySelectorAll('[data-testid="memory-item"]')]
    .some(m => m.textContent.includes('E2E 测试记忆'))`, 8000, '记忆删除');
  const after = await evaluate(`document.querySelectorAll('[data-testid="memory-item"]').length`);
  return `记忆 ${before} → 增 → 删 → ${after}`;
});

S('memory-validation-error', async () => {
  await evaluate(`document.getElementById('memory-body').value = '  '`);
  await click('[data-testid="memory-add"]');
  await waitFor(`!!document.querySelector('.hub-toast--error')`, 6000, '校验错误 toast');
  const txt = await evaluate(`document.querySelector('.hub-toast--error').textContent`);
  if (!txt.includes('内容不能为空')) throw new Error('错误文案不符: ' + txt);
  return '空内容被拦截，错误反馈正确';
});

S('duplicate-migration-guard', async () => {
  await click('[data-testid="tab-migrate"]');
  await click('[data-testid="filter-claude"]');
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
    return 'OK';
  })()`);
  if (found !== 'OK') throw new Error('未找到已迁移的 claude 会话行');
  const countsBefore = await evaluate(`[...document.querySelectorAll('[data-testid^="count-"]')].map(x => x.textContent).join(',')`);
  await click('[data-testid="drop-codex"]');
  await waitFor(`document.body.textContent.includes('迁移确认')`, 5000, '迁移确认弹层');
  await click('.hub-modal__ok');   // 开始迁移
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
  await evaluate(`(() => {
    const inp = document.getElementById('search-input');
    inp.value = 'GitNexus';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(`document.getElementById('search-panel').style.display !== 'none'`, 8000, '搜索面板出现');
  await waitFor(`document.querySelectorAll('[data-testid="search-item"]').length >= 1`, 8000, '搜索结果条目');
  const n = await evaluate(`document.querySelectorAll('[data-testid="search-item"]').length`);
  await evaluate(`document.querySelector('[data-testid="search-item"]').click()`);
  await waitFor(`document.getElementById('preview-overlay').classList.contains('is-open')`, 6000, '点击结果打开预览');
  const chain = await evaluate(`document.getElementById('preview-chain').textContent`);
  await click('[data-testid="preview-close"]');
  await evaluate(`(() => { const inp = document.getElementById('search-input'); inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  return `${n} 条消息命中 → 点击打开对应会话`;
});

S('preview-actions', async () => {
  await evaluate(`(() => { document.querySelector('[data-testid="row"]').click(); })()`);
  await waitFor(`document.getElementById('preview-overlay').classList.contains('is-open')`, 6000, '预览打开');
  // star: state-agnostic flip check (initial state may vary between runs)
  const L0 = await evaluate(`document.getElementById('preview-star').textContent`);
  await click('[data-testid="preview-star"]');
  await waitFor(`!!document.querySelector('.hub-toast--success')`, 6000, '收藏 toast');
  await sleep(300);
  const L1 = await evaluate(`document.getElementById('preview-star').textContent`);
  if (L1 === L0) throw new Error('收藏态未翻转: ' + L1);
  // export
  await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
  await click('[data-testid="preview-export"]');
  await waitFor(`[...document.querySelectorAll('.hub-toast--success')].some(t => t.textContent.includes('已导出'))`, 8000, '导出 toast');
  // resume copy (clipboard may be restricted headless -> accept success or warn)
  await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
  await click('[data-testid="preview-resume"]');
  await waitFor(`document.querySelector('.hub-toast--success') || document.querySelector('.hub-toast--warn')`, 6000, '复制反馈 toast');
  // restore star to original state
  await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
  await click('[data-testid="preview-star"]');
  await waitFor(`document.getElementById('preview-star').textContent === ${JSON.stringify(L0)}`, 6000, '恢复收藏初始态');
  await click('[data-testid="preview-close"]');
  return `收藏 ${L0.trim()} → ${L1.trim()} → 还原`;
});

S('module-nav-views', async () => {
  await click('[data-testid="nav-skills"]');
  await waitFor(`document.getElementById('view-skills').classList.contains('is-active')`, 6000, 'skills 视图');
  await skillsRowsOrDump();
  const sRows = await evaluate(`document.querySelectorAll('[data-testid="skills-row"]').length`);
  await click('[data-testid="nav-mcp"]');
  await waitFor(`document.querySelectorAll('[data-testid="mcp-row"]').length >= 2`, 10000, 'mcp 行');
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

S('skills-pull-and-wizard', async () => {
  await click('[data-testid="nav-skills"]');
  await skillsRowsOrDump();
  // pull from first source via UI
  await evaluate(`document.querySelector('[data-testid^="skills-pull-"]').click()`);
  await waitFor(`!!document.querySelector('.hub-toast--success, .hub-toast--info')`, 12000, '拉取反馈');
  // select first row -> open distribute wizard -> cancel (no write)
  await evaluate(`document.querySelector('[data-testid="skills-row"] input').click()`);
  await click('[data-testid="skills-distribute"]');
  await waitFor(`document.querySelectorAll('.wiz-targets input').length >= 1`, 6000, '分发向导目标列表');
  const targets = await evaluate(`document.querySelectorAll('.wiz-targets input').length`);
  await evaluate(`document.querySelector('.hub-modal__cancel').click()`);
  await sleep(300);
  await click('[data-testid="nav-sessions"]');
  return `UI 拉取 OK · 分发向导展示 ${targets} 个目标（未执行写入）`;
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

  const target = await newPage(BASE + '/');
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  cdp.on(msg => {
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
    results, consoleErrors: realErrors,
  };
  writeFileSync(join(EVIDENCE, `e2e-report-${HEADED ? 'headed' : 'headless'}.json`), JSON.stringify(report, null, 2));
  console.log(`\n=== E2E ${report.mode}${SMOKE ? ' (smoke)' : ''}: ${report.passed} passed / ${report.failed} failed ===`);

  proc.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(report.failed ? 1 : 0);
})().catch(e => { console.error('driver fatal:', e); process.exit(3); });
