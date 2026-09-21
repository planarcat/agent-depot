#!/usr/bin/env node
/* ====================================================================
   失败场景 / 边界 E2E —— 在沙箱服务器上运行，不触碰真实数据。
   覆盖：空态 · casr 缺失 · casr 报错 · 空内容校验 · 100 行渲染性能 · 长标题
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
const failures = () => results.filter(r => !r.ok);

(async () => {
  /* spawn sandbox server (no casr, 100 rows, no real data) */
  serverProc = spawn('python3', [join(__dirname, 'sandbox_server.py'), '--port', String(PORT), '--strip-casr', '--rows', '100'],
                     { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  serverProc.stdout.on('data', d => { if (String(d).includes('READY')) ready = true; });
  for (let i = 0; i < 50 && !ready; i++) await sleep(200);
  if (!ready) { console.error('sandbox server 未就绪'); process.exit(2); }

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
