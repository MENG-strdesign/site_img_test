# ✅ 画面比較ツール使用手順

このツールは、指定した URL の Web ページをスクリーンショットし、「変更前（Before）」と「変更後（After）」の画像を比較して差分レポート（`report.html`）を自動生成するツールです。主に Web サイトのビジュアル差分確認に利用できます。

---

## ⚙️ 必要環境

このプロジェクトを実行するには、Node.js のインストールが必要です。  
以下のリンクから Node.js をインストールしてください：

👉 [Node.js ダウンロードページ](https://nodejs.org/ja)

- 推奨バージョン：**Node.js v18以上**
- `npm` も自動で含まれます

---

## 📁 ディレクトリ構成

```
project-root/
├── before/                    # 変更前のスクリーンショット保存先
├── after/                     # 変更後のスクリーンショット保存先
├── diff/                      # 差分画像の保存先
├── compare/                   # 比較画像の保存先
├── url.txt                    # 対象URL一覧（1行1URL形式）
├── capture-before.js          # 変更前のキャプチャ用スクリプト
├── capture-after-and-compare.js # 変更後のキャプチャ＆比較処理
└── report.html                # 自動生成される比較レポート
```

---

## 📝 1. URLリストを作成する

比較対象の URL を `url.txt` に 1 行ずつ記載してください。

例：(同じURLで比較する場合)

```
https://example.com/page1
https://example.com/page2
https://example.com/secure-page?basicID=username&basicPW=password
```
例：(異なるURLで比較する場合)

```
#before
https://example.com/page1
https://example.com/page2
https://example.com/secure-page?basicID=username&basicPW=password

#after
https://example2.com/page1
https://example2.com/page2
https://example2.com/secure-page?basicID=username&basicPW=password
```
※ Basic認証が必要なページには、クエリパラメータで `basicID` および `basicPW` を指定します。

---

## 📸 2. 変更前のスクリーンショットを撮影（Before）

```bash
npm run before
```

- 成功すると `before/` フォルダにスクリーンショット画像が保存されます。
- ファイル名は URL をもとに自動整形され、記号などは `_` に置換されます。

---

## ✏️ 3. サイトの変更・修正を行う

HTML/CSS/JS の修正やデザイン変更など、確認対象の更新を行ってください。

---

## 📸 4. 変更後のスクリーンショットと差分比較を実行（After & Compare）

```bash
npm run after
```

このコマンドで以下が自動実行されます：

- `after/` に新しいスクリーンショットを保存
- `diff/` に差分画像を生成（差分ピクセルのみ赤く表示）
- `compare/` に左右比較画像を生成
- `report.html` を生成し、結果を一覧表示

実行後に `レポートをブラウザで開きますか？` と表示されるので、`y` を入力してください。

---

## 📄 5. レポートの確認

生成された `report.html` をブラウザで開くと、以下の内容が確認できます：

- 各 URL に対しての Before / After / Diff / Compare の画像リンク
- 差分ピクセル数と差分率（%）
- テスト結果一覧（OK / DIFFERENT / 比較失敗）

---

## ⚠️ 差分レポートの補足

- スクリーンショットの画像サイズが一致しない場合、比較は失敗します。
- 認証エラーやアクセス失敗時には **スクリーンショットが撮影されず**、その URL は「比較失敗」として扱われます。
- 差分がない場合のみ「OK」、差分がある場合は「DIFFERENT」と表示されます。
- 認証やネットワークの問題などで画像が取得できなかった場合は、差分カウントに含まず「比較失敗」として処理されます。

---

## 🧰 使用ライブラリ

- [Puppeteer](https://github.com/puppeteer/puppeteer)：ブラウザ操作とスクリーンショット撮影
- [Pixelmatch](https://github.com/mapbox/pixelmatch)：画像の差分比較処理
- Node.js 標準モジュール（fs, path, readline など）

---

## 💬 ご不明点があれば

不具合やご質問がある場合は、開発者までお気軽にご連絡ください。