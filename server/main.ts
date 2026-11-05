import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { initDB } from './db.ts';
import { buildApi } from './routes.ts';

const HERE = import.meta.dirname; // server/
const ROOT = path.resolve(HERE, '..');
const DATA_DIR = path.resolve(process.env.PAPER_AI_DATA ?? path.join(ROOT, 'data'));
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const WEB_DIST = path.join(ROOT, 'web', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStaticFile(filePath: string): Response | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const ext = path.extname(filePath).toLowerCase();
    const body = fs.readFileSync(filePath);
    const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
    return new Response(new Uint8Array(body), {
      headers: {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': String(stat.size),
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    });
  } catch {
    return null;
  }
}

async function main() {
  initDB(DATA_DIR);
  fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

  const app = new Hono();
  app.route('/api', buildApi({ dataDir: DATA_DIR }));

  // 静态资源（web/dist），跨平台手写实现，避免 Windows 路径差异
  app.get('*', (c) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith('/api/')) return c.json({ error: '接口不存在' }, 404);

    if (fs.existsSync(WEB_DIST)) {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const candidate = path.join(WEB_DIST, rel);
      const normalized = path.resolve(candidate);
      if (normalized.startsWith(path.resolve(WEB_DIST)) && rel !== '') {
        const hit = serveStaticFile(normalized);
        if (hit) return hit;
      }
      // SPA 回退
      const index = serveStaticFile(path.join(WEB_DIST, 'index.html'));
      if (index) return index;
    }

    return c.html(
      `<!doctype html><meta charset="utf-8"><title>paper-ai</title>
       <body style="font-family:system-ui;padding:40px;line-height:1.8">
       <h2>前端还没有构建</h2>
       <p>请在项目目录执行：<code>npm run build</code>，然后刷新本页。</p>
       <p>开发模式请用 <code>npm run dev</code>（Vite 会跑在 5173 端口并代理 /api）。</p>
       <p>接口自检：<a href="/api/health">/api/health</a></p>`,
      503,
    );
  });

  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${info.port}`;
    console.log('');
    console.log('  AI 改卷台');
    console.log(`  服务地址  ${url}`);
    console.log(`  数据目录  ${DATA_DIR}`);
    console.log(`  运行环境  Node ${process.version} / ${process.platform}-${process.arch}`);
    console.log('');
    if (process.env.PAPER_AI_OPEN === '1') {
      const cmd =
        process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', url]]
          : process.platform === 'darwin'
            ? ['open', [url]]
            : ['xdg-open', [url]];
      import('node:child_process').then(({ spawn }) => {
        spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore' }).unref();
      });
    }
  });

  const shutdown = () => {
    console.log('\n正在退出…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
