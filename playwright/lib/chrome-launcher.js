/**
 * Chrome 启动器 — 共享模块
 *
 * 提供干净 Chrome 的启动和 CDP 连接能力，
 * 供 recorder.js / replayer.js / turnstile-bypass-demo.js 复用。
 */

const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const debug = require('./debug');

const DEFAULT_DEBUG_PORT = 19222;
const DEFAULT_USER_DATA_DIR = path.resolve(__dirname, '..', 'chrome-user-data-clean');

/**
 * 启动干净的 Chrome 并通过 CDP 连接 Playwright
 * @param {object} opts
 * @param {boolean}  opts.headless    - 是否无头模式
 * @param {number}   opts.debugPort   - 远程调试端口
 * @param {string}   opts.userDataDir - Chrome 用户数据目录
 * @returns {{ browser, context, page, chromeProcess, cdpSession }}
 */
async function launchAndConnect(opts = {}) {
  const {
    headless = false,
    debugPort = DEFAULT_DEBUG_PORT,
    userDataDir = DEFAULT_USER_DATA_DIR,
  } = opts;

  // 1. 找到系统 Chrome
  const chromePath = findChrome();
  console.log(`[launcher] Chrome: ${chromePath}`);

  // 2. 确保端口空闲
  await ensurePortFree(debugPort);

  // 3. 构建启动参数
  const chromeArgs = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-background-networking',
    // 不加 --enable-automation（关键！）
  ];
  if (headless) {
    chromeArgs.push('--headless=new');
  }

  debug('launcher', 'Chrome 启动参数:', chromeArgs.join(' '));

  // 4. 启动 Chrome
  console.log(`[launcher] 启动 Chrome (${headless ? 'headless' : 'headful'})...`);
  const chromeProcess = spawn(chromePath, chromeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let stderrData = '';
  chromeProcess.stderr.on('data', (data) => {
    stderrData += data.toString();
    debug('launcher', 'Chrome stderr:', data.toString().trim());
  });

  chromeProcess.on('error', (err) => {
    console.error('[launcher] Chrome 启动失败:', err.message);
    process.exit(1);
  });

  // 5. 等待 Chrome 就绪
  const wsEndpoint = await waitForChromeReady(debugPort, 15000);
  console.log(`[launcher] Chrome 就绪: ${wsEndpoint}`);

  // 6. Playwright 通过 CDP 连接
  const browser = await chromium.connectOverCDP(`http://localhost:${debugPort}`);
  console.log('[launcher] Playwright CDP 已连接');

  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();

  debug('launcher', `初始 context pages: ${context.pages().length}`);
  debug('launcher', `初始 page URL: ${page.url()}`);

  // 7. 获取原始 CDP session（用于录制/回放）
  const cdpSession = await context.newCDPSession(page);

  return { browser, context, page, chromeProcess, cdpSession };
}

/** 查找系统安装的 Chrome */
function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    return execSync('where chrome', { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {}
  throw new Error('找不到 Chrome，请手动指定路径');
}

/** 确保端口没被占用 */
function ensurePortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[launcher] 端口 ${port} 被占用，尝试关闭旧进程...`);
        try {
          execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`);
          setTimeout(resolve, 1000);
        } catch {
          reject(new Error(`端口 ${port} 被占用且无法释放`));
        }
      } else {
        reject(err);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve();
    });
    server.listen(port);
  });
}

/** 等待 Chrome 调试端口就绪 */
async function waitForChromeReady(port, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const resp = await fetch(`http://localhost:${port}/json/version`);
      const data = await resp.json();
      debug('launcher', 'Chrome /json/version:', JSON.stringify(data).slice(0, 200));
      return data.webSocketDebuggerUrl || `ws://localhost:${port}`;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Chrome 在 ${timeout}ms 内未就绪`);
}

/**
 * 优雅关闭
 */
async function cleanup(browser, chromeProcess) {
  console.log('[launcher] 正在关闭...');
  await browser.close().catch(() => {});
  chromeProcess.kill();
  console.log('[launcher] 已关闭');
}

module.exports = { launchAndConnect, cleanup };
