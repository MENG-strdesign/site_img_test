const fs = require('fs');
const path = require('path');
const fse = require('fs-extra');
const { PNG } = require('pngjs');
const { default: pixelmatch } = require('pixelmatch');
const { chromium } = require('playwright');
const readline = require('readline');
const { default: open } = require('open');
const { default: inquirer } = require('inquirer');
const pLimit = require('p-limit').default;

let mode;
let device;
let counter = 1;
let beforeUrls = [];
const BEFORE_DIR = 'before';
const AFTER_DIR = 'after';
const DIFF_DIR = 'diff';
const COMPARE_DIR = 'compare';
const URL_FILE = 'url.txt';
const REPORT_FILE = 'report.html';
const reportFullPath = path.resolve(REPORT_FILE);

// 実行前にディレクトリを空にするかどうか
const CLEAN_BEFORE_RUN = true;
const CONCURRENCY = 3; // 并发数，可根据机器性能调整

function cleanDirs() {
  [AFTER_DIR, DIFF_DIR, COMPARE_DIR].forEach(dir => {
    if (fse.existsSync(dir)) {
      fse.emptyDirSync(dir);
      console.log(`🧹 ディレクトリをクリーンしました: ${dir}`);
    } else {
      fse.ensureDirSync(dir);
      console.log(`📁 ディレクトリを作成しました: ${dir}`);
    }
  });
}

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

  return { cleanUrl, basicID, basicPW, filename, rawUrl };
}

function blendYellow(r, g, b, a, alpha = 0.5) {
  const yR = 255;
  const yG = 255;
  const yB = 0;
  return {
    r: Math.round(r * (1 - alpha) + yR * alpha),
    g: Math.round(g * (1 - alpha) + yG * alpha),
    b: Math.round(b * (1 - alpha) + yB * alpha),
    a: a
  };
}

function compareImages(beforePath, afterPath, diffPath, comparePath) {
  let imgBefore = PNG.sync.read(fs.readFileSync(beforePath));
  let imgAfter = PNG.sync.read(fs.readFileSync(afterPath));

  // 计算统一宽高（取较大）
  const width = Math.max(imgBefore.width, imgAfter.width);
  const height = Math.max(imgBefore.height, imgAfter.height);

  // 将原图扩展到统一尺寸（右下填充透明）
  const expandTo = (img, targetW, targetH) => {
    if (img.width === targetW && img.height === targetH) return img;
    const expanded = new PNG({ width: targetW, height: targetH });
    PNG.bitblt(img, expanded, 0, 0, img.width, img.height, 0, 0);
    return expanded;
  };

  imgBefore = expandTo(imgBefore, width, height);
  imgAfter = expandTo(imgAfter, width, height);

  // 创建差分图
  const diff = new PNG({ width, height });

  const diffPixels = pixelmatch(
    imgBefore.data,
    imgAfter.data,
    diff.data,
    width,
    height,
    {
      threshold: 0.1,
      includeAA: true,
      alpha: 0.5,
      diffColor: [255, 255, 0],
      diffColorAlt: [255, 255, 0],
    }
  );

  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  // 生成对比图（左右拼接）
  const compare = new PNG({ width: width * 2, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      const leftIdx = (y * (width * 2) + x) << 2;
      const rightIdx = (y * (width * 2) + x + width) << 2;

      const isDiff =
        imgBefore.data[idx] !== imgAfter.data[idx] ||
        imgBefore.data[idx + 1] !== imgAfter.data[idx + 1] ||
        imgBefore.data[idx + 2] !== imgAfter.data[idx + 2] ||
        imgBefore.data[idx + 3] !== imgAfter.data[idx + 3];

      // left side: before
      if (isDiff) {
        const blended = blendYellow(
          imgBefore.data[idx],
          imgBefore.data[idx + 1],
          imgBefore.data[idx + 2],
          imgBefore.data[idx + 3],
          0.5
        );
        compare.data[leftIdx] = blended.r;
        compare.data[leftIdx + 1] = blended.g;
        compare.data[leftIdx + 2] = blended.b;
        compare.data[leftIdx + 3] = blended.a;
      } else {
        compare.data[leftIdx] = imgBefore.data[idx];
        compare.data[leftIdx + 1] = imgBefore.data[idx + 1];
        compare.data[leftIdx + 2] = imgBefore.data[idx + 2];
        compare.data[leftIdx + 3] = imgBefore.data[idx + 3];
      }

      // right side: after
      if (isDiff) {
        const blended = blendYellow(
          imgAfter.data[idx],
          imgAfter.data[idx + 1],
          imgAfter.data[idx + 2],
          imgAfter.data[idx + 3],
          0.5
        );
        compare.data[rightIdx] = blended.r;
        compare.data[rightIdx + 1] = blended.g;
        compare.data[rightIdx + 2] = blended.b;
        compare.data[rightIdx + 3] = blended.a;
      } else {
        compare.data[rightIdx] = imgAfter.data[idx];
        compare.data[rightIdx + 1] = imgAfter.data[idx + 1];
        compare.data[rightIdx + 2] = imgAfter.data[idx + 2];
        compare.data[rightIdx + 3] = imgAfter.data[idx + 3];
      }
    }
  }

  fs.writeFileSync(comparePath, PNG.sync.write(compare));
  const percent = (diffPixels / (width * height)) * 100;
  return { diffPixels, percent };
}





