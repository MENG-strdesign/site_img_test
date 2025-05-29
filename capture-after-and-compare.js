const fs = require('fs');
const path = require('path');
const fse = require('fs-extra');
const { PNG } = require('pngjs');
const { default: pixelmatch } = require('pixelmatch');
const { chromium } = require('playwright');
const readline = require('readline');
const { default: open } = require('open');

const BEFORE_DIR = 'before';
const AFTER_DIR = 'after';
const DIFF_DIR = 'diff';
const COMPARE_DIR = 'compare';
const URL_FILE = 'url.txt';
const REPORT_FILE = 'report.html';
const reportFullPath = path.resolve(REPORT_FILE);

// 実行前にディレクトリを空にするかどうか
const CLEAN_BEFORE_RUN = true;

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
  const imgBefore = PNG.sync.read(fs.readFileSync(beforePath));
  const imgAfter = PNG.sync.read(fs.readFileSync(afterPath));

  if (imgBefore.width !== imgAfter.width || imgBefore.height !== imgAfter.height) {
    throw new Error('画像サイズが一致しません');
  }

  const { width, height } = imgBefore;

  // 生成差分图
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
      diffColor: [255, 255, 0],      // 黄色
      diffColorAlt: [255, 255, 0],   // 不透明版本
    }
  );

  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  // 生成对比图（左右拼接：左=before，右=after+高亮差异）
  const compare = new PNG({ width: width * 2, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;

      const leftIdx = (y * (width * 2) + x) << 2;
      const rightIdx = (y * (width * 2) + (x + width)) << 2;

      // 拷贝左边 before 图像
      compare.data[leftIdx] = imgBefore.data[idx];
      compare.data[leftIdx + 1] = imgBefore.data[idx + 1];
      compare.data[leftIdx + 2] = imgBefore.data[idx + 2];
      compare.data[leftIdx + 3] = imgBefore.data[idx + 3];

      // 判断是否为差异像素
      const isDiff =
        imgBefore.data[idx] !== imgAfter.data[idx] ||
        imgBefore.data[idx + 1] !== imgAfter.data[idx + 1] ||
        imgBefore.data[idx + 2] !== imgAfter.data[idx + 2] ||
        imgBefore.data[idx + 3] !== imgAfter.data[idx + 3];

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
        // 直接复制 after 像素
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
  let rows = '';
  results.forEach(r => {
    let diffStatus = '';
    let diffPixels = r.diffPixels >= 0 ? r.diffPixels : '―';
    let percent = r.diffPixels >= 0 ? r.percent.toFixed(2) + '%' : '―';

    if (r.error) {
      if (r.error.includes('認証失敗')) {
        diffStatus = `<span style="color:orange;">Basic認証失敗</span>`;
      } else {
        diffStatus = `<span style="color:red;">エラー</span>`;
      }
    } else if (r.diffPixels === -1) {
      diffStatus = `<span style="color:orange;">比較なし</span>`;
    } else if (r.diffPixels === 0) {
      diffStatus = `<span style="color:green;">一致</span>`;
    } else {
      diffStatus = `<span style="color:red;">差分あり</span>`;
    }

    const linksList = [];

    const beforePath = path.join(BEFORE_DIR, r.filename);
    const afterPath = path.join(AFTER_DIR, r.filename);
    const diffPath = path.join(DIFF_DIR, r.filename);
    const comparePath = path.join(COMPARE_DIR, r.filename);

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
    rows += `
<tr>
  <td>${r.rawUrl}</td>
  <td>${r.filename}</td>
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

  const urls = fs.readFileSync(URL_FILE, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line);

  if (urls.length === 0) {
    console.log('⚠️ URLが1つもありません。url.txtを確認してください。');
    process.exit(0);
  }

  const browser = await chromium.launch();
  const results = [];

  for (const url of urls) {
    const { cleanUrl, basicID, basicPW, filename, rawUrl } = parseUrlInfo(url);

    const contextOptions = {
      viewport: { width: 1366, height: 768 }
    };
    if (basicID && basicPW) {
      contextOptions.httpCredentials = { username: basicID, password: basicPW };
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    const afterPath = path.join(AFTER_DIR, filename);
    const beforePath = path.join(BEFORE_DIR, filename);
    const diffPath = path.join(DIFF_DIR, filename);
    const comparePath = path.join(COMPARE_DIR, filename);

    try {
      const response = await page.goto(cleanUrl, { waitUntil: 'networkidle', timeout: 20000 });

      // Basic認証失敗の判定
      if (response && response.status() === 401) {
        console.warn(`⚠️ 認証失敗: ${cleanUrl} - ステータス401`);
        results.push({
          rawUrl,
          filename,
          diffPixels: -1,
          percent: 0,
          error: '認証失敗: ステータス401'
        });
        await page.close();
        await context.close();
        continue;
      }

      await page.screenshot({ path: afterPath, fullPage: true });
      console.log(`✅ AFTER画像取得成功: ${cleanUrl} → ${afterPath}`);
    } catch (err) {
      console.error(`❌ キャプチャ失敗: ${cleanUrl} - ${err.message}`);
      await page.close();
      await context.close();
      results.push({
        rawUrl,
        filename,
        diffPixels: -1,
        percent: 0,
        error: `キャプチャ失敗: ${err.message}`
      });
      continue;
    }


    let diffPixels = -1;
    let percent = 0;

    if (fs.existsSync(beforePath)) {
      try {
        const result = compareImages(beforePath, afterPath, diffPath, comparePath);
        diffPixels = result.diffPixels;
        percent = result.percent;
        console.log(`🧪 比較成功: ${filename} 差分ピクセル=${diffPixels} 割合=${percent.toFixed(2)}%`);
      } catch (err) {
        console.error(`❌ 比較失敗: ${filename} - ${err.message}`);
        results.push({ rawUrl, filename, diffPixels: -1, percent: 0, error: `比較失敗: ${err.message}` });
        await page.close();
        await context.close();
        continue;
      }
    } else {
      console.warn(`⚠️ BEFORE画像がありません: ${filename}`);
    }

    results.push({ rawUrl, filename, diffPixels, percent });

    await page.close();
    await context.close();
  }

  await browser.close();

  const html = generateHTMLReport(results);
  fs.writeFileSync(REPORT_FILE, html);

  const total = results.length;
  const okCount = results.filter(r => r.diffPixels === 0).length;
  const diffCount = results.filter(r => r.diffPixels > 0).length;
  const errorCount = results.filter(r => r.diffPixels < 0 || r.error).length;


  console.log('\n===== テスト結果 =====');
  console.log(`合計URL数: ${total}`);
  console.log(`差分なし (OK): ${okCount}`);
  console.log(`差分あり (DIFFERENT): ${diffCount}`);
  console.log(`比較失敗 (ERROR): ${errorCount}`);
  console.log(`レポートファイル: file://${reportFullPath}`);
  console.log('====================\n');


  askToOpenReport();
}

main().catch(err => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
