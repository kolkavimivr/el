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
  const j = await r.json(); let text;
  if (j.content && j.encoding === 'base64') text = Buffer.from(j.content, 'base64').toString('utf8');
  else { // קבצים גדולים מ-1MB: ה-API לא מחזיר content, לכן קוראים את הגרסה הגולמית
    const r2 = await fetch(U(f), { headers: { ...H, Accept: 'application/vnd.github.raw+json' } });
    if (!r2.ok) throw new Error('GitHub raw ' + r2.status); text = await r2.text();
  }
  return { sha: j.sha, data: JSON.parse(text) };
}
async function ghWrite(f, data, sha) {
  const r = await fetch(U(f), { method: 'PUT', headers: H, body: JSON.stringify({ message: 'update ' + f, content: Buffer.from(JSON.stringify(data)).toString('base64'), sha }) });
  if (!r.ok) throw new Error('GitHub ' + r.status);
}
let cache = { t: 0, d: null };
// כשקריאה מגיטאב נכשלת משתמשים בעותק האחרון שנשמר, כדי שהשלוחה לא תיפול
const state = async () => {
  if (Date.now() - cache.t > 15000) {
    try { cache = { t: Date.now(), d: (await ghRead('state.json'))?.data || cache.d || null }; }
    catch (e) { console.error('state read failed:', e.message); if (!cache.d) throw e; cache.t = Date.now() - 10000; }
  }
  return cache.d;
};
const stateRetry = async () => { for (let i = 0; ; i++) { try { return await state(); } catch (e) { if (i >= 2) throw e; await new Promise(r => setTimeout(r, 1500)); } } };

