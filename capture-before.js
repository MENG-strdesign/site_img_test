const fs = require('fs');
const path = require('path');
const fse = require('fs-extra');
const { chromium } = require('playwright');
const  { default: inquirer }  = require('inquirer');
const { default: pLimit }  = require('p-limit'); // 新增依赖

const BEFORE_DIR = 'before';
const URL_FILE = 'url.txt';
const CONCURRENCY = 3; // 并发数，可根据机器性能调整

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
        { name: '🔀 異なるURLでの比較', value: 'different' },
        { name: '🔁 同じURLでの比較', value: 'same' }
      ]
    }
  ]);
  return answer.mode;
}

async function captureWithProgress(page, url, savePath) {
  let loadedBytes = 0;

  page.on('response', resp => {
    const clen = resp.headers()['content-length'];
    if (clen) {
      loadedBytes += parseInt(clen, 10);
      process.stdout.write(`\r読込済み: ${(loadedBytes/1024).toFixed(1)} KB`);
    }
  });

  let gotoError = null;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
  } catch (err) {
    gotoError = err;
    console.warn(`\n⚠️ ページの完全な読込を待てませんでした（タイムアウト）。現在の状態でスクリーンショットを保存します。`);
  }
  process.stdout.write('\n');
  await page.screenshot({ path: savePath, fullPage: true });
  if (gotoError) {
    // 可以在这里记录日志或做其它处理
  }
}

async function main() {
  if (!fs.existsSync(URL_FILE)) {
    console.error(`❌ URLファイルが見つかりません: ${URL_FILE}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(URL_FILE, 'utf-8')
    .split('\n')
    .map(line => line.trim());

  const mode = await askUserMode();
  fse.ensureDirSync(BEFORE_DIR);
  fse.emptyDirSync(BEFORE_DIR);

  const browser = await chromium.launch();

  let startProcessing = false;
  let counter = 1;
  const tasks = [];

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
    const savePath = path.join(BEFORE_DIR, finalFilename);

    const contextOptions = {
      viewport: { width: 1366, height: 768 }
    };
    if (basicID && basicPW) {
      contextOptions.httpCredentials = { username: basicID, password: basicPW };
    }

    // 并发任务封装
    tasks.push(async () => {
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      try {
        console.log(`\n[${counter}] 取得中: ${cleanUrl}`);
        await captureWithProgress(page, cleanUrl, savePath);
        console.log(`✅ BEFORE取得完了: ${cleanUrl} → ${savePath}`);
      } catch (err) {
        console.error(`❌ 取得失敗: ${cleanUrl} → ${err.message}`);
      } finally {
        await page.close();
        await context.close();
      }
    });

    counter++;
  }

  const limit = pLimit(CONCURRENCY);
  await Promise.all(tasks.map(task => limit(task)));

  await browser.close();
}

main();
