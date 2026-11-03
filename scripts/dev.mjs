import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = new Map();
let stopping = false;

function startTask(name, workspace) {
  const args = ['run', 'dev', '--workspace', workspace];
  const child = npmCli
    ? spawn(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit', env: process.env })
    : spawn(npmCommand, args, { cwd: root, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });

  children.set(name, child);
  child.on('error', (error) => {
    console.error(`[${name}] Could not start: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[${name}] stopped${signal ? ` (${signal})` : ` with exit code ${code ?? 1}`}. Stopping the other process.`);
    stop(code && code !== 0 ? code : 1);
  });
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) {
    if (!child.killed) child.kill('SIGTERM');
  }
  const forceExit = setTimeout(() => {
    for (const child of children.values()) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    process.exit(exitCode);
  }, 4000);
  forceExit.unref();
  Promise.all([...children.values()].map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
  }))).finally(() => {
    clearTimeout(forceExit);
    process.exit(exitCode);
  });
}

process.once('SIGINT', () => stop(130));
process.once('SIGTERM', () => stop(143));

console.log('Starting Judo API and frontend. Press Ctrl+C to stop both.');
startTask('server', 'language-classroom-server');
startTask('client', 'language-classroom-client');
