#!/usr/bin/env node
/**
 * 回放入口
 *
 * 用法:
 *   node replayer.js <recording-file>                   # 真实网络 + 操作回放
 *   node replayer.js --mock-network <recording-file>    # mock 网络 + 操作回放
 *   node replayer.js --speed 2 <recording-file>         # 2倍速回放
 *   node replayer.js --headless <recording-file>        # 无头模式
 *
 * 回放使用 CDP Input.dispatch* 发送事件，Chrome 保持干净，可通过 Turnstile。
 */

const path = require('path');
const fs = require('fs');
const { launchAndConnect, cleanup } = require('./lib/chrome-launcher');
const { CdpReplayer } = require('./lib/cdp-replayer');

// 解析参数
const args = process.argv.slice(2);
const HEADLESS = args.includes('--headless');
const MOCK_NETWORK = args.includes('--mock-network');

let SPEED = 1;
const speedIdx = args.indexOf('--speed');
if (speedIdx !== -1 && args[speedIdx + 1]) {
  SPEED = parseFloat(args[speedIdx + 1]);
}

// 录制文件路径（最后一个非 -- 参数）
const RECORDING_FILE = args.filter(a => !a.startsWith('--')).pop()
  || (() => {
    // 如果没指定，找最新的录制文件
    const dir = path.resolve(__dirname, 'recordings');
    if (!fs.existsSync(dir)) {
      console.error('[!] 没有找到 recordings 目录');
      process.exit(1);
    }
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();
    if (!files.length) {
      console.error('[!] 没有找到录制文件');
      process.exit(1);
    }
    return path.join(dir, files[0]);
  })();

(async () => {
  // 1. 加载录制数据
  const recordingPath = path.resolve(RECORDING_FILE);
  if (!fs.existsSync(recordingPath)) {
    console.error(`[!] 录制文件不存在: ${recordingPath}`);
    process.exit(1);
  }

  console.log(`[*] 加载录制: ${recordingPath}`);
  const recording = JSON.parse(fs.readFileSync(recordingPath, 'utf-8'));

  console.log(`[*] 元数据: ${recording.metadata.url} @ ${recording.metadata.timestamp}`);
  console.log(`[*] 事件: ${recording.events.length} 个, 网络: ${recording.network.length} 个`);
  console.log(`[*] 模式: ${MOCK_NETWORK ? 'mock 网络' : '真实网络'}, 速度: ${SPEED}x`);

  // 2. 启动 Chrome + CDP 连接
  const { browser, context, page, chromeProcess, cdpSession } = await launchAndConnect({
    headless: HEADLESS,
  });

  // 3. 创建回放器（传入 context 以支持多标签页）
  const replayer = new CdpReplayer(context, cdpSession, page);

  // 4. 可选：设置网络 mock
  if (MOCK_NETWORK && recording.network.length > 0) {
    await replayer.setupNetworkMock(recording.network);
  }

  // 5. 导航到起始页
  const startUrl = recording.metadata.url;
  console.log(`[*] 导航到: ${startUrl}`);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`[*] 页面已加载`);

  // 等一小段时间让页面完全稳定
  await new Promise(r => setTimeout(r, 1000));

  // 6. 过滤掉第一个 navigate 事件（已经手动导航了）
  const events = recording.events.filter((e, i) => {
    if (i === 0 && e.type === 'navigate') return false;
    return true;
  });

  // 7. 开始回放
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  回放中... 按 Ctrl+C 中止                       ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // Ctrl+C 中止
  process.on('SIGINT', async () => {
    replayer.abort();
    console.log('\n[*] 正在中止...');
    await cleanup(browser, chromeProcess);
    process.exit(0);
  });

  await replayer.replay(events, { speed: SPEED });

  // 8. 回放完成后保持浏览器打开（等待当前活跃标签页关闭）
  console.log('');
  console.log('[*] 回放完成，浏览器保持打开');
  console.log('[*] 按 Ctrl+C 退出');

  const activePage = replayer.page;
  await activePage.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await cleanup(browser, chromeProcess);
})();
