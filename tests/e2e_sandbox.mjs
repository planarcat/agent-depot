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
  // v0.8 口径：工具是实体的唯一编辑处在「设置 → 工具」（会话页不再有编辑/新增入口）。
  // 下面的工具类用例先打开设置窗并切到「工具」面板，再用 manage-* / 程序化登记弹窗。
  // 注：2026-10-16 起前端**没有**添加工具的能力（用户指令「去掉添加工具的能力」，工具弹窗已删）。
  //     用例需要的自定义工具一律走后端 POST /api/tools 当夹具造出来，再验证设置页的编辑/启停/删除。
  const openToolPane = async () => {
    if (!(await evaluate(`document.getElementById('settings-overlay').classList.contains('is-open')`))) {
      await click('[data-testid="settings-open"]');
      await waitFor(`document.getElementById('settings-overlay').classList.contains('is-open')`, 4000, '设置中心');
    }
    await click('[data-testid="settings-nav-tools"]');
    // 设置面板内容是异步渲染的，等真正的按钮/行出现（容器 [settings-tools] 一直在 DOM 里）
    await waitFor(`!!document.querySelector('[data-testid^="settings-tool-"]')`, 6000, '设置工具面板');
  };
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
      window.__migSid = cb.closest('[data-testid="row"]').dataset.sid;
    })()`);
    await waitFor(`document.querySelector('[data-testid="sel-count"]').textContent === '1'`, 4000, '选中');
    // 卡片上已无「迁移到此」按钮（按注解去掉）→ 模拟把该会话拖到 codex 卡片上
    await evaluate(`(() => {
      const card = document.querySelector('[data-testid="tool-card-codex"]');
      const dt = new DataTransfer();
      dt.setData('text/plain', window.__migSid || '');
      card.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`);
    // v0.6：确认条内联在右栏
    await waitFor(`!!document.getElementById('mig-confirm')`, 4000, '迁移内联确认条');
    await click('#mig-confirm [data-act="go"]');
    await waitFor(`!!document.querySelector('.hub-toast--error')`, 8000, '错误 toast');
    const txt = await evaluate(`document.querySelector('.hub-toast--error').textContent`);
    // 口径（2026-10-17）：沙箱里 casr 不可用，迁移必然失败；这里断言"失败有明确反馈"，
    // 且文案里能看出是**引擎/迁移**这一层（'casr' 或 '迁移' 均可），不再写死具体措辞。
    if (!/casr|迁移/.test(txt)) throw new Error('迁移失败反馈不含引擎/迁移线索: ' + txt);
    await shot('sandbox-casr-missing.png');
    return '引擎缺失 → 明确错误 toast: ' + txt.slice(0, 40);
  });

  S('validation-empty-memory', async () => {
    // 记忆视图 = 来源卡片 + 条目列表（v1.0）；新建表单在「笔记 · 本地」里，
    // 所以先回到全部来源、再进笔记（与主 E2E 的 memory-flow 同口径）
    await click('[data-testid="nav-memory"]');
    await evaluate(`(() => { const b = document.getElementById('mv-back-notes'); if (b) b.click(); })()`);
    await waitFor(`!!document.querySelector('[data-testid="mv-sources"]')`, 8000, '记忆来源卡片');
    await evaluate(`(() => { if (!document.querySelector('[data-testid="mv-add"]'))
      document.querySelector('[data-testid="mv-sources"] .tcard[data-src="notes"]').click(); })()`);
    await waitFor(`!!document.querySelector('[data-testid="mv-add"]')`, 8000, '记忆视图');
    await evaluate(`document.getElementById('mv-body').value = ''`);
    await click('[data-testid="mv-add"]');
    await waitFor(`!!document.querySelector('.hub-toast--error')`, 6000, '校验错误');
    return '空记忆内容被拦截';
  });

  S('long-title-no-overflow', async () => {
    // 先回到会话页：上一条用例可能停在记忆/设置页，页面宽度会被那些页面的边框/面板影响，
    // 让这条断言依赖了无关状态（曾因此报 1482 的 2px 溢出）
    await click('[data-testid="nav-sessions"]');
    await waitFor(`!!document.querySelector('[data-testid="row"]')`, 6000, '会话列表');
    // v0.8：会话行标题在 .mvi__title（列表行内，旧 .nv-name 随三栏布局一并重命名）
    await evaluate(`(() => {
      const t = document.querySelector('[data-testid="row"] .mvi__title');
      if (!t) throw new Error('no session title node');
      t.textContent = '这是一个非常非常非常长的会话标题用来测试省略号与不换行约束在窄屏下的表现'.repeat(3);
    })()`);
    const overflow = await evaluate(`document.documentElement.scrollWidth`);
    if (overflow > 1481) {
      const who = await evaluate(`JSON.stringify({client:document.documentElement.clientWidth,
        offenders:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();
          return r.right > document.documentElement.clientWidth+0.5;})
          .slice(0,4).map(e=>e.tagName+'.'+String(e.className).slice(0,36)+' right='+Math.round(e.getBoundingClientRect().right))})`);
      throw new Error('横向溢出: ' + overflow + ' · ' + who);
    }
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

  // 登记一个采集源：**不填名称、不选格式**（v0.8 口径：hub 按路径识别）→ 返回 tool id
  const addSource = async (root) => {
    const r = await evaluate(`fetch('/api/tools', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ root: ${JSON.stringify(root)} }) }).then(r => r.json())`);
    if (!r || !r.ok) throw new Error('夹具登记失败：' + JSON.stringify(r));
    await evaluate('window.hubApp.loadState()');
    // 设置页若开着，重绘工具列表（夹具是接口直接造的，页面不会自己知道）
    await evaluate(`(document.getElementById('settings-overlay') || {}).classList
      && document.getElementById('settings-overlay').classList.contains('is-active')
      ? window.SettingsCenter.refresh() : null`);
    return await evaluate(`(window.hubApp.state.tool_list.find(t => t.root === ${JSON.stringify(root)}) || {}).id`);
  };
  const idOfRoot = (root) =>
    `(window.hubApp.state.tool_list.find(t => t.root === ${JSON.stringify(root)}) || {}).id`;


  S('tools-add-and-refresh', async () => {
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    const root = join(sbxTmp, 'pi-fixture');
    const tid = await addSource(root);          // 名称 √ 自动（Pi-Agent）、格式 √ 静默识别
    if (!tid) throw new Error('登记后找不到该工具');
    await waitFor(`(window.hubApp.state.tool_list.find(t => t.id === ${JSON.stringify(tid)}) || {}).adapter === 'pi'`, 6000, '自动识别为 pi 格式');
    await waitFor(`!!document.querySelector('[data-testid="tool-card-${tid}"]')`, 6000, '卡片出现');
    // 卡片上没有 ⟳（按注解去掉）→ 进入该工具，用侧栏的刷新按钮采集
    await click(`[data-testid="tool-open-${tid}"]`);
    await waitFor(`!!document.querySelector('[data-testid="focus-refresh"]')`, 6000, '侧栏刷新按钮');
    await click('[data-testid="focus-refresh"]');
    await waitFor(`document.querySelector('[data-testid="count-${tid}"]') && document.querySelector('[data-testid="count-${tid}"]').textContent === '1'`, 10000, '会话计数=1');
    const mc = await evaluate(`(window.hubApp.state.sessions.find(s => s.tool === ${JSON.stringify(tid)}) || {}).msg_count`);
    if (mc !== 3) throw new Error('消息数应为 3，实际 ' + mc);
    // 已在该工具视图里 → 列表只应有它的 1 条会话（卡片即筛选入口，chips 已去掉）
    await waitFor(`document.querySelectorAll('[data-testid="row"]').length === 1`, 6000, '工具视图筛选生效');
    await evaluate(`document.querySelector('[data-testid="filter-all"]').click()`);
    await sleep(300);
    await shot('sandbox-tool-added.png');
    return `登记(${tid}，格式自动识别) → 采集 1 会话 / 3 消息 → 卡片筛选生效`;
  });

  S('tools-root-redetect', async () => {
    // 自定义工具：改路径 → 自动重新识别格式（持久化 + 还原）
    const root = join(sbxTmp, 'pi-fixture');
    const croot = join(sbxTmp, 'claude-fixture');
    mkdirSync(join(croot, 'proj'), { recursive: true });
    writeFileSync(join(croot, 'proj', 's1.jsonl'),
      JSON.stringify({ type: 'user', sessionId: 'x', parentUuid: null, cwd: '/tmp',
                       message: { role: 'user', content: 'hi' } }) + '\n');
    const tid = await evaluate(idOfRoot(root));
    if (!tid) throw new Error('前置工具缺失');
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await openToolPane();
    await click(`[data-testid="manage-${tid}"]`);
    await waitFor(`!!document.querySelector('[data-testid="settings-tool-${tid}"][data-open="1"]')`, 4000, '行内编辑面板');
    const adOpen = await evaluate(`(window.hubApp.state.tool_list.find(t => t.id === ${JSON.stringify(tid)}) || {}).adapter`);
    if (adOpen !== 'pi') throw new Error('前置工具格式应为 pi: ' + adOpen);
    await evaluate(`(() => { const e = document.getElementById('settool-root');
      e.value = ${JSON.stringify(croot)}; e.dispatchEvent(new Event('input')); })()`);
    await click('[data-testid="settool-save"]');
    await waitFor(`!!document.querySelector('.hub-toast--success')`, 8000, '保存 toast');
    let ad = await evaluate(`(window.hubApp.state.tool_list.find(t => t.id === ${JSON.stringify(tid)}) || {}).adapter`);
    if (ad !== 'claude') throw new Error('格式未随路径重新识别：' + ad);
    // 还原为 pi 路径
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await click(`[data-testid="manage-${tid}"]`);
    await waitFor(`!!document.querySelector('[data-testid="settings-tool-${tid}"][data-open="1"]')`, 4000, '行内编辑面板');
    await evaluate(`(() => { const e = document.getElementById('settool-root');
      e.value = ${JSON.stringify(root)}; e.dispatchEvent(new Event('input')); })()`);
    await click('[data-testid="settool-save"]');
    await waitFor(`!!document.querySelector('.hub-toast--success')`, 8000, '还原保存 toast');
    ad = await evaluate(`(window.hubApp.state.tool_list.find(t => t.id === ${JSON.stringify(tid)}) || {}).adapter`);
    if (ad !== 'pi') throw new Error('格式还原失败：' + ad);
    // 内置工具：路径锁定（格式仍可见）
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await click('[data-testid="manage-claude"]');
    await waitFor(`!!document.querySelector('[data-testid="settings-tool-claude"][data-open="1"]')`, 4000, '内置工具行内面板');
    const st = await evaluate(`(() => ({ rootDisabled: document.getElementById('settool-root').disabled,
      adapter: (window.hubApp.state.tool_list.find(t => t.id === 'claude') || {}).adapter }))()`);
    if (!st.rootDisabled) throw new Error('内置工具路径应锁定，实际可改');
    if (st.adapter !== 'claude') throw new Error('内置工具格式应保持 claude: ' + st.adapter);
    await click('[data-testid="settool-cancel"]');      // 工具弹窗已删：行内面板用「取消」收起
    return '改路径→自动重识别（持久化+还原）· 内置路径锁定 + 格式可见';
  });

  S('tools-disable-and-remove', async () => {
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    // v0.7：停用/删除统一走设置中心；v0.8：登记由路径识别，工具 id 从 registry 取
    const root = join(sbxTmp, 'pi-fixture');
    const tid = await evaluate(idOfRoot(root));
    if (!tid) throw new Error('前置工具缺失');
    await click('[data-testid="settings-open"]');
    await waitFor(`document.getElementById('settings-overlay').classList.contains('is-open')`, 4000, '设置中心');
    await click('[data-testid="settings-nav-tools"]');
    await waitFor(`!!document.querySelector('[data-testid="settings-tool-toggle-${tid}"]')`, 6000, '设置工具行');
    await click(`[data-testid="settings-tool-toggle-${tid}"]`);
    await waitFor(`!!document.querySelector('.hub-toast--success')`, 8000, '停用保存 toast');
    // 口径 B（2026-10-14 定稿）：停用 = 在所有界面隐藏（含历史会话）→ 卡片消失
    await waitFor(`!document.querySelector('[data-testid="tool-card-${tid}"]')`, 6000, '卡片停用即隐藏');
    const kept = await evaluate(`window.hubApp.state.sessions.some(s => s.tool === ${JSON.stringify(tid)})`);
    if (!kept) throw new Error('停用后会话不应消失');
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    const del = await evaluate(`(async () => { const r = await fetch('/api/tools/${tid}', { method: 'DELETE' }); return (await r.json()).ok; })()`);
    if (!del) throw new Error('删除失败');
    // 设置面板内容不自动感知 API 删除 —— 重开设置中心刷新
    await click('[data-testid="settings-close"]');
    await waitFor(`!document.getElementById('settings-overlay').classList.contains('is-open')`, 4000, '设置关闭');
    await click('[data-testid="settings-open"]');
    await waitFor(`!!document.querySelector('[data-testid="settings-body"]')`, 4000, '设置重开');
    await click('[data-testid="settings-nav-tools"]');
    await waitFor(`!document.querySelector('[data-testid="settings-tool-${tid}"]')`, 6000, '设置行消失');
    const still = await evaluate(`window.hubApp.state.sessions.some(s => s.tool === ${JSON.stringify(tid)})`);
    if (!still) throw new Error('移除后会话数据应保留');
    return '停用→卡片隐藏（数据保留）→移除→数据仍保留';
  });

  S('tools-purge-delete', async () => {
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    const root2 = join(sbxTmp, 'pi-fixture2');
    const tid2 = await addSource(root2);
    if (!tid2) throw new Error('登记失败');
    await waitFor(`!!document.querySelector('[data-testid="tool-card-${tid2}"]')`, 8000, '卡片出现');
    await click(`[data-testid="tool-open-${tid2}"]`);
    await waitFor(`!!document.querySelector('[data-testid="focus-refresh"]')`, 6000, '侧栏刷新按钮');
    await click('[data-testid="focus-refresh"]');
    await waitFor(`document.querySelector('[data-testid="count-${tid2}"]') && document.querySelector('[data-testid="count-${tid2}"]').textContent === '1'`, 10000, '采集完成');
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await openToolPane();
    await click(`[data-testid="manage-${tid2}"]`);
    await waitFor(`!!document.querySelector('[data-testid="settings-tool-${tid2}"][data-open="1"]')`, 4000, '行内编辑面板');
    await click('[data-testid="settool-delete"]');
    await waitFor(`!!document.querySelector('[data-testid="tool-purge-opt"]')`, 4000, '删除确认弹层');
    await evaluate(`document.querySelector('[data-testid="tool-purge-opt"]').click()`);
    await click('.hub-modal__ok');
    await waitFor(`[...document.querySelectorAll('.hub-toast--success')].some(t => t.textContent.includes('彻底删除'))`, 10000, '彻底删除 toast');
    await waitFor(`!document.querySelector('[data-testid="tool-card-${tid2}"]')`, 6000, '卡片消失');
    const gone = await evaluate(`!window.hubApp.state.sessions.some(s => s.tool === ${JSON.stringify(tid2)})`);
    if (!gone) throw new Error('彻底删除后数据应清除');
    return '勾选彻底清除 → 数据清除 → 卡片消失';
  });


  S('tools-sync-targets', async () => {
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    await openToolPane();
    const r = await evaluate(`fetch('/api/tools', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ root: ${JSON.stringify(join(sbxTmp, 'pi-fixture'))},
        skills_dir: ${JSON.stringify(join(sbxTmp, 'st-skills'))},
        mcp_config: ${JSON.stringify(join(sbxTmp, 'st-mcp.json'))} }) }).then(r => r.json())`);
    if (!r.ok || !(r.targets_created || []).length) throw new Error('目标未随登记同步：' + JSON.stringify(r));
    await evaluate('window.hubApp.loadState()');
    await evaluate(`window.SettingsCenter.refresh()`);
    const okSkills = await evaluate(`fetch('/api/skills/targets').then(r=>r.json()).then(d=>d.targets.some(t=>t.path.includes('st-skills')))`);
    const okMcp = await evaluate(`fetch('/api/mcp/targets').then(r=>r.json()).then(d=>d.targets.some(t=>t.path.includes('st-mcp')))`);
    if (!okSkills || !okMcp) throw new Error(`目标未同步: skills=${okSkills} mcp=${okMcp}`);
    await evaluate(`document.querySelectorAll('#hub-toasts > *').forEach(t => t.remove())`);
    const syncId = await evaluate(`(window.hubApp.state.tool_list.find(t => t.skills_dir && t.skills_dir.endsWith('st-skills')) || {}).id`);
    if (!syncId) throw new Error('找不到同步工具');
    await click(`[data-testid="manage-${syncId}"]`);
    await waitFor(`!!document.querySelector('[data-testid="settings-tool-${syncId}"][data-open="1"]')`, 4000, '行内编辑面板');
    await click('[data-testid="settool-delete"]');
    await waitFor(`!!document.querySelector('.hub-modal__ok')`, 4000, '删除确认');
    await click('.hub-modal__ok');
    await waitFor(`!!document.querySelector('.hub-toast--success')`, 8000, '删除 toast');
    const gone = await evaluate(`fetch('/api/skills/targets').then(r=>r.json()).then(d=>!d.targets.some(t=>t.path.includes('st-skills')))`);
    if (!gone) throw new Error('删除后目标未清理');
    return '添加同步（Skills+MCP）→ 删除自动清理';
  });

  S('tools-no-add-entry', async () => {
    // 用户指令 2026-10-16「去掉添加工具的能力」：任何界面都不得出现添加入口 / 工具弹窗
    await openToolPane();
    const r = await evaluate(`JSON.stringify({
      overlay: !!document.getElementById('tool-overlay'),
      api: typeof (window.hubApp || {}).openToolModal,
      addBtn: !!document.querySelector('[data-testid="settings-tool-add"], [data-testid="tool-add"]') })`);
    const d = JSON.parse(r);
    if (d.overlay || d.api !== 'undefined' || d.addBtn) throw new Error('仍存在添加入口：' + r);
    return '无工具弹窗 / 无 openToolModal / 无添加按钮';
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
