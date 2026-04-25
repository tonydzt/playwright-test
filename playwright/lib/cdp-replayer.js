/**
 * CDP 回放模块
 *
 * 通过 Chrome DevTools Protocol 回放录制的用户操作：
 *   - Input.dispatchMouseEvent: 鼠标事件
 *   - Input.dispatchKeyEvent: 键盘事件
 *   - Runtime.evaluate: 滚动
 *   - Playwright route(): 网络 mock（可选）
 *   - 多标签页支持：tab_open / tab_switch / tab_close
 */

/** CDP 鼠标按钮映射 */
const BUTTON_MAP = { 0: 'left', 1: 'middle', 2: 'right' };

/** key -> CDP keyCode 映射（常用键） */
const KEY_CODE_MAP = {
  'Backspace': 8, 'Tab': 9, 'Enter': 13, 'Shift': 16, 'Control': 17,
  'Alt': 18, 'Escape': 27, 'Space': 32, ' ': 32, 'ArrowLeft': 37,
  'ArrowUp': 38, 'ArrowRight': 39, 'ArrowDown': 40, 'Delete': 46,
};

class CdpReplayer {
  /**
   * @param {object} context    - Playwright BrowserContext
   * @param {object} cdpSession - 初始页的 CDP session
   * @param {object} page       - 初始页
   */
  constructor(context, cdpSession, page) {
    this.context = context;
    this._aborted = false;

    // 多标签页管理
    this.pages = [page];
    this.cdpSessions = [cdpSession];
    this.activePageIndex = 0;

    // 预缓存：监听 context 级别的 page 事件，
    // 将新出现的 page 存入队列，供 tab_open 消费
    this._pendingPages = [];
    this._pageWaiters = [];
    this.context.on('page', (newPage) => {
      console.log(`[replayer] 检测到新标签页出现: ${newPage.url() || '(loading)'}`);
      if (this._pageWaiters.length > 0) {
        // 有等待者，直接交付
        const resolve = this._pageWaiters.shift();
        resolve(newPage);
      } else {
        // 缓存起来
        this._pendingPages.push(newPage);
      }
    });
  }