let q = Promise.resolve();
const locked = fn => { const r = q.then(fn); q = r.catch(() => {}); return r; };
const dayIL = () => ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5 })[new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Jerusalem' }).format(new Date())] ?? -1;
// השבוע הנוכחי מחושב מהתאריך העברי של יום ראשון האחרון (כמו בדף). הערך השמור בקובץ משמש רק כשנבחר שבוע ידני.
const HEB_SLOTS = [[2, 7], [2, 14], [2, 21], [2, 28], [3, 5], [3, 12], [3, 19], [4, 3], [4, 10], [4, 17], [4, 24]];
const HEB_MONTH = { Tishri: 1, Heshvan: 2, Kislev: 3, Tevet: 4, Shevat: 5, Adar: 6, 'Adar I': 6, 'Adar II': 7, Nisan: 8, Iyar: 9, Sivan: 10, Tamuz: 11, Tammuz: 11, Av: 12, Elul: 13 };
function autoWeek() {
  const now = new Date(), wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Jerusalem' }).format(now);
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 0, sun = new Date(now.getTime() - idx * 86400000);
  const p = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem' }).formatToParts(sun);
  const key = (HEB_MONTH[p.find(x => x.type === 'month').value] || 1) * 100 + +p.find(x => x.type === 'day').value;
  let w = 1; HEB_SLOTS.forEach(([m, d], i) => { if (key >= m * 100 + d) w = i + 1; }); return w;
}
const curWeek = st => (st?.cfg?.manualWeek ? (+st.cfg.curSlot || 1) : autoWeek());
// ---------- תורנית יומן בחודשים עבריים שלמים (cfg.fmt === 'h1'). תורנית כיתה / ארון / חזנית נשארות לפי שבוע ----------
const HF = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' });
const hparts = dt => { const p = HF.formatToParts(dt); return { d: +p.find(x => x.type === 'day').value, m: HEB_MONTH[p.find(x => x.type === 'month').value] || 1, y: +p.find(x => x.type === 'year').value }; };
const hnow = () => hparts(new Date());
const PER = 30;                                   // מקומות דיווח בחודש (יומן): יום בחודש (1-30) פחות 1
const isH = st => st?.cfg?.fmt === 'h1';
const yo = (st, x) => isH(st) && x.role === 3;
const activeNow = (st, x) => x.from >= 1 && (yo(st, x) ? (hnow().m >= x.from && hnow().m <= x.to) : (curWeek(st) >= x.from && curWeek(st) <= x.to));
const rkOf = (st, x) => x.id + '|' + x.from + (yo(st, x) ? '|y' : '');              // ליומן סיומת, כדי שלא יתערבב עם תורנות כיתה עם אותו מספר
const posOfDay = (st, x, d) => (yo(st, x) ? (hnow().m - x.from) * PER + (hnow().d - 1) : (curWeek(st) - x.from) * 6 + d);
const YC = {};
function ycal(y) { if (YC[y]) return YC[y]; const C = {}; let t = Date.UTC(y - 3761, 7, 10, 12); for (let n = 0; n < 430; n++, t += 864e5) { const h = hparts(new Date(t)); if (h.y !== y) continue; (C[h.m] = C[h.m] || []).push({ d: h.d, t }); } return (YC[y] = C); }
const schoolYear = () => { const h = hnow(); return h.m === 13 ? h.y + 1 : h.y; };
const wkSunMs = w => { const d = HEB_SLOTS[Math.min(Math.max(w, 1), HEB_SLOTS.length) - 1], x = (ycal(schoolYear())[d[0]] || []).find(z => z.d === d[1]); return x ? x.t : null; };
// דיווחי יומן שנשמרו במודל השבועי (reports.json ישן) מומרים פעם אחת לחודשים לפי התאריך של כל יום. כיתה וארון לא משתנים
function convReportsY(rep, st) {
  const out = {};
  for (const [k, arr] of Object.entries(rep || {})) {
    const p = k.split('|');
    if (p.length !== 2 || p[1] !== '1') { out[k] = arr; continue; }
    const id = p[0], y = (st.rows || []).find(r => r.id === id && r.role === 3 && !r.w0);
    if (!y || (st.rows || []).some(r => r.id === id && r.role !== 3 && r.role !== 4 && !r.w0 && r.from === 1)) { out[k] = arr; continue; }
    const nk = id + '|' + y.from + '|y', na = out[nk] = out[nk] || [];
    (arr || []).forEach((v, i) => { if (v == null) return; const t = wkSunMs(1 + Math.floor(i / 6)); if (t === null) return;
      const h = hparts(new Date(t + (i % 6) * 864e5)), q = (h.m - y.from) * PER + (h.d - 1); if (q < 0) return;
      na[q] = (na[q] && typeof na[q] === 'object' && typeof v === 'object') ? { ...na[q], ...v } : (na[q] || v); });
  }
  return out;
}
const tsIL = () => new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

// עדכון reports.json בנעילה עם ניסיון חוזר
const updateReports = (mutate, msg) => locked(async () => {
  for (let i = 0; i < 3; i++) {
    try {
      const cur = await ghRead('reports.json');
      const R = cur?.data || { rep: {}, log: [] };
      const st0 = await state().catch(() => null);
      if (isH(st0) && R.fmt !== 'h1') { R.rep = convReportsY(R.rep || {}, st0); R.fmt = 'h1'; }
      mutate(R);
      if (msg) R.log.push({ t: tsIL(), ...msg });
      await ghWrite('reports.json', R, cur?.sha); return;
    } catch (e) { if (i === 2) throw e; }
  }
});

const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
app.get('/', (_, res) => res.send('tornuyot server is running'));

// שמירה ברקע: משיבים לימות מיד ולא ממתינים לגיטאב (השהיה ארוכה גרמה להודעת שגיאה למרות שהדיווח נקלט)
const saveBg = (mutate, msg) => updateReports(mutate, msg).catch(e => {
  console.error('save failed, retrying:', e.message); setTimeout(() => updateReports(mutate, msg).catch(e2 => console.error('save failed again:', e2.message)), 5000);
});
// לפי תיעוד ימות המשיח אסור להכניס בטקסט הודעה את התווים נקודה (.) וקו מפריד (-): הם שוברים את התשובה והשיחה נותקת
const say = t => [{ type: 'text', data: String(t).replace(/[.\-]+/g, ' ').replace(/\s+/g, ' ').trim() }];
// ניתוק של המתקשרת הוא לא שגיאה: לא מדפיסים את כל אובייקט השיחה ולא מנסים להשמיע הודעה
const quiet = e => /hangup|exit/i.test(String(e?.name) + ' ' + String(e?.message));
const onErr = (call, e, tag) => { console.error('[' + tag + ']', e?.name || '', e?.message || e); return quiet(e) ? undefined : bye(call, 'אירעה שגיאה, נסי שוב מאוחר יותר'); };
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
    const st = await state(), d = dayIL();
    const rowsNow = (st?.rows || []).filter(x => x.id === id && x.role !== 4 && activeNow(st, x));
    if (!rowsNow.length || d < 0) {
      if (st?.students?.[id]) saveBg(R => {}, { id, msg: 'דיווח טלפוני נדחה - לא משובצת בתקופה זו' });
      return bye(call, 'אינך משובצת לתורנות בתקופה זו');
    }
    const key = await call.read(say('הקישי 1 אם ביצעת את התפקיד במלואו, 2 אם ביצעת חלקית, 3 אם לא ביצעת, 4 ליום חופש'), 'tap',
      { val_name: 'KEY', min_digits: 1, max_digits: 1, sec_wait: 8, digits_allowed: ['1', '2', '3', '4'], amount_attempts: 3 });
    const val = SKEYS[key];   // הדיווח נרשם לכל התפקידים הפעילים שלה היום (כיתה / ארון / יומן)
    saveBg(R => { for (const row of rowsNow) { const k = rkOf(st, row), pos = posOfDay(st, row, d); R.rep[k] = R.rep[k] || []; R.rep[k][pos] = Object.assign(R.rep[k][pos] || {}, { stu: val }); } },
      { id, msg: 'דיווח תלמידה (טלפון) ליום ' + 'אבגדהו'[d] + ': ' + SLABEL[val] });
    return bye(call, 'הדיווח נקלט, תודה');
  } catch (e) { return onErr(call, e, 'student'); }
});

