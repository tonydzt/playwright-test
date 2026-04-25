/**
 * Cloudflare Turnstile Bypass — connectOverCDP 方案
 *
 * 原理：
 *   Playwright launch/launchPersistentContext 会注入大量自动化痕迹（CDP binding、
 *   __playwright_* 全局变量、Runtime.evaluate 的执行上下文等），Turnstile 能检测到这些。
 *
 *   本方案改用 connectOverCDP：
 *   1. 先用系统命令启动一个 **完全干净的 Chrome**，只开启 remote-debugging-port
 *   2. Playwright 通过 CDP WebSocket 连接，**不注入任何内部代码**
 *   3. Turnstile 看到的是一个 100% 真实的浏览器环境
 *   4. 可以跑 headless（Chrome --headless=new）或 headful
 *
 * 用法:
 *   node turnstile-bypass-demo.js [url]
 *   node turnstile-bypass-demo.js --headless [url]
 */

const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

// ── 配置 ──
const HEADLESS = process.argv.includes('--headless');
const TARGET_URL = process.argv.filter(a => !a.startsWith('--')).slice(2)[0]
  || 'https://www.cityline.com/zh_CN/Events.html';
const DEBUG_PORT = 19222;
const USER_DATA_DIR = path.resolve(__dirname, 'chrome-user-data-clean');

(async () => {
  console.log(`[*] 目标: ${TARGET_URL}`);
  console.log(`[*] 模式: ${HEADLESS ? 'headless' : 'headful'}`);

  // ══════════════════════════════════════════════════
  // 1. 找到系统 Chrome
  // ══════════════════════════════════════════════════
  const chromePath = findChrome();
  console.log(`[*] Chrome 路径: ${chromePath}`);

  // ══════════════════════════════════════════════════
  // 2. 确保调试端口没被占用，然后启动 Chrome
  // ══════════════════════════════════════════════════
  await ensurePortFree(DEBUG_PORT);

  const chromeArgs = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-background-networking',
    // 不加 --enable-automation（关键！）
    // 不加 --disable-blink-features=AutomationControlled（Chrome 原生不需要）
  ];

  if (HEADLESS) {
    chromeArgs.push('--headless=new');
  }

  console.log('[*] 正在启动 Chrome...');
  const chromeProcess = spawn(chromePath, chromeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // 收集 stderr 来获取 DevTools URL
  let stderrData = '';
  chromeProcess.stderr.on('data', (data) => {
    stderrData += data.toString();
  });

  chromeProcess.on('error', (err) => {
    console.error('[!] Chrome 启动失败:', err.message);
    process.exit(1);
  });

  // 等待 Chrome 启动完毕（DevTools listening 或端口可用）
  const wsEndpoint = await waitForChromeReady(DEBUG_PORT, stderrData, 15000);
  console.log(`[*] Chrome 已就绪: ${wsEndpoint}`);

  // ══════════════════════════════════════════════════
  // 3. 用 Playwright connectOverCDP 连接（零注入）
  // ══════════════════════════════════════════════════
  const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
  console.log('[*] Playwright 已通过 CDP 连接');

  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();

  // ══════════════════════════════════════════════════
  // 4. 导航到目标页面
  // ══════════════════════════════════════════════════
  console.log('[*] 正在导航...');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('[*] 页面已加载:', page.url());

  // ══════════════════════════════════════════════════
  // 5. 验证指纹是否干净
  // ══════════════════════════════════════════════════
  const fingerprint = await page.evaluate(() => ({
    webdriver: navigator.webdriver,
    languages: navigator.languages,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    hasChrome: !!window.chrome,
    hasChromeRuntime: !!window.chrome?.runtime,
    hasChromeLoadTimes: typeof window.chrome?.loadTimes === 'function',
    hasChromeCSI: typeof window.chrome?.csi === 'function',
  }));
  console.log('[*] 浏览器指纹:', JSON.stringify(fingerprint, null, 2));

  if (fingerprint.webdriver === true) {
    console.warn('[!] 警告: navigator.webdriver 为 true，Turnstile 会失败！');
  } else {
    console.log('[*] navigator.webdriver =', fingerprint.webdriver, '(干净)');
  }

  // ══════════════════════════════════════════════════
  // 6. 监听 Turnstile iframe（弹窗场景）
  // ══════════════════════════════════════════════════
  console.log('[*] 开始监听 Turnstile...');

  page.on('frameattached', (frame) => {
    console.log(`[frame] 新 frame: ${frame.url() || '(等待导航)'}`);
  });

  page.on('framenavigated', (frame) => {
    const url = frame.url();
    if (url.includes('challenges.cloudflare.com')) {
      console.log(`[!] Turnstile iframe 已加载: ${url}`);
      if (url.includes('failure')) {
        console.log('[!] URL 包含 failure — 指纹仍被检测到');
      }
    }
  });

  // 后台轮询 Turnstile 状态
  monitorTurnstile(page);

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  浏览器已就绪，请在浏览器中操作：                 ║');
  console.log('║  1. 选择演出/场次                                ║');
  console.log('║  2. 点击"继续"按钮触发 Turnstile 弹窗           ║');
  console.log('║  脚本会自动监控 Turnstile 状态                    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // 保持运行直到用户关闭
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});

  // 清理
  console.log('[*] 正在关闭...');
  await browser.close().catch(() => {});
  chromeProcess.kill();
  console.log('[*] 完成');
})();

