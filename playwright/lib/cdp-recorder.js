/**
 * CDP 录制模块
 *
 * 通过 Chrome DevTools Protocol 录制：
 *   - 网络请求/响应（含 body）
 *   - 用户交互事件（鼠标、键盘、滚动）
 *   - 页面导航
 *   - 新标签页的打开和切换
 *
 * 支持多标签页：每个事件带 pageIndex 标识所属标签页，
 * 新标签页打开时自动创建 CDP session 并注入监听。
 */

/**
 * 注入到页面中的事件监听脚本（极简，仅监听 + 回传）
 */
const INJECTED_SCRIPT = `
(function() {
  if (window.__cdpRecorderInit) return;
  window.__cdpRecorderInit = true;

  function send(data) {
    try { window.__cdpRecorder(JSON.stringify(data)); } catch {}
  }

  // 鼠标事件
  document.addEventListener('mousedown', function(e) {
    send({ type: 'mousedown', x: e.clientX, y: e.clientY, button: e.button, ts: Date.now() });
  }, true);
  document.addEventListener('mouseup', function(e) {
    send({ type: 'mouseup', x: e.clientX, y: e.clientY, button: e.button, ts: Date.now() });
  }, true);
  document.addEventListener('click', function(e) {
    send({ type: 'click', x: e.clientX, y: e.clientY, button: e.button, ts: Date.now() });
  }, true);
  document.addEventListener('dblclick', function(e) {
    send({ type: 'dblclick', x: e.clientX, y: e.clientY, button: e.button, ts: Date.now() });
  }, true);

  // 键盘事件
  document.addEventListener('keydown', function(e) {
    send({
      type: 'keydown', key: e.key, code: e.code,
      modifiers: (e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0),
      ts: Date.now()
    });
  }, true);
  document.addEventListener('keyup', function(e) {
    send({
      type: 'keyup', key: e.key, code: e.code,
      modifiers: (e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0),
      ts: Date.now()
    });
  }, true);

  // 输入事件（捕获文本输入）
  document.addEventListener('input', function(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      var sel = '';
      if (e.target.id) sel = '#' + e.target.id;
      else if (e.target.name) sel = '[name="' + e.target.name + '"]';
      else sel = e.target.tagName.toLowerCase();
      send({ type: 'input', selector: sel, value: e.target.value, ts: Date.now() });
    }
  }, true);

  // 滚动事件（节流）
  var lastScroll = 0;
  window.addEventListener('scroll', function() {
    var now = Date.now();
    if (now - lastScroll < 100) return;
    lastScroll = now;
    send({ type: 'scroll', x: window.scrollX, y: window.scrollY, ts: now });
  }, true);
})();
`;

class CdpRecorder {
  /**
   * @param {object} context - Playwright BrowserContext（用于监听新标签页）
   * @param {object} page    - 初始 page
   */
  constructor(context, page) {
    this.context = context;
    this.events = [];
    this.networkRequests = new Map(); // requestId -> partial data
    this.networkLog = [];
    this.startTime = null;
    this._disposed = false;

    // 多标签页管理: pages[0] = 初始页, pages[1] = 第一个新标签页, ...
    this.pages = [page];
    this.cdpSessions = [];  // 与 pages 一一对应
    this.activePageIndex = 0;
  }

