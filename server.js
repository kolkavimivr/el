import express from 'express';
import pg from 'pg';
import { YemotRouter } from 'yemot-router2';

const { DATABASE_URL, ADMIN_PASSWORD, IVR_SECRET = 'ivr', PORT = 3000 } = process.env;
if (!DATABASE_URL || !ADMIN_PASSWORD) { console.error('Missing DATABASE_URL or ADMIN_PASSWORD'); process.exit(1); }

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } });
await pool.query('create table if not exists kv(k text primary key, v jsonb not null)');

const EMPTY = { students: {}, rows: [], cfg: { chaz: {} }, rep: {}, log: [], curWeek: 1, dayOv: '' };
const getState = async () => (await pool.query("select v from kv where k='state'")).rows[0]?.v || structuredClone(EMPTY);
const putState = s => pool.query("insert into kv(k,v) values('state',$1) on conflict(k) do update set v=$1", [JSON.stringify(s)]);

// כתיבה אחת בכל רגע (שירות בודד) - מונע התנגשות בין הדפדפן לשלוחה
let q = Promise.resolve();
const locked = fn => { const r = q.then(fn); q = r.catch(() => {}); return r; };

const dayIL = () => ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: -1 })[new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Asia/Jerusalem' }).format(new Date())];
const tsIL = () => new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

const app = express();
app.use(express.json({ limit: '10mb' }));
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'x-pass,content-type', 'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/healthz', (_, res) => res.send('ok'));

const auth = (req, res, next) => req.get('x-pass') === ADMIN_PASSWORD ? next() : res.status(401).json({ error: 'auth' });
app.get('/api/state', auth, async (_, res) => res.json(await getState()));
app.put('/api/state', auth, async (req, res) => {
  res.json(await locked(async () => {
    const inc = req.body; inc.rep = inc.rep || {}; inc.log = inc.log || [];
    if (!req.query.reset) {
      const cur = await getState();
      // דיווחי תלמידות מהטלפון (s) הם המקור הקובע - לא נדרסים מהדפדפן
      for (const [k, days] of Object.entries(cur.rep || {})) {
        inc.rep[k] = inc.rep[k] || [];
        days.forEach((e, i) => { if (e && e.s) { inc.rep[k][i] = inc.rep[k][i] || {}; inc.rep[k][i].s = e.s; } });
      }
      const seen = new Set(inc.log.map(l => l.t + l.id + l.msg));
      (cur.log || []).forEach(l => { if (!seen.has(l.t + l.id + l.msg)) inc.log.push(l); });
    }
    await putState(inc);
    return inc;
  }));
});

// ---------- שלוחת דיווח בימות המשיח ----------
const say = t => [{ type: 'text', data: t }];
const KEYS = { 1: 'done', 2: 'missed', 3: 'free' };
const LABEL = { done: 'ביצעתי', missed: 'לא ביצעתי', free: 'יום חופשי' };
const ivr = YemotRouter({ printLog: true });

ivr.get('/', async call => {
  const bye = msg => { call.id_list_message(say(msg), { prependToNextAction: true }); return call.hangup(); };
  let id = await call.read(say('אנא הקישי את מספר תעודת הזהות שלך, ובסיומו סולמית'), 'tap',
    { val_name: 'ID', min_digits: 5, max_digits: 9, sec_wait: 8, block_asterisk_key: true, amount_attempts: 3 });
  id = String(id).padStart(9, '0');

  const ok = await locked(async () => {
    const s = await getState(), row = s.rows.find(x => x.id === id), d = dayIL();
    if (row && row.week && row.week == s.curWeek && d >= 0) return true;
    if (s.students[id]) { s.log.push({ t: tsIL(), id, msg: 'דיווח טלפוני נדחה - לא משובצת בתקופה זו' }); await putState(s); }
    return false;
  });
  if (!ok) return bye('אינך משובצת לתורנות בתקופה זו');

  const key = await call.read(say('הקישי 1 אם ביצעת את התפקיד, 2 אם לא ביצעת, 3 ליום חופשי'), 'tap',
    { val_name: 'KEY', min_digits: 1, max_digits: 1, sec_wait: 8, digits_allowed: ['1', '2', '3'], amount_attempts: 3 });

  const res = await locked(async () => {   // קריאה מחדש בתוך הנעילה, כדי לא לדרוס שינויים
    const s = await getState(), row = s.rows.find(x => x.id === id), d = dayIL();
    if (!row || row.week != s.curWeek || d < 0) return false;
    const k = id + '|' + row.week;
    s.rep[k] = s.rep[k] || []; s.rep[k][d] = Object.assign(s.rep[k][d] || {}, { s: KEYS[key] });
    s.log.push({ t: tsIL(), id, msg: 'דיווח תלמידה (טלפון) ליום ' + 'אבגדהו'[d] + ': ' + LABEL[KEYS[key]] });
    await putState(s); return true;
  });
  return bye(res ? 'הדיווח נקלט, תודה' : 'אינך משובצת לתורנות בתקופה זו');
});

app.use('/ivr/' + IVR_SECRET, ivr);
app.get('/', (_, res) => res.send('tornuyot server is running'));
app.listen(PORT, () => console.log('listening on', PORT));
