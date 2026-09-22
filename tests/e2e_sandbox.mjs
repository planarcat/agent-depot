#!/usr/bin/env node
/* ====================================================================
   失败场景 / 边界 E2E —— 在沙箱服务器上运行，不触碰真实数据。
   覆盖：空态 · casr 缺失 · casr 报错 · 空内容校验 · 100 行渲染性能 · 长标题
        · 工具注册表（添加 / 校验 / 停用 / 删除 / 彻底删除 / 预设 / 目标同步）
   ==================================================================== */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(__dirname, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });
const PORT = 8400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* minimal CDP (same as e2e.mjs) */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) c.handlers.forEach(h => h(msg));
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); } }, 30000);
    });
  }
  on(fn) { this.handlers.push(fn); }
}
async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || expr));
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

const results = [];
const consoleErrors = [];
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

/* ---------- main ---------- */
let serverProc, cdp;
let sbxTmp = '';
const failures = () => results.filter(r => !r.ok);

(async () => {
  /* spawn sandbox server (no casr, 100 rows, no real data) */
  serverProc = spawn('python3', [join(__dirname, 'sandbox_server.py'), '--port', String(PORT), '--strip-casr', '--rows', '100'],
                     { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  serverProc.stdout.on('data', d => {
    const m = String(d).match(/READY port=\d+ tmp=(.+)/);
    if (m) { sbxTmp = m[1].trim(); ready = true; }
  });
  for (let i = 0; i < 50 && !ready; i++) await sleep(200);
  if (!ready) { console.error('sandbox server 未就绪'); process.exit(2); }

  /* 工具注册表夹具：pi-agent JSONL（写入沙箱临时目录，不触碰真实数据） */
  const piFixtureDir = join(sbxTmp, 'pi-fixture');
  mkdirSync(piFixtureDir, { recursive: true });
  const piLines = [
    { type: 'session', id: '019f0000-1111-7222-8333-444455556666',
      timestamp: '2026-09-21T10:00:00.000Z', cwd: '/tmp/sbx-pi' },
    { type: 'message', timestamp: '2026-09-21T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '沙箱 Pi 会话' }] } },
    { type: 'message', timestamp: '2026-09-21T10:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] } },
    { type: 'message', timestamp: '2026-09-21T10:00:03.000Z',
      message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] } },
  ];
  writeFileSync(join(piFixtureDir, '2026-09-21T10-00-00-000Z_019f0000-1111-7222-8333-444455556666.jsonl'),
    piLines.map(o => JSON.stringify(o)).join('\n') + '\n');
  const piFixture2Dir = join(sbxTmp, 'pi-fixture2');
  mkdirSync(piFixture2Dir, { recursive: true });
  const piLines2 = [
    { type: 'session', id: '019f0000-2222-7333-8444-555566667777',
      timestamp: '2026-09-21T11:00:00.000Z', cwd: '/tmp/sbx-pi2' },
    { type: 'message', timestamp: '2026-09-21T11:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Purge 夹具会话' }] } },
    { type: 'message', timestamp: '2026-09-21T11:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  ];
  writeFileSync(join(piFixture2Dir, '2026-09-21T11-00-00-000Z_019f0000-2222-7333-8444-555566667777.jsonl'),
    piLines2.map(o => JSON.stringify(o)).join('\n') + '\n');
  mkdirSync(join(sbxTmp, 'st-skills'), { recursive: true });
  writeFileSync(join(sbxTmp, 'st-mcp.json'), '{}');

  /* launch chrome headless */
  const profile = join(tmpdirOverride(), 'hub-sbx-profile');
  const proc = spawn(CHROME, [
    '--remote-debugging-port=9335', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new', '--disable-gpu',
    '--window-size=1480,960', 'about:blank'], { stdio: 'ignore' });
  let version = '';
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:9335/json/version`); if (r.ok) { version = (await r.json())['Browser']; break; } } catch {}
    await sleep(250);
  }
  const r2 = await fetch(`http://127.0.0.1:9335/json/new?${encodeURIComponent(BASE + '/')}`, { method: 'PUT' });
  const target = await r2.json();
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  cdp.on(msg => {
    if (msg.method === 'Runtime.exceptionThrown')
      consoleErrors.push('exception: ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text));
  });
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');

  const S = (name, fn) => scenarios.push({ name, fn });
  const scenarios = [];

  S('empty-then-refresh', async () => {
    await waitFor(`document.readyState === 'complete'`, 10000, 'ready');
    // 100 rows were pre-seeded in db -> rows should render WITHOUT any refresh
    const n = await evaluate(`document.querySelectorAll('[data-testid="row"]').length`);
    if (n < 100) throw new Error('预置 100 行应直接渲染，实际 ' + n);
    return `${n} 行直接渲染（db 预置）`;
  });

  S('render-performance-100-rows', async () => {
    const t0 = Date.now();
    await evaluate(`window.hubApp.loadState()`);
    await waitFor(`document.querySelectorAll('[data-testid="row"]').length >= 100`, 5000, '重渲染');
    const ms = Date.now() - t0;
    if (ms > 3000) throw new Error('渲染过慢: ' + ms + 'ms');
    return `100 行 loadState+渲染 ${ms}ms`;
  });

  S('casr-missing-error-feedback', async () => {
    // sandbox PATH has no casr -> migrate must produce a clean error toast
    await evaluate(`(() => {
      const cb = document.querySelector('[data-testid="row-check"]');
      cb.click();
    })()`);
    await waitFor(`document.querySelector('[data-testid="sel-count"]').textContent === '1'`, 4000, '选中');
    await click('[data-testid="drop-codex"]');
    await waitFor(`document.body.textContent.includes('迁移确认')`, 4000, '确认弹层');
    await click('.hub-modal__ok');
    await waitFor(`!!document.querySelector('.hub-toast--error')`, 8000, '错误 toast');
    const txt = await evaluate(`document.querySelector('.hub-toast--error').textContent`);
    if (!txt.includes('casr')) throw new Error('错误信息未提及 casr: ' + txt);
    await shot('sandbox-casr-missing.png');
    return '引擎缺失 → 明确错误 toast: ' + txt.slice(0, 40);
  });

  S('validation-empty-memory', async () => {
    await click('[data-testid="tab-memory"]');
    await evaluate(`document.getElementById('memory-body').value = ''`);
    await click('[data-testid="memory-add"]');
    await waitFor(`!!document.querySelector('.hub-toast--error')`, 6000, '校验错误');
    return '空记忆内容被拦截';
  });

  S('long-title-no-overflow', async () => {
    await evaluate(`(() => {
      const t = document.querySelector('.row__title');
      t.textContent = '这是一个非常非常非常长的会话标题用来测试省略号与不换行约束在窄屏下的表现'.repeat(3);
    })()`);
    const overflow = await evaluate(`document.documentElement.scrollWidth`);
    if (overflow > 1481) throw new Error('横向溢出: ' + overflow);
    await shot('sandbox-long-title.png');
    return '长标题省略正常，无溢出';
  });

  S('screenshot-mobile-sandbox', async () => {
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    await shot('sandbox-mobile.png');
    const overflow = await evaluate(`document.documentElement.scrollWidth`);
    if (overflow > 391) throw new Error('移动端溢出: ' + overflow);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    return '沙箱移动端 390px 无溢出';
  });

  S('tools-add-validation', async () => {
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await click('[data-testid="tool-add"]');
    await waitFor(`document.getElementById('tool-overlay').classList.contains('is-open')`, 4000, '工具弹窗');
    await click('[data-testid="tool-save"]');
    await waitFor(`!!document.querySelector('.hub-toast--error')`, 6000, '校验错误 toast');
    const txt = await evaluate(`document.querySelector('.hub-toast--error').textContent`);
    if (!txt.includes('名称不能为空')) throw new Error('错误文案不符: ' + txt);
    await click('[data-testid="tool-close"]');
    return '空表单被拦截：' + txt.slice(0, 24);
  });

  S('tools-add-and-refresh', async () => {
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await click('[data-testid="tool-add"]');
    await waitFor(`document.getElementById('tool-overlay').classList.contains('is-open')`, 4000, '工具弹窗');
    await evaluate(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v;
        el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
      set('tool-name', 'Pi Sandbox');
      set('tool-adapter', 'pi');
      set('tool-root', ${JSON.stringify(join(sbxTmp, 'pi-fixture'))});
    })()`);
    await click('[data-testid="tool-save"]');
    await waitFor(`!!document.querySelector('.hub-toast--success')`, 8000, '添加成功 toast');
    await waitFor(`!!document.querySelector('[data-testid="tool-card-pi-sandbox"]')`, 6000, '新卡片出现');
    await click('[data-testid="refresh-pi-sandbox"]');
    await waitFor(`document.querySelector('[data-testid="count-pi-sandbox"]') && document.querySelector('[data-testid="count-pi-sandbox"]').textContent === '1'`, 10000, '会话计数=1');
    const mc = await evaluate(`(window.hubApp.state.sessions.find(s => s.tool === 'pi-sandbox') || {}).msg_count`);
    if (mc !== 3) throw new Error('消息数应为 3，实际 ' + mc);
    const feed = await evaluate(`!!document.querySelector('[data-testid="filter-pi-sandbox"]')`);
    if (!feed) throw new Error('动态筛选按钮缺失');
    await shot('sandbox-tool-added.png');
    return '添加 → 采集 1 会话 / 3 消息 → 动态筛选出现';
  });

  S('tools-disable-and-remove', async () => {
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await click('[data-testid="manage-pi-sandbox"]');
    await waitFor(`document.getElementById('tool-overlay').classList.contains('is-open')`, 4000, '设置弹窗');
    await click('[data-testid="tool-enabled"]');
    await click('[data-testid="tool-save"]');
    await waitFor(`!!document.querySelector('.hub-toast--success')`, 8000, '停用保存 toast');
    await waitFor(`document.querySelector('[data-testid="tool-card-pi-sandbox"]').classList.contains('is-off')`, 6000, '卡片停用态');
    const kept = await evaluate(`window.hubApp.state.sessions.some(s => s.tool === 'pi-sandbox')`);
    if (!kept) throw new Error('停用后会话不应消失');
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await click('[data-testid="manage-pi-sandbox"]');
    await waitFor(`document.getElementById('tool-overlay').classList.contains('is-open')`, 4000, '设置弹窗');
    await click('[data-testid="tool-delete"]');
    await waitFor(`!!document.querySelector('.hub-modal__ok')`, 4000, '移除确认弹层');
    await click('.hub-modal__ok');
    await waitFor(`!!document.querySelector('.hub-toast--success')`, 8000, '移除 toast');
    await waitFor(`!document.querySelector('[data-testid="tool-card-pi-sandbox"]')`, 6000, '卡片消失');
    const still = await evaluate(`window.hubApp.state.sessions.some(s => s.tool === 'pi-sandbox')`);
    if (!still) throw new Error('移除后会话数据应保留');
    return '停用→数据保留→移除→卡片消失、数据仍保留';
  });

  S('tools-purge-delete', async () => {
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await click('[data-testid="tool-add"]');
    await waitFor(`document.getElementById('tool-overlay').classList.contains('is-open')`, 4000, '工具弹窗');
    await evaluate(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v;
        el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
      set('tool-name', 'Purge Me');
      set('tool-adapter', 'pi');
      set('tool-root', ${JSON.stringify(join(sbxTmp, 'pi-fixture2'))});
    })()`);
    await click('[data-testid="tool-save"]');
    await waitFor(`!!document.querySelector('[data-testid="tool-card-purge-me"]')`, 8000, '卡片出现');
    await click('[data-testid="refresh-purge-me"]');
    await waitFor(`document.querySelector('[data-testid="count-purge-me"]') && document.querySelector('[data-testid="count-purge-me"]').textContent === '1'`, 10000, '采集完成');
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await click('[data-testid="manage-purge-me"]');
    await waitFor(`document.getElementById('tool-overlay').classList.contains('is-open')`, 4000, '设置弹窗');
    await click('[data-testid="tool-delete"]');
    await waitFor(`!!document.querySelector('[data-testid="tool-purge-opt"]')`, 4000, '删除确认弹层');
    await evaluate(`document.querySelector('[data-testid="tool-purge-opt"]').click()`);
    await click('.hub-modal__ok');
    await waitFor(`[...document.querySelectorAll('.hub-toast--success')].some(t => t.textContent.includes('彻底删除'))`, 10000, '彻底删除 toast');
    await waitFor(`!document.querySelector('[data-testid="tool-card-purge-me"]')`, 6000, '卡片消失');
    const gone = await evaluate(`!window.hubApp.state.sessions.some(s => s.tool === 'purge-me')`);
    if (!gone) throw new Error('彻底删除后数据应清除');
    return '勾选彻底清除 → 数据清除 → 卡片消失';
  });

  S('tools-preset-fill', async () => {
    await click('[data-testid="tool-add"]');
    await waitFor(`document.getElementById('tool-overlay').classList.contains('is-open')`, 4000, '工具弹窗');
    const nOpt = await evaluate(`document.querySelectorAll('#tool-preset option').length`);
    if (nOpt < 6) throw new Error('预设选项应 ≥6，实际 ' + nOpt);
    await evaluate(`(() => { const s = document.getElementById('tool-preset'); s.value = 'cursor'; s.dispatchEvent(new Event('change')); })()`);
    const f = await evaluate(`(() => ({
      name: document.getElementById('tool-name').value,
      root: document.getElementById('tool-root').value,
      skills: document.getElementById('tool-skills').value,
      mcp: document.getElementById('tool-mcp').value }))()`);
    if (f.name !== 'Cursor') throw new Error('预设未填名称: ' + JSON.stringify(f));
    if (!f.root.includes('state.vscdb') || !f.skills.includes('.cursor/skills') || !f.mcp.includes('mcp.json'))
      throw new Error('预设未填路径: ' + JSON.stringify(f));
    await click('[data-testid="tool-close"]');
    return `预设快填 OK（Cursor → ${f.skills}）`;
  });

  S('tools-sync-targets', async () => {
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await click('[data-testid="tool-add"]');
    await waitFor(`document.getElementById('tool-overlay').classList.contains('is-open')`, 4000, '工具弹窗');
    await evaluate(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v;
        el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); };
      set('tool-name', 'Sync Test');
      set('tool-adapter', 'pi');
      set('tool-root', ${JSON.stringify(join(sbxTmp, 'pi-fixture'))});
      set('tool-skills', ${JSON.stringify(join(sbxTmp, 'st-skills'))});
      set('tool-mcp', ${JSON.stringify(join(sbxTmp, 'st-mcp.json'))});
    })()`);
    await click('[data-testid="tool-save"]');
    await waitFor(`[...document.querySelectorAll('.hub-toast--success')].some(t => t.textContent.includes('已同步'))`, 8000, '目标同步 toast');
    const okSkills = await evaluate(`fetch('/api/skills/targets').then(r=>r.json()).then(d=>d.targets.some(t=>t.path.includes('st-skills')))`);
    const okMcp = await evaluate(`fetch('/api/mcp/targets').then(r=>r.json()).then(d=>d.targets.some(t=>t.path.includes('st-mcp')))`);
    if (!okSkills || !okMcp) throw new Error(`目标未同步: skills=${okSkills} mcp=${okMcp}`);
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await click('[data-testid="manage-sync-test"]');
    await waitFor(`document.getElementById('tool-overlay').classList.contains('is-open')`, 4000, '设置弹窗');
    await click('[data-testid="tool-delete"]');
    await waitFor(`!!document.querySelector('.hub-modal__ok')`, 4000, '删除确认');
    await click('.hub-modal__ok');
    await waitFor(`!!document.querySelector('.hub-toast--success')`, 8000, '删除 toast');
    const gone = await evaluate(`fetch('/api/skills/targets').then(r=>r.json()).then(d=>!d.targets.some(t=>t.path.includes('st-skills')))`);
    if (!gone) throw new Error('删除后目标未清理');
    return '添加同步（Skills+MCP）→ 删除自动清理';
  });

  for (const s of scenarios) await scenario(s.name, s.fn);

  const realErrors = consoleErrors.filter(e => !/favicon|net::ERR_|Failed to load resource/.test(e));
  if (realErrors.length) results.push({ name: 'console-clean', ok: false, error: realErrors.join('|') });
  else results.push({ name: 'console-clean', ok: true, detail: 'clean' });

  const report = { mode: 'sandbox', chrome: version, base: BASE,
    passed: results.filter(r => r.ok).length, failed: failures().length,
    results, consoleErrors: realErrors, at: new Date().toISOString() };
  writeFileSync(join(EVIDENCE, 'e2e-report-sandbox.json'), JSON.stringify(report, null, 2));
  console.log(`\n=== E2E sandbox: ${report.passed} passed / ${report.failed} failed ===`);

  proc.kill(); serverProc.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(report.failed ? 1 : 0);
})().catch(e => { console.error('driver fatal:', e); try { serverProc.kill(); } catch {} process.exit(3); });

function tmpdirOverride() { return join(tmpdir(), 'hub-e2e-sbx-' + process.pid); }
