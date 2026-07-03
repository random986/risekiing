import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  page.on('response', response => {
    if (!response.ok()) {
      console.log('HTTP ERROR:', response.status(), response.url());
    }
  });

  console.log('Navigating to preview...');
  await page.goto('http://localhost:4173', { waitUntil: 'networkidle0' });
  
  const rootContent = await page.$eval('#root', el => el.innerHTML);
  console.log('Root content length:', rootContent.length);
  if (rootContent.length < 100) {
    console.log('Root content is suspiciously small:', rootContent);
  }

  await browser.close();
})();
