import express from 'express';
import { YemotRouter } from 'yemot-router2';

const { GITHUB_TOKEN, DATA_REPO, IVR_SECRET = 'ivr', TEACHER_PASS = '12369', PORT = 3000, YEMOT_TOKEN, CRON_KEY, CALLER_ID = '', TZ_TEMPLATE = '73875' } = process.env;
if (!GITHUB_TOKEN || !DATA_REPO) { console.error('Missing GITHUB_TOKEN or DATA_REPO'); process.exit(1); }
if (!YEMOT_TOKEN || !CRON_KEY) console.warn('YEMOT_TOKEN or CRON_KEY missing - daily tzintuk disabled');

// state.json נכתב מהדף. reports.json נכתב רק מהשרת (דיווחי תלמידות ומורות).
const H = { Authorization: 'Bearer ' + GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'tornuyot' };
const U = f => `https://api.github.com/repos/${DATA_REPO}/contents/${f}`;
async function ghRead(f) {
  const r = await fetch(U(f), { headers: H }); if (r.status === 404) return null;
  if (!r.ok) throw new Error('GitHub ' + r.status);
  const j = await r.json(); return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) };
}
async function ghWrite(f, data, sha) {
  const r = await fetch(U(f), { method: 'PUT', headers: H, body: JSON.stringify({ message: 'update ' + f, content: Buffer.from(JSON.stringify(data)).toString('base64'), sha }) });
  if (!r.ok) throw new Error('GitHub ' + r.status);
}
let cache = { t: 0, d: null };
const state = async () => { if (Date.now() - cache.t > 15000) cache = { t: Date.now(), d: (await ghRead('state.json'))?.data || null }; return cache.d; };

