const fs = require('fs');
const path = require('path');
const fse = require('fs-extra');
const { chromium } = require('playwright');
const  { default: inquirer }  = require('inquirer');

const BEFORE_DIR = 'before';
const URL_FILE = 'url.txt';

// 生成保存用的文件名
function parseUrlInfo(line) {
  const parts = line.split(',');
  const rawUrl = parts[0].trim();
  let cleanUrl = rawUrl;
  let basicID = parts[1] ? parts[1].trim() : null;
  let basicPW = parts[2] ? parts[2].trim() : null;

  try {
    const urlObj = new URL(rawUrl);
    if (!basicID && urlObj.searchParams.has('basicID')) {
      basicID = urlObj.searchParams.get('basicID');
    }
    if (!basicPW && urlObj.searchParams.has('basicPW')) {
      basicPW = urlObj.searchParams.get('basicPW');
    }
    urlObj.searchParams.delete('basicID');
    urlObj.searchParams.delete('basicPW');
    cleanUrl = urlObj.toString();
  } catch (e) {
    console.warn(`⚠️ URL解析に失敗しました: ${rawUrl}`);
  }

  try {
    const urlForFilename = new URL(cleanUrl);
    const filenameBase = (urlForFilename.hostname + urlForFilename.pathname)
      .replace(/[\/\\?&=:]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    const filename = filenameBase + '.png';
    return { cleanUrl, basicID, basicPW, filename };
  } catch (e) {
    return { cleanUrl, basicID, basicPW, filename: 'invalid_url.png' };
  }
}

async function askUserMode() {
  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: '📸 比較方法を選んでください：',
      choices: [
        { name: '🔁 同じURLでの比較', value: 'same' },
        { name: '🔀 異なるURLでの比較', value: 'different' }
      ]
    }
  ]);
  return answer.mode;
}

async function main() {
  if (!fs.existsSync(URL_FILE)) {
    console.error(`❌ URLファイルが見つかりません: ${URL_FILE}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(URL_FILE, 'utf-8')
    .split('\n')
    .map(line => line.trim());

  const mode = await askUserMode(); // 用户选择模式
  fse.ensureDirSync(BEFORE_DIR);
  fse.emptyDirSync(BEFORE_DIR); // ✅ 清空 before 文件夹内容
  const browser = await chromium.launch();


  let startProcessing = false;
  let counter = 1;

  for (const line of lines) {
    if (line === '#before') {
      startProcessing = true;
      continue;
    }
    if (line === '#after') {
      break;
    }
    if (!startProcessing || !line || line.startsWith('#')) {
      continue;
    }

    const { cleanUrl, basicID, basicPW, filename } = parseUrlInfo(line);
    const prefix = mode === 'different' ? String(counter).padStart(3, '0') + '_' : '';
    const finalFilename = prefix + filename;

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
      const savePath = path.join(BEFORE_DIR, finalFilename);
      await page.screenshot({ path: savePath, fullPage: true });
      console.log(`✅ Captured BEFORE: ${cleanUrl} → ${savePath}`);
    } catch (err) {
      console.error(`❌ Failed: ${cleanUrl} → ${err.message}`);
    } finally {
      await page.close();
      await context.close();
    }

    counter++;
  }

  await browser.close();
}

main();
