const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const BASE_DIR = path.join(__dirname, 'jmam_assets');
const CSS_DIR = path.join(BASE_DIR, 'css');
const JS_DIR = path.join(BASE_DIR, 'js');

// 自动创建文件夹
fs.mkdirSync(CSS_DIR, { recursive: true });
fs.mkdirSync(JS_DIR, { recursive: true });

// 资源列表
const urls = [
  // CSS
  "https://www.jmam.co.jp/assets/css_hrm/lightbox.css",
  "https://www.jmam.co.jp/assets/css/hrm/style.css",
  "https://www.jmam.co.jp/assets/css_hrm/slick.css",
  "https://www.jmam.co.jp/assets/css_hrm/slick-theme.css",
  "https://www.jmam.co.jp/assets/css/hrm/module.css",
  "https://www.jmam.co.jp/assets/css/hrm/new-common.css",
  "https://www.jmam.co.jp/assets/css/hrm/common.css",

  // JS
  "https://www.jmam.co.jp/assets/js_hrm/vendor/mobile-detect.min.js",
  "https://www.jmam.co.jp/js/vendor/jquery-3.2.1.min.js",
  "https://www.jmam.co.jp/assets/js_hrm/vendor/slick.min.js",
  "https://www.jmam.co.jp/assets/js_hrm/plugins.js",
  "https://www.jmam.co.jp/assets/js_hrm/main.js",
  "https://www.jmam.co.jp/assets/js_hrm/lightbox.js",
  "https://www.jmam.co.jp/assets/js/lib/jquery.min.js",
  "https://www.jmam.co.jp/assets/js/common.min.js",
  "https://www.jmam.co.jp/assets/js/lib/slick.min.js",
  "https://www.jmam.co.jp/assets/js/lib/js.cookie.js",
  "https://www.jmam.co.jp/assets/js/hrm/elearning_lib/elr_common.js",
];

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, (res) => {
      if (res.statusCode === 302 && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed with status ${res.statusCode}`));
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(resolve));
    }).on('error', reject);
  });
}

(async () => {
  for (const url of urls) {
    try {
      const urlObj = new URL(url);
      const fileName = urlObj.pathname.split('/').pop().split('?')[0];
      const ext = path.extname(fileName);
      const targetDir = ext === '.css' ? CSS_DIR : JS_DIR;
      const filePath = path.join(targetDir, fileName);
      console.log(`⬇️ Downloading ${url}`);
      await downloadFile(url, filePath);
    } catch (err) {
      console.error(`❌ ${url} 下载失败: ${err.message}`);
    }
  }
  console.log('✅ 所有文件已保存到 jmam_assets/css 和 jmam_assets/js');
})();
