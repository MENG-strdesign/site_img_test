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
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: '📸 比較方法を選んでください：',
      choices: [
        { name: '🔀 異なるURLでの比較', value: 'different' },
        { name: '🔁 同じURLでの比較', value: 'same' }
      ]
    },
    {
      type: 'list',
      name: 'device',
      message: '📱 デバイスタイプを選んでください：',
      choices: [
        { name: '💻 デスクトップ (1920x1080)', value: 'desktop' },
        { name: '📱 モバイル (390x844)', value: 'mobile' }
      ]
    }
  ]);
  return answers;
}

async function captureWithProgress(page, url, savePath) {
  let loadedBytes = 0;
  const pendingRequests = new Set();
  const failedRequests = [];

  // 监控请求状态
  page.on('request', request => {
    pendingRequests.add(request.url());
  });

  page.on('response', resp => {
    pendingRequests.delete(resp.url());
    const clen = resp.headers()['content-length'];
    if (clen) {
      loadedBytes += parseInt(clen, 10);
      process.stdout.write(`\r読込済み: ${(loadedBytes/1024).toFixed(1)} KB`);
    }
    
    // 记录失败的请求
    if (resp.status() >= 400) {
      failedRequests.push({
        url: resp.url(),
        status: resp.status(),
        statusText: resp.statusText()
      });
    }
  });

  page.on('requestfailed', request => {
    pendingRequests.delete(request.url());
    failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText || 'Unknown error'
    });
  });

  // 从URL参数中读取WP_USER和WP_PASS，WP_USER非必须
  let wpUser = null;
  let wpPass = null;
  try {
    const urlObj = new URL(url);
    if (urlObj.searchParams.has('WP_USER')) {
      wpUser = urlObj.searchParams.get('WP_USER');
      urlObj.searchParams.delete('WP_USER');
    }
    if (urlObj.searchParams.has('WP_PASS')) {
      wpPass = urlObj.searchParams.get('WP_PASS');
      urlObj.searchParams.delete('WP_PASS');
    }
    url = urlObj.toString();
  } catch {}

  let gotoError = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // 如果有WP_PASS且检测到WordPress登录表单，则自动登录
    if (wpPass && await page.$('form#loginform')) {
      console.log('\n🔑 WordPressログインページを検出、自動ログインします...');

      // 用户名输入框
      if (wpUser) {
        if (await page.$('input#user')) {
          console.log('→ input#user にユーザー名を入力します');
          await page.type('input#user', wpUser, { delay: 50 });
        } else if (await page.$('input[name="log"]')) {
          console.log('→ input[name="log"] にユーザー名を入力します');
          await page.type('input[name="log"]', wpUser, { delay: 50 });
        } else {
          console.log('⚠️ ユーザー名入力欄が見つかりません');
        }
      }

      // 密码输入框
      if (await page.$('input#pass')) {
        console.log('→ input#pass にパスワードを入力します');
        await page.type('input#pass', wpPass, { delay: 50 });
      } else if (await page.$('input[type="password"]')) {
        console.log('→ input[type="password"] にパスワードを入力します');
        await page.type('input[type="password"]', wpPass, { delay: 50 });
      } else {
        console.log('⚠️ パスワード入力欄が見つかりません');
      }

      // 登录按钮
      if (await page.$('input#wp-submit')) {
        console.log('→ input#wp-submit をクリックします');
        await page.click('input#wp-submit');
      } else if (await page.$('input[type="submit"]')) {
        console.log('→ input[type="submit"] をクリックします');
        await page.click('input[type="submit"]');
      } else {
        console.log('⚠️ ログインボタンが見つかりません');
      }

      console.log('→ ログイン後の遷移を待機します...');
      await page.waitForNavigation({ waitUntil: 'load', timeout: 20000 });
      console.log('✅ ログイン成功');
      // 登录后等待额外2秒，确保动态内容渲染
      await page.waitForTimeout(2000);
    } else {
      // 普通页面 - 改用load而非networkidle
      await page.waitForLoadState('load', { timeout: 20000 });
      // 等待额外2秒，确保动态内容和延迟脚本完成
      await page.waitForTimeout(2000);
    }
  } catch (err) {
    gotoError = err;
    console.warn(`\n⚠️ ページの完全な読込を待てませんでした（タイムアウト）。現在の状態でスクリーンショットを保存します。`);
    
    // 超时详细信息
    console.log(`🔍 タイムアウト詳細:`);
    console.log(`   エラー: ${err.message}`);
    
    if (pendingRequests.size > 0) {
      console.log(`   未完了リクエスト数: ${pendingRequests.size}`);
      const pendingArray = Array.from(pendingRequests).slice(0, 5);
      pendingArray.forEach((req, idx) => {
        console.log(`   [${idx + 1}] ${req}`);
      });
      if (pendingRequests.size > 5) {
        console.log(`   ... 他 ${pendingRequests.size - 5} 件`);
      }
    }
    
    if (failedRequests.length > 0) {
      console.log(`   失敗リクエスト数: ${failedRequests.length}`);
      failedRequests.slice(0, 3).forEach((req, idx) => {
        if (req.status) {
          console.log(`   [${idx + 1}] ${req.status} ${req.statusText}: ${req.url}`);
        } else {
          console.log(`   [${idx + 1}] ${req.error}: ${req.url}`);
        }
      });
      if (failedRequests.length > 3) {
        console.log(`   ... 他 ${failedRequests.length - 3} 件`);
      }
    }
  }
  process.stdout.write('\n');

  // ページ読込完了後に特定の要素を探してクリック
  try {
    // 1. <x-t data-ttr="dismiss" data-ttr-dismiss="" data-ttr-done="1"></x-t> を探してクリック
    const dismissElement = await page.$('x-t[data-ttr="dismiss"][data-ttr-dismiss=""][data-ttr-done="1"]');
    if (dismissElement) {
      console.log('🎯 dismissエレメントを検出、クリックします...');
      await dismissElement.click();
      await page.waitForTimeout(500); // クリック後の処理を待機
    }

    // 2. #onetrust-close-btn-container>button を探してクリック
    const onetrustButton = await page.$('#onetrust-close-btn-container > button');
    if (onetrustButton) {
      console.log('🎯 OneTrustクローズボタンを検出、クリックします...');
      await onetrustButton.click();
      await page.waitForTimeout(500); // クリック後の処理を待機
    }

    // 両方の要素をクリック後、追加で2秒待機
    if (dismissElement || onetrustButton) {
      await page.waitForTimeout(2000);
      console.log('✅ エレメントクリック完了、2秒待機しました');
    }
  } catch (err) {
    console.log(`⚠️ エレメントクリック中にエラー: ${err.message}`);
  }

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

  const userChoice = await askUserMode();
  const mode = userChoice.mode;
  const device = userChoice.device;
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
    const deviceSuffix = device === 'mobile' ? '-sp' : '';
    const finalFilename = prefix + filename.replace('.png', deviceSuffix + '.png');
    const savePath = path.join(BEFORE_DIR, finalFilename);

    const contextOptions = {
      viewport: device === 'mobile' ? { width: 390, height: 844 } : { width: 1920, height: 1080 }
    };
    if (basicID && basicPW) {
      contextOptions.httpCredentials = { username: basicID, password: basicPW };
    }

    // 并发任务封装，捕获当前的counter值
    const currentCounter = counter;
    tasks.push(async () => {
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      try {
        console.log(`\n[${currentCounter}] 取得中: ${cleanUrl}`);
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
