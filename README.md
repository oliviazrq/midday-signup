# 7月午間開播流量加碼計畫 · 公開報名頁（飛書多維表格版）部署指南

一個**可對外公開**的報名頁：外部主播能打開、填寫、送出，報名資料會即時進到你的**飛書多維表格（Bitable）**。頁面和後端一起部署到 Vercel，飛書的密鑰只放在伺服器端，不會外洩。

```
public-site/
├─ index.html               ← 對外公開的報名頁（生動新版）
├─ api/registration.js       ← 後端（Vercel 函式 → 飛書多維表格）
└─ README.md                 ← 你正在看的說明
```

> 💡 直接打開 `index.html` 可預覽版面（此時是「示範模式」，資料只暫存在你自己的瀏覽器）。要正式對外收單，請完成下面三步。

---

## 步驟 1️⃣ ：建立飛書自建應用 + 多維表格

**A. 建多維表格**
1. 在飛書新建一個「多維表格」，新增一個資料表。
2. 建立以下**文本欄位**（名稱要一模一樣）：
   `報名時間`、`參與活動`、`是否掃碼`、`使用者名稱`、`作品連結`、`期數`、`日期`、`時段`、`key`、`時段標籤`、`審核狀態`、`通知訊息`
3. 從網址取出兩個 ID：`https://xxx.feishu.cn/base/{app_token}?table={table_id}&...`
   - `app_token`（base 後那串）→ 之後填 `FEISHU_APP_TOKEN`
   - `table_id`（table= 後那串）→ 之後填 `FEISHU_TABLE_ID`

**B. 建自建應用拿密鑰**
1. 到飛書開放平台 <https://open.feishu.cn/app>（Lark 國際版：<https://open.larksuite.com/app>）→ 建立企業自建應用。
2. 「憑證與基礎資訊」取得 **App ID** 與 **App Secret**。
3. 「權限管理」開啟多維表格讀寫權限：`bitable:app`（或 `bitable:record` 讀寫）。
4. 把這個應用**加為該多維表格的協作者**（在多維表格右上「…」→ 新增文件應用/協作者，搜尋你的應用名稱給編輯權限），否則無權寫入。
5. 發布並讓應用生效。

---

## 步驟 2️⃣ ：部署到 Vercel（頁面 + 後端一起）

1. 到 <https://vercel.com> 用 Google / GitHub 註冊登入。
2. 把整個 `public-site` 資料夾部署上去（可用 <https://vercel.com/new> 匯入 GitHub repo，或安裝 Vercel CLI `vercel` 拖拉上傳）。Vercel 會自動把 `api/registration.js` 變成 `/api/registration` 這個 API。
3. 進 Vercel 專案 **Settings → Environment Variables**，新增：
   | 變數名 | 值 |
   |---|---|
   | `FEISHU_APP_ID` | 你的 App ID |
   | `FEISHU_APP_SECRET` | 你的 App Secret |
   | `FEISHU_APP_TOKEN` | 多維表格 app_token |
   | `FEISHU_TABLE_ID` | 資料表 table_id |
   | `FEISHU_DOMAIN` | （Lark 國際版才填）`https://open.larksuite.com` |
4. 存檔後 **Redeploy** 一次讓變數生效。

---

## 步驟 3️⃣ ：把報名頁接上後端

打開 `index.html` 最上面的 CONFIG，把 API 改成相對路徑：

```js
const CONFIG = {
  API: "/api/registration",                  // ← 改成這個
  QR_LINK: "https://www.tiktok.com/t/ZSXFg4ddf/"
};
```

存檔後重新部署。你的 `https://xxxx.vercel.app` 就是可以發給主播的公開報名連結 🎉
（`QR_LINK` 可換成正式的海外掃碼綁定連結。）

---

## ✅ 完成後怎麼用

- **發連結給主播**：他們打開就能報名，送出看到「報名已送出（待審核）」。
- **看報名資料**：打開你的飛書多維表格，每筆報名即時出現，可篩選、排序、做看板/儀表盤。
- **審核**：把某列 `審核狀態` 改成 `待審核 / 已通過 / 未通過`；主播在「🔍 查看我的報名」就會看到最新狀態。想給主播的話填 `通知訊息` 欄。
- **名額控管**：後端自動確保每時段最多 5 位（金魔杖），同一人同一天限一個時段，額滿自動顯示「額滿」。
- **匯出 CSV**：報名頁網址加 `?admin=1` 會顯示營運面板，可下載 CSV（也可直接在多維表格匯出）。

---

## 常見問題

- **送不出去 / 一直額滿是 5？** 多半是「應用沒被加為多維表格協作者」或「權限沒開 bitable 讀寫」。回步驟 1-B 檢查。
- **回傳「後端環境變數未設定完整」？** Vercel 環境變數沒填齊或沒 Redeploy。
- **用的是 Lark 國際版？** 記得把 `FEISHU_DOMAIN` 設成 `https://open.larksuite.com`，且應用要在對應平台建立。
- **合規提醒**：本頁與後端在你自己的 Vercel 帳號、資料回到公司飛書多維表格；如涉及對外蒐集個資，建議先確認符合團隊資料合規要求。
