const fs = require('fs');
const path = require('path');
const fse = require('fs-extra');
const { chromium } = require('playwright');

const BEFORE_DIR = 'before';
const URL_FILE = 'url.txt';

// 生成保存用的文件名
function parseUrlInfo(line) {
  const parts = line.split(',');
  const rawUrl = parts[0].trim();
  let cleanUrl = rawUrl;
  let basicID = parts[1] ? parts[1].trim() : null;
  let basicPW = parts[2] ? parts[2].trim() : null;

  // 如果没有用 ,username,password 提供认证信息，就尝试从 query 中解析
  try {
    const urlObj = new URL(rawUrl);

    if (!basicID && urlObj.searchParams.has('basicID')) {
      basicID = urlObj.searchParams.get('basicID');
    }

    if (!basicPW && urlObj.searchParams.has('basicPW')) {
      basicPW = urlObj.searchParams.get('basicPW');
    }

    // 去掉 query 中的 basicID 和 basicPW，生成干净的 cleanUrl
    urlObj.searchParams.delete('basicID');
    urlObj.searchParams.delete('basicPW');
    cleanUrl = urlObj.toString();
  } catch (e) {
    console.warn(`⚠️ URL解析に失敗しました: ${rawUrl}`);
  }

  // 生成文件名：用 URL 的 host+path 去除协议及特殊符号
  const urlForFilename = new URL(cleanUrl);
  const filenameBase = (urlForFilename.hostname + urlForFilename.pathname)
    .replace(/[\/\\?&=:]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const filename = filenameBase + '.png';

  return { cleanUrl, basicID, basicPW, filename };
}


async function main() {
  if (!fs.existsSync(URL_FILE)) {
    console.error(`❌ URLファイルが見つかりません: ${URL_FILE}`);
    process.exit(1);
  }

  const urls = fs.readFileSync(URL_FILE, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line);

  fse.ensureDirSync(BEFORE_DIR);

  const browser = await chromium.launch();

  for (const rawUrl of urls) {
    const { cleanUrl, basicID, basicPW, filename } = parseUrlInfo(rawUrl);

    const contextOptions = {
      viewport: { width: 1366, height: 768 }
    };
    if (basicID && basicPW) {
      contextOptions.httpCredentials = { username: basicID, password: basicPW };
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
      await page.goto(cleanUrl, { waitUntil: 'networkidle', timeout: 20000 });
      const savePath = path.join(BEFORE_DIR, filename);
      await page.screenshot({ path: savePath, fullPage: true });
      console.log(`✅ Captured BEFORE: ${cleanUrl} → ${savePath}`);
    } catch (err) {
      console.error(`❌ Failed: ${cleanUrl} → ${err.message}`);
    } finally {
      await page.close();
      await context.close();
    }
  }

  await browser.close();
}

main();
