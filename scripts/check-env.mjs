#!/usr/bin/env node
/**
 * 自检脚本：确认目标机器（尤其是 Windows）能跑起来。
 *   node scripts/check-env.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const head = (s) => console.log(`\n${s}`);

let failed = 0;

head('运行环境');
ok(`Node ${process.version}`);
ok(`${process.platform} ${process.arch}`);

const major = Number(process.version.replace(/^v/, '').split('.')[0]);
if (major < 24) {
  bad(`Node 版本过低（需要 ≥ 24，当前 ${process.version}）。node:sqlite 与 TypeScript 直跑都依赖它。`);
  failed++;
} else {
  ok('Node 版本满足要求（≥ 24）');
}

head('内置能力');
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('create table t(a text)');
  db.prepare('insert into t values (?)').run('x');
  ok('node:sqlite 可用（无需编译原生模块）');
} catch (err) {
  bad(`node:sqlite 不可用：${err.message}`);
  failed++;
}

try {
  const { createCanvas } = await import('@napi-rs/canvas');
  const cv = createCanvas(10, 10);
  cv.getContext('2d').fillRect(0, 0, 1, 1);
  ok('@napi-rs/canvas 可用（答题卡渲染 / 裁切）');
} catch (err) {
  bad(`@napi-rs/canvas 不可用：${err.message}。请重新执行 npm install（不要直接拷贝 macOS 的 node_modules 到 Windows）。`);
  failed++;
}

try {
  const { pdf } = await import('pdf-to-img');
  ok('pdf-to-img 可用（PDF 扫描页转图）');
  void pdf;
} catch (err) {
  bad(`pdf-to-img 不可用：${err.message}。pdfjs-dist 版本必须与 pdf-to-img 一致（6.4.299）。`);
  failed++;
}

head('项目文件');
if (fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) ok('前端已构建（web/dist）');
else {
  warn('前端尚未构建，运行 npm run build');
}

const dataDir = path.resolve(process.env.PAPER_AI_DATA ?? path.join(ROOT, 'data'));
try {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const probe = path.join(dataDir, '.write-test');
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
  ok(`数据目录可写：${dataDir}`);
} catch (err) {
  bad(`数据目录不可写：${dataDir}（${err.message}）`);
  failed++;
}

const port = Number(process.env.PORT ?? 8787);
await new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', (err) => {
    if (err.code === 'EADDRINUSE') bad(`端口 ${port} 已被占用（换一个：set PORT=8788）`);
    else bad(`端口 ${port} 检查失败：${err.message}`);
    failed++;
    resolve();
  });
  srv.once('listening', () => {
    srv.close();
    ok(`端口 ${port} 可用`);
    resolve();
  });
  srv.listen(port, '127.0.0.1');
});

head('可选组件');
try {
  await import('tesseract.js');
  ok('tesseract.js 已安装（印刷体 OCR，手写体不推荐）');
} catch {
  warn('未安装 tesseract.js（可选）：需要纯本地印刷体 OCR 时执行 npm i tesseract.js');
}

head(failed ? `完成，但有 ${failed} 项需要处理` : '全部通过');
process.exit(failed ? 1 : 0);
