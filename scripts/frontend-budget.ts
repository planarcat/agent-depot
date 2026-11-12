#!/usr/bin/env bun
/**
 * 前端体积与产物完整性门禁（CI / check.sh 调用，不依赖网络）。
 *
 * 1) 体积预算：入口 raw/gzip、单 chunk、JS 总量、CSS 总量、首屏 gzip
 * 2) 完整性：index.html 引用的入口/CSS 必须存在；JS 内相对 import 必须能落到 dist 文件
 * 3) 缓存性：除 index.html / manifest.json 外，资源文件名必须带内容哈希
 *
 * 超预算 → 退出码 1（构建/提交前置闸门），并逐条打印超限项。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'web', 'dist');

const KB = 1024;
const BUDGET = {
  entryRaw: 60 * KB,
  entryGzip: 20 * KB,
  chunkRaw: 120 * KB,
  jsTotal: 400 * KB,
  cssTotal: 200 * KB,
  firstLoadGzip: 60 * KB,
};

interface Entry {
  file: string;
  bytes: number;
}

const problems: string[] = [];
const notes: string[] = [];

function gzipBytes(path: string): number {
  return Bun.gzipSync(readFileSync(path)).length;
}

function fmt(n: number): string {
  return `${(n / KB).toFixed(1)}KB`;
}

function checkBudget(label: string, actual: number, max: number): void {
  if (actual > max) problems.push(`${label} 超预算：${fmt(actual)} > ${fmt(max)}`);
}

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('budget: 缺少 web/dist/manifest.json —— 先跑 bun run build');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')) as {
  entry: string;
  css: Record<string, string>;
};
const files = readdirSync(DIST).filter((f) => f !== '.tmp');
const jsFiles = files.filter((f) => f.endsWith('.js'));
const cssFiles = files.filter((f) => f.endsWith('.css'));

/* ---------- 1) 体积 ---------- */
if (!jsFiles.includes(manifest.entry)) {
  problems.push(`入口文件不存在：${manifest.entry}`);
} else {
  const entryPath = join(DIST, manifest.entry);
  const raw = statSync(entryPath).size;
  const gz = gzipBytes(entryPath);
  checkBudget('入口 raw', raw, BUDGET.entryRaw);
  checkBudget('入口 gzip', gz, BUDGET.entryGzip);
  notes.push(`入口 ${manifest.entry} · raw ${fmt(raw)} · gzip ${fmt(gz)}`);
}

const chunks: Entry[] = jsFiles
  .filter((f) => f !== manifest.entry)
  .map((f) => ({ file: f, bytes: statSync(join(DIST, f)).size }));
for (const c of chunks) checkBudget(`chunk ${c.file}`, c.bytes, BUDGET.chunkRaw);

const jsTotal = jsFiles.reduce((a, f) => a + statSync(join(DIST, f)).size, 0);
const cssTotal = cssFiles.reduce((a, f) => a + statSync(join(DIST, f)).size, 0);
checkBudget('JS 总量', jsTotal, BUDGET.jsTotal);
checkBudget('CSS 总量', cssTotal, BUDGET.cssTotal);
notes.push(`JS ${jsFiles.length} 个 · ${fmt(jsTotal)}；CSS ${cssFiles.length} 个 · ${fmt(cssTotal)}`);

/* ---------- 2) 完整性 ---------- */
const indexPath = join(DIST, 'index.html');
if (!existsSync(indexPath)) {
  problems.push('缺少 dist/index.html');
} else {
  const html = readFileSync(indexPath, 'utf8');
  if (!html.includes(`/assets/${manifest.entry}`)) {
    problems.push(`index.html 未引用入口 ${manifest.entry}`);
  }
  for (const hashed of Object.values(manifest.css)) {
    if (!files.includes(hashed)) problems.push(`index.html 引用的 CSS 不存在：${hashed}`);
    if (!html.includes(`/assets/${hashed}`)) problems.push(`index.html 未引用 CSS：${hashed}`);
  }
  const firstLoad = gzipBytes(indexPath) + gzipBytes(join(DIST, manifest.entry));
  const cssGzip = Object.values(manifest.css)
    .filter((f) => files.includes(f))
    .reduce((a, f) => a + gzipBytes(join(DIST, f)), 0);
  checkBudget('首屏 gzip（html+入口+css）', firstLoad + cssGzip, BUDGET.firstLoadGzip);
  notes.push(`首屏 gzip（html+入口+css）${fmt(firstLoad + cssGzip)}`);
}

/* JS 内相对 import 必须全部可解析（splitting 后漏拷 chunk 会在浏览器 404） */
const importRe = /["']\.\/([A-Za-z0-9._-]+\.js)["']/g;
for (const f of jsFiles) {
  const src = readFileSync(join(DIST, f), 'utf8');
  for (const m of src.matchAll(importRe)) {
    const dep = m[1];
    if (dep && !files.includes(dep)) problems.push(`${f} 引用的 chunk 缺失：${dep}`);
  }
}

/* ---------- 3) 缓存性 ---------- */
const hashRe = /-[a-z0-9]{8,}\.(?:js|css)$/;
for (const f of [...jsFiles, ...cssFiles]) {
  if (!hashRe.test(f)) problems.push(`资源缺少内容哈希：${f}`);
}

/* ---------- 输出 ---------- */
const top = [...jsFiles, ...cssFiles]
  .map((f) => ({ f, n: statSync(join(DIST, f)).size }))
  .sort((a, b) => b.n - a.n)
  .slice(0, 5)
  .map((x) => `${basename(x.f)} ${fmt(x.n)}`)
  .join(' · ');
for (const n of notes) console.log(`  ${n}`);
console.log(`  top: ${top}`);

if (problems.length > 0) {
  console.error(`\nbudget FAIL（${problems.length} 项）`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('budget ok');