function generateHTMLReport(results) {
  try {

    let rows = '';
    results.forEach(r => {
      let diffStatus = '';
      let diffPixels = r.diffPixels >= 0 ? r.diffPixels : '―';
      let percent = r.diffPixels >= 0 ? r.percent.toFixed(3) + '%' : '―';

      if (r.error) {
        if (r.error.includes('認証失敗')) {
          diffStatus = `<span style="color:orange;">Basic認証失敗</span>`;
        } else {
          diffStatus = `<span style="color:red;">エラー</span>`;
        }
      } else if (r.diffPixels === -1) {
        diffStatus = `<span style="color:orange;">比較なし</span>`;
      } else if (r.diffPixels === 0) {
        diffStatus = `<span style="color:green;">完全一致</span>`;
      } else {
        if (r.percent.toFixed(3) == 0) {
          diffStatus = `<span style="color:green;">一致</span>`;
        } else if (r.percent.toFixed(3) < 0.01 && r.percent.toFixed(3) > 0.001) {
          diffStatus = `<span style="color:orange;">軽微な差分あり</span>`;
        } else {
          diffStatus = `<span style="color:red;">差分あり</span>`;
        }
      }

      const linksList = [];
      const beforePath = path.join(BEFORE_DIR, r.beforeFilename);
      const afterPath = path.join(AFTER_DIR, r.afterFilename);
      const diffPath = path.join(DIFF_DIR, r.afterFilename);
      const comparePath = path.join(COMPARE_DIR, r.afterFilename);

      if (fs.existsSync(beforePath)) {
        linksList.push(`<a href="${beforePath}" target="_blank">Before</a>`);
      }
      if (fs.existsSync(afterPath)) {
        linksList.push(`<a href="${afterPath}" target="_blank">After</a>`);
      }
      if (fs.existsSync(diffPath)) {
        linksList.push(`<a href="${diffPath}" target="_blank">Diff</a>`);
      }
      if (fs.existsSync(comparePath)) {
        linksList.push(`<a href="${comparePath}" target="_blank">Compare</a>`);
      }

      const links = linksList.length > 0 ? linksList.join(' | ') : '-';

      // 新增：URL列变为可点击a标签，链接为不含basic认证参数的cleanUrl
      // r.rawUrl 里可能有basicID/basicPW，r.beforeUrl 也是
      // 取出r.rawUrl和r.beforeUrl的clean部分
      let afterUrl = r.rawUrl;
      let beforeUrl = r.beforeUrl;
      try {
        const afterObj = new URL(afterUrl);
        afterObj.searchParams.delete('basicID');
        afterObj.searchParams.delete('basicPW');
        afterUrl = afterObj.toString();
      } catch {}
      try {
        const beforeObj = new URL(beforeUrl);
        beforeObj.searchParams.delete('basicID');
        beforeObj.searchParams.delete('basicPW');
        beforeUrl = beforeObj.toString();
      } catch {}

      rows += `
<tr>
  <td>
    Before: <a href="${beforeUrl}" target="_blank">${beforeUrl}</a><br>
    After: <a href="${afterUrl}" target="_blank">${afterUrl}</a>
  </td>
  <td>Before: ${r.beforeFilename}<br>After: <span style="">${r.afterFilename}</span></td>
  <td>${diffPixels}</td>
  <td>${percent}</td>
  <td>${diffStatus}</td>
  <td>${links}</td>
</tr>`;

    });

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<title>比較レポート</title>
<style>
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 8px; text-align: center; }
  th { background-color: #f4f4f4; }
  td a { margin: 0 2px; }
</style>
</head>
<body>
<h1>比較レポート</h1>
<table>
<thead>
<tr>
  <th>URL</th>
  <th>ファイル名</th>
  <th>差分ピクセル数</th>
  <th>差分割合</th>
  <th>テスト結果</th>
  <th>画像リンク</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;

  } catch (error) {
    console.log(error)
  }
}


