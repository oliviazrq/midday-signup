/*************************************************************************
 *  Vercel Serverless Function —— 飛書多維表格（Bitable）報名後端
 *  路徑：/api/registration
 *  ----------------------------------------------------------------------
 *  作用：外部主播在公開報名頁送出的資料，經過這支函式安全地寫進你的
 *        飛書多維表格；查詢、匯出也都由這裡處理。
 *        飛書的 App Secret 只放在伺服器環境變數，不會出現在網頁裡。
 *
 *  【本版重點｜一位主播一行】
 *    - 原始報名表現在採「一位主播（同一期）＝一行」結構。
 *    - 主播每報名一個新時段，會「合併寫進同一行」的「申請時段」欄，
 *      不會再新增一列，所以整張表維持一主播一行、按報名時間排序。
 *    - 審核狀態一個主播（同一期）只有一個，運營直接在這行改即可。
 *    - action=resync 可把任何殘留的多列自動合併回一行（自我修復）。
 *
 *  【需要設定的 Vercel 環境變數 (Settings → Environment Variables)】
 *    FEISHU_APP_ID       自建應用的 App ID
 *    FEISHU_APP_SECRET   自建應用的 App Secret
 *    FEISHU_APP_TOKEN    多維表格的 app_token（Base ID）
 *    FEISHU_TABLE_ID     資料表的 table_id
 *    FEISHU_DOMAIN       (選填) 飛書=https://open.feishu.cn (預設)
 *                              Lark 國際版=https://open.larksuite.com
 *************************************************************************/

const DOMAIN = process.env.FEISHU_DOMAIN || 'https://open.feishu.cn';
const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const APP_TOKEN = process.env.FEISHU_APP_TOKEN;
const TABLE_ID = process.env.FEISHU_TABLE_ID;
const ONE_SLOT_PER_DAY = true;

// 飛書多維表格的欄位名稱（對應你表格裡實際的欄位）
const F = {
  submitted_at: '報名時間', plan: '參與活動', scanned: '掃碼授權',
  username: 'TikTok使用者名稱', videourl: '作品連結', period: '期數',
  slots: '申請時段', key: 'key',
  status: '審核狀態', notify: '通知訊息'
};
const STATUS_MAP = { '待審核': 'pending', '已通過': 'approved', '未通過': 'rejected' };

async function token() {
  const r = await fetch(DOMAIN + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const j = await r.json();
  if (!j.tenant_access_token) throw new Error('取得飛書 token 失敗：' + (j.msg || JSON.stringify(j)));
  return j.tenant_access_token;
}

// 回傳 [{ id, fields }]，帶 record_id 以便就地更新（一主播一行的關鍵）
async function listAll(tk) {
  const out = [];
  let pageToken = '';
  do {
    const url = DOMAIN + '/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID +
      '/records?page_size=500' + (pageToken ? '&page_token=' + pageToken : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tk } });
    const j = await r.json();
    if (j.code !== 0) throw new Error('讀取表格失敗：' + (j.msg || JSON.stringify(j)));
    (j.data.items || []).forEach(it => out.push({ id: it.record_id, fields: it.fields || {} }));
    pageToken = j.data.has_more ? j.data.page_token : '';
  } while (pageToken);
  return out;
}

const txt = v => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => (x && x.text) || x).join('');
  if (typeof v === 'object') return v.text || v.link || '';
  return String(v);
};
function normU(s) { return String(s || '').trim().toLowerCase().replace(/^@/, ''); }
function lines(s) { return txt(s).split('\n').map(x => x.trim()).filter(Boolean); }
// 「作品連結」是 URL 型欄位，Bitable API 需要 { link, text } 物件格式，不能寫純字串
function urlCell(raw) {
  let link = '', text = '';
  if (raw == null) { link = text = ''; }
  else if (Array.isArray(raw)) { raw.forEach(x => { if (x && x.link) link = x.link; if (x && x.text) text = x.text; }); }
  else if (typeof raw === 'object') { link = raw.link || ''; text = raw.text || ''; }
  else { link = text = String(raw); }
  link = link || text; text = text || link;
  if (!link) return null;
  return { link, text };
}
function submitMs(s) {
  if (!s) return 0;
  const t = Date.parse(String(s).trim().replace(' ', 'T') + '+08:00');
  return isNaN(t) ? 0 : t;
}
function nowStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}
function periodName(p) {
  if (p === '4') return '第四期';
  if (p === '3') return '第三期';
  return p ? ('第' + p + '期') : '其他';
}
function aggStatus(labels) {
  if (labels.some(l => l === '未通過')) return '未通過';
  if (labels.length && labels.every(l => l === '已通過')) return '已通過';
  return '待審核';
}

