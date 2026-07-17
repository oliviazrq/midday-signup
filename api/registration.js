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

function myRecords(rows, username) {
  const q = String(username || '').trim().toLowerCase().replace(/^@/, '');
  if (!q) return [];
  return rows.filter(r => txt(r[F.username]).trim().toLowerCase().replace(/^@/, '') === q).map(r => {
    const label = txt(r[F.status]) || '待審核';
    return {
      submitted_at: txt(r[F.submitted_at]), plan: txt(r[F.plan]), scanned: txt(r[F.scanned]),
      username: txt(r[F.username]), videourl: txt(r[F.videourl]), slots: txt(r[F.slots]),
      status: STATUS_MAP[label] || 'pending', status_label: label, notify_msg: txt(r[F.notify])
    };
  });
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
  if (count >= QUOTA) return { ok: false, detail: '此時段金魔杖名額已額滿' };

  const label = (d.period === '4' ? '第四期' : '第三期') + ' ' + d.date + ' ' + d.slot;
  const fields = {};
  fields[F.submitted_at] = new Date().  fields[F.submitted_at] = (dd=>{const p=n=>String(n).padStart(2,'0');return dd.getUTCFullYear()+'-'+p(dd.getUTCMonth()+1)+'-'+p(dd.getUTCDate())+' '+p(dd.getUTCHours())+':'+p(dd.getUTCMinutes())+':'+p(dd.getUTCSeconds());})(new Date(Date.now()+8*3600*1000));();
  fields[F.plan] = d.plan; fields[F.scanned] = d.scanned || '';
  fields[F.username] = uname; fields[F.videourl] = { link: vurl, text: vurl };
  fields[F.period] = String(d.period);
  fields[F.key] = key; fields[F.slots] = label;
  fields[F.status] = '待審核'; fields[F.notify] = '';
  await createRecord(tk, fields);
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