let q = Promise.resolve();
const locked = fn => { const r = q.then(fn); q = r.catch(() => {}); return r; };
const dayIL = () => ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5 })[new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Jerusalem' }).format(new Date())] ?? -1;
const tsIL = () => new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

// עדכון reports.json בנעילה עם ניסיון חוזר
const updateReports = (mutate, msg) => locked(async () => {
  for (let i = 0; i < 3; i++) {
    try {
      const cur = await ghRead('reports.json');
      const R = cur?.data || { rep: {}, log: [] };
      mutate(R);
      if (msg) R.log.push({ t: tsIL(), ...msg });
      await ghWrite('reports.json', R, cur?.sha); return;
    } catch (e) { if (i === 2) throw e; }
  }
});

const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
app.get('/', (_, res) => res.send('tornuyot server is running'));

const say = t => [{ type: 'text', data: t }];
const bye = (call, m) => { call.id_list_message(say(m), { prependToNextAction: true }); return call.hangup(); };

// ---------- שלוחת תלמידה ----------
const SKEYS = { 1: 'full', 2: 'partial', 3: 'missed', 4: 'free' };
const SLABEL = { full: 'ביצעתי מלא', partial: 'ביצעתי חלקי', missed: 'לא ביצעתי', free: 'יום חופש' };
const student = YemotRouter({ printLog: true });
student.get('/', async call => {
  try {
    let id = await call.read(say('אנא הקישי את מספר תעודת הזהות שלך, ובסיומו סולמית'), 'tap',
      { val_name: 'ID', min_digits: 5, max_digits: 9, sec_wait: 8, block_asterisk_key: true, amount_attempts: 3 });
    id = String(id).padStart(9, '0');
    const st = await state(), cur = +st?.cfg?.curSlot || 1, d = dayIL();
    const row = st?.rows?.find(x => x.id === id && x.role !== 4 && x.from >= 1 && x.from <= cur && cur <= x.to);
    if (!row || d < 0) {
      if (st?.students?.[id]) await updateReports(R => {}, { id, msg: 'דיווח טלפוני נדחה - לא משובצת בתקופה זו' });
      return bye(call, 'אינך משובצת לתורנות בתקופה זו');
    }
    const key = await call.read(say('הקישי 1 אם ביצעת את התפקיד במלואו, 2 אם ביצעת חלקית, 3 אם לא ביצעת, 4 ליום חופש'), 'tap',
      { val_name: 'KEY', min_digits: 1, max_digits: 1, sec_wait: 8, digits_allowed: ['1', '2', '3', '4'], amount_attempts: 3 });
    const val = SKEYS[key], k = row.id + '|' + row.from, pos = (cur - row.from) * 6 + d;
    await updateReports(R => { R.rep[k] = R.rep[k] || []; R.rep[k][pos] = Object.assign(R.rep[k][pos] || {}, { stu: val }); },
      { id, msg: 'דיווח תלמידה (טלפון) ליום ' + 'אבגדהו'[d] + ': ' + SLABEL[val] });
    return bye(call, 'הדיווח נקלט, תודה');
  } catch (e) { console.error(e); return bye(call, 'אירעה שגיאה, נסי שוב מאוחר יותר'); }
});

// ---------- שלוחת מורה ----------
// שאלות לפי סוג תורנות ושלב ביום. המפתחות נשמרים ב-tch ומוצגים בדף הניהול.
const GRADES = ['א', 'ב', 'ג', 'ד'];
const TQ = {
  cls_mid: ['כיתה מטואטאת?', 'טורים ישרים?'],
  cls_end: ['כיסאות מורמים?', 'שולחנות בסוף כיתה?', 'רצפה מטואטאת?', 'לוח נקי?', 'אורות ומזגנים מכובים?'],
  aron_mid: ['ארון מסודר?'],
  aron_end: ['סידורים בארון?'],
  yom: ['יומן במשרד?'],
};
const TNAME = { cls_mid: 'תורנית כיתה - אמצע היום', cls_end: 'תורנית כיתה - סוף היום', aron_mid: 'תורנית ארון - אמצע היום', aron_end: 'תורנית ארון - סוף היום', yom: 'תורנית יומן' };
const ROLE_OF = { cls: 1, aron: 2, yom: 3 };
const tap = (call, txt, name, o = {}) => call.read(say(txt), 'tap', { val_name: name, min_digits: 1, max_digits: 1, sec_wait: 8, amount_attempts: 3, ...o });
const teacher = YemotRouter({ printLog: true });
teacher.get('/', async call => {
  try {
    const pass = String(await call.read(say('הקישי סיסמת מורה ובסיומה סולמית'), 'tap',
      { val_name: 'PASS', min_digits: 3, max_digits: 10, sec_wait: 8, block_asterisk_key: true, amount_attempts: 3 }));
    if (pass !== TEACHER_PASS) return bye(call, 'הסיסמה שגויה');
    let note = '';
    for (;;) { // רצף דיווח: אחרי כל כיתה שואלים אם לעדכן כיתה נוספת
      const g = +(await tap(call, 'הקישי את מספר השכבה: אחד לכיתה א, שתים לכיתה ב, שלוש לכיתה ג, ארבע לכיתה ד', 'G', { digits_allowed: ['1', '2', '3', '4'] }));
      const room = String(await call.read(say('הקישי את מספר הכיתה ובסיומו סולמית'), 'tap',
        { val_name: 'ROOM', min_digits: 1, max_digits: 2, sec_wait: 8, block_asterisk_key: true, amount_attempts: 3 }));
      const cls = `${GRADES[g - 1]}'${+room}`;
      const kind = String(await tap(call, 'לדיווח על תורנית כיתה הקישי אחד, על תורנית ארון הקישי שתים, על תורנית יומן הקישי שלוש', 'K', { digits_allowed: ['1', '2', '3'] }));
      let key, role;
      if (kind === '3') { key = 'yom'; role = ROLE_OF.yom; }
      else {
        const ph = await tap(call, 'לדיווח אמצע היום הקישי 1, לדיווח סוף היום הקישי 2', 'PH', { digits_allowed: ['1', '2'] });
        const base = kind === '1' ? 'cls' : 'aron'; role = ROLE_OF[base]; key = base + (String(ph) === '1' ? '_mid' : '_end');
      }
      const ans = [];
      for (const q of TQ[key]) ans.push(String(await tap(call, q + ' 1 כן, 2 לא', 'A', { digits_allowed: ['1', '2'] })));
      const no = ans.filter(a => a === '2').length, bad = no > ans.length / 2 ? 'bad' : 'ok';
      const st = await state(), cur = +st?.cfg?.curSlot || 1, d = dayIL();
      const who = (st?.rows || []).filter(x => x.role === role && x.from >= 1 && x.from <= cur && cur <= x.to && st.students?.[x.id]?.cls === cls);
      if (!who.length || d < 0) note = 'אין תורנית משובצת לכיתה זו היום';
      else {
        await updateReports(R => {
          for (const x of who) { const k = x.id + '|' + x.from, pos = (cur - x.from) * 6 + d;
            R.rep[k] = R.rep[k] || []; R.rep[k][pos] = Object.assign(R.rep[k][pos] || {}, { tch: Object.assign((R.rep[k][pos] || {}).tch || {}, { [key]: { v: bad, a: ans, by: cls, at: tsIL() } }) }); }
        }, { msg: `דיווח מורה לכיתה ${cls} (${TNAME[key]}): ${bad === 'bad' ? '⚠ הרוב לא תקין' : 'תקין'} - ${who.map(x => st.students[x.id].name).join(', ')}` });
        note = bad === 'bad' ? 'הדיווח נקלט, סומן כלא תקין' : 'הדיווח נקלט';
      }
      const more = String(await tap(call, note + '. לעדכון כיתה נוספת הקישי 1, לסיום הקישי 2', 'MORE', { digits_allowed: ['1', '2'] }));
      if (more !== '1') return bye(call, 'תודה, להתראות');
    }
  } catch (e) { console.error(e); return bye(call, 'אירעה שגיאה, נסי שוב מאוחר יותר'); }
});


// ---------- צינתוק יומי לתורניות (בתשלום, קמפיין פעמון - RunCampaign) ----------
// נקרא כל כמה דקות מ-cron חיצוני (למשל cron-job.org). שולח פעם ביום, החל משעת ההגדרה.
const hhmmIL = () => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jerusalem' }).format(new Date());
const dateIL = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
async function sendTzDaily(force) {
  const st = await state(), tz = st?.cfg?.tz || {};
  if (!force && !tz.on) return { skipped: 'off' };
  if (!force && dayIL() < 0) return { skipped: 'shabbat' };
  const now = hhmmIL(), today = dateIL();
  if (!force && now < (tz.time || '07:30')) return { skipped: 'not yet', now };
  const R = (await ghRead('reports.json'))?.data || { rep: {}, log: [] };
  if (!force && R.tzDate === today) return { skipped: 'already sent today' };
  const cur = +st?.cfg?.curSlot || 1;
  const phones = [...new Set((st?.rows || []).filter(x => x.role !== 4 && x.from >= 1 && x.from <= cur && cur <= x.to)
    .map(x => String(st.students?.[x.id]?.phone || '').replace(/\D/g, '')).filter(p => /^0\d{8,9}$/.test(p)))];
  if (!phones.length) { await updateReports(R2 => { R2.tzDate = today; }, { msg: 'צינתוק יומי: אין נמענות לשבוע זה' }); return { sent: 0 }; }
  const tpl = String(tz.tpl || TZ_TEMPLATE);
  const url = 'https://www.call2all.co.il/ym/api/RunCampaign?' + new URLSearchParams({ token: YEMOT_TOKEN, templateId: tpl, phones: phones.join(':'), ...(CALLER_ID ? { callerId: CALLER_ID } : {}) });
  const r = await fetch(url); const j = await r.json().catch(() => ({}));
  const ok = j.responseStatus === 'OK' || !!j.campaignId;
  await updateReports(R2 => { R2.tzDate = today; }, { msg: `צינתוק יומי (קמפיין ${tpl}) ל-${phones.length} נמענות: ${ok ? 'נשלח, בהמתנה לחיוג ' + (j.pending ?? phones.length) : 'שגיאה ' + (j.message || j.messageCode || j.responseStatus || r.status)}` });
  return { sent: phones.length, ok, campaignId: j.campaignId, pending: j.pending, blocked: j.blocked, estimatedPrice: j.estimatedPrice };
}
app.get('/tz/run', async (req, res) => {
  if (!CRON_KEY || req.query.key !== CRON_KEY) return res.status(401).send('unauthorized');
  if (!YEMOT_TOKEN) return res.status(500).json({ error: 'YEMOT_TOKEN missing' });
  try { res.json(await sendTzDaily(req.query.force === '1')); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.use('/ivr/' + IVR_SECRET + '/teacher', teacher);
app.use('/ivr/' + IVR_SECRET, student);
app.listen(PORT, () => console.log('listening on', PORT));
