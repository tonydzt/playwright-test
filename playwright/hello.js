const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

// 这行代码设置了以下参数，主要针对的是无头模式设置，有头模式很多参数采用本地的
chromium.use(stealth());

// const userAgents = [
//   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
//   'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
// ];
// const ua = userAgents[Math.floor(Math.random() * userAgents.length)];

(async () => {
  // const browser = await chromium.launch({});
  const browser = await chromium.launch({ headless: false });

  const context = await browser.newContext({
    // userAgent: ua,
    extraHTTPHeaders: {
      // 'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  const page = await context.newPage();
  // await page.goto('https://www.cityline.com/zh_CN/Events.html', {
  await page.goto('https://webscraper.io/bot-check');

  await page.waitForEvent('close', { timeout: 0 });
  await context.close();
})();