  /**
   * 等待下一个新标签页（消费缓存或等待新事件）
   */
  _waitForNewPage(timeout = 30000) {
    if (this._pendingPages.length > 0) {
      return Promise.resolve(this._pendingPages.shift());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 移除等待者
        const idx = this._pageWaiters.indexOf(resolve);
        if (idx !== -1) this._pageWaiters.splice(idx, 1);
        reject(new Error(`等待新标签页超时 (${timeout}ms)`));
      }, timeout);
      this._pageWaiters.push((page) => {
        clearTimeout(timer);
        resolve(page);
      });
    });
  }

  /** 当前活跃的 CDP session */
  get cdp() {
    return this.cdpSessions[this.activePageIndex];
  }

  /** 当前活跃的 page */
  get page() {
    return this.pages[this.activePageIndex];
  }

  /**
   * 设置网络 mock（离线回放模式）
   * 对 context 级别设置 route，这样所有标签页都会被 mock
   * @param {Array} networkLog - 录制的网络数据
   */
  async setupNetworkMock(networkLog) {
    console.log(`[replayer] 设置网络 mock: ${networkLog.length} 个请求`);

    const requestMap = new Map();
    for (const entry of networkLog) {
      const key = `${entry.method}:${entry.url}`;
      if (!requestMap.has(key)) requestMap.set(key, []);
      requestMap.get(key).push(entry);
    }

    await this.context.route('**/*', (route) => {
      const req = route.request();
      const key = `${req.method()}:${req.url()}`;
      const queue = requestMap.get(key);

      if (queue && queue.length > 0) {
        const entry = queue.shift();
        const resp = entry.response;

        if (!resp || resp.body === null) {
          route.continue();
          return;
        }

        const body = resp.base64Encoded
          ? Buffer.from(resp.body, 'base64')
          : Buffer.from(resp.body, 'utf-8');

        const headers = {};
        for (const [k, v] of Object.entries(resp.headers || {})) {
          const lower = k.toLowerCase();
          if (['content-encoding', 'content-length', 'transfer-encoding'].includes(lower)) continue;
          headers[k] = v;
        }

        route.fulfill({ status: resp.status, headers, body });
      } else {
        route.continue();
      }
    });

    console.log('[replayer] 网络 mock 已就绪（context 级别，覆盖所有标签页）');
  }

  /**
   * 回放事件序列
   * @param {Array} events - 录制的事件数组
   * @param {object} opts
   * @param {number} opts.speed - 回放速度倍率（默认 1）
   */
  async replay(events, opts = {}) {
    const { speed = 1 } = opts;

    if (!events.length) {
      console.log('[replayer] 没有事件需要回放');
      return;
    }

    console.log(`[replayer] 开始回放 ${events.length} 个事件 (${speed}x 速度)`);

    let lastTs = 0;

    for (let i = 0; i < events.length; i++) {
      if (this._aborted) {
        console.log('[replayer] 回放已中止');
        return;
      }

      const event = events[i];

      // 按时间差等待
      const delay = (event.ts - lastTs) / speed;
      if (delay > 0) {
        await sleep(delay);
      }
      lastTs = event.ts;

      try {
        await this._dispatchEvent(event, i, events);
      } catch (err) {
        console.warn(`[replayer] 事件 #${i} (${event.type}) 失败:`, err.message);
      }

      // 进度
      if ((i + 1) % 10 === 0 || i === events.length - 1) {
        process.stdout.write(`\r[replayer] 进度: ${i + 1}/${events.length}`);
      }
    }

    console.log('\n[replayer] 回放完成');
  }

  abort() {
    this._aborted = true;
  }

  /**
   * 检查接下来是否紧跟 tab_open 事件（用于决定是否需要等待新标签页）
   */
  _nextEventIsTabOpen(currentIndex, events) {
    for (let j = currentIndex + 1; j < events.length; j++) {
      const next = events[j];
      // 跳过同一时间戳的 click 事件（mousedown/mouseup/click 是一组）
      if (next.type === 'mouseup' || next.type === 'click') continue;
      return next.type === 'tab_open';
    }
    return false;
  }

  /**
   * 分发单个事件到 CDP
   */
  async _dispatchEvent(event, index, events) {
    switch (event.type) {
      case 'tab_open': {
        const pageIndex = event.pageIndex;
        console.log(`\n[replayer] 等待新标签页 #${pageIndex} 打开...`);

        // 使用预缓存的新标签页监听，避免竞态条件
        const newPage = await this._waitForNewPage(30000);
        await newPage.waitForLoadState('domcontentloaded').catch(() => {});

        this.pages[pageIndex] = newPage;

        // 为新标签页创建 CDP session
        const newCdp = await this.context.newCDPSession(newPage);
        this.cdpSessions[pageIndex] = newCdp;

        console.log(`[replayer] 新标签页 #${pageIndex} 已就绪: ${newPage.url()}`);
        break;
      }

      case 'tab_switch': {
        const targetIndex = event.pageIndex;
        if (this.pages[targetIndex] && !this.pages[targetIndex].isClosed()) {
          this.activePageIndex = targetIndex;
          await this.pages[targetIndex].bringToFront();
          console.log(`\n[replayer] 切换到标签页 #${targetIndex}`);
        } else {
          console.warn(`\n[replayer] 标签页 #${targetIndex} 不存在或已关闭，跳过切换`);
        }
        break;
      }

      case 'tab_close': {
        const targetIndex = event.pageIndex;
        if (this.pages[targetIndex] && !this.pages[targetIndex].isClosed()) {
          console.log(`\n[replayer] 关闭标签页 #${targetIndex}`);
          await this.pages[targetIndex].close();
        }
        break;
      }

      case 'navigate': {
        const url = event.url;
        // 跳过 chrome-error:// 等无效导航
        if (url.startsWith('chrome-error://') || url === 'about:blank') {
          console.log(`\n[replayer] [tab#${event.pageIndex ?? 0}] 跳过无效导航: ${url}`);
          break;
        }
        console.log(`\n[replayer] [tab#${event.pageIndex ?? 0}] 导航: ${url}`);
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        break;
      }

      case 'mousedown':
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: event.x,
          y: event.y,
          button: BUTTON_MAP[event.button] || 'left',
          clickCount: 1,
        });
        break;

      case 'mouseup':
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: event.x,
          y: event.y,
          button: BUTTON_MAP[event.button] || 'left',
          clickCount: 1,
        });
        break;

      case 'click':
        // mousedown + mouseup 已覆盖点击。这里发 mouseMoved 定位。
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: event.x,
          y: event.y,
        });
        break;

      case 'dblclick':
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: event.x,
          y: event.y,
          button: BUTTON_MAP[event.button] || 'left',
          clickCount: 2,
        });
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: event.x,
          y: event.y,
          button: BUTTON_MAP[event.button] || 'left',
          clickCount: 2,
        });
        break;

      case 'keydown':
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: event.key,
          code: event.code,
          modifiers: event.modifiers || 0,
          windowsVirtualKeyCode: getKeyCode(event),
          nativeVirtualKeyCode: getKeyCode(event),
          text: event.key.length === 1 ? event.key : '',
        });
        if (event.key.length === 1) {
          await this.cdp.send('Input.dispatchKeyEvent', {
            type: 'char',
            key: event.key,
            code: event.code,
            modifiers: event.modifiers || 0,
            text: event.key,
          });
        }
        break;

      case 'keyup':
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: event.key,
          code: event.code,
          modifiers: event.modifiers || 0,
          windowsVirtualKeyCode: getKeyCode(event),
          nativeVirtualKeyCode: getKeyCode(event),
        });
        break;

      case 'scroll':
        await this.cdp.send('Runtime.evaluate', {
          expression: `window.scrollTo(${event.x}, ${event.y})`,
        });
        break;

      case 'input':
        break;

      default:
        break;
    }
  }
}

function getKeyCode(event) {
  if (KEY_CODE_MAP[event.key]) return KEY_CODE_MAP[event.key];
  if (event.key.length === 1) return event.key.toUpperCase().charCodeAt(0);
  return 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { CdpReplayer };