// ---------- שלוחת מורה ----------
// שאלות לפי סוג תורנות ושלב ביום. המפתחות נשמרים ב-tch ומוצגים בדף הניהול.
const GRADES = ['א', 'ב', 'ג', 'ד'];
const TQ = {
  cls_mid: ['כיתה מטואטאת?', 'טורים ישרים?'],
  cls_end: ['כיסאות מורמים?', 'שולחנות בסוף כיתה?', 'רצפה מטואטאת?', 'לוח נקי?', 'אורות ומזגנים מכובים?'],
  aron_mid: ['ארון מסודר?'],
  aron_end: ['ארון מסודר?', 'סידורים בארון?'],
  yom: ['יומן במשרד?'],
};
const TNAME = { cls_mid: 'תורנית כיתה - אמצע היום', cls_end: 'תורנית כיתה - סוף היום', aron_mid: 'תורנית ארון - אמצע היום', aron_end: 'תורנית ארון - סוף היום', yom: 'תורנית יומן' };
// אחרי בחירת כיתה ושלב ביום, שואלים ברצף את כל השאלות של כל התורניות. החלוקה לסוג תורנות נעשית רק בשמירה.
const PHASES = { mid: ['cls_mid', 'aron_mid'], end: ['cls_end', 'aron_end', 'yom'] };
const ROLE_OF_KEY = k => (k.startsWith('cls') ? 1 : k.startsWith('aron') ? 2 : 3);
const tap = (call, txt, name, o = {}) => call.read(say(txt), 'tap', { val_name: name, min_digits: 1, max_digits: 1, sec_wait: 8, amount_attempts: 3, ...o });
// שיוך לפי סוג תורנות ושמירה: הכול ברקע, עם ניסיונות חוזרים
function saveTeacher(cls, phase, res, d) {
  const at = tsIL();
  const job = async () => {
    const st = await stateRetry();
    const rows = (st?.rows || []).filter(x => x.role >= 1 && x.role <= 3 && activeNow(st, x) && st.students?.[x.id]?.cls === cls);
    const anyBad = Object.values(res).some(r => r.v === 'bad');
    if (!rows.length || d < 0) return updateReports(() => {}, { msg: `דיווח מורה לכיתה ${cls}: לא נמצאו תורניות משובצות להיום` });
    return updateReports(R => {
      for (const x of rows) for (const [key, r] of Object.entries(res)) {
        if (x.role !== ROLE_OF_KEY(key)) continue;
        const k = rkOf(st, x), pos = posOfDay(st, x, d);
        R.rep[k] = R.rep[k] || [];
        R.rep[k][pos] = Object.assign(R.rep[k][pos] || {}, { tch: Object.assign((R.rep[k][pos] || {}).tch || {}, { [key]: { v: r.v, a: r.a, by: cls, at } }) });
      }
    }, { msg: `דיווח מורה לכיתה ${cls} (${phase === 'mid' ? 'אמצע היום' : 'סוף היום'}): ${anyBad ? '⚠ יש פריט לא תקין' : 'תקין'} - ${rows.length} תורניות` });
  };
  job().catch(e => { console.error('teacher save failed, retrying:', e.message); setTimeout(() => job().catch(e2 => console.error('teacher save failed again:', e2.message)), 8000); });
}
const teacher = YemotRouter({ printLog: true });
teacher.get('/', async call => {
  try {
    const pass = String(await call.read(say('הקישי סיסמת מורה ובסיומה סולמית'), 'tap',
      { val_name: 'PASS', min_digits: 3, max_digits: 10, sec_wait: 8, block_asterisk_key: true, amount_attempts: 3 }));
    if (pass !== TEACHER_PASS) return bye(call, 'הסיסמה שגויה');
    state().catch(() => {}); // חימום הנתונים בזמן שהמורה מקישה (לא חוסם ולא מפיל את השיחה)
    for (;;) { // רצף דיווח: אחרי כל כיתה שואלים אם לעבור לכיתה נוספת
      const g = +(await tap(call, 'הקישי את מספר השכבה: 1 לכיתה א, 2 לכיתה ב, 3 לכיתה ג, 4 לכיתה ד', 'G', { digits_allowed: ['1', '2', '3', '4'] }));
      const room = String(await call.read(say('הקישי את מספר הכיתה ובסיומו סולמית'), 'tap',
        { val_name: 'ROOM', min_digits: 1, max_digits: 2, sec_wait: 8, block_asterisk_key: true, amount_attempts: 3 }));
      const cls = `${GRADES[g - 1]}'${+room}`;
      const phase = String(await tap(call, 'לדיווח אמצע היום הקישי 1, לדיווח סוף היום הקישי 2', 'PH', { digits_allowed: ['1', '2'] })) === '1' ? 'mid' : 'end';
      const res = {}; // key -> { a, v }
      for (const key of PHASES[phase]) {
        const ans = [];
        for (const q of TQ[key]) ans.push(String(await tap(call, q + ' 1 כן, 2 לא', 'A', { digits_allowed: ['1', '2'] })));
        res[key] = { a: ans, v: ans.includes('2') ? 'bad' : 'ok' };   // 1 = כן (תקין), 2 = לא (לא תקין): כל "לא" מסמן את הפריט כלא תקין
      }
      let note = 'הדיווח נקלט, תודה';
      try { // כל מה שאחרי השאלות הוא ברקע ולא יכול להפיל את השיחה
        const d = dayIL(); saveTeacher(cls, phase, res, d);
        if (d < 0) note = 'אין תורנית משובצת לכיתה זו היום';
        else if (Object.values(res).some(r => r.v === 'bad')) note = 'הדיווח נקלט, סומנו פריטים לא תקינים';
      } catch (e) { console.error('teacher post-step:', e); }
      const more = String(await tap(call, note + ' למעבר לכיתה נוספת הקישי 1, לסיום הקישי 2', 'MORE', { digits_allowed: ['1', '2'] }));
      if (more !== '1') return bye(call, 'תודה, להתראות');
    }
  } catch (e) { return onErr(call, e, 'teacher'); }
});


