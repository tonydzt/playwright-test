const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const webglVendorEvasion = require('puppeteer-extra-plugin-stealth/evasions/webgl.vendor');

const useStealth = process.argv.includes('--stealth');
const useHeadful = process.argv.includes('--headful');
const reloadOnceArg = process.argv.includes('--reload-once');
const outputArg = process.argv.find((arg) => arg.startsWith('--out='));
const recipeArg = process.argv.find((arg) => arg.startsWith('--recipe='));
const outputFile = outputArg ? outputArg.slice('--out='.length) : null;
const recipeFile = recipeArg ? recipeArg.slice('--recipe='.length) : null;
const targetUrl = 'https://www.cityline.com/zh_CN/Events.html';
const recipe = recipeFile ? JSON.parse(fs.readFileSync(path.resolve(recipeFile), 'utf8')) : null;

if (useStealth) {
  const stealthPlugin = stealth();
  if (recipe && recipe.chromeRuntimeOverride) {
    stealthPlugin.enabledEvasions.delete('chrome.runtime');
  }
  if (recipe && recipe.webglOverride) {
    stealthPlugin.enabledEvasions.delete('webgl.vendor');
    chromium.use(webglVendorEvasion(recipe.webglOverride));
  }
  chromium.use(stealthPlugin);
}

