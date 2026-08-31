# 跨解析度 PageUp／PageDown

這是一支給 Tampermonkey 使用的純前端 userscript。輕按 `PageUp`／`PageDown` 時，依目前捲動區可見高度捲動固定比例；按住按鍵後，從第一個 auto-repeat event 開始完全交回 Chrome／Edge 原生捲動引擎。

## 連結

- [Greasy Fork 發布頁](https://greasyfork.org/zh-TW/scripts/593678-better-pageup-pagedown)
- [直接安裝 GitHub raw 版本](https://raw.githubusercontent.com/29988122/better-page-up-down/main/better-page-up-down.user.js)
- [GitHub 原始碼](https://github.com/29988122/better-page-up-down)
- [問題回報](https://github.com/29988122/better-page-up-down/issues)

## 安裝

1. 在 Chrome 或 Edge 安裝並啟用 Tampermonkey。
2. 開啟 Tampermonkey Dashboard，新增腳本。
3. 貼入 [`better-page-up-down.user.js`](./better-page-up-down.user.js) 全文並儲存。
4. 重新載入要使用的網頁。

## 行為

- 預設每次輕按捲動目前 scrollport 的 **85%**，保留 15% 重疊內容。
- Tampermonkey 選單提供 70%、75%、80%、85%、90%。
- 選單值保存在目前瀏覽器；新裝置首次使用仍為 85%。
- 距離在每次按鍵時重新以 `clientHeight × percentage` 計算，沒有固定 pixel 距離。
- 優先捲動鍵盤焦點所在區域，其次是最近點擊或滾輪操作的內層捲動區，最後才是整頁。
- 內層捲動區到頂或到底時，會改找仍能沿該方向捲動的祖先。
- 支援一般 scroll range，也處理 `flex-direction: column-reverse` 的負 `scrollTop` 聊天式捲動區。
- 網站已處理 PageUp／PageDown、文字輸入、組字、修飾鍵組合時不介入。
- 不使用 `stopPropagation()` 或 `stopImmediatePropagation()`。
- 單按會先同步套用 1% 位移作為即時回饋，再用約 146 ms 的 `cubic-bezier(0.42, 0, 0.58, 1)` ease-in-out 曲線完成；這條曲線與時長來自 Chromium 原生 PageDown 的逐幀量測，保留可感知的起步加速與末段煞車。
- 每一幀都以 callback 實際執行時的 `performance.now()` 計算進度；頁面掉幀時會跳到當下應有的位置，不會從中斷處重新慢慢播放。
- 每次位置更新都明確使用 `behavior: "instant"`，避免網站自身的 CSS smooth scrolling 再次加工而變慢。

## 長按限制

每次長按的第一個 `keydown` 和單按完全相同，因此第一格仍使用所選比例。瀏覽器送出第一個 `repeat === true` 之後，本腳本不再阻止、取消或修改任何事件；後續速度與 cadence 由作業系統及 Chromium 決定。

## 不支援範圍

Tampermonkey 無法注入的受保護頁面不在支援範圍，例如 `chrome://`、`edge://`、Chrome Web Store、擴充套件頁及 Chromium 內建 PDF viewer。遇到無法可靠辨識捲動目標的特殊 Web App，腳本會保留原生行為。

## 測試

```bash
node --test test/userscript.test.mjs
```

瀏覽器 fixture 位於 `test/browser-fixture.html`，涵蓋根頁面、nested scroller、祖先 fallback、網站快捷鍵、互動元件、auto-repeat 與多種 viewport／比例。

`test/browser-runner.js` 是可交給 Playwright CLI `run-code` 的真實瀏覽器測試，另含十次 timing trace、40 ms long-task 追趕、快速連按及 reduced-motion 驗收。先從專案根目錄以 HTTP server 提供 fixture，再在 Chromium 執行該 runner。

## 授權

[MIT License](./LICENSE)
