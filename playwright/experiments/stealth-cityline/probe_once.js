const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

const useStealth = process.argv.includes('--stealth');
const useHeadful = process.argv.includes('--headful');
const outputArg = process.argv.find((arg) => arg.startsWith('--out='));
const recipeArg = process.argv.find((arg) => arg.startsWith('--recipe='));
const outputFile = outputArg ? outputArg.slice('--out='.length) : null;
const recipeFile = recipeArg ? recipeArg.slice('--recipe='.length) : null;
const targetUrl = 'https://www.cityline.com/zh_CN/Events.html';
const recipe = recipeFile ? JSON.parse(fs.readFileSync(path.resolve(recipeFile), 'utf8')) : null;

if (useStealth) {
  chromium.use(stealth());
}

async function run() {
  const browser = await chromium.launch({ headless: !useHeadful });
  const context = await browser.newContext((recipe && recipe.contextOptions) || {});
  if (recipe && Array.isArray(recipe.initScripts)) {
    for (const script of recipe.initScripts) {
      await context.addInitScript(script);
    }
  }
  const page = await context.newPage();
  if (recipe && recipe.cdpUserAgentOverride) {
    const client = await context.newCDPSession(page);
    await client.send('Network.setUserAgentOverride', recipe.cdpUserAgentOverride);
  }

  let mainRequestHeaders = null;
  let mainNavigationRequest = null;
  page.on('request', (request) => {
    if (!mainNavigationRequest && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
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

  if (mainNavigationRequest) {
    try {
      mainRequestHeaders = await mainNavigationRequest.allHeaders();
    } catch {
      mainRequestHeaders = mainNavigationRequest.headers();
    }
  }

  async function collectResultWithRetry() {
    try {
      return await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl');
        const webglVendor = gl ? gl.getParameter(37445) : null;
        const webglRenderer = gl ? gl.getParameter(37446) : null;

        const hasChrome = typeof window.chrome !== 'undefined';
        const chromeRuntimeExists = hasChrome && typeof window.chrome.runtime !== 'undefined';
        const chromeAppExists = hasChrome && typeof window.chrome.app !== 'undefined';

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
          innerHeight: window.innerHeight
        };
      });
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      if (!message.includes('Execution context was destroyed')) {
        throw err;
      }
      await page.waitForTimeout(1500);
      return await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl');
        const webglVendor = gl ? gl.getParameter(37445) : null;
        const webglRenderer = gl ? gl.getParameter(37446) : null;

        const hasChrome = typeof window.chrome !== 'undefined';
        const chromeRuntimeExists = hasChrome && typeof window.chrome.runtime !== 'undefined';
        const chromeAppExists = hasChrome && typeof window.chrome.app !== 'undefined';

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
          innerHeight: window.innerHeight
        };
      });
    }
  }

  const result = await collectResultWithRetry();

  const payload = {
    mode: (recipe && recipe.modeLabel) || (useStealth ? 'stealth' : 'baseline'),
    browserMode: useHeadful ? 'headful' : 'headless',
    targetUrl,
    timestamp: new Date().toISOString(),
    requestHeaders: mainRequestHeaders,
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