  /**
   * 开始录制
   */
  async start() {
    this.startTime = Date.now();
    console.log('[recorder] 开始录制...');

    // 为初始页设置 CDP 监听
    await this._setupPageRecording(this.pages[0], 0);

    // 监听新标签页打开
    this.context.on('page', async (newPage) => {
      const pageIndex = this.pages.length;
      this.pages.push(newPage);
      console.log(`[recorder] 新标签页 #${pageIndex} 已检测到`);

      // 立即（不等 load）为新页面设置 CDP 监听
      // 必须在 waitForLoadState 之前设置，否则会错过初始页面的事件
      try {
        await this._setupPageRecording(newPage, pageIndex);
        console.log(`[recorder] 新标签页 #${pageIndex} CDP 监听已就绪`);
      } catch (err) {
        console.error(`[recorder] 新标签页 #${pageIndex} CDP 设置失败:`, err.message);
      }

      // 等新页面完成初始导航（用于获取 URL）
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});

      const url = newPage.url();
      console.log(`[recorder] 新标签页 #${pageIndex} URL: ${url}`);

      // 录制 tab_open 事件
      this.events.push({
        type: 'tab_open',
        pageIndex,
        url,
        ts: Date.now() - this.startTime,
      });

      // 录制焦点切换
      this.activePageIndex = pageIndex;
      this.events.push({
        type: 'tab_switch',
        pageIndex,
        ts: Date.now() - this.startTime,
      });

      // 监听新标签页关闭
      newPage.on('close', () => {
        console.log(`[recorder] 标签页 #${pageIndex} 已关闭`);
        this.events.push({
          type: 'tab_close',
          pageIndex,
          ts: Date.now() - this.startTime,
        });
        // 切回最后一个还存活的标签页
        for (let i = this.pages.length - 1; i >= 0; i--) {
          if (this.pages[i] && !this.pages[i].isClosed()) {
            this.activePageIndex = i;
            this.events.push({
              type: 'tab_switch',
              pageIndex: i,
              ts: Date.now() - this.startTime,
            });
            break;
          }
        }
      });
    });

    console.log('[recorder] 录制中... 在浏览器中操作，完成后按 Ctrl+C 保存');
  }

  /**
   * 为一个 page 设置完整的 CDP 录制（binding + 注入 + network + 导航）
   */
  async _setupPageRecording(page, pageIndex) {
    const cdpSession = await this.context.newCDPSession(page);
    this.cdpSessions[pageIndex] = cdpSession;

    // 1. 启用 Page domain（必须在 addScriptToEvaluateOnNewDocument 之前）
    await cdpSession.send('Page.enable');

    // 2. 启用 Runtime domain
    await cdpSession.send('Runtime.enable');

    // 3. 注册 binding（在 Runtime.enable 之后）
    await cdpSession.send('Runtime.addBinding', { name: '__cdpRecorder' });

    // 4. 注入事件监听脚本（对后续文档导航也生效）
    await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
      source: INJECTED_SCRIPT,
    });

    // 5. 在当前页面也立即执行一次
    //    新标签页此时可能还在 about:blank 或初始 URL 加载中，
    //    通过 Page.addScriptToEvaluateOnNewDocument 确保后续导航也会注入。
    //    这里的 evaluate 是为了覆盖当前已加载的文档。
    await cdpSession.send('Runtime.evaluate', {
      expression: INJECTED_SCRIPT,
    }).catch((err) => {
      console.log(`[recorder] [tab#${pageIndex}] 初始注入跳过 (${err.message})`);
    });

    // 6. 监听 execution context 创建，每次新的 context 都重新注入
    //    这是关键：SPA 导航、iframe、页面刷新都会创建新的 execution context
    cdpSession.on('Runtime.executionContextCreated', async (params) => {
      // 只处理主 frame 的 context（auxData.isDefault === true）
      if (!params.context.auxData?.isDefault) return;

      console.log(`[recorder] [tab#${pageIndex}] 新执行上下文 #${params.context.id}, 重新注入监听`);
      try {
        await cdpSession.send('Runtime.evaluate', {
          expression: INJECTED_SCRIPT,
          contextId: params.context.id,
        });
      } catch (err) {
        // context 可能已经被销毁
        console.log(`[recorder] [tab#${pageIndex}] 重新注入失败: ${err.message}`);
      }
    });

    // 7. 监听 binding 回调（带 pageIndex）
    cdpSession.on('Runtime.bindingCalled', (params) => {
      if (params.name !== '__cdpRecorder') return;
      try {
        const event = JSON.parse(params.payload);
        event.ts = event.ts - this.startTime;
        event.pageIndex = pageIndex;

        // 如果事件来自非当前活跃页，先插入一个 tab_switch
        if (pageIndex !== this.activePageIndex) {
          this.activePageIndex = pageIndex;
          this.events.push({
            type: 'tab_switch',
            pageIndex,
            ts: event.ts,
          });
        }

        this.events.push(event);

        if (event.type === 'click') {
          console.log(`[recorder] [tab#${pageIndex}] click (${event.x}, ${event.y})`);
        } else if (event.type === 'keydown' && event.key.length === 1) {
          process.stdout.write(`[recorder] [tab#${pageIndex}] "${event.key}" `);
        }
      } catch {}
    });

    // 8. 启用 Network domain
    await cdpSession.send('Network.enable', {
      maxResourceBufferSize: 10 * 1024 * 1024,
      maxTotalBufferSize: 50 * 1024 * 1024,
    });

    cdpSession.on('Network.requestWillBeSent', (params) => {
      this.networkRequests.set(params.requestId, {
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        headers: params.request.headers,
        postData: params.request.postData || null,
        resourceType: params.type,
        pageIndex,
        ts: Date.now() - this.startTime,
      });
    });

    cdpSession.on('Network.responseReceived', (params) => {
      const req = this.networkRequests.get(params.requestId);
      if (req) {
        req.response = {
          status: params.response.status,
          statusText: params.response.statusText,
          headers: params.response.headers,
          mimeType: params.response.mimeType,
        };
      }
    });

    cdpSession.on('Network.loadingFinished', async (params) => {
      const req = this.networkRequests.get(params.requestId);
      if (!req || !req.response) return;
      try {
        const { body, base64Encoded } = await cdpSession.send('Network.getResponseBody', {
          requestId: params.requestId,
        });
        req.response.body = body;
        req.response.base64Encoded = base64Encoded;
      } catch {
        req.response.body = null;
        req.response.base64Encoded = false;
      }
      this.networkLog.push(req);
      this.networkRequests.delete(params.requestId);
    });

    // 9. 导航事件
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.events.push({
          type: 'navigate',
          url: frame.url(),
          pageIndex,
          ts: Date.now() - this.startTime,
        });
        console.log(`[recorder] [tab#${pageIndex}] 导航: ${frame.url()}`);
      }
    });

    console.log(`[recorder] [tab#${pageIndex}] CDP 录制已设置 (Page.enable + Runtime.enable + binding + script + Network)`);
  }

  /**
   * 停止录制，返回完整的录制数据
   */
  async stop() {
    if (this._disposed) return null;
    this._disposed = true;

    console.log('\n[recorder] 停止录制');

    // 从第一个还活着的页面获取视口
    let viewport = { width: 1280, height: 720 };
    for (const p of this.pages) {
      if (p && !p.isClosed()) {
        try {
          const cdp = this.cdpSessions[this.pages.indexOf(p)];
          const r = await cdp.send('Runtime.evaluate', {
            expression: 'JSON.stringify({ width: window.innerWidth, height: window.innerHeight })',
            returnByValue: true,
          });
          viewport = JSON.parse(r.result.value);
        } catch {}
        break;
      }
    }

    const recording = {
      metadata: {
        url: this.pages[0].url(),
        timestamp: new Date().toISOString(),
        viewport,
        duration: Date.now() - this.startTime,
        pageCount: this.pages.length,
      },
      events: this.events,
      network: this.networkLog,
    };

    console.log(`[recorder] 录制完成: ${this.events.length} 个事件, ${this.networkLog.length} 个网络请求, ${this.pages.length} 个标签页`);
    return recording;
  }
}

module.exports = { CdpRecorder };
