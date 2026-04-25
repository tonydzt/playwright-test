# 录制 / 回放工具

基于 CDP（Chrome DevTools Protocol）的页面操作录制与回放工具。
Chrome 保持 100% 干净，Turnstile 等反自动化检测无法感知。

## 原理

```
录制：Chrome(干净) → CDP连接 → Network domain 录制请求 + 页面注入极简事件监听 → 保存 JSON
回放：Chrome(干净) → CDP连接 → Input.dispatch* 回放操作 + 可选 route() mock 网络
```

- 通过 `connectOverCDP` 连接系统 Chrome，不注入 Playwright 内部代码
- 用户交互通过 `addEventListener` 监听（标准 DOM API，非自动化特征）
- 回放通过 CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`，比 `page.click()` 更底层
- 支持多标签页录制和回放

## 使用

### 录制

```bash
node recorder.js                                     # 默认打开 cityline
node recorder.js https://example.com                 # 指定 URL
node recorder.js --headless https://example.com      # 无头模式
```

在浏览器中正常操作（点击、输入、滚动、打开新标签页等），完成后按 **Ctrl+C** 保存。

录制数据保存到 `recordings/session-<timestamp>.json`。

### 回放

```bash
node replayer.js recordings/session-xxx.json         # 真实网络，操作回放
node replayer.js --mock-network session-xxx.json     # mock 网络，离线回放
node replayer.js --speed 2 session-xxx.json          # 2 倍速
node replayer.js --speed 0.5 session-xxx.json        # 0.5 倍速（慢放）
node replayer.js --headless session-xxx.json         # 无头模式
node replayer.js                                     # 自动使用最新的录制文件
```

### npm scripts

```bash
npm run record                # 等同于 node recorder.js
npm run replay                # 等同于 node replayer.js
```

## 回放模式说明

| 参数 | 网络 | 用户操作 | 适用场景 |
|------|------|----------|----------|
| （默认） | 真实网络请求 | CDP 回放 | 实际操作自动化，需过 Turnstile |
| `--mock-network` | 录制数据 mock | CDP 回放 | 离线测试、调试流程 |

## 录制数据格式

```json
{
  "metadata": {
    "url": "起始页 URL",
    "timestamp": "录制时间",
    "viewport": { "width": 1280, "height": 720 },
    "duration": 30000,
    "pageCount": 2
  },
  "events": [
    { "ts": 0, "type": "navigate", "url": "...", "pageIndex": 0 },
    { "ts": 500, "type": "click", "x": 100, "y": 200, "button": 0, "pageIndex": 0 },
    { "ts": 1200, "type": "tab_open", "pageIndex": 1, "url": "..." },
    { "ts": 1200, "type": "tab_switch", "pageIndex": 1 },
    { "ts": 1800, "type": "keydown", "key": "a", "code": "KeyA", "pageIndex": 1 },
    { "ts": 3000, "type": "scroll", "x": 0, "y": 500, "pageIndex": 1 }
  ],
  "network": [
    {
      "requestId": "1", "url": "...", "method": "GET",
      "headers": {}, "pageIndex": 0,
      "response": { "status": 200, "headers": {}, "body": "...", "base64Encoded": false }
    }
  ]
}
```

### 事件类型

| 类型 | 说明 |
|------|------|
| `navigate` | 页面导航 |
| `click` / `dblclick` | 鼠标点击 |
| `mousedown` / `mouseup` | 鼠标按下/释放 |
| `keydown` / `keyup` | 键盘按下/释放 |
| `input` | 输入框值变化 |
| `scroll` | 页面滚动 |
| `tab_open` | 新标签页打开 |
| `tab_switch` | 标签页焦点切换 |
| `tab_close` | 标签页关闭 |

## 文件结构

```
playwright/
  recorder.js              # 录制入口
  replayer.js              # 回放入口
  lib/
    chrome-launcher.js     # 共享：干净 Chrome 启动 + CDP 连接
    cdp-recorder.js        # CDP 录制逻辑（多标签页）
    cdp-replayer.js        # CDP 回放逻辑（多标签页）
  recordings/              # 录制数据
```
