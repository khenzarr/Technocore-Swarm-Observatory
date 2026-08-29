/**
 * Browser acceptance probe.
 *
 * Launches headless Chrome, loads a URL, waits, then reports what a user would actually
 * see: metric values, swarm-canvas ink coverage, the observer status line, and any runtime
 * console errors or page exceptions. Drives Chrome over CDP directly so the repo needs no
 * browser-automation dependency.
 *
 * Usage: node scripts/browser-check.mjs <url> [waitMs]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ARG = process.argv[2] ?? 'http://localhost:3000/?demo=1';
const WAIT_MS = Number(process.argv[3] ?? 9000);
const PORT = 9333 + Math.floor(Math.random() * 200);

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

/** Runs inside the page. Reports only what a user could actually see. */
const READOUT = `(() => {
  const metrics = {};
  for (const el of document.querySelectorAll('.metric')) {
    const label = el.querySelector('small')?.textContent ?? '?';
    metrics[label] = el.querySelector('b')?.textContent ?? '?';
  }
  const ink = [...document.querySelectorAll('canvas')].map((c) => {
    const ctx = c.getContext('2d');
    if (!ctx || c.width === 0) return { w: c.width, h: c.height, inkRatio: 0 };
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const stride = 4 * 13;
    let painted = 0;
    let sampled = 0;
    for (let i = 3; i < data.length; i += stride) {
      sampled++;
      if (data[i] > 8) painted++;
    }
    return { w: c.width, h: c.height, inkRatio: +(painted / Math.max(sampled, 1)).toFixed(4) };
  });
  const field = document.querySelector('.field canvas');
  return {
    metrics,
    status: document.querySelector('.status')?.textContent?.trim() ?? null,
    observerStatus: document.querySelector('.observer-status')?.textContent?.trim() ?? null,
    notice: document.querySelector('.notice')?.textContent?.trim() ?? null,
    emptyOverlay: document.querySelector('.field .empty')?.textContent?.trim() ?? null,
    fieldAria: field?.getAttribute('aria-label') ?? null,
    roomChips: [...document.querySelectorAll('.rooms button')].map((b) => b.textContent.trim()).slice(0, 12),
    canvasInk: ink,
    fieldHeight: document.querySelector('.field')?.clientHeight ?? null,
  };
})()`;

const binary = CHROME_CANDIDATES.find((path) => existsSync(path));
if (!binary) {
  console.log('BROWSER_CHECK=NO_BROWSER_FOUND');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'tc-obs-'));
const chrome = spawn(
  binary,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1920,1080',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const issues = [];
let socket;

try {
  const target = await waitForTarget();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('cdp socket failed'));
  });

  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      const text = msg.params.args
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ');
      issues.push(`${msg.params.type}: ${text}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails;
      issues.push(`exception: ${details.exception?.description ?? details.text}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL_ARG });
  await sleep(WAIT_MS);

  const response = await send('Runtime.evaluate', {
    expression: READOUT,
    returnByValue: true,
    awaitPromise: true,
  });

  console.log('URL', URL_ARG);
  if (response.result?.exceptionDetails) {
    console.log('READOUT_FAILED', JSON.stringify(response.result.exceptionDetails).slice(0, 500));
  }
  console.log('READOUT', JSON.stringify(response.result?.result?.value, null, 1));
  console.log('CONSOLE_ISSUES', issues.length);
  for (const line of issues.slice(0, 12)) console.log('  -', line.slice(0, 400));
} catch (error) {
  console.log('BROWSER_CHECK_ERROR', error.message);
} finally {
  socket?.close();
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* profile cleanup is best effort */
  }
}

async function waitForTarget() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* chrome is still starting */
    }
    await sleep(250);
  }
  throw new Error('chrome devtools endpoint never became available');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