async function run() {
  const launchOptions = { channel: 'chrome', headless: !useHeadful, ...((recipe && recipe.launchOptions) || {}) };
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext((recipe && recipe.contextOptions) || {});
  if (recipe && Array.isArray(recipe.initScripts)) {
    for (const script of recipe.initScripts) {
      await context.addInitScript(script);
    }
  }
  const page = await context.newPage();
  let cdpClient = null;
  try {
    cdpClient = await context.newCDPSession(page);
    await cdpClient.send('Network.enable');
  } catch {
    cdpClient = null;
  }

  if (recipe && recipe.cdpUserAgentOverride && cdpClient) {
    try {
      await cdpClient.send('Network.setUserAgentOverride', recipe.cdpUserAgentOverride);
    } catch (err) {
      const md = recipe.cdpUserAgentOverride.userAgentMetadata;
      if (!md) {
        throw err;
      }
      const fallback = {
        userAgent: recipe.cdpUserAgentOverride.userAgent,
        acceptLanguage: recipe.cdpUserAgentOverride.acceptLanguage,
        platform: recipe.cdpUserAgentOverride.platform
      };
      const brands = Array.isArray(md.brands) ? md.brands : [];
      const mobile = typeof md.mobile === 'boolean' ? md.mobile : false;
      const platform = typeof md.platform === 'string' ? md.platform : undefined;
      if (brands.length && platform) {
        fallback.userAgentMetadata = { brands, mobile, platform };
      }
      await cdpClient.send('Network.setUserAgentOverride', fallback);
    }
  }

  let mainRequestHeaders = null;
  let mainNavigationRequest = null;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      mainNavigationRequest = request;
    }
  });

  async function gotoWithRetry() {
    let lastError = null;
    const maxAttempts = 6;
    for (let i = 0; i < maxAttempts; i += 1) {
      const attempt = i % 2 === 0
        ? { waitUntil: 'domcontentloaded', timeout: 30000 }
        : { waitUntil: 'commit', timeout: 30000 };
      const finalAttempt = recipe && recipe.gotoOptions
        ? { ...attempt, ...recipe.gotoOptions }
        : attempt;
      try {
        await page.goto(targetUrl, finalAttempt);
        const currentUrl = page.url();
        if (currentUrl.startsWith('chrome-error://')) {
          lastError = new Error(`Navigation landed on error page: ${currentUrl}`);
          await page.waitForTimeout(2000);
          continue;
        }
        return;
      } catch (err) {
        const currentUrl = page.url();
        if (currentUrl.startsWith('https://www.cityline.com/zh_CN/Events.html')) {
          return;
        }
        lastError = err;
        await page.waitForTimeout(2000);
      }
    }
    throw lastError;
  }

  await gotoWithRetry();
  if (reloadOnceArg || (recipe && recipe.reloadOnce)) {
    let reloaded = false;
    for (let i = 0; i < 4; i += 1) {
      const waitUntil = i % 2 === 0 ? 'domcontentloaded' : 'commit';
      try {
        await page.reload({ waitUntil, timeout: 30000 });
        reloaded = true;
        break;
      } catch {
        await page.waitForTimeout(1500);
      }
    }
    if (!reloaded) {
      throw new Error('Reload failed after retries');
    }
  }

  if (mainNavigationRequest) {
    try {
      mainRequestHeaders = await mainNavigationRequest.allHeaders();
    } catch {
      mainRequestHeaders = mainNavigationRequest.headers();
    }
  }

  async function collectResultWithRetry() {
    try {
      return await page.evaluate(async () => {
        const gl = document.createElement('canvas').getContext('webgl');
        const webglVendor = gl ? gl.getParameter(37445) : null;
        const webglRenderer = gl ? gl.getParameter(37446) : null;

        const hasChrome = typeof window.chrome !== 'undefined';
        const chromeRuntimeExists = hasChrome && typeof window.chrome.runtime !== 'undefined';
        const chromeAppExists = hasChrome && typeof window.chrome.app !== 'undefined';
        const readUserAgentData = async () => {
          const uad = navigator.userAgentData;
          if (!uad) {
            return { supported: false };
          }
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
        };
        const userAgentData = await readUserAgentData();

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
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      if (!message.includes('Execution context was destroyed')) {
        throw err;
      }
      await page.waitForTimeout(1500);
      return await page.evaluate(async () => {
        const gl = document.createElement('canvas').getContext('webgl');
        const webglVendor = gl ? gl.getParameter(37445) : null;
        const webglRenderer = gl ? gl.getParameter(37446) : null;

        const hasChrome = typeof window.chrome !== 'undefined';
        const chromeRuntimeExists = hasChrome && typeof window.chrome.runtime !== 'undefined';
        const chromeAppExists = hasChrome && typeof window.chrome.app !== 'undefined';
        const readUserAgentData = async () => {
          const uad = navigator.userAgentData;
          if (!uad) {
            return { supported: false };
          }
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
        };
        const userAgentData = await readUserAgentData();

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
    }
  }

  const result = await collectResultWithRetry();
  async function collectTlsFingerprint() {
    const tlsPage = await context.newPage();
    let tlsCdpClient = null;
    if (recipe && recipe.cdpUserAgentOverride) {
      try {
        tlsCdpClient = await context.newCDPSession(tlsPage);
        await tlsCdpClient.send('Network.enable');
        await tlsCdpClient.send('Network.setUserAgentOverride', recipe.cdpUserAgentOverride);
      } catch {
        tlsCdpClient = null;
      }
    }
    try {
      let response = null;
      for (let i = 0; i < 3; i += 1) {
        try {
          response = await tlsPage.goto('https://tls.peet.ws/api/all', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          if (response) {
            break;
          }
        } catch {
          await tlsPage.waitForTimeout(1500);
        }
      }
      if (!response) {
        return null;
      }
      let data = null;
      try {
        data = await response.json();
      } catch {
        const text = await tlsPage.textContent('body');
        data = JSON.parse(text || '{}');
      }
      return {
        tls: data && data.tls ? data.tls : null,
        http2: data && data.http2 ? data.http2 : null,
        tcpip: data && data.tcpip ? data.tcpip : null
      };
    } catch {
      return null;
    } finally {
      await tlsPage.close();
    }
  }
  const tlsFingerprint = await collectTlsFingerprint();

  const payload = {
    mode: (recipe && recipe.modeLabel) || (useStealth ? 'stealth' : 'baseline'),
    browserMode: useHeadful ? 'headful' : 'headless',
    targetUrl,
    timestamp: new Date().toISOString(),
    requestHeaders: mainRequestHeaders,
    tlsFingerprint,
    result
  };

  if (outputFile) {
    const outPath = path.resolve(outputFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  }

  console.log(JSON.stringify(payload, null, 2));
  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
