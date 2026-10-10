import express from 'express';
import { YemotRouter } from 'yemot-router2';

const { GITHUB_TOKEN, DATA_REPO, IVR_SECRET = 'ivr', PORT = 3000 } = process.env;
if (!GITHUB_TOKEN || !DATA_REPO) { console.error('Missing GITHUB_TOKEN or DATA_REPO'); process.exit(1); }

// הנתונים יושבים בריפו פרטי בגיטאב: state.json (נכתב מהדף) ו-reports.json (נכתב מהשרת הזה)
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
const roster = async () => { if (Date.now() - cache.t > 20000) cache = { t: Date.now(), d: (await ghRead('state.json'))?.data || null }; return cache.d; };

let q = Promise.resolve();
const locked = fn => { const r = q.then(fn); q = r.catch(() => {}); return r; };
const dayIL = () => ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: -1 })[new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Jerusalem' }).format(new Date())];
const tsIL = () => new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
const record = (id, msg, k, p, s) => locked(async () => {
  for (let i = 0; i < 3; i++) {
    try {
      const cur = await ghRead('reports.json'), R = cur?.data || { rep: {}, log: [] };
      if (s) { R.rep[k] = R.rep[k] || []; R.rep[k][p] = { s }; }
      R.log.push({ t: tsIL(), id, msg }); await ghWrite('reports.json', R, cur?.sha); return;
    } catch (e) { if (i === 2) throw e; }
  }
});

const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
app.get('/', (_, res) => res.send('tornuyot server is running'));

const say = t => [{ type: 'text', data: t }];
const KEYS = { 1: 'done', 2: 'missed', 3: 'free' };
const LABEL = { done: 'ביצעתי', missed: 'לא ביצעתי', free: 'יום חופשי' };
const ivr = YemotRouter({ printLog: true });
ivr.get('/', async call => {
  const bye = m => { call.id_list_message(say(m), { prependToNextAction: true }); return call.hangup(); };
  try {
    let id = await call.read(say('אנא הקישי את מספר תעודת הזהות שלך, ובסיומו סולמית'), 'tap',
      { val_name: 'ID', min_digits: 5, max_digits: 9, sec_wait: 8, block_asterisk_key: true, amount_attempts: 3 });
    id = String(id).padStart(9, '0');
    const st = await roster(), row = st?.rows?.find(x => x.id === id), d = dayIL(), cw = +st?.curWeek;
    const from = row ? (row.from || row.week) : 0, to = row ? (row.to || row.week) : 0;
    if (!row || !row.week || cw < from || cw > to || d < 0) {
      if (st?.students?.[id]) await record(id, 'דיווח טלפוני נדחה - לא משובצת בתקופה זו');
      return bye('אינך משובצת לתורנות בתקופה זו');
    }
    const key = await call.read(say('הקישי אחד אם ביצעת את התפקיד, שתיים אם לא ביצעת, שלוש ליום חופשי'), 'tap',
      { val_name: 'KEY', min_digits: 1, max_digits: 1, sec_wait: 8, digits_allowed: ['1', '2', '3'], amount_attempts: 3 });
    await record(id, 'דיווח תלמידה (טלפון) ליום ' + 'אבגדהו'[d] + ': ' + LABEL[KEYS[key]], id + '|' + from, (cw - from) * 6 + d, KEYS[key]);
    return bye('הדיווח נקלט, תודה');
  } catch (e) { console.error(e); return bye('אירעה שגיאה, נסי שוב מאוחר יותר'); }
});
app.use('/ivr/' + IVR_SECRET, ivr);
app.listen(PORT, () => console.log('listening on', PORT));