async function createRecord(tk, fields) {
  const r = await fetch(DOMAIN + '/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID + '/records', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('寫入表格失敗：' + (j.msg || JSON.stringify(j)));
  return j;
}
async function updateRecord(tk, recordId, fields) {
  const r = await fetch(DOMAIN + '/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID + '/records/' + recordId, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('更新表格失敗：' + (j.msg || JSON.stringify(j)));
  return j;
}
async function batchDelete(tk, ids) {
  if (!ids.length) return;
  const r = await fetch(DOMAIN + '/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID + '/records/batch_delete', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: ids })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('刪除記錄失敗：' + (j.msg || JSON.stringify(j)));
  return j;
}

// 名額使用量（每個時段 key 各算一次；整位主播未通過的不計）
function usedMap(rows) {
  const used = {};
  rows.forEach(r => {
    if (txt(r.fields[F.status]) === '未通過') return;
    lines(r.fields[F.key]).forEach(k => { used[k] = (used[k] || 0) + 1; });
  });
  return used;
}

// 查詢：一位主播一行（同一期），直接回傳該行狀態與時段清單
function myRecords(rows, username) {
  const q = normU(username);
  if (!q) return [];
  const mine = rows.filter(r => normU(txt(r.fields[F.username])) === q);
  return mine.map(r => {
    const f = r.fields;
    const label = txt(f[F.status]) || '待審核';
    const p = txt(f[F.period]);
    const slotList = lines(f[F.slots]).map(s => s.replace(/^第\S+期\s*/, ''));
    const slotsText = periodName(p) + '：' + slotList.join('、');
    return {
      plan: txt(f[F.plan]), username: txt(f[F.username]), slots: slotsText,
      status: STATUS_MAP[label] || 'pending', status_label: label,
      _ms: submitMs(txt(f[F.submitted_at]))
    };
  }).sort((a, b) => a._ms - b._ms);
}

// 報名：一位主播（同一期）＝一行。已有該行 → 把新時段併進同一行；沒有 → 新建一行
async function register(tk, d) {
  const uname = String(d.username || '').trim();
  const vurl = String(d.videourl || '').trim();
  if (!d.plan) return { ok: false, detail: '缺少參與活動類型' };
  if (!uname) return { ok: false, detail: '缺少 TikTok 使用者名稱' };
  if (!/^https?:\/\/.+/.test(vurl)) return { ok: false, detail: '作品連結格式不正確' };
  if (!d.period || !d.date || !d.slot) return { ok: false, detail: '缺少申請時段' };

  const key = d.period + '|' + d.date + '|' + d.slot;
  const label = periodName(String(d.period)) + ' ' + d.date + ' ' + d.slot;
  const rows = await listAll(tk);
  const uL = normU(uname);
  const hit = rows.find(r => normU(txt(r.fields[F.username])) === uL &&
    String(txt(r.fields[F.period])) === String(d.period));

  if (hit) {
    const keys = lines(hit.fields[F.key]);
    for (const rk of keys) {
      const parts = rk.split('|');
      if (rk === key) return { ok: false, detail: '您已報名過此時段，請至「查看我的報名」確認。' };
      if (ONE_SLOT_PER_DAY && parts[1] === d.date)
        return { ok: false, detail: '同一天僅能申請一個時段，您當天已有報名。' };
    }
    const slots = lines(hit.fields[F.slots]);
    if (!slots.includes(label)) slots.push(label);
    keys.push(key);
    const fields = {};
    fields[F.submitted_at] = nowStr();
    fields[F.slots] = slots.join('\n');
    fields[F.key] = keys.join('\n');
    // 若原本作品連結為空，補上；狀態沿用原本審核結果不覆蓋
    if (!txt(hit.fields[F.videourl]) && vurl) fields[F.videourl] = { link: vurl, text: vurl };
    await updateRecord(tk, hit.id, fields);
    return { ok: true };
  }

  const fields = {};
  fields[F.submitted_at] = nowStr();
  fields[F.plan] = d.plan; fields[F.scanned] = d.scanned || '';
  fields[F.username] = uname; fields[F.videourl] = { link: vurl, text: vurl };
  fields[F.period] = String(d.period);
  fields[F.key] = key; fields[F.slots] = label;
  fields[F.status] = '待審核';
  await createRecord(tk, fields);
  return { ok: true };
}

// 自我修復：把任何殘留的「同一主播＋同期多列」合併回一行
async function resyncAll(tk) {
  const rows = await listAll(tk);
  const g = {};
  rows.forEach(r => {
    const u = normU(txt(r.fields[F.username]));
    const p = String(txt(r.fields[F.period]) || '');
    if (!u || !p) return;
    (g[u + '|' + p] = g[u + '|' + p] || []).push(r);
  });
  let merged = 0; const toDelete = [];
  for (const k of Object.keys(g)) {
    const grp = g[k];
    if (grp.length < 2) continue;
    const slots = [], keys = [], labels = [];
    let latestMs = 0, latestStr = '', plan = '', scanned = '', username = '', videourlRaw = null, period = '';
    grp.forEach(r => {
      const f = r.fields;
      lines(f[F.slots]).forEach(s => { if (!slots.includes(s)) slots.push(s); });
      lines(f[F.key]).forEach(s => { if (!keys.includes(s)) keys.push(s); });
      labels.push(txt(f[F.status]) || '待審核');
      const ms = submitMs(txt(f[F.submitted_at]));
      if (ms >= latestMs) { latestMs = ms; latestStr = txt(f[F.submitted_at]) || latestStr; }
      if (!plan) plan = txt(f[F.plan]);
      if (!scanned) scanned = txt(f[F.scanned]);
      if (!username) username = txt(f[F.username]);
      if (videourlRaw == null && txt(f[F.videourl])) videourlRaw = f[F.videourl];
      if (!period) period = txt(f[F.period]);
    });
    const fields = {};
    fields[F.submitted_at] = latestStr;
    fields[F.slots] = slots.join('\n');
    fields[F.key] = keys.join('\n');
    fields[F.status] = aggStatus(labels);
    fields[F.plan] = plan; fields[F.scanned] = scanned;
    fields[F.username] = username; fields[F.period] = period;
    const uc = urlCell(videourlRaw); if (uc) fields[F.videourl] = uc;
    await updateRecord(tk, grp[0].id, fields);
    merged++;
    grp.slice(1).forEach(r => toDelete.push(r.id));
  }
  for (let i = 0; i < toDelete.length; i += 200) await batchDelete(tk, toDelete.slice(i, i + 200));
  return { rows: rows.length, mergedGroups: merged, deletedRows: toDelete.length };
}

function csv(rows) {
  const head = ['報名時間', '參與活動', '掃碼授權', 'TikTok使用者名稱', '作品連結', '期數', '申請時段', '審核狀態'];
  const lines2 = [head.join(',')];
  rows.forEach(r => {
    const f = r.fields;
    const row = [F.submitted_at, F.plan, F.scanned, F.username, F.videourl, F.period, F.slots, F.status]
      .map(k => '"' + txt(f[k]).replace(/"/g, '""').replace(/\n/g, ' / ') + '"');
    lines2.push(row.join(','));
  });
  return '\ufeff' + lines2.join('\n');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!APP_ID || !APP_SECRET || !APP_TOKEN || !TABLE_ID) {
    return res.status(500).json({ ok: false, detail: '後端環境變數未設定完整（FEISHU_APP_ID / SECRET / APP_TOKEN / TABLE_ID）' });
  }

  try {
    const tk = await token();
    const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

    if (req.method === 'GET') {
      if (action === 'quota') return res.status(200).json({ ok: true, used: usedMap(await listAll(tk)) });
      if (action === 'my') return res.status(200).json({ ok: true, records: myRecords(await listAll(tk), req.query.username || '') });
      if (action === 'resync') return res.status(200).json({ ok: true, ...(await resyncAll(tk)) });
      if (action === 'export') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="signups.csv"');
        return res.status(200).send(csv(await listAll(tk)));
      }
      return res.status(200).json({ ok: true, msg: 'alive', ver: 'urlfix-2' });
    }

    if (req.method === 'POST') {
      let data = req.body;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
      if (!data) data = {};
      if ((data.action || 'register') === 'register') return res.status(200).json(await register(tk, data));
      return res.status(200).json({ ok: false, detail: '未知的動作' });
    }
    return res.status(405).json({ ok: false, detail: 'method not allowed' });
  } catch (err) {
    return res.status(200).json({ ok: false, detail: String(err && err.message || err) });
  }
};
