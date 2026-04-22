const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const baseDir = __dirname;
const resultsDir = path.join(baseDir, 'results');
const probeScript = path.join(baseDir, 'probe_once.js');
const reportPath = path.join(baseDir, 'report.html');
const manualBaselinePath = path.join(resultsDir, 'manual-headful-merged.json');
const generatedResultFiles = [
  'no-stealth.json',
  'stealth-run-1.json',
  'stealth-run-2.json',
  'stealth-headful-run-1.json',
  'stealth-recommended-headless-run-1.json',
  'stealth-recommended-headful-run-1.json',
  'recommended-headless-recipe.json',
  'recommended-headful-recipe.json'
];

function runProbe(args) {
  return execFileSync(process.execPath, [probeScript, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function valueEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function formatValue(v) {
  if (typeof v === 'undefined') {
    return 'undefined';
  }
  return JSON.stringify(v);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderBooleanIcon(ok, okText, noText) {
  if (ok) {
    return `<span class="bool ok" title="${escapeHtml(okText)}"><span class="icon">&#10003;</span>${escapeHtml(okText)}</span>`;
  }
  return `<span class="bool no" title="${escapeHtml(noText)}"><span class="icon">&#10007;</span>${escapeHtml(noText)}</span>`;
}

function renderDiffIcon(isDifferent) {
  if (isDifferent) {
    return `<span class="bool no" title="有差异"><span class="icon">&#10007;</span>有差异</span>`;
  }
  return `<span class="bool ok" title="无差异"><span class="icon">&#10003;</span>无差异</span>`;
}

function renderHtmlTable(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.configItem)) {
      grouped.set(row.configItem, []);
    }
    grouped.get(row.configItem).push(row);
  }

  const trs = [];
  for (const [configItem, list] of grouped.entries()) {
    list.forEach((r, idx) => {
      const configCell = idx === 0
        ? `<td rowspan="${list.length}" class="config-cell"><code>${escapeHtml(configItem)}</code></td>`
        : '';
      trs.push(
        `<tr>${configCell}<td><code>${escapeHtml(r.item)}</code></td><td><pre class="value-block">${escapeHtml(r.baseline)}</pre></td><td><pre class="value-block">${escapeHtml(r.stealth)}</pre></td><td><pre class="value-block">${escapeHtml(r.headfulStealth)}</pre></td><td><pre class="value-block">${escapeHtml(r.recommendedHeadless)}</pre></td><td><pre class="value-block">${escapeHtml(r.recommendedHeadful)}</pre></td><td><pre class="value-block">${escapeHtml(r.manualRef)}</pre></td><td><pre class="value-block">${escapeHtml(r.configValue)}</pre></td><td>${renderBooleanIcon(r.effectChanged, '生效', '未生效')}</td><td>${renderBooleanIcon(r.isFixed, '固定', '随机')}</td><td>${renderDiffIcon(r.headfulDiff)}</td><td>${renderDiffIcon(r.manualDiff)}</td><td>${renderDiffIcon(r.recommendedHeadlessManualDiff)}</td><td>${renderDiffIcon(r.recommendedHeadfulManualDiff)}</td></tr>`
      );
    });
  }

  return `
  <table>
    <thead>
      <tr>
        <th>对应配置项</th>
        <th>观测项</th>
        <th>no-stealth</th>
        <th>stealth(run1)</th>
        <th>headful-stealth(run1)</th>
        <th>recommended-headless(run1)</th>
        <th>recommended-headful(run1)</th>
        <th>manual基准</th>
        <th>配置值(观测)</th>
        <th>生效判断</th>
        <th>固定/随机</th>
        <th>headful差异</th>
        <th>manual差异(原有头)</th>
        <th>manual差异(推荐无头)</th>
        <th>manual差异(推荐有头)</th>
      </tr>
    </thead>
    <tbody>
      ${trs.join('\n')}
    </tbody>
  </table>`;
}

function renderCategoryTables(rows) {
  const categories = [
    { key: 'request_headers', title: 'A. Request Headers（请求头）' },
    { key: 'navigator_fingerprint', title: 'B. Navigator Fingerprint（浏览器指纹）' },
    { key: 'browser_runtime', title: 'C. Browser Runtime APIs（浏览器运行时对象）' },
    { key: 'graphics_media', title: 'D. Graphics & Media（图形与媒体能力）' }
  ];

  return categories
    .map((c) => {
      const subset = rows.filter((r) => r.category === c.key);
      if (!subset.length) {
        return '';
      }
      return `
      <h3>${escapeHtml(c.title)}</h3>
      <div class="table-wrap">
        ${renderHtmlTable(subset)}
      </div>`;
    })
    .join('\n');
}

function buildAlignmentPlan(sampleSource, manualBaseline, isHeadless) {
  const manualHeaders = manualBaseline?.requestHeaders || {};
  const sampleHeaders = sampleSource?.requestHeaders || {};
  const manualResult = manualBaseline?.result || {};
  const sampleResult = sampleSource?.result || {};

  const diffs = [];
  for (const key of Object.keys(manualHeaders)) {
    if (!valueEqual(sampleHeaders[key], manualHeaders[key])) {
      diffs.push({ key: `requestHeaders.${key}`, manual: manualHeaders[key], sample: sampleHeaders[key] });
    }
  }

  const resultKeys = [
    'userAgent',
    'platform',
    'language',
    'languages',
    'vendor',
    'hardwareConcurrency',
    'pluginsLength',
    'mimeTypesLength',
    'webglVendor',
    'webglRenderer',
    'hasChrome',
    'chromeRuntimeExists',
    'chromeAppExists'
  ];
  for (const key of resultKeys) {
    if (!valueEqual(sampleResult[key], manualResult[key])) {
      diffs.push({ key: `result.${key}`, manual: manualResult[key], sample: sampleResult[key] });
    }
  }

  const diffKeys = new Set(diffs.map((d) => d.key));
  const contextOptions = {};
  const extraHTTPHeaders = {};
  const initScriptLines = [];
  const notes = [];
  const cannotAutoAlign = [];
  let needsCDPOverride = false;

  if (diffKeys.has('requestHeaders.user-agent') || diffKeys.has('result.userAgent')) {
    contextOptions.userAgent = manualHeaders['user-agent'] || manualResult.userAgent;
    needsCDPOverride = true;
  }

  if (diffKeys.has('requestHeaders.accept-language')) {
    extraHTTPHeaders['accept-language'] = manualHeaders['accept-language'];
  }
  if (diffKeys.has('requestHeaders.accept')) {
    extraHTTPHeaders.accept = manualHeaders.accept;
  }
  if (diffKeys.has('requestHeaders.cache-control')) {
    extraHTTPHeaders['cache-control'] = manualHeaders['cache-control'];
  }
  if (diffKeys.has('requestHeaders.referer')) {
    notes.push('可在 page.goto(url, { referer }) 中设置 referer，或通过 extraHTTPHeaders 设置。');
  }
  if (diffKeys.has('requestHeaders.cookie')) {
    notes.push('Cookie 建议用 context.addCookies()/storageState 注入，不建议直接写 Cookie 头。');
  }
  if (diffKeys.has('requestHeaders.if-modified-since') || diffKeys.has('requestHeaders.if-none-match')) {
    cannotAutoAlign.push('if-modified-since/if-none-match 依赖缓存状态，自动化新 context 通常不会自然一致。');
  }
  for (const k of ['requestHeaders.priority', 'requestHeaders.sec-fetch-dest', 'requestHeaders.sec-fetch-mode', 'requestHeaders.sec-fetch-site', 'requestHeaders.sec-fetch-user', 'requestHeaders.upgrade-insecure-requests']) {
    if (diffKeys.has(k)) {
      cannotAutoAlign.push(`${k} 属于浏览器导航受控头，通常不能稳定手动精确伪造。`);
    }
  }

  if (diffKeys.has('result.language') || diffKeys.has('result.languages') || diffKeys.has('requestHeaders.accept-language')) {
    const locale = manualResult.language || (Array.isArray(manualResult.languages) && manualResult.languages[0]) || 'en-US';
    contextOptions.locale = locale;
    if (Array.isArray(manualResult.languages) && manualResult.languages.length) {
      initScriptLines.push(`Object.defineProperty(navigator, 'language', { get: () => ${JSON.stringify(manualResult.language || manualResult.languages[0])} });`);
      initScriptLines.push(`Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(manualResult.languages)} });`);
    }
  }

  if (diffKeys.has('result.hardwareConcurrency') && typeof manualResult.hardwareConcurrency === 'number') {
    initScriptLines.push(`Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${manualResult.hardwareConcurrency} });`);
  }
  if (diffKeys.has('result.vendor') && typeof manualResult.vendor === 'string') {
    initScriptLines.push(`Object.defineProperty(navigator, 'vendor', { get: () => ${JSON.stringify(manualResult.vendor)} });`);
  }
  if (diffKeys.has('result.webglVendor') || diffKeys.has('result.webglRenderer')) {
    const vendor = manualResult.webglVendor || 'Intel Inc.';
    const renderer = manualResult.webglRenderer || 'Intel Iris OpenGL Engine';
    initScriptLines.push(`
const _origGetParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(param) {
  if (param === 37445) return ${JSON.stringify(vendor)};
  if (param === 37446) return ${JSON.stringify(renderer)};
  return _origGetParameter.call(this, param);
};`.trim());
  }

  for (const k of ['result.pluginsLength', 'result.mimeTypesLength', 'result.hasChrome', 'result.chromeRuntimeExists', 'result.chromeAppExists']) {
    if (diffKeys.has(k)) {
      cannotAutoAlign.push(`${k} 受浏览器实现与运行时环境影响，通常无法仅靠简单配置完全对齐。`);
    }
  }

  if (Object.keys(extraHTTPHeaders).length) {
    contextOptions.extraHTTPHeaders = extraHTTPHeaders;
  }

  const cdpUserAgentOverride = needsCDPOverride
    ? {
        userAgent: contextOptions.userAgent || manualHeaders['user-agent'] || '',
        acceptLanguage: manualHeaders['accept-language'] || ''
      }
    : null;

  const gotoOptions = {};
  if (diffKeys.has('requestHeaders.referer') && manualHeaders.referer) {
    gotoOptions.referer = manualHeaders.referer;
  }

  return {
    diffCount: diffs.length,
    contextOptions,
    cdpUserAgentOverride,
    initScripts: initScriptLines,
    gotoOptions,
    notes,
    cannotAutoAlign,
    isHeadless
  };
}

function buildSuggestions(sampleName, sampleSource, manualBaseline, isHeadless) {
  const plan = buildAlignmentPlan(sampleSource, manualBaseline, isHeadless);

  const contextOptionsText = JSON.stringify(plan.contextOptions, null, 2);
  const cdpText = plan.cdpUserAgentOverride
    ? `
const client = await context.newCDPSession(page);
await client.send('Network.setUserAgentOverride', {
  userAgent: ${JSON.stringify(plan.cdpUserAgentOverride.userAgent)},
  acceptLanguage: ${JSON.stringify(plan.cdpUserAgentOverride.acceptLanguage)}
});
`.trim()
    : '';

  const initText = plan.initScripts.length
    ? `
await context.addInitScript(() => {
  ${plan.initScripts.join('\n  ')}
});
`.trim()
    : '';

  const gotoOptionsText = plan.gotoOptions && Object.keys(plan.gotoOptions).length
    ? `, ${JSON.stringify(plan.gotoOptions, null, 2).slice(1, -1).trim()}`
    : '';

  const snippet = `
// ${sampleName} 建议模板（目标：贴近 manual 基准）
const browser = await chromium.launch({ headless: ${isHeadless ? 'true' : 'false'} });
const context = await browser.newContext(${contextOptionsText});
const page = await context.newPage();
${cdpText}
${initText}
await page.goto('https://www.cityline.com/zh_CN/Events.html', { waitUntil: 'domcontentloaded'${gotoOptionsText} });
`.trim();

  return {
    diffCount: plan.diffCount,
    snippet,
    notes: plan.notes,
    cannotAutoAlign: plan.cannotAutoAlign,
    plan
  };
}

function generateReport(
  baseline,
  stealth1,
  stealth2,
  headfulStealth,
  recommendedHeadless,
  recommendedHeadful,
  manualBaseline,
  headlessSuggest,
  headfulSuggest
) {
  const getByPath = (source, key) => {
    const safeSource = source || { requestHeaders: {}, result: {} };
    if (key.startsWith('requestHeaders.')) {
      const headerKey = key.slice('requestHeaders.'.length);
      return safeSource.requestHeaders?.[headerKey];
    }
    if (key === 'requestHeaders.user-agent') return safeSource.requestHeaders?.['user-agent'];
    if (key === 'requestHeaders.sec-ch-ua') return safeSource.requestHeaders?.['sec-ch-ua'];
    if (key === 'requestHeaders.sec-ch-ua-platform') return safeSource.requestHeaders?.['sec-ch-ua-platform'];
    if (key === 'requestHeaders.sec-ch-ua-mobile') return safeSource.requestHeaders?.['sec-ch-ua-mobile'];
    if (key === 'requestHeaders.accept-language') return safeSource.requestHeaders?.['accept-language'];
    if (key === 'result.userAgent') return safeSource.result.userAgent;
    if (key === 'result.platform') return safeSource.result.platform;
    if (key === 'result.language') return safeSource.result.language;
    if (key === 'result.webdriver') return safeSource.result.webdriver;
    if (key === 'result.pluginsLength') return safeSource.result.pluginsLength;
    if (key === 'result.plugins') return safeSource.result.plugins;
    if (key === 'result.mimeTypesLength') return safeSource.result.mimeTypesLength;
    if (key === 'result.mimeTypes') return safeSource.result.mimeTypes;
    if (key === 'result.hardwareConcurrency') return safeSource.result.hardwareConcurrency;
    if (key === 'result.languages') return safeSource.result.languages;
    if (key === 'result.webglVendor') return safeSource.result.webglVendor;
    if (key === 'result.webglRenderer') return safeSource.result.webglRenderer;
    if (key === 'result.chromeRuntimeExists') return safeSource.result.chromeRuntimeExists;
    if (key === 'result.chromeAppExists') return safeSource.result.chromeAppExists;
    if (key === 'result.hasChrome') return safeSource.result.hasChrome;
    if (key === 'result.vendor') return safeSource.result.vendor;
    if (key === 'result.outerWidth') return safeSource.result.outerWidth;
    if (key === 'result.outerHeight') return safeSource.result.outerHeight;
    if (key === 'result.innerWidth') return safeSource.result.innerWidth;
    if (key === 'result.innerHeight') return safeSource.result.innerHeight;
    return undefined;
  };

  const dynamicHeaderKeys = new Set(
    Object.keys((manualBaseline && manualBaseline.requestHeaders) || {})
  );

  const requestHeaderChecks = [...dynamicHeaderKeys]
    .sort()
    .map((headerKey) => {
      const configItem =
        headerKey === 'user-agent' ||
        headerKey === 'accept-language' ||
        headerKey.startsWith('sec-ch-ua')
          ? 'stealth/evasions/user-agent-override'
          : 'browser/default-request-headers';
      return {
        item: `requestHeaders.${headerKey}`,
        configItem,
        category: 'request_headers'
      };
    });

  const checks = [
    ...requestHeaderChecks,
    { item: 'result.userAgent', configItem: 'stealth/evasions/user-agent-override', category: 'navigator_fingerprint' },
    { item: 'result.platform', configItem: 'stealth/evasions/user-agent-override', category: 'navigator_fingerprint' },
    { item: 'result.language', configItem: 'stealth/evasions/user-agent-override', category: 'navigator_fingerprint' },
    { item: 'result.webdriver', configItem: 'stealth/evasions/navigator.webdriver', category: 'navigator_fingerprint' },
    { item: 'result.hardwareConcurrency', configItem: 'stealth/evasions/navigator.hardwareConcurrency', category: 'navigator_fingerprint' },
    { item: 'result.languages', configItem: 'stealth/evasions/navigator.languages', category: 'navigator_fingerprint' },
    { item: 'result.vendor', configItem: 'stealth/evasions/navigator.vendor', category: 'navigator_fingerprint' },
    { item: 'result.hasChrome', configItem: 'stealth/evasions/chrome.runtime+chrome.app', category: 'browser_runtime' },
    { item: 'result.chromeRuntimeExists', configItem: 'stealth/evasions/chrome.runtime', category: 'browser_runtime' },
    { item: 'result.chromeAppExists', configItem: 'stealth/evasions/chrome.app', category: 'browser_runtime' },
    { item: 'result.pluginsLength', configItem: 'stealth/evasions/navigator.plugins', category: 'graphics_media' },
    { item: 'result.plugins', configItem: 'stealth/evasions/navigator.plugins', category: 'graphics_media' },
    { item: 'result.mimeTypesLength', configItem: 'stealth/evasions/navigator.plugins', category: 'graphics_media' },
    { item: 'result.mimeTypes', configItem: 'stealth/evasions/navigator.plugins', category: 'graphics_media' },
    { item: 'result.webglVendor', configItem: 'stealth/evasions/webgl.vendor', category: 'graphics_media' },
    { item: 'result.webglRenderer', configItem: 'stealth/evasions/webgl.vendor', category: 'graphics_media' },
    { item: 'result.outerWidth', configItem: 'stealth/evasions/window.outerdimensions', category: 'graphics_media' },
    { item: 'result.outerHeight', configItem: 'stealth/evasions/window.outerdimensions', category: 'graphics_media' },
    { item: 'result.innerWidth', configItem: 'stealth/evasions/window.outerdimensions', category: 'graphics_media' },
    { item: 'result.innerHeight', configItem: 'stealth/evasions/window.outerdimensions', category: 'graphics_media' }
  ];

  const rows = checks.map(({ item, configItem, category }) => {
    const baselineValue = getByPath(baseline, item);
    const stealthValue = getByPath(stealth1, item);
    const stealth2Value = getByPath(stealth2, item);
    const headfulValue = getByPath(headfulStealth, item);
    const recommendedHeadlessValue = getByPath(recommendedHeadless, item);
    const recommendedHeadfulValue = getByPath(recommendedHeadful, item);
    const manualValue = getByPath(
      manualBaseline || { requestHeaders: {}, result: {} },
      item
    );
    return {
      item,
      category,
      configItem,
      baseline: formatValue(baselineValue),
      stealth: formatValue(stealthValue),
      headfulStealth: formatValue(headfulValue),
      recommendedHeadless: formatValue(recommendedHeadlessValue),
      recommendedHeadful: formatValue(recommendedHeadfulValue),
      manualRef: formatValue(manualValue),
      configValue: formatValue(stealthValue),
      effectChanged: !valueEqual(baselineValue, stealthValue),
      isFixed: valueEqual(stealthValue, stealth2Value),
      headfulDiff: !valueEqual(stealthValue, headfulValue),
      manualDiff: typeof manualValue === 'undefined'
        ? false
        : !valueEqual(headfulValue, manualValue),
      recommendedHeadlessManualDiff: typeof manualValue === 'undefined'
        ? false
        : !valueEqual(recommendedHeadlessValue, manualValue),
      recommendedHeadfulManualDiff: typeof manualValue === 'undefined'
        ? false
        : !valueEqual(recommendedHeadfulValue, manualValue)
    };
  });

  const deterministic = valueEqual(
    { requestHeaders: stealth1.requestHeaders, result: stealth1.result },
    { requestHeaders: stealth2.requestHeaders, result: stealth2.result }
  );
  const randomConclusion = deterministic ? '一致（确定性）' : '不一致（存在随机性）';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Stealth 对比实验报告（cityline）</title>
  <style>
    :root {
      --bg: #f4f7fb;
      --card: #ffffff;
      --text: #1a2233;
      --muted: #5b6475;
      --line: #dfe5ee;
      --head: #edf3fb;
      --code: #f3f6fb;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
      margin: 0;
      padding: 28px;
      color: var(--text);
      background: radial-gradient(1200px 600px at 20% -10%, #e9f2ff 0%, var(--bg) 45%, var(--bg) 100%);
    }
    h1, h2 { margin: 0 0 12px; letter-spacing: 0.1px; }
    h1 { font-size: 30px; }
    h2 { font-size: 20px; margin-top: 2px; }
    h3 { margin: 14px 0 8px; font-size: 16px; color: #284163; }
    p, li { color: var(--muted); }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 18px 20px;
      margin-bottom: 16px;
      box-shadow: 0 6px 24px rgba(20, 35, 60, 0.05);
    }
    ul, ol { margin: 8px 0 8px 22px; }
    code {
      background: var(--code);
      padding: 2px 6px;
      border-radius: 6px;
      font-size: 0.95em;
    }
    .table-wrap {
      margin-top: 10px;
      overflow: auto;
      max-height: 68vh;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #fff;
    }
    table {
      width: 100%;
      min-width: 1700px;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      border-right: 1px solid var(--line);
      padding: 10px 10px;
      vertical-align: top;
      text-align: left;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    th:last-child, td:last-child { border-right: 0; }
    th {
      background: var(--head);
      position: sticky;
      top: 0;
      z-index: 5;
      color: #1f2f4a;
      font-weight: 650;
      box-shadow: inset 0 -1px 0 var(--line);
    }
    tbody tr:nth-child(even) td { background: #fbfdff; }
    .value-block {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.35;
      max-width: 100%;
    }
    .config-cell {
      background: #f6faff !important;
      width: 240px;
    }
    .bool {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.35;
      white-space: nowrap;
    }
    .bool .icon {
      font-size: 15px;
      line-height: 1;
    }
    .bool.ok {
      background: #e8f9ee;
      color: #0f6a33;
      border: 1px solid #bfe8cd;
    }
    .bool.no {
      background: #ffeef0;
      color: #9a1b2f;
      border: 1px solid #f3c2cb;
    }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .code-block {
      margin: 8px 0 0;
      padding: 12px;
      border-radius: 8px;
      background: #0f172a;
      color: #e2e8f0;
      border: 1px solid #1f2937;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <h1>Stealth 对比实验报告（cityline）</h1>

  <section class="card">
    <h2>实验设置</h2>
    <ul>
      <li>目标站点：<code>${escapeHtml(baseline.targetUrl)}</code></li>
      <li>浏览器模式：<code>headless: true</code></li>
      <li>运行方式：
        <ol>
          <li>no-stealth 跑 1 次</li>
          <li>stealth 跑 2 次</li>
          <li>stealth + headful 跑 1 次（追加轮）</li>
          <li>stealth + 无头推荐参数 跑 1 次</li>
          <li>stealth + 有头推荐参数 跑 1 次</li>
        </ol>
      </li>
      <li>每次重跑前先清理旧结果目录：<code>results/</code></li>
    </ul>
  </section>

  <section class="card">
    <h2>结果文件</h2>
    <ul class="mono">
      <li>results/no-stealth.json</li>
      <li>results/stealth-run-1.json</li>
      <li>results/stealth-run-2.json</li>
      <li>results/stealth-headful-run-1.json</li>
      <li>results/stealth-recommended-headless-run-1.json</li>
      <li>results/stealth-recommended-headful-run-1.json</li>
      <li>results/manual-headful-merged.json（手工维护，只读）</li>
    </ul>
  </section>

  <section class="card">
    <h2>固定报告格式（配置匹配 + 生效判断）</h2>
    <ul>
      <li>“对应配置项”表示由 <code>chromium.use(stealth())</code> 启用的 evasion 模块（支持一个配置项对应多个观测项）</li>
      <li>“配置值(观测)”使用 stealth run1 的实际观测值</li>
      <li>“生效判断”基于 no-stealth vs stealth(run1)</li>
      <li>“固定/随机”基于 stealth run1 vs run2</li>
      <li>“headful差异”基于 headless-stealth(run1) vs headful-stealth(run1)</li>
      <li>“manual差异(原有头)”对 manual 基准中存在的字段生效，基于 headful-stealth(run1) vs manual 基准</li>
      <li>“manual差异(推荐无头/推荐有头)”用于验证应用推荐参数后的收敛效果</li>
      <li>已纳入关键一致性监控（含 <code>language</code> vs <code>languages</code>、UA hints、window 尺寸等）</li>
    </ul>
    ${renderCategoryTables(rows)}
  </section>

  <section class="card">
    <h2>是否随机</h2>
    <p>stealth run1 与 run2 完整对比结论：<strong>${escapeHtml(randomConclusion)}</strong></p>
  </section>

  <section class="card">
    <h2>结论</h2>
    <ol>
      <li><code>chromium.use(stealth())</code> 对多项指纹产生可观测改写。</li>
      <li>本机两次 stealth 重复实验结果一致，表现为确定性策略（非每次随机）。</li>
      <li>有头追加轮对比已并入主表，不再单独使用第二张表。</li>
    </ol>
  </section>

  <section class="card">
    <h2>建议配置（自动生成）</h2>
    <p>目标：分别让 <code>stealth(run1)</code> 与 <code>headful-stealth(run1)</code> 尽量贴近 manual 基准。</p>

    <h3>1) stealth(run1) -> manual（差异 ${headlessSuggest.diffCount} 项）</h3>
    <pre class="code-block">${escapeHtml(headlessSuggest.snippet)}</pre>
    ${headlessSuggest.notes.length ? `<p><strong>补充说明</strong></p><ul>${headlessSuggest.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
    ${headlessSuggest.cannotAutoAlign.length ? `<p><strong>无法稳定自动对齐项</strong></p><ul>${headlessSuggest.cannotAutoAlign.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}

    <h3>2) headful-stealth(run1) -> manual（差异 ${headfulSuggest.diffCount} 项）</h3>
    <pre class="code-block">${escapeHtml(headfulSuggest.snippet)}</pre>
    ${headfulSuggest.notes.length ? `<p><strong>补充说明</strong></p><ul>${headfulSuggest.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
    ${headfulSuggest.cannotAutoAlign.length ? `<p><strong>无法稳定自动对齐项</strong></p><ul>${headfulSuggest.cannotAutoAlign.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
  </section>
</body>
</html>`;
}

function main() {
  fs.mkdirSync(resultsDir, { recursive: true });
  for (const filename of generatedResultFiles) {
    fs.rmSync(path.join(resultsDir, filename), { force: true });
  }

  runProbe([`--out=${path.join(resultsDir, 'no-stealth.json')}`]);
  runProbe(['--stealth', `--out=${path.join(resultsDir, 'stealth-run-1.json')}`]);
  runProbe(['--stealth', `--out=${path.join(resultsDir, 'stealth-run-2.json')}`]);
  runProbe(['--stealth', '--headful', `--out=${path.join(resultsDir, 'stealth-headful-run-1.json')}`]);

  const baseline = readJson(path.join(resultsDir, 'no-stealth.json'));
  const stealth1 = readJson(path.join(resultsDir, 'stealth-run-1.json'));
  const stealth2 = readJson(path.join(resultsDir, 'stealth-run-2.json'));
  const headfulStealth = readJson(path.join(resultsDir, 'stealth-headful-run-1.json'));
  const manualBaseline = fs.existsSync(manualBaselinePath)
    ? readJson(manualBaselinePath)
    : null;

  let recommendedHeadless = null;
  let recommendedHeadful = null;
  const headlessSuggest = buildSuggestions('stealth(run1)', stealth1, manualBaseline, true);
  const headfulSuggest = buildSuggestions('headful-stealth(run1)', headfulStealth, manualBaseline, false);

  if (manualBaseline) {
    const headlessRecipePath = path.join(resultsDir, 'recommended-headless-recipe.json');
    const headfulRecipePath = path.join(resultsDir, 'recommended-headful-recipe.json');
    fs.writeFileSync(
      headlessRecipePath,
      JSON.stringify({ ...headlessSuggest.plan, modeLabel: 'stealth-recommended-headless' }, null, 2)
    );
    fs.writeFileSync(
      headfulRecipePath,
      JSON.stringify({ ...headfulSuggest.plan, modeLabel: 'stealth-recommended-headful' }, null, 2)
    );

    runProbe([
      '--stealth',
      `--recipe=${headlessRecipePath}`,
      `--out=${path.join(resultsDir, 'stealth-recommended-headless-run-1.json')}`
    ]);
    runProbe([
      '--stealth',
      '--headful',
      `--recipe=${headfulRecipePath}`,
      `--out=${path.join(resultsDir, 'stealth-recommended-headful-run-1.json')}`
    ]);

    recommendedHeadless = readJson(path.join(resultsDir, 'stealth-recommended-headless-run-1.json'));
    recommendedHeadful = readJson(path.join(resultsDir, 'stealth-recommended-headful-run-1.json'));
  }

  const report = generateReport(
    baseline,
    stealth1,
    stealth2,
    headfulStealth,
    recommendedHeadless,
    recommendedHeadful,
    manualBaseline,
    headlessSuggest,
    headfulSuggest
  );
  fs.writeFileSync(reportPath, report);
  fs.rmSync(path.join(baseDir, 'report.md'), { force: true });
  console.log(`Generated report: ${reportPath}`);
}

main();
