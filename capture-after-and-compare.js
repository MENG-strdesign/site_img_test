const fs = require('fs');
const path = require('path');
const fse = require('fs-extra');
const { PNG } = require('pngjs');
const { default: pixelmatch } = require('pixelmatch');
const { chromium } = require('playwright');
const readline = require('readline');
const { default: open } = require('open');
const { default: inquirer } = require('inquirer');
let mode;
let counter = 1;
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
      if (r.percent.toFixed(2) == 0) {
        diffStatus = `<span style="color:green;">一致</span>`;
      } else if (r.percent.toFixed(2) < 1) {
        diffStatus = `<span style="color:orange;">軽微な差分あり</span>`;
      } else {
        diffStatus = `<span style="color:red;">差分あり</span>`;
      }
    }

    const linksList = [];
    // console.log("r.beforeFilename",r.beforeFilename)
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
    rows += `
<tr>
  <td>${r.rawUrl}</td>
  <td>${r.afterFilename}</td>
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
  if (CLEAN_BEFORE_RUN) {
    cleanDirs();
  } else {
    [AFTER_DIR, DIFF_DIR, COMPARE_DIR].forEach(dir => {
      fse.ensureDirSync(dir);
    });
  }

  // 替换原有 URL 读取部分
  if (!fs.existsSync(URL_FILE)) {
    console.error(`❌ URLファイルが見つかりません: ${URL_FILE}`);
    process.exit(1);
  }
  mode = await askUserMode(); // 用户选择模式

  const rawLines = fs.readFileSync(URL_FILE, 'utf-8').split('\n');

  let started = mode === 'same';
  const urls = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (!started) {
      if (trimmed.toLowerCase() === '#after') {
        started = true;
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

  for (const url of urls) {
    const { cleanUrl, basicID, basicPW, filename, rawUrl } = parseUrlInfo(url);
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

    const afterPath = path.join(AFTER_DIR, finalFilename);
        // 查找与 filename 前缀三位数字相同的 BEFORE 文件
    // 取用于比较的前缀（仅在 different 模式下才有前缀）
    const filePrefix = mode === 'different' ? String(counter).padStart(3, '0') + '_' : '';
    const beforeFile = fs.readdirSync(BEFORE_DIR).find(name => name.startsWith(filePrefix));
    const beforePath = mode === 'different' ? path.join(BEFORE_DIR, beforeFile) : path.join(BEFORE_DIR, filename);
    const diffPath = path.join(DIFF_DIR, finalFilename);
    const comparePath = path.join(COMPARE_DIR, finalFilename);

    try {
      const response = await page.goto(cleanUrl, { waitUntil: 'networkidle', timeout: 20000 });

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
        finalFilename,
        diffPixels: -1,
        percent: 0,
        error: `キャプチャ失敗: ${err.message}`
      });
      continue;
    }




    let diffPixels = -1;
    let percent = 0;

    if (beforePath && fs.existsSync(beforePath)) {
      try {
        const result = compareImages(beforePath, afterPath, diffPath, comparePath);
        diffPixels = result.diffPixels;
        percent = result.percent;
        console.log(`🧪 比較成功: ${finalFilename} ← ${path.basename(beforePath)} 差分ピクセル=${diffPixels} 割合=${percent.toFixed(2)}%`);
      } catch (err) {
        console.error(`❌ 比較失敗: ${finalFilename} - ${err.message}`);
        results.push({ rawUrl, beforeFilename:path.basename(beforePath), afterFilename:finalFilename, diffPixels: -1, percent: 0, error: `比較失敗: ${err.message}` });
        await page.close();
        await context.close();
        continue;
      }
    } else {
      console.warn(`⚠️ 比較対象のBEFORE画像が見つかりません: prefix=${filePrefix}`);
    }

    results.push({ rawUrl, beforeFilename:path.basename(beforePath),afterFilename:finalFilename, diffPixels, percent });

    await page.close();
    await context.close();
    counter++;
  }

  await browser.close();

  const html = generateHTMLReport(results);
  fs.writeFileSync(REPORT_FILE, html);

  const total = results.length;
  const okCount = results.filter(r => r.diffPixels === 0).length;
  const diffCount = results.filter(r => {
    return r.diffPixels > 0 && r.percent.toFixed(2) > 0.01
  }).length;
  const smallDiffCount = results.filter(r => {
    return r.diffPixels > 0 && r.percent.toFixed(2) <= 0.01
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
