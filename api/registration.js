/*************************************************************************
 *  Vercel Serverless Function —— 飛書多維表格（Bitable）報名後端
 *  路徑：/api/registration
 *  ----------------------------------------------------------------------
 *  作用：外部主播在公開報名頁送出的資料，經過這支函式安全地寫進你的
 *        飛書多維表格；名額、查詢、匯出也都由這裡處理。
 *        飛書的 App Secret 只放在伺服器環境變數，不會出現在網頁裡。
 *
 *  【需要設定的 Vercel 環境變數 (Settings → Environment Variables)】
 *    FEISHU_APP_ID       自建應用的 App ID
 *    FEISHU_APP_SECRET   自建應用的 App Secret
 *    FEISHU_APP_TOKEN    多維表格的 app_token（Base ID）
 *    FEISHU_TABLE_ID     資料表的 table_id
 *    FEISHU_DOMAIN       (選填) 飛書=https://open.feishu.cn (預設)
 *                              Lark 國際版=https://open.larksuite.com
 *  詳見 README.md
 *************************************************************************/

const DOMAIN = process.env.FEISHU_DOMAIN || 'https://open.feishu.cn';
const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const APP_TOKEN = process.env.FEISHU_APP_TOKEN;
const TABLE_ID = process.env.FEISHU_TABLE_ID;
const QUOTA = 5;
const ONE_SLOT_PER_DAY = true;

// 飛書多維表格的欄位名稱（對應你表格裡實際的欄位）
const F = {
  submitted_at: '報名時間', plan: '參與活動', scanned: '掃碼授權',
  username: 'TikTok使用者名稱', videourl: '作品連結', period: '期數',
  slots: '申請時段', key: 'key',
  status: '審核狀態', notify: '通知訊息'
};
const STATUS_MAP = { '待審核': 'pending', '已通過': 'approved', '未通過': 'rejected' };

// ---- 主播總覽（彙總表）：一位主播一行，後端自動同步 ----
const OV_TABLE_ID = process.env.FEISHU_OVERVIEW_TABLE_ID || 'tbl5TsO0wVNlWzzR';
const OF = {
  username: 'TikTok使用者名稱', period: '期數', slotsSum: '申請時段彙總',
  slotCount: '時段數', status: '整體審核狀態', plan: '參與活動',
  videourl: '作品連結', notify: '通知訊息', latest: '最新報名時間'
};

