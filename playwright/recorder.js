#!/usr/bin/env node
/**
 * 录制入口
 *
 * 用法:
 *   node recorder.js [url]
 *   node recorder.js --headless [url]
 *
 * 在浏览器中操作，按 Ctrl+C 或关闭浏览器时自动保存录制数据到 recordings/ 目录。
 */

const path = require('path');
const fs = require('fs');
const { launchAndConnect, cleanup } = require('./lib/chrome-launcher');
const { CdpRecorder } = require('./lib/cdp-recorder');

const HEADLESS = process.argv.includes('--headless');
const TARGET_URL = process.argv.filter(a => !a.startsWith('--')).slice(2)[0]
  || 'https://www.cityline.com/zh_CN/Events.html';
const RECORDINGS_DIR = path.resolve(__dirname, 'recordings');

(async () => {
  console.log(`[*] 录制模式`);
  console.log(`[*] 目标: ${TARGET_URL}`);

  // 确保 recordings 目录存在
  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }

  // 1. 启动 Chrome + CDP 连接
  const { browser, context, page, chromeProcess } = await launchAndConnect({
    headless: HEADLESS,
  });

  // 2. 创建录制器（传入 context 以支持多标签页监听）
  const recorder = new CdpRecorder(context, page);

  // 3. 导航到目标页面
  console.log('[*] 正在导航...');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`[*] 页面已加载: ${page.url()}`);

  // 4. 开始录制
  await recorder.start();

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  录制中 — 在浏览器中操作                         ║');
  console.log('║  完成后按 Ctrl+C 保存录制数据                    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // 5. 保存逻辑
  let saved = false;
  async function save() {
    if (saved) return;
    saved = true;

    const recording = await recorder.stop();
    if (!recording) return;

    const filename = `session-${Date.now()}.json`;
    const filepath = path.join(RECORDINGS_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(recording, null, 2));
    console.log(`[*] 录制已保存: ${filepath}`);
    console.log(`[*] 回放命令: node replayer.js ${filepath}`);

    await cleanup(browser, chromeProcess);
    process.exit(0);
  }

  // Ctrl+C
  process.on('SIGINT', save);
  process.on('SIGTERM', save);

  // 浏览器关闭
  page.on('close', save);
  chromeProcess.on('exit', save);

  // 保持运行
  await new Promise(() => {});
})();
