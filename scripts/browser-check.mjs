/**
 * Browser acceptance probe.
 *
 * Launches headless Chrome, loads a URL, waits, then reports what a user would actually
 * see: metric values, swarm-canvas ink coverage, the observer status line, and any runtime
 * console errors or page exceptions. Drives Chrome over CDP directly so the repo needs no
 * browser-automation dependency.
 *
 * The field readout includes a coarse occupancy grid, which is how the AGENTS arena claim is
 * checked without a pixel-comparison test: one shared crowd paints most cells across the
 * whole canvas, whereas per-room panels leave regular unpainted gutters between them.
 *
 * Usage: node scripts/browser-check.mjs <url> [waitMs] [viewToClick]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ARG = process.argv[2] ?? 'http://localhost:3000/?demo=1';
const WAIT_MS = Number(process.argv[3] ?? 9000);
/** Optional mode label (AGENTS/SWARM/TIMELINE) to click after the first readout. */
const VIEW_ARG = process.argv[4] ?? null;
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
  const chart = document.querySelector('.chart canvas');
  // Occupancy of the hero canvas over a 10x5 grid: painted share per cell, plus how many
  // cells carry any ink at all. A shared arena fills nearly every cell.
  let occupancy = null;
  if (field) {
    const ctx = field.getContext('2d');
    if (ctx && field.width > 0) {
      const cols = 10;
      const rows = 5;
      const cw = Math.floor(field.width / cols);
      const ch = Math.floor(field.height / rows);
      const cells = [];
      for (let r = 0; r < rows; r++) {
        const line = [];
        for (let c = 0; c < cols; c++) {
          const { data } = ctx.getImageData(c * cw, r * ch, cw, ch);
          let painted = 0;
          let sampled = 0;
          for (let i = 3; i < data.length; i += 4 * 7) {
            sampled++;
            if (data[i] > 8) painted++;
          }
          line.push(+(painted / Math.max(sampled, 1)).toFixed(3));
        }
        cells.push(line);
      }
      const flat = cells.flat();
      occupancy = {
        grid: cells,
        cellsWithInk: flat.filter((v) => v > 0.002).length,
        cellsTotal: flat.length,
        emptyColumns: Array.from({ length: cols }, (_, c) =>
          cells.every((row) => row[c] <= 0.002) ? c : -1,
        ).filter((c) => c >= 0),
      };
    }
  }
  const fieldH = document.querySelector('.field')?.clientHeight ?? 0;
  const chartH = document.querySelector('.chart')?.clientHeight ?? 0;
  return {
    metrics,
    headline: document.querySelector('.headline')?.textContent?.trim() ?? null,
    status: document.querySelector('.status')?.textContent?.trim() ?? null,
    observerStatus: document.querySelector('.observer-status')?.textContent?.trim() ?? null,
    notice: document.querySelector('.notice')?.textContent?.trim() ?? null,
    emptyOverlay: document.querySelector('.field .empty')?.textContent?.trim() ?? null,
    fieldAria: field?.getAttribute('aria-label') ?? null,
    chartAria: chart?.getAttribute('aria-label') ?? null,
    view: [...document.querySelectorAll('.viewswitch button')]
      .map((b) => b.textContent.trim() + (b.dataset.active === 'true' ? '*' : '')),
    legend: [...document.querySelectorAll('.legend-room')].map((n) => n.textContent.trim()),
    roomChips: [...document.querySelectorAll('.rooms button')].map((b) => b.textContent.trim()).slice(0, 12),
    canvasInk: ink,
    fieldOccupancy: occupancy,
    fieldHeight: fieldH,
    chartHeight: chartH,
    // The swarm must stay the hero: its share of the viewport, and the chart's.
    fieldViewportShare: +(fieldH / window.innerHeight).toFixed(3),
    chartViewportShare: +(chartH / window.innerHeight).toFixed(3),
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

  // Optional second readout after switching modes, used for the mode-switch regression pass.
  if (VIEW_ARG) {
    await send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('.viewswitch button')]
        .find((b) => b.textContent.trim().toUpperCase() === ${JSON.stringify(VIEW_ARG.toUpperCase())})?.click()`,
      returnByValue: true,
    });
    await sleep(3500);
    const after = await send('Runtime.evaluate', {
      expression: READOUT,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log(`READOUT_AFTER_${VIEW_ARG.toUpperCase()}`, JSON.stringify(after.result?.result?.value, null, 1));
  }

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
