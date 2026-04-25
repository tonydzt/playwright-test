const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const webglVendorEvasion = require('puppeteer-extra-plugin-stealth/evasions/webgl.vendor');
const fs = require('fs');
const path = require('path');

const stealthPlugin = stealth();
stealthPlugin.enabledEvasions.delete('chrome.runtime');
stealthPlugin.enabledEvasions.delete('webgl.vendor');
chromium.use(
  webglVendorEvasion({
    vendor: 'Google Inc. (Apple)',
    renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'
  })
);
chromium.use(stealthPlugin);

const manualPath = path.join(
  __dirname,
  'experiments/stealth-cityline/results/manual-headful-merged.json'
);

function deepGet(obj, dottedPath) {
  if (!obj) return undefined;
  return dottedPath.split('.').reduce((acc, key) => {
    if (acc === null || typeof acc === 'undefined') return undefined;
    return acc[key];
  }, obj);
}

function collectComparePaths(value, prefix, out) {
  if (Array.isArray(value)) {
    out.push(prefix);
    return;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const next = prefix ? `${prefix}.${k}` : k;
      collectComparePaths(value[k], next, out);
    }
    return;
  }
  out.push(prefix);
}

(async () => {
  // const browser = await chromium.launch({
  //   // channel: 'chrome',
  //   headless: false,
  //   args: ['--start-maximized']
  // });

  // const browser = await chromium.launchPersistentContext("./chrome-user-data", {
  //   channel: "chrome",
  //   headless: false,
  //   args: [
  //     "--start-maximized",
  //   ],
  //   viewport: null,
  //   locale: "zh-CN",
  //   timezoneId: "Asia/Tokyo",
  // });

  const context = await chromium.launchPersistentContext("./chrome-user-data", {
    channel: "chrome",
    headless: false,
    args: [
      "--start-maximized",
    ],
    viewport: null,
    locale: "zh-CN",
    timezoneId: "Asia/Tokyo",

    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    viewport: null,
    extraHTTPHeaders: {
      'cache-control': 'max-age=0'
    }
  });
  await context.addInitScript("Object.defineProperty(navigator, 'language', { get: () => \"zh-CN\" });");
  await context.addInitScript("Object.defineProperty(navigator, 'languages', { get: () => [\"zh-CN\",\"zh\",\"en\",\"ar\"] });");
  await context.addInitScript("Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });");
  await context.addInitScript(`(() => {
    const chromeObj = (window.chrome && typeof window.chrome === 'object') ? window.chrome : {};
    try { delete chromeObj.runtime; } catch (e) { chromeObj.runtime = undefined; }
    chromeObj.app = chromeObj.app && typeof chromeObj.app === 'object' ? chromeObj.app : {};
    Object.defineProperty(window, 'chrome', {
      get: () => chromeObj,
      configurable: true
    });
  })();`);

  const page = await context.newPage();
  let mainNavigationRequest = null;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      mainNavigationRequest = request;
    }
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    acceptLanguage: 'zh-CN,zh,en,ar',
    userAgentMetadata: {
      brands: [
        { brand: 'Chromium', version: '146' },
        { brand: 'Not-A.Brand', version: '24' },
        { brand: 'Google Chrome', version: '146' }
      ],
      mobile: false,
      platform: 'macOS',
      fullVersionList: [
        { brand: 'Chromium', version: '146.0.7680.178' },
        { brand: 'Not-A.Brand', version: '24.0.0.0' },
        { brand: 'Google Chrome', version: '146.0.7680.178' }
      ],
      platformVersion: '14.1.0',
      architecture: 'arm',
      bitness: '64',
      model: '',
      wow64: false,
      fullVersion: '146.0.7680.178'
    }
  });
  await page.goto('https://www.cityline.com/zh_CN/Events.html', {
    waitUntil: 'domcontentloaded',
    referer: 'https://venue.cityline.com/'
  });
  await page.reload({
    waitUntil: 'domcontentloaded'
  });

  let requestHeaders = {};
  if (mainNavigationRequest) {
    try {
      requestHeaders = await mainNavigationRequest.allHeaders();
    } catch {
      requestHeaders = mainNavigationRequest.headers();
    }
  }

  const result = await page.evaluate(async () => {
    const gl = document.createElement('canvas').getContext('webgl');
    const webglVendor = gl ? gl.getParameter(37445) : null;
    const webglRenderer = gl ? gl.getParameter(37446) : null;
    const hasChrome = typeof window.chrome !== 'undefined';
    const chromeRuntimeExists = hasChrome && typeof window.chrome.runtime !== 'undefined';
    const chromeAppExists = hasChrome && typeof window.chrome.app !== 'undefined';

    const userAgentData = await (async () => {
      const uad = navigator.userAgentData;
      if (!uad) return { supported: false };
      const hints = [
        'architecture',
        'bitness',
        'brands',
        'formFactors',
        'fullVersionList',
        'mobile',
        'model',
        'platform',
        'platformVersion',
        'uaFullVersion',
        'wow64'
      ];
      let highEntropy = {};
      try {
        highEntropy = await uad.getHighEntropyValues(hints);
      } catch (e) {
        highEntropy = { error: String(e && e.message ? e.message : e) };
      }
      return {
        supported: true,
        lowEntropy: {
          brands: uad.brands,
          mobile: uad.mobile,
          platform: uad.platform
        },
        highEntropy
      };
    })();

    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      vendor: navigator.vendor,
      language: navigator.language,
      languages: navigator.languages,
      hardwareConcurrency: navigator.hardwareConcurrency,
      webdriver: navigator.webdriver,
      pluginsLength: navigator.plugins.length,
      plugins: Array.from(navigator.plugins).map((p) => ({
        name: p.name,
        filename: p.filename,
        description: p.description
      })),
      mimeTypesLength: navigator.mimeTypes.length,
      mimeTypes: Array.from(navigator.mimeTypes).map((m) => ({
        type: m.type,
        suffixes: m.suffixes,
        description: m.description
      })),
      webglVendor,
      webglRenderer,
      hasChrome,
      chromeRuntimeExists,
      chromeAppExists,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      userAgentData
    };
  });

  const current = {
    mode: 'hello-check',
    browserMode: 'headful',
    targetUrl: page.url(),
    timestamp: new Date().toISOString(),
    requestHeaders,
    result
  };

  const manual = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
  const paths = [];
  collectComparePaths(manual.requestHeaders || {}, 'requestHeaders', paths);
  collectComparePaths(manual.result || {}, 'result', paths);

  const mismatches = [];
  for (const p of paths) {
    const expected = deepGet(manual, p);
    const actual = deepGet(current, p);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      mismatches.push({ path: p, expected, actual });
    }
  }

  console.log(`Compared fields: ${paths.length}`);
  console.log(`Mismatches: ${mismatches.length}`);
  if (mismatches.length) {
    console.log(JSON.stringify(mismatches, null, 2));
  } else {
    console.log('All manual fields matched.');
  }

  await page.waitForEvent('close', { timeout: 0 });
  await context.close();
})();
