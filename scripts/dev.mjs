#!/usr/bin/env node
/**
 * 开发模式：同时跑 API（8787）和 Vite（5173，代理 /api）。
 *   npm run dev
 */
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const children = [];

const api = spawn(process.execPath, ['--watch', 'server/main.ts'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: process.env.PORT ?? '8787' },
});
children.push(api);

const vite = spawn(isWin ? 'npx.cmd' : 'npx', ['vite'], {
  stdio: 'inherit',
  env: { ...process.env, PAPER_AI_API: `http://127.0.0.1:${process.env.PORT ?? '8787'}` },
  shell: isWin,
});
children.push(vite);

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', (code) => {
  if (code) stop();
});
vite.on('exit', (code) => {
  if (code) stop();
});
