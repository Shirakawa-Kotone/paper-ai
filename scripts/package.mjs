#!/usr/bin/env node
/**
 * 打包成"免安装"压缩包：内置 Node 运行时 + 预装依赖，解压后双击脚本即可用。
 *
 *   node scripts/package.mjs --target win64
 *   node scripts/package.mjs --target mac-arm64
 *
 * 产物：dist/paper-ai-win64.zip（或 mac-arm64）
 *
 * 需要联网下载 Node 官方运行时；依赖在目标平台上预装（用 npm 的 --os/--cpu 交叉拉取原生模块）。
 */
import fs from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const NODE_VERSION = getArg('node', 'v26.13.0');
const target = getArg('target', process.platform === 'win32' ? 'win64' : 'mac-arm64');

const TARGETS = {
  win64: {
    label: 'Windows x64',
    os: 'win32',
    cpu: 'x64',
    runtimeUrl: `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`,
    runtimeFile: 'runtime/node.exe',
    archive: `paper-ai-win64.zip`,
  },
  'mac-arm64': {
    label: 'macOS Apple Silicon',
    os: 'darwin',
    cpu: 'arm64',
    runtimeUrl: `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    runtimeFile: 'runtime/node',
    archive: `paper-ai-mac-arm64.zip`,
  },
  'mac-x64': {
    label: 'macOS Intel',
    os: 'darwin',
    cpu: 'x64',
    runtimeUrl: `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-x64.tar.gz`,
    runtimeFile: 'runtime/node',
    archive: `paper-ai-mac-x64.zip`,
  },
};

const cfg = TARGETS[target];
if (!cfg) {
  console.error(`未知目标：${target}（可选：${Object.keys(TARGETS).join(' / ')}）`);
  process.exit(1);
}

const BUILD = path.join(ROOT, 'build');
const PKG_NAME = `paper-ai-${target}`;
const PKG_DIR = path.join(BUILD, PKG_NAME);
const APP_DIR = path.join(PKG_DIR, 'app');
const DIST = path.join(ROOT, 'dist');

const log = (s) => console.log(`  ${s}`);
const run = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT, ...opts });

// 版本号跟根 package.json 保持一致，避免包里写死旧版本
const ROOT_PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const SLIM_PACKAGE = {
  name: 'paper-ai',
  version: ROOT_PKG.version,
  private: true,
  type: 'module',
  description: '化学 AI 改卷台（免安装版）',
  dependencies: {
    '@hono/node-server': '^2.1.6',
    '@napi-rs/canvas': '^1.1.0',
    hono: '^4.13.16',
    'pdf-lib': '^1.17.1',
    'pdf-to-img': '^7.0.2',
    'pdfjs-dist': '6.4.299',
    'exceljs': '^4.4.0',
    zod: '^4.6.7',
  },
};

/** 随包携带的 OCR 语言包，让本机 OCR 离线可用 */
const TESSDATA = ['chi_sim.traineddata.gz'];
const TESSDATA_BASE = 'https://tessdata.projectnaptha.com/4.0.0';

async function copyDir(from, to, filter = () => true) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === '__pycache__') continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (!filter(src, entry)) continue;
    if (entry.isDirectory()) await copyDir(src, dst, filter);
    else await fs.copyFile(src, dst);
  }
}

function sh(cmd, shellArgs, opts = {}) {
  execFileSync(cmd, shellArgs, { stdio: 'inherit', ...opts });
}

async function main() {
  console.log(`\n打包 ${cfg.label} · Node ${NODE_VERSION}\n`);

  // 0. 前端必须已经构建
  if (!existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
    log('前端还没构建，先跑 vite build…');
    run(path.join(ROOT, 'node_modules', '.bin', 'vite'), ['build']);
  }

  // 1. 清空暂存目录
  await fs.rm(PKG_DIR, { recursive: true, force: true });
  mkdirSync(APP_DIR, { recursive: true });
  await fs.mkdir(DIST, { recursive: true });

  // 2. 拷源码与构建产物
  log('复制程序文件…');
  await copyDir(path.join(ROOT, 'server'), path.join(APP_DIR, 'server'));
  await copyDir(path.join(ROOT, 'shared'), path.join(APP_DIR, 'shared'));
  await copyDir(path.join(ROOT, 'web', 'dist'), path.join(APP_DIR, 'web', 'dist'));
  if (existsSync(path.join(ROOT, 'tools'))) await copyDir(path.join(ROOT, 'tools'), path.join(APP_DIR, 'tools'));
  await fs.copyFile(path.join(ROOT, 'README.md'), path.join(APP_DIR, 'README.md'));
  await fs.writeFile(path.join(APP_DIR, 'package.json'), JSON.stringify(SLIM_PACKAGE, null, 2) + '\n');

  // 3. 为目标平台安装生产依赖
  log(`安装依赖（${cfg.os}-${cfg.cpu}）…`);
  const cacheDir = path.join(ROOT, '.cache', 'npm');
  for (const f of ['package-lock.json', 'node_modules']) {
    await fs.rm(path.join(APP_DIR, f), { recursive: true, force: true });
  }
  sh('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', `--os=${cfg.os}`, `--cpu=${cfg.cpu}`], {
    cwd: APP_DIR,
    env: { ...process.env, npm_config_cache: cacheDir },
  });

  // 4. 下载 Node 运行时（带缓存，重打包不用重下）
  const runtimePath = path.join(PKG_DIR, cfg.runtimeFile);
  await fs.mkdir(path.dirname(runtimePath), { recursive: true });

  const runtimeCacheDir = path.join(BUILD, '.runtime-cache');
  await fs.mkdir(runtimeCacheDir, { recursive: true });
  const cached = path.join(runtimeCacheDir, path.basename(cfg.runtimeUrl));
  if (!existsSync(cached)) {
    log(`下载 Node 运行时（${cfg.runtimeUrl.split('/').pop()}，首次较慢）…`);
    sh('curl', ['-fL', '--retry', '5', '--retry-all-errors', '--retry-delay', '2', '-C', '-', '-o', cached, cfg.runtimeUrl]);
  } else {
    log(`使用已缓存的 Node 运行时（${path.basename(cached)}）`);
  }

  if (cfg.runtimeFile.endsWith('.exe')) {
    await fs.copyFile(cached, runtimePath);
  } else {
    const extractDir = path.join(BUILD, `node-${target}`);
    await fs.rm(extractDir, { recursive: true, force: true });
    await fs.mkdir(extractDir, { recursive: true });
    sh('tar', ['-xzf', cached, '-C', extractDir, '--strip-components=1']);
    await fs.copyFile(path.join(extractDir, 'bin', 'node'), runtimePath);
    await fs.chmod(runtimePath, 0o755);
    await fs.rm(extractDir, { recursive: true, force: true });
  }

  // 5. 启动脚本与说明
  log('写启动脚本…');
  if (cfg.os === 'win32') {
    await fs.writeFile(
      path.join(PKG_DIR, 'START.cmd'),
      `@echo off
setlocal
cd /d "%~dp0"
if not exist data mkdir data
set "PAPER_AI_DATA=%~dp0data"
set "PAPER_AI_OPEN=1"
if "%PORT%"=="" set "PORT=8787"
echo.
echo   Paper AI - chemistry grading station
echo   http://127.0.0.1:%PORT%
echo   Keep this window open. Close it to stop.
echo.
"%~dp0runtime\\node.exe" "%~dp0app\\server\\main.ts"
echo.
echo Server stopped.
pause
`,
      'utf8',
    );
  } else {
    const launcher = `#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PAPER_AI_DATA="$PWD/data"
export PAPER_AI_OPEN=1
mkdir -p data
./runtime/node app/server/main.ts
`;
    await fs.writeFile(path.join(PKG_DIR, 'START.command'), launcher, 'utf8');
    await fs.chmod(path.join(PKG_DIR, 'START.command'), 0o755);
    await fs.writeFile(path.join(PKG_DIR, 'start.sh'), launcher, 'utf8');
    await fs.chmod(path.join(PKG_DIR, 'start.sh'), 0o755);
  }

  await fs.writeFile(
    path.join(PKG_DIR, 'README.txt'),
    `\uFEFF化学 AI 改卷台（免安装版 · ${cfg.label}）
========================================

一、怎么启动
  ${cfg.os === 'win32' ? '双击 START.cmd' : '双击 START.command（首次若提示"未验证开发者"，右键 → 打开）'}
  浏览器会自动打开 http://127.0.0.1:8787
  ${cfg.os === 'win32' ? '' : '也可以命令行运行：./start.sh'}

  关闭那个黑色窗口 = 停止服务。

二、第一次使用
  1. 点右上角「设置」，选服务商、填 API Key，点「测试连接」
  2. 新建考试 →「试题」页录题号和参考答案
  3. 「答题卡」页点「出答题卡」，打印发给学生
  4. 收上来扫描成 PDF，拖进上传区 → 开始识别 → 开始批改
  5. 「成绩」页导出 CSV

  用年级组统一下发的答题卡也可以，直接上传，系统会自动做版面分析。

三、数据在哪
  本目录下的 data 文件夹：
    data/paper-ai.db      数据库
    data/uploads/         原始 PDF
    data/crops/           每道题的裁切图
  备份就整个拷走 data 目录。

四、注意
  · 不要解压到 OneDrive / iCloud 同步目录，数据库会锁冲突
  · 服务只监听本机（127.0.0.1），不对局域网开放
  · 端口被占用时：在 START 里把 PORT 改成 8788 再启动
  · 本包已内置 Node 运行时，不需要另外安装任何东西
  · 详细说明见 app/README.md

五、出问题
  · 双击没反应 / 提示"无法启动此程序"：
      这是 Windows 对"网上下载的文件"的来源标记。
      右键下载的 zip → 属性 → 勾选"解除锁定" → 再解压，就能正常运行。
      也可以把整个文件夹加入杀毒软件白名单。
  · 窗口一闪而过：右键 START.cmd → 以管理员身份运行，看具体报错
  · 端口被占用：编辑 START.cmd，把 8787 改成 8788
  · 识别慢：正常，扫描版每份要调一次视觉模型
`,
    'utf8',
  );

  // 去掉条件模板留下的空行
  const readmePath = path.join(PKG_DIR, 'README.txt');
  const readme = await fs.readFile(readmePath, 'utf8');
  await fs.writeFile(readmePath, readme.replace(/\n[ \t]+\n/g, '\n'), 'utf8');

  // 6. 打包
  const zipPath = path.join(DIST, cfg.archive);
  await fs.rm(zipPath, { force: true });
  log('压缩…');
  sh('zip', ['-r', '-q', '-X', zipPath, PKG_NAME], { cwd: BUILD });

  const size = (await fs.stat(zipPath)).size;
  console.log(`\n完成：dist/${cfg.archive}`);
  console.log(`大小：${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`目录：build/${PKG_NAME}\n`);
}

main().catch((err) => {
  console.error('\n打包失败：', err.message);
  process.exit(1);
});