// ---------- צינתוק יומי אוטומטי לתורניות (בתשלום, קמפיין פעמון - RunCampaign) ----------
// ברירת מחדל: פעיל, בשעה 14:30, בכל יום פעילות (א-ו). נשלח פעם אחת ביום לכל התורניות המשובצות לשבוע הנוכחי, בלי התערבות ידנית.
// ההפעלה: (1) מתזמן פנימי שבודק כל 30 שניות כשהשרת ער, (2) /tz/tick שנקרא מבחוץ (GitHub Actions) ומעיר את השרת ב-Render החינמי.
const hhmmIL = () => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Jerusalem' }).format(new Date());
const dateIL = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
let tzBusy = false;
async function sendTzDaily(force) {
  if (tzBusy) return { skipped: 'busy' };
  tzBusy = true;
  try {
    const st = await stateRetry(), tz = { on: true, time: '14:30', ...(st?.cfg?.tz || {}) };
    if (!force && tz.on === false) return { skipped: 'off' };
    if (!force && dayIL() < 0) return { skipped: 'shabbat' };
    const now = hhmmIL(), today = dateIL();
    if (!force && now < tz.time) return { skipped: 'not yet', now, time: tz.time };
    const R = (await ghRead('reports.json'))?.data || { rep: {}, log: [] };
    if (!force && R.tzDate === today) {
      if (R.tzOk) return { skipped: 'already sent today' };
      if ((R.tzTry || 0) >= 3) return { skipped: 'gave up after 3 failed tries' };
      if (Date.now() - (R.tzAt || 0) < 5 * 60000) return { skipped: 'waiting before retry' };
    }
    const cur = curWeek(st);
    const phones = [...new Set((st?.rows || []).filter(x => x.role >= 1 && x.role <= 3 && activeNow(st, x))
      .map(x => String(st.students?.[x.id]?.phone || '').replace(/\D/g, '')).filter(p => /^0\d{8,9}$/.test(p)))];
    const tpl = String(tz.tpl || TZ_TEMPLATE);
    let ok = false, j = {}, err = '';
    if (!phones.length) { ok = true; err = 'אין נמענות לשבוע ' + cur; }
    else {
      try {
        const url = 'https://www.call2all.co.il/ym/api/RunCampaign?' + new URLSearchParams({ token: YEMOT_TOKEN, templateId: tpl, phones: phones.join(':'), ...(CALLER_ID ? { callerId: CALLER_ID } : {}) });
        const r = await fetch(url); j = await r.json().catch(() => ({}));
        ok = j.responseStatus === 'OK' || !!j.campaignId; if (!ok) err = j.message || j.messageCode || j.responseStatus || r.status;
      } catch (e) { err = e.message; }
    }
    await updateReports(R2 => { R2.tzTry = (R2.tzDate === today ? (R2.tzTry || 0) : 0) + 1; R2.tzDate = today; R2.tzOk = ok; R2.tzAt = Date.now(); },
      { msg: `צינתוק יומי אוטומטי (קמפיין ${tpl}, שבוע ${cur}) ל-${phones.length} נמענות: ${ok ? (phones.length ? 'נשלח, בהמתנה לחיוג ' + (j.pending ?? phones.length) : err) : 'שגיאה ' + err}` });
    return { sent: phones.length, week: cur, ok, error: err || undefined, campaignId: j.campaignId, pending: j.pending, blocked: j.blocked, estimatedPrice: j.estimatedPrice };
  } finally { tzBusy = false; }
}
const tzTick = () => { if (!YEMOT_TOKEN) return; sendTzDaily(false).then(r => { if (r && r.sent !== undefined) console.log('[tz]', JSON.stringify(r)); }).catch(e => console.error('[tz] tick failed:', e.message)); };
app.get('/tz/tick', (_, res) => { tzTick(); res.json({ ok: true, now: hhmmIL() }); });          // ללא מפתח: בטוח, כי שולח רק בשעה המוגדרת ופעם ביום
app.get('/tz/run', async (req, res) => {                                                          // ידני/בדיקה (דורש מפתח); force=1 שולח מיד
  if (!CRON_KEY || req.query.key !== CRON_KEY) return res.status(401).send('unauthorized');
  if (!YEMOT_TOKEN) return res.status(500).json({ error: 'YEMOT_TOKEN missing' });
  try { res.json(await sendTzDaily(req.query.force === '1')); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
if (YEMOT_TOKEN) { setInterval(tzTick, 30000); setTimeout(tzTick, 20000); }                     // מתזמן פנימי + השלמה מיד אחרי שהשרת מתעורר

app.use('/ivr/' + IVR_SECRET + '/teacher', teacher);
app.use('/ivr/' + IVR_SECRET, student);
app.listen(PORT, () => console.log('listening on', PORT));
