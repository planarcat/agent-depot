#!/usr/bin/env bun
/**
 * 前端核心覆盖率门禁：解析 bun test 的 lcov.info，只考核 src/core/（纯逻辑层）。
 *
 * 阈值：行覆盖 ≥90%、函数覆盖 ≥90%。
 * 说明：Bun 的 lcov 不输出分支计数（BRF/BRH），分支维度暂不可度量；
 *      视图/入口层靠 e2e（tests/e2e.mjs）做行为覆盖，不纳入单测门禁。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, '..');
const LCOV = join(ROOT, 'web', 'coverage', 'lcov.info');
const MIN_LINES = 0.9;
const MIN_FUNCS = 0.9;

if (!existsSync(LCOV)) {
  console.error(`coverage: 缺少 ${LCOV} —— 先跑 bun run test:cov`);
  process.exit(1);
}

interface Rec {
  file: string;
  lf: number;
  lh: number;
  fnf: number;
  fnh: number;
}

const records: Rec[] = [];
let cur: Rec | null = null;

for (const line of readFileSync(LCOV, 'utf8').split('\n')) {
  if (line.startsWith('SF:')) {
    cur = { file: line.slice(3), lf: 0, lh: 0, fnf: 0, fnh: 0 };
  } else if (cur && line.startsWith('LF:')) cur.lf = Number(line.slice(3));
  else if (cur && line.startsWith('LH:')) cur.lh = Number(line.slice(3));
  else if (cur && line.startsWith('FNF:')) cur.fnf = Number(line.slice(4));
  else if (cur && line.startsWith('FNH:')) cur.fnh = Number(line.slice(4));
  else if (line === 'end_of_record' && cur) {
    records.push(cur);
    cur = null;
  }
}

const core = records.filter((r) => r.file.replaceAll('\\', '/').includes('src/core/'));
if (core.length === 0) {
  console.error('coverage: lcov 中没有 src/core/ 记录');
  process.exit(1);
}

const sum = core.reduce(
  (a, r) => ({
    lf: a.lf + r.lf,
    lh: a.lh + r.lh,
    fnf: a.fnf + r.fnf,
    fnh: a.fnh + r.fnh,
  }),
  { lf: 0, lh: 0, fnf: 0, fnh: 0 },
);

const linePct = sum.lf ? sum.lh / sum.lf : 1;
const funcPct = sum.fnf ? sum.fnh / sum.fnf : 1;

const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
console.log(`  core lines ${sum.lh}/${sum.lf} = ${pct(linePct)}（阈值 ${MIN_LINES * 100}%）`);
console.log(`  core funcs ${sum.fnh}/${sum.fnf} = ${pct(funcPct)}（阈值 ${MIN_FUNCS * 100}%）`);

const bad = core
  .map((r) => ({ ...r, line: r.lf ? r.lh / r.lf : 1 }))
  .filter((r) => r.line < MIN_LINES)
  .sort((a, b) => a.line - b.line);

if (bad.length > 0) {
  for (const r of bad.slice(0, 10)) {
    console.log(`  ! ${r.file} lines ${r.lh}/${r.lf} = ${pct(r.line)}`);
  }
}

if (linePct < MIN_LINES || funcPct < MIN_FUNCS) {
  console.error('\ncoverage FAIL');
  process.exit(1);
}
console.log('coverage ok');