// ═══════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════

/** 查找系统安装的 Chrome */
function findChrome() {
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Windows: 尝试 where
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
        console.log(`[*] 端口 ${port} 被占用，尝试关闭旧进程...`);
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
async function waitForChromeReady(port, stderrRef, timeout) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const resp = await fetch(`http://localhost:${port}/json/version`);
      const data = await resp.json();
      return data.webSocketDebuggerUrl || `ws://localhost:${port}`;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  throw new Error(`Chrome 在 ${timeout}ms 内未就绪`);
}

/** 持续监控 Turnstile 状态 */
function monitorTurnstile(page) {
  let lastToken = '';
  let checkCount = 0;

  const check = async () => {
    try {
      checkCount++;

      // 扫描 Turnstile iframe
      for (const frame of page.frames()) {
        if (!frame.url().includes('challenges.cloudflare.com')) continue;

        const state = await frame.evaluate(() => {
          return {
            bodyClasses: document.body?.className || '',
            bodyText: document.body?.innerText?.slice(0, 300) || '',
            iframeCount: document.querySelectorAll('iframe').length,
            inputCount: document.querySelectorAll('input').length,
            hasCheckbox: !!document.querySelector('input[type="checkbox"]'),
          };
        }).catch(() => null);

        if (state && checkCount % 5 === 0) {
          console.log('[monitor] Turnstile iframe:', JSON.stringify(state));
        }
      }

      // 检查是否已拿到 token
      const token = await page.evaluate(() => {
        for (const sel of [
          'input[name="cf-turnstile-response"]',
          'textarea[name="cf-turnstile-response"]',
          '[name="g-recaptcha-response"]',
        ]) {
          const el = document.querySelector(sel);
          if (el?.value?.length > 10) return el.value;
        }
        for (const el of document.querySelectorAll('[data-turnstile-token]')) {
          const t = el.getAttribute('data-turnstile-token');
          if (t?.length > 10) return t;
        }
        return null;
      }).catch(() => null);

      if (token && token !== lastToken) {
        lastToken = token;
        console.log('');
        console.log('='.repeat(50));
        console.log('  Turnstile 验证通过!');
        console.log(`  Token: ${token.slice(0, 50)}...`);
        console.log('='.repeat(50));
        console.log('');
      }
    } catch {
      // 页面导航中，忽略
    }
  };

  const interval = setInterval(check, 1000);
  page.on('close', () => clearInterval(interval));
}