async function token() {
  const r = await fetch(DOMAIN + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  const j = await r.json();
  if (!j.tenant_access_token) throw new Error('取得飛書 token 失敗：' + (j.msg || JSON.stringify(j)));
  return j.tenant_access_token;
}

async function listAll(tk) {
  const out = [];
  let pageToken = '';
  do {
    const url = DOMAIN + '/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID +
      '/records?page_size=500' + (pageToken ? '&page_token=' + pageToken : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tk } });
    const j = await r.json();
    if (j.code !== 0) throw new Error('讀取表格失敗：' + (j.msg || JSON.stringify(j)));
    (j.data.items || []).forEach(it => out.push(it.fields || {}));
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

async function createRecord(tk, fields) {
  const r = await fetch(DOMAIN + '/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + TABLE_ID + '/records', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('寫入表格失敗：' + (j.msg || JSON.stringify(j)));
  return j;
}

function usedMap(rows) {
  const used = {};
  rows.forEach(r => {
    if (txt(r[F.status]) === '未通過') return;
    const k = txt(r[F.key]);
    if (k) used[k] = (used[k] || 0) + 1;
  });
  return used;
}

function periodName(p) {
  if (p === '4') return '第四期';
  if (p === '3') return '第三期';
  return p ? ('第' + p + '期') : '其他';
}

// 以「主播 + 期」為維度彙整：同一期只要有一筆未通過 → 整期未通過；全部已通過 → 整期已通過；否則待審核
function myRecords(rows, username) {
  const q = String(username || '').trim().toLowerCase().replace(/^@/, '');
  if (!q) return [];
  const mine = rows.filter(r => txt(r[F.username]).trim().toLowerCase().replace(/^@/, '') === q);
  const byPeriod = {};
  mine.forEach(r => {
    const p = txt(r[F.period]) || '-';
    (byPeriod[p] = byPeriod[p] || []).push(r);
  });
  const out = [];
  Object.keys(byPeriod).sort().forEach(p => {
    const recs = byPeriod[p];
    const labels = recs.map(r => txt(r[F.status]) || '待審核');
    let label;
    if (labels.some(l => l === '未通過')) label = '未通過';
    else if (labels.length && labels.every(l => l === '已通過')) label = '已通過';
    else label = '待審核';
    const slotList = recs.map(r => txt(r[F.slots]).replace(/^第\S+期\s*/, '')).filter(Boolean);
    const slotsText = periodName(p) + '：' + slotList.join('、');
    const notify = recs.map(r => txt(r[F.notify])).filter(Boolean).join('\n');
    const submitted = recs.map(r => txt(r[F.submitted_at])).filter(Boolean).sort()[0] || '';
    out.push({
      submitted_at: submitted, plan: txt(recs[0][F.plan]), scanned: txt(recs[0][F.scanned]),
      username: txt(recs[0][F.username]), videourl: txt(recs[0][F.videourl]), slots: slotsText,
      status: STATUS_MAP[label] || 'pending', status_label: label, notify_msg: notify
    });
  });
  return out;
}

// 由原始表所有列，彙整成「主播+期」→ 總覽欄位物件
function submitMs(s) {
  if (!s) return 0;
  const t = Date.parse(String(s).trim().replace(' ', 'T') + '+08:00');
  return isNaN(t) ? 0 : t;
}
function normU(s) { return String(s || '').trim().toLowerCase().replace(/^@/, ''); }
function overviewGroups(rows) {
  const g = {};
  rows.forEach(r => {
    const u = txt(r[F.username]).trim();
    const ul = normU(u);
    const p = String(txt(r[F.period]) || '');
    if (!ul || !p) return;
    const k = ul + '|' + p;
    (g[k] = g[k] || { rows: [], username: u, period: p }).rows.push(r);
  });
  const map = {};
  Object.keys(g).forEach(k => {
    const recs = g[k].rows;
    const labels = recs.map(r => txt(r[F.status]) || '待審核');
    let label;
    if (labels.some(l => l === '未通過')) label = '未通過';
    else if (labels.length && labels.every(l => l === '已通過')) label = '已通過';
    else label = '待審核';
    let latest = 0; recs.forEach(r => { const ms = submitMs(txt(r[F.submitted_at])); if (ms > latest) latest = ms; });
    if (!latest) latest = Date.now();
    const fields = {};
    fields[OF.username] = g[k].username;
    fields[OF.period] = g[k].period;
    fields[OF.slotsSum] = recs.map(r => txt(r[F.slots])).filter(Boolean).join('\n');
    fields[OF.slotCount] = recs.length;
    fields[OF.status] = label;
    fields[OF.plan] = recs.map(r => txt(r[F.plan])).filter(Boolean)[0] || '';
    fields[OF.videourl] = recs.map(r => txt(r[F.videourl])).filter(Boolean)[0] || '';
    fields[OF.notify] = recs.map(r => txt(r[F.notify])).filter(Boolean).join('\n');
    fields[OF.latest] = latest;
    map[k] = fields;
  });
  return map;
}
async function ovList(tk) {
  const out = []; let pt = '';
  do {
    const url = DOMAIN + '/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + OV_TABLE_ID +
      '/records?page_size=500' + (pt ? '&page_token=' + pt : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tk } });
    const j = await r.json();
    if (j.code !== 0) throw new Error('讀取總覽表失敗：' + (j.msg || JSON.stringify(j)));
    (j.data.items || []).forEach(it => out.push({ id: it.record_id, fields: it.fields || {} }));
    pt = j.data.has_more ? j.data.page_token : '';
  } while (pt);
  return out;
}
async function ovBatch(tk, op, payload) {
  const r = await fetch(DOMAIN + '/open-apis/bitable/v1/apps/' + APP_TOKEN + '/tables/' + OV_TABLE_ID + '/records/' + op, {
    method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('總覽表 ' + op + ' 失敗：' + (j.msg || JSON.stringify(j)));
  return j;
}
// 即時：新報名後只同步「這一位主播＋期」，其他不動
async function syncOne(tk, rows, username, period) {
  try {
    const all = overviewGroups(rows);
    const fields = all[normU(username) + '|' + String(period)];
    if (!fields) return;
    const exist = await ovList(tk);
    const hit = exist.find(it => normU(txt(it.fields[OF.username])) === normU(username) &&
      String(txt(it.fields[OF.period])) === String(period));
    if (hit) await ovBatch(tk, 'batch_update', { records: [{ record_id: hit.id, fields }] });
    else await ovBatch(tk, 'batch_create', { records: [{ fields }] });
  } catch (e) { console.warn('overview syncOne fail:', e && e.message); }
}
// 全量：重建整張總覽（能同步後台手動改過的審核狀態），由排程或手動觸發
async function resyncAll(tk) {
  const rows = await listAll(tk);
  const desired = overviewGroups(rows);
  const exist = await ovList(tk);
  const existMap = {};
  exist.forEach(it => { existMap[normU(txt(it.fields[OF.username])) + '|' + String(txt(it.fields[OF.period]) || '')] = it.id; });
  const toCreate = [], toUpdate = [], seen = {};
  Object.keys(desired).forEach(k => {
    seen[k] = true;
    if (existMap[k]) toUpdate.push({ record_id: existMap[k], fields: desired[k] });
    else toCreate.push({ fields: desired[k] });
  });
  const toDelete = Object.keys(existMap).filter(k => !seen[k]).map(k => existMap[k]);
  const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
  for (const c of chunk(toCreate, 500)) await ovBatch(tk, 'batch_create', { records: c });
  for (const c of chunk(toUpdate, 500)) await ovBatch(tk, 'batch_update', { records: c });
  for (const c of chunk(toDelete, 500)) await ovBatch(tk, 'batch_delete', { records: c });
  return { groups: Object.keys(desired).length, created: toCreate.length, updated: toUpdate.length, deleted: toDelete.length };
}

async function register(tk, d) {
  const uname = String(d.username || '').trim();
  const vurl = String(d.videourl || '').trim();
  if (!d.plan) return { ok: false, detail: '缺少參與活動類型' };
  if (!uname) return { ok: false, detail: '缺少 TikTok 使用者名稱' };
  if (!/^https?:\/\/.+/.test(vurl)) return { ok: false, detail: '作品連結格式不正確' };
  if (!d.period || !d.date || !d.slot) return { ok: false, detail: '缺少申請時段' };

  const key = d.period + '|' + d.date + '|' + d.slot;
  const rows = await listAll(tk);
  const unameLower = uname.toLowerCase().replace(/^@/, '');
  let count = 0;
  for (const r of rows) {
    if (txt(r[F.status]) === '未通過') continue;
    const rk = txt(r[F.key]);
    const parts = rk.split('|');
    const rperiod = parts[0] || '', rdate = parts[1] || '';
    const ru = txt(r[F.username]).toLowerCase().replace(/^@/, '');
    if (rk === key) count++;
    if (rk === key && ru === unameLower) return { ok: false, detail: '您已報名過此時段，請至「查看我的報名」確認。' };
    if (ONE_SLOT_PER_DAY && rperiod == d.period && rdate == d.date && ru === unameLower)
      return { ok: false, detail: '同一天僅能申請一個時段，您當天已有報名。' };
  }
  // 名額上限已取消：不再限制每個時段的報名數量，主播可正常報名

  const label = (d.period === '4' ? '第四期' : '第三期') + ' ' + d.date + ' ' + d.slot;
  const fields = {};
  fields[F.submitted_at] = (dd=>{const p=n=>String(n).padStart(2,'0');return dd.getUTCFullYear()+'-'+p(dd.getUTCMonth()+1)+'-'+p(dd.getUTCDate())+' '+p(dd.getUTCHours())+':'+p(dd.getUTCMinutes())+':'+p(dd.getUTCSeconds());})(new Date(Date.now()+8*3600*1000));
  fields[F.plan] = d.plan; fields[F.scanned] = d.scanned || '';
  fields[F.username] = uname; fields[F.videourl] = { link: vurl, text: vurl };
  fields[F.period] = String(d.period);
  fields[F.key] = key; fields[F.slots] = label;
  fields[F.status] = '待審核'; fields[F.notify] = '';
  await createRecord(tk, fields);
  // 即時同步「主播總覽」彙總表（一位主播一行）
  rows.push(fields);
  await syncOne(tk, rows, uname, String(d.period));
  return { ok: true };
}

function csv(rows) {
  const head = ['報名時間', '參與活動', '掃碼授權', 'TikTok使用者名稱', '作品連結', '期數', '申請時段', '審核狀態'];
  const lines = [head.join(',')];
  rows.forEach(r => {
    const row = [F.submitted_at, F.plan, F.scanned, F.username, F.videourl, F.period, F.slots, F.status]
      .map(k => '"' + txt(r[k]).replace(/"/g, '""') + '"');
    lines.push(row.join(','));
  });
  return '\ufeff' + lines.join('\n');
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
      return res.status(200).json({ ok: true, msg: 'alive' });
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