function askToOpenReport() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('レポートをブラウザで開きますか？(y/n) ', answer => {
    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      open(reportFullPath);
    }
    rl.close();
  });
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
async function captureWithProgress(page, url, afterPath) {
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

  let response = null;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // 如果有WP_PASS且检测到WordPress登录表单，则自动登录（WP_USER非必须）
    if (wpPass && await page.$('form#loginform')) {
      console.log('\n🔑 WordPressログインページを検出、自動ログインします...');
      if (wpUser) {
        await page.type('input#user', wpUser, { delay: 50 });
      }
      await page.type('input#pass', wpPass, { delay: 50 });
      await page.click('input#wp-submit');
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

  await page.screenshot({ path: afterPath, fullPage: true });
  return response;
}

async function main() {
  if (CLEAN_BEFORE_RUN) {
    cleanDirs();
  } else {
    [AFTER_DIR, DIFF_DIR, COMPARE_DIR].forEach(dir => {
      fse.ensureDirSync(dir);
    });
  }

  if (!fs.existsSync(URL_FILE)) {
    console.error(`❌ URLファイルが見つかりません: ${URL_FILE}`);
    process.exit(1);
  }
  const userChoice = await askUserMode();
  mode = userChoice.mode;
  device = userChoice.device;

  const rawLines = fs.readFileSync(URL_FILE, 'utf-8').split('\n');
  let started = mode === 'same';
  const urls = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!started) {
      if (trimmed.toLowerCase() === '#after') {
        started = true;
      } else if (trimmed.toLowerCase() !== '#before') {
        beforeUrls.push(trimmed);
      }
      continue;
    }
    if (trimmed.startsWith('#')) continue;
    urls.push(trimmed);
  }

  if (urls.length === 0) {
    console.log('⚠️ #AFTER以降にURLが1つもありません。url.txtを確認してください。');
    process.exit(0);
  }
  const browser = await chromium.launch();
  const results = [];
  const limit = pLimit(CONCURRENCY);

  await Promise.all(urls.map((url, idx) => limit(async () => {
    const { cleanUrl, basicID, basicPW, filename, rawUrl } = parseUrlInfo(url);
    const prefix = mode === 'different' ? String(idx + 1).padStart(3, '0') + '_' : '';
    const deviceSuffix = device === 'mobile' ? '-sp' : '';
    const finalFilename = prefix + filename.replace('.png', deviceSuffix + '.png');
    const contextOptions = {
      viewport: device === 'mobile' ? { width: 390, height: 844 } : { width: 1920, height: 1080 }
    };
    if (basicID && basicPW) {
      contextOptions.httpCredentials = { username: basicID, password: basicPW };
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    const afterPath = path.join(AFTER_DIR, finalFilename);
    const filePrefix = mode === 'different' ? String(idx + 1).padStart(3, '0') + '_' : '';
    const beforeFile = fs.readdirSync(BEFORE_DIR).find(name => name.startsWith(filePrefix) && name.includes(deviceSuffix));
    const beforePath = mode === 'different' ? path.join(BEFORE_DIR, beforeFile) : path.join(BEFORE_DIR, filename.replace('.png', deviceSuffix + '.png'));
    const diffPath = path.join(DIFF_DIR, finalFilename);
    const comparePath = path.join(COMPARE_DIR, finalFilename);

    try {
      console.log(`\n[${idx + 1}/${urls.length}] 取得中: ${cleanUrl}`);
      const response = await captureWithProgress(page, cleanUrl, afterPath);

      if (response && typeof response.status === 'function' && response.status() === 401) {
        console.warn(`⚠️ 認証失敗: ${cleanUrl} - ステータス401`);
        results[idx] = {
          rawUrl,
          filename,
          diffPixels: -1,
          percent: 0,
          error: '認証失敗: ステータス401'
        };
        await page.close();
        await context.close();
        return;
      }
      console.log(`\n✅ AFTER画像取得成功: ${cleanUrl} → ${afterPath}`);
    } catch (err) {
      console.error(`\n❌ キャプチャ失敗: ${cleanUrl} - ${err.message}`);
      await page.close();
      await context.close();
      results[idx] = {
        rawUrl,
        finalFilename,
        diffPixels: -1,
        percent: 0,
        error: `キャプチャ失敗: ${err.message}`
      };
      return;
    }

    // 检查 beforePath 是否有效
    let diffPixels = -1;
    let percent = 0;
    if (beforePath && fs.existsSync(beforePath)) {
      try {
        const result = compareImages(beforePath, afterPath, diffPath, comparePath);
        diffPixels = result.diffPixels;
        percent = result.percent;
        console.log(`🧪 比較成功: ${finalFilename} ← ${path.basename(beforePath)} 差分ピクセル=${diffPixels} 割合=${percent.toFixed(3)}%`);
      } catch (err) {
        console.error(`❌ 比較失敗: ${finalFilename} - ${err.message}`);
        results[idx] = { rawUrl, beforeFilename: path.basename(beforePath), afterFilename: finalFilename, diffPixels: -1, percent: 0, error: `比較失敗: ${err.message}` };
        await page.close();
        await context.close();
        return;
      }
    } else {
      console.warn(`⚠️ 比較対象のBEFORE画像が見つかりません: prefix=${filePrefix}`);
      results[idx] = { rawUrl, beforeFilename: beforePath ? path.basename(beforePath) : '', afterFilename: finalFilename, diffPixels: -1, percent: 0, error: 'BEFORE画像が見つかりません' };
      await page.close();
      await context.close();
      return;
    }
    results[idx] = { rawUrl, beforeUrl: beforeUrls[idx], beforeFilename: path.basename(beforePath), afterFilename: finalFilename, diffPixels, percent };
    await page.close();
    await context.close();
  })));

  await browser.close();

  const html = generateHTMLReport(results);
  fs.writeFileSync(REPORT_FILE, html);

  const total = results.length;
  const okCount = results.filter(r => r.diffPixels === 0 || r.percent.toFixed(3) < 0.001).length;
  const diffCount = results.filter(r => {
    return r.diffPixels > 0 && r.percent.toFixed(3) > 0.01
  }).length;
  const smallDiffCount = results.filter(r => {
    return r.percent.toFixed(3) > 0.001 && r.percent.toFixed(3) <= 0.01
  }).length;
  const errorCount = results.filter(r => r.diffPixels < 0 || r.error).length;

  console.log('\n===== テスト結果 =====');
  console.log(`合計URL数: ${total}`);
  console.log(`差分なし (OK): ${okCount}`);
  console.log(`軽微な差分あり (DIFFERENT): ${smallDiffCount}`);
  console.log(`大きな差分あり (DIFFERENT): ${diffCount}`);
  console.log(`比較失敗 (ERROR): ${errorCount}`);
  console.log(`レポートファイル: file://${reportFullPath}`);
  console.log('====================\n');

  askToOpenReport();
}


main().catch(err => {
  console.error(`エラー: ${err}`);
  process.exit(1);
});
