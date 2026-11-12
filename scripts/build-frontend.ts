#!/usr/bin/env bun
/**
 * 前端构建：web/src/main.ts → web/dist/
 *   - bun build：单入口 + 自动 code splitting（视图 import()）+ minify + 外置 sourcemap
 *   - 哈希文件名（内容即版本，可长缓存）
 *   - CSS 三件套哈希复制
 *   - 由 web/index.html 生成 dist/index.html（注入真实哈希文件名）
 *   - dist/manifest.json 供 depotd 判断产物就绪
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = join(import.meta.dir, '..');
const WEB = join(ROOT, 'web');
const SRC = join(WEB, 'src');
const DIST = join(WEB, 'dist');

function hash8(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 8);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

/* 1) JS 打包：bun build 输出到临时目录，再按内容哈希改名 */
const tmp = join(DIST, '.tmp');
const proc = Bun.spawnSync(
  [
    'bun',
    'build',
    join(SRC, 'main.ts'),
    '--outdir',
    tmp,
    '--minify',
    '--splitting',
    '--sourcemap=external',
    '--target=browser',
    '--entry-naming',
    '[name]-[hash].[ext]',
    '--chunk-naming',
    'chunk-[hash].[ext]',
    `--metafile=${join(tmp, 'metafile.json')}`,
    '--asset-naming',
    '[name]-[hash].[ext]',
  ],
  { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
);
if (proc.exitCode !== 0) {
  console.error(new TextDecoder().decode(proc.stderr));
  process.exit(1);
}

/* 2) 从 metafile 精确识别入口产物（splitting 后共享 chunk 不再以 main- 开头） */
const outFiles = readdirSync(tmp).filter((f) => f !== 'metafile.json');
const meta = JSON.parse(readFileSync(join(tmp, 'metafile.json'), 'utf8')) as {
  outputs: Record<string, { entryPoint?: string }>;
};
const entryKey = Object.keys(meta.outputs).find((k) => meta.outputs[k]?.entryPoint?.endsWith('src/main.ts'));
const entryName = entryKey ? basename(entryKey) : undefined;
if (!entryName || !outFiles.includes(entryName)) {
  console.error('找不到入口产物：', outFiles.join(', '));
  process.exit(1);
}
for (const f of outFiles) {
  copyFileSync(join(tmp, f), join(DIST, f));
}
rmSync(tmp, { recursive: true, force: true });

/* 3) CSS：内容哈希复制 */
const cssNames = ['tokens.css', 'hub-ui.css', 'app.css'];
const cssHashed: Record<string, string> = {};
for (const name of cssNames) {
  const data = readFileSync(join(WEB, name));
  const hashed = `${basename(name, '.css')}-${hash8(data)}.css`;
  writeFileSync(join(DIST, hashed), data);
  cssHashed[name] = hashed;
}

/* 4) index.html：替换脚本与样式引用 */
let html = readFileSync(join(WEB, 'index.html'), 'utf8');
for (const name of cssNames) {
  html = html.replaceAll(`/assets/${name}`, `/assets/${cssHashed[name]}`);
}
html = html.replace(
  /<script type="module" src="\/assets\/main\.js"><\/script>/,
  `<script type="module" src="/assets/${entryName}"></script>`,
);
writeFileSync(join(DIST, 'index.html'), html);

/* 5) manifest + 体积报告 */
const entries = readdirSync(DIST).filter((f) => f !== 'manifest.json');
let total = 0;
const files: { file: string; bytes: number }[] = [];
for (const f of entries) {
  const size = readFileSync(join(DIST, f)).length;
  total += size;
  files.push({ file: f, bytes: size });
}
const jsBytes = files.filter((f) => f.file.endsWith('.js')).reduce((a, f) => a + f.bytes, 0);
const mapBytes = files.filter((f) => f.file.endsWith('.map')).reduce((a, f) => a + f.bytes, 0);
const cssBytes = files.filter((f) => f.file.endsWith('.css')).reduce((a, f) => a + f.bytes, 0);
writeFileSync(
  join(DIST, 'manifest.json'),
  JSON.stringify(
    {
      entry: entryName,
      css: cssHashed,
      built_at: new Date().toISOString(),
      bytes: { js: jsBytes, css: cssBytes, map: mapBytes, total },
      files,
    },
    null,
    2,
  ),
);
console.log(
  `build ok: ${entryName} · js ${(jsBytes / 1024).toFixed(1)}KB · css ${(cssBytes / 1024).toFixed(1)}KB · map ${(mapBytes / 1024).toFixed(1)}KB · 共 ${(total / 1024).toFixed(1)}KB`,
);
