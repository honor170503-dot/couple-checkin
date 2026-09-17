// 情侣互督计分器 - 服务端 (零依赖 Node.js)
// 数据持久化到 data/db.json，两人通过同一网址访问，账本互通
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// 数据目录解析（优先级从高到低）：
//   1) DATA_DIR 环境变量 —— 显式指定，最可靠
//   2) 部署环境自动兜底：类 Unix 下若存在 /workspace 持久目录，就把账本放到
//      /workspace/.data，使其位于「部署包之外」，每次发布只覆盖代码、不碰数据。
//      本机开发（Windows / 无 /workspace）自动落到 3)，行为不变。
//   3) ROOT/data —— 开发默认位置
function resolveDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  try {
    if (process.platform !== 'win32') {
      const ws = '/workspace';
      if (fs.existsSync(ws) && fs.statSync(ws).isDirectory()) return path.join(ws, '.data');
    }
  } catch (e) { /* 探测失败则退回默认 */ }
  return path.join(ROOT, 'data');
}

const DATA_DIR = resolveDataDir();
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LEGACY_DB_FILE = path.join(ROOT, 'data', 'db.json'); // 旧位置，仅用于首次迁移
const PORT = process.env.PORT || 3867;

/* ================= 时间工具（固定 +8 时区，服务器时间只做兜底） ================= */
const TZ_OFFSET = 8 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');

function dateFromTs(ts) {
  const d = new Date(ts + TZ_OFFSET);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
// 每日结算点（小时）：0 = 当晚 24:00（零点切换），4 = 次日凌晨 4:00 切换
// 例：结算点为 4 时，凌晨 3 点打卡仍算作前一天，4 点后才按新的一天/未完成结算
function cutoffHour() {
  const v = db && db.rules ? Number(db.rules.dayCutoffHour) : 0;
  if (!isFinite(v)) return 0;
  return Math.min(12, Math.max(0, Math.round(v)));
}
function todayStr() {
  let t = Date.now();
  if (new Date(t + TZ_OFFSET).getUTCHours() < cutoffHour()) t -= 86400000; // 未到结算点，仍算前一天
  return dateFromTs(t);
}

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - TZ_OFFSET; // 转回真实时间戳（当天 0 点）
}
function dateAdd(str, days) {
  return dateFromTs(parseDate(str) + days * 86400000);
}
function weekdayCN(str) {
  // 直接按日历日期的星期计算（与展示时区无关）
  const [y, m, d] = str.split('-').map(Number);
  return ['日', '一', '二', '三', '四', '五', '六'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
// 所在比赛周的起始周六
function cycleStartOf(dateStr) {
  let d = dateStr;
  while (weekdayCN(d) !== '六') d = dateAdd(d, -1);
  return d;
}
function cycleEndOf(startStr) { return dateAdd(startStr, 6); } // 周五
function todayCN() {
  const w = weekdayCN(todayStr());
  return '星期' + w;
}

/* ================= 数据存储 ================= */
const DEFAULT_RULES = {
  startScore: 100,
  wakeDeduct: 1,           // 晚起扣分
  dayCutoffHour: 4,        // 每日结算点：0=当晚 24:00，4=次日凌晨 4:00（凌晨继续算前一天）
  enabledFrom: null,       // 缺勤起算日（YYYY-MM-DD）：早于它一律不判缺勤。缺失时自动取账本最早一天
  taskDeducts: {           // 各科任务未完成扣分（科目名 -> 每科扣分）
    '政治': 1,
    '英语': 1,
    '专业课': 2,
  },
  screenLimitMinutes: 180, // 娱乐软件超时判定线（仅用于文案提示：超过它算“超时”）
  screenRate: 1,           // 屏幕“超时”固定扣分（二选一，不再按时长换算）
  leaveFreePerWeek: 2,     // 每周免费请假额度（次数）
  leaveMaxHours: 3,        // 请假超时判定线（仅用于文案提示：超过它算“超时”）
  leaveHourRate: 1,        // 请假每超 1 小时扣分
  penaltyText: '输的人请对方喝奶茶，本周打工人当牛马也要快乐！', // 结算惩罚文案
};

function defaultDB() {
  return {
    version: 1,
    users: [
      { id: 'a', name: '小蓝', color: '#5b7cfa' },
      { id: 'b', name: '小粉', color: '#f7617e' },
    ],
    rules: JSON.parse(JSON.stringify(DEFAULT_RULES)),
    days: {}, // 'YYYY-MM-DD' -> { a: userDay, b: userDay }
  };
}

function emptyUserDay() {
  return {
    wake: null,            // null 未记录 / 'late' 晚起 / 'ok' 正常
    screenOver: null,      // 娱乐软件是否超时：null 未记录 / true 超时 / false 未超时
    subjects: {},          // 三科打卡：{ '政治': true|false|null, '英语': …, '专业课': … }（true完成/false未完成/null没点）
    leaves: [],            // { id, type:'normal'|'event', overtime, overHours, reason, ts }
    _t: 0,                 // 用于保证 id 唯一
  };
}
// 当天“本人有没有动过 App”：起床 / 屏幕 / 任一科打卡 / 请假，任一有值即算动过。
// 这是漏点结算的开关——没动过的人不进入漏点判定，而是走“缺勤”。
function actedOf(ud) {
  if (!ud) return false;
  return (ud.wake !== null && ud.wake !== undefined)
    || (ud.screenOver !== null && ud.screenOver !== undefined)
    || Object.values(ud.subjects || {}).some((v) => v === true || v === false)
    || (ud.leaves || []).length > 0;
}

let db = null;
let readOnlyMode = false; // 账本损坏且无法自救时置位：拒绝一切写盘，绝不把坏状态固化

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function listSnapshots() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR).filter((x) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
  } catch (e) { return []; }
}
function latestSnapshot() {
  const files = listSnapshots();
  return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null;
}

// 启动足迹：每次启动往 DATA_DIR/boot.log 追一行（只追加、不重写、不参与计分）。
// 用途：判断「一次发布是否清空了数据目录」——
//   数据目录存活 → 每次重启 bootCount 递增
//   数据目录被清 → bootCount 归 1（说明只靠包里那份账本重新迁移）
function appendBootLog(info) {
  try {
    ensureDirs();
    fs.appendFileSync(path.join(DATA_DIR, 'boot.log'), JSON.stringify(info) + '\n', 'utf8');
  } catch (e) { /* 写不了也不影响主流程 */ }
}
function readBootLog(limit) {
  try {
    const f = path.join(DATA_DIR, 'boot.log');
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-(limit || 5)).map((l) => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
  } catch (e) { return []; }
}
function bootCount() {
  try {
    const f = path.join(DATA_DIR, 'boot.log');
    if (!fs.existsSync(f)) return 0;
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  } catch (e) { return -1; }
}
// 每日快照：每天第一份，最多保留 7 份。目录在部署包之外，上线不会覆盖它。
function snapshotDaily() {
  if (readOnlyMode) return;
  try {
    if (!fs.existsSync(DB_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const f = path.join(BACKUP_DIR, 'db-' + todayStr() + '.json');
    if (!fs.existsSync(f)) {
      fs.copyFileSync(DB_FILE, f);
      console.log('[backup] 已生成每日快照 ' + path.basename(f));
    }
    const files = listSnapshots();
    while (files.length > 7) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) {}
    }
  } catch (e) { console.error('[backup] 快照失败: ' + (e && e.message)); }
}

/* ---------- 旧数据迁移（幂等，每次启动都跑一遍） ---------- */
function migrateRules() {
  if (db.rules.taskDeduct !== undefined && !db.rules.taskDeducts) {
    const old = Number(db.rules.taskDeduct) || 1;
    db.rules.taskDeducts = { '政治': old, '英语': old, '专业课': old };
  }
  if (db.rules.leaveDeduct !== undefined && db.rules.leaveHourRate === undefined) db.rules.leaveHourRate = 1;
  delete db.rules.taskDeduct; delete db.rules.leaveDeduct;
  if (!db.rules.taskDeducts || typeof db.rules.taskDeducts !== 'object') {
    db.rules.taskDeducts = JSON.parse(JSON.stringify(DEFAULT_RULES.taskDeducts));
  }
  // 缺勤起算日：没设过就取账本里最早的一天（空账本则取今天），Early 于它一律不判缺勤
  if (!db.rules.enabledFrom) {
    const days = Object.keys(db.days || {}).sort();
    db.rules.enabledFrom = days.length ? days[0] : todayStr();
    console.log('[migrate] 缺勤起算日设为 ' + db.rules.enabledFrom);
  }
}
function migrateDays() {
  const maxH = Number(db.rules.leaveMaxHours) || 3;
  const limit = Number(db.rules.screenLimitMinutes) || 180;
  for (const ds of Object.keys(db.days || {})) {
    const day = db.days[ds];
    for (const u of db.users) {
      const ud = day[u.id];
      if (!ud) continue;
      // 屏幕：分钟数 -> 是否超时（旧值超过限额才算超时）
      if (ud.screenOver === undefined) {
        ud.screenOver = ud.screenMin == null ? null : Number(ud.screenMin) > limit;
      }
      delete ud.screenMin;
      // 请假：时长 -> 超时标记 + 超出小时数
      ud.leaves = (ud.leaves || []).map((lv) => {
        if (lv.type === 'event') return { id: lv.id, type: 'event', overtime: false, overHours: 0, reason: lv.reason || '', ts: lv.ts };
        if (lv.overtime === undefined) {
          const h = Number(lv.hours) || 0;
          lv.overtime = h > maxH;
          lv.overHours = lv.overtime ? Math.ceil(h - maxH) : 0;
        }
        delete lv.hours;
        return lv;
      });
      ud.subjects = ud.subjects || {};
      if (ud.tasks) delete ud.tasks; // 旧字段（自由任务列表）已废弃
    }
  }
}

function loadDB() {
  if (db) return db;
  const dbExistedBefore = fs.existsSync(DB_FILE);
  const legacyExistedBefore = fs.existsSync(LEGACY_DB_FILE);
  let migrated = false;
  // 首次启动：若数据目录已挪出部署包，把旧位置的账本搬过来
  try {
    ensureDirs();
    if (!dbExistedBefore && LEGACY_DB_FILE !== DB_FILE && legacyExistedBefore) {
      fs.copyFileSync(LEGACY_DB_FILE, DB_FILE);
      migrated = true;
      console.log('[migrate] 账本已从 ' + LEGACY_DB_FILE + ' 迁移到 ' + DB_FILE);
    }
  } catch (e) { console.error('[migrate] 迁移失败: ' + (e && e.message)); }
  // 记一笔启动足迹（用于事后判断发布有没有清掉数据目录）
  appendBootLog({ t: new Date().toISOString(), dbExistedBefore, legacyExistedBefore, migrated, pid: process.pid });

  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (!db.users || !db.rules) throw new Error('bad db shape');
    } catch (e) {
      // 文件在、但读不出来 = 损坏。绝不覆盖：先留档，再尝试从快照自救。
      const bad = path.join(DATA_DIR, 'db.corrupt-' + Date.now() + '.json');
      try { fs.copyFileSync(DB_FILE, bad); } catch (e2) {}
      console.error('[FATAL] db.json 无法解析，原文件已留档到 ' + bad);
      const snap = latestSnapshot();
      let ok = false;
      if (snap) {
        try {
          const t = JSON.parse(fs.readFileSync(snap, 'utf8'));
          if (t.users && t.rules && t.days) { db = t; ok = true; console.error('[recover] 已从快照恢复：' + snap); }
        } catch (e3) {}
      }
      if (!ok) {
        readOnlyMode = true;
        console.error('[readonly] 无可用快照，服务以只读模式启动：拒绝一切写盘，等人工处理');
        return defaultDB();
      }
    }
  } else {
    db = defaultDB(); // 首次运行
  }

  db.rules = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_RULES)), db.rules || {});
  migrateRules();
  migrateDays();
  saveDB(); // 让迁移结果落盘，并顺带生成当日快照
  return db;
}
let writeTimer = null;
function saveDB() {
  if (readOnlyMode) return;
  ensureDirs();
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
      fs.renameSync(tmp, DB_FILE);
      snapshotDaily();
    } catch (e) { console.error('[write] 写盘失败: ' + (e && e.message)); }
  }, 120);
}
function getDay(dateStr) {
  if (!db.days[dateStr]) db.days[dateStr] = {};
  const d = db.days[dateStr];
  for (const u of db.users) {
    const ud = d[u.id];
    if (ud) {
      ud.subjects = ud.subjects || {};
      ud.leaves = ud.leaves || [];
      if (ud.tasks) delete ud.tasks; // 旧字段（自由任务列表）已废弃
    }
  }
  return d;
}
// 只为「写入方」建档。旧版这里会给双方都建空档案，导致一方记录后
// 另一方被连带判定为“漏点”，所以必须分开。
function ensureUserDay(dateStr, uid) {
  const d = getDay(dateStr);
  if (!d[uid]) d[uid] = emptyUserDay();
  saveDB();
  return d[uid];
}
function getUid(nameOrId) {
  const u = db.users.find((x) => x.id === nameOrId || x.name === nameOrId);
  return u ? u.id : null;
}

/* ================= 计分引擎 ================= */
function subjectNames() {
  return Object.keys(db.rules.taskDeducts || {}).filter(Boolean);
}

function deductOfCycle(startStr) {
  // 返回 { a:{score,total,events,absentDays}, b:{...}, winner, isTie }
  const rules = db.rules;
  const end = cycleEndOf(startStr);
  const result = {};
  const today = todayStr();
  const subs = subjectNames(); // 固定顺序科目（政治/英语/专业课…可配）
  const enabledFrom = rules.enabledFrom || null;
  for (const u of db.users) {
    const uid = u.id;
    const events = [];
    let lvIndex = 0;     // 本周普通请假序号（用于超出免费次数后固定 +1）
    let total = 0;
    let absentDays = 0;  // 本周缺勤天数
    let d = startStr;
    while (d <= end) {
      const raw = db.days[d] ? db.days[d][uid] : null;
      const dayPast = d < today;               // 今天还没过完，不结算
      const inScope = !enabledFrom || d >= enabledFrom;
      const acted = actedOf(raw);              // 本人当天有没有动过 App
      const absent = !acted && inScope && dayPast;
      if (!raw && !absent) { d = dateAdd(d, 1); continue; } // 启用日之前的日子不结算
      if (absent) {
        absentDays++;
        events.push({ date: d, label: '缺勤（当天未打开）', points: 0, note: '整天未打开 App，三科按未完成计' });
      }
      // 起床：只有本人动过 App 才判晚起（缺勤不额外扣这一项）
      if (acted && raw.wake === 'late') {
        total += rules.wakeDeduct;
        events.push({ date: d, label: '晚起', points: rules.wakeDeduct, note: '' });
      }
      // 三科打卡：动过 App 的人「没点」算漏点；整天没动的人整体按未完成
      for (const cat of subs) {
        const st = acted && raw.subjects ? raw.subjects[cat] : null;
        const deduct = Number(rules.taskDeducts[cat] || 1);
        if (st === false || (st == null && dayPast)) {
          total += deduct;
          events.push({
            date: d,
            label: `${cat} 未完成`,
            points: deduct,
            note: absent ? '缺勤，按未完成计' : (st === false ? '本人标记未完成' : '当日未打卡，按未完成计'),
          });
        } else if (st === true) {
          events.push({ date: d, label: `${cat} 完成`, points: 0, note: '' });
        }
      }
      if (acted) {
        // 屏幕：二选一，超时固定扣 screenRate
        if (raw.screenOver === true) {
          total += rules.screenRate;
          events.push({ date: d, label: '娱乐软件超时', points: rules.screenRate, note: '超过 ' + fmtMin(rules.screenLimitMinutes) });
        }
        // 请假：没超时只消耗一次额度；超时每超 1 小时扣 leaveHourRate；
        //       超出免费次数后第 N 次固定再扣 1 分（不再按 3/4/5 递增）
        const leaves = (raw.leaves || []).slice().sort((x, y) => (x.ts || 0) - (y.ts || 0));
        for (const lv of leaves) {
          if (lv.type === 'event') {
            events.push({ date: d, label: '突发事件请假(豁免)', points: 0, note: lv.reason || '' });
            continue;
          }
          lvIndex++;
          const overH = lv.overtime ? (Number(lv.overHours) || 0) : 0;
          const overPts = overH * (rules.leaveHourRate || 1);
          const basePts = lvIndex > rules.leaveFreePerWeek ? 1 : 0;
          const pts = overPts + basePts;
          if (pts === 0) {
            events.push({ date: d, label: `请假(免费额度 ${lvIndex}/${rules.leaveFreePerWeek})`, points: 0, note: '未超时 · ' + (lv.reason || '') });
          } else {
            total += pts;
            const why = [];
            if (overPts) why.push(`超时${overH}h`);
            if (basePts) why.push(`第${lvIndex}次`);
            events.push({ date: d, label: `请假扣分(${why.join('+')})`, points: pts, note: (lv.overtime ? '超时' : '未超时') + ' · ' + (lv.reason || '') });
          }
        }
      }
      d = dateAdd(d, 1);
    }
    result[uid] = { score: rules.startScore - total, total, events, absentDays };
  }
  const [u1, u2] = db.users;
  const r1 = result[u1.id], r2 = result[u2.id];
  let winner = null;
  if (r1.score > r2.score) winner = u1.id;
  else if (r2.score > r1.score) winner = u2.id;
  return Object.assign(result, {
    winner,
    isTie: r1.score === r2.score,
    rules,
    users: db.users,
    start: startStr,
    end,
  });
}

function fmtMin(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  if (h === 0) return `${mm} 分钟`;
  return mm === 0 ? `${h} 小时` : `${h} 小时 ${mm} 分`;
}

function cycleSummary(calc) {
  const [u1, u2] = db.users;
  const r1 = calc[u1.id], r2 = calc[u2.id];
  return {
    start: calc.start, end: calc.end,
    scores: { [u1.id]: r1.score, [u2.id]: r2.score },
    winner: calc.winner, isTie: calc.isTie,
    deduct: { [u1.id]: r1.total, [u2.id]: r2.total },
  };
}

// 所有已完成(结束日 < 今天)且有数据的比赛周
function weekHasData(startStr) {
  const end = cycleEndOf(startStr);
  let d = startStr;
  while (d <= end) {
    if (db.days[d]) {
      for (const u of db.users) {
        const ud = db.days[d][u.id];
        if (ud && actedOf(ud)) return true;
      }
    }
    d = dateAdd(d, 1);
  }
  return false;
}
// 历史战绩缓存：已结算周的数据是只读的（服务端锁定当前周之外的一切写入），
// 因此同一比赛周内历史列表不会变化，只在“跨周/改规则”时失效，无需每次请求全量回溯。
let histCache = { key: null, list: null };
function historyCycles() {
  const today = todayStr();
  const key = cycleStartOf(today); // 历史集合只取决于“本周是第几周”
  if (histCache.key === key && histCache.list) return histCache.list;
  const list = [];
  let cur = cycleStartOf(dateAdd(today, -7)); // 从上一个比赛周往前推
  const guard = 520;
  while (cycleEndOf(cur) < today && guard > 0) {
    if (weekHasData(cur)) list.push(cycleSummary(deductOfCycle(cur)));
    cur = dateAdd(cur, -7);
  }
  histCache = { key, list: list.reverse() };
  return histCache.list;
}
function invalidateHist() { histCache = { key: null, list: null }; }

// 写入锁：只有「当前比赛周、且不晚于今天」的日期允许修改
function lockMsg(date) {
  const today = todayStr();
  if (date > today) return '未来日期还不能记录哦';
  if (cycleStartOf(date) !== cycleStartOf(today)) return '该周已结算锁定，仅可回看';
  return null;
}

/* ================= HTTP 服务 ================= */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function publicCycleView(startStr) {
  const calc = deductOfCycle(startStr);
  const today = todayStr();
  const enabledFrom = db.rules.enabledFrom || null;
  const view = {
    start: calc.start,
    end: calc.end,
    today,
    isCurrent: cycleStartOf(today) === calc.start,
    weekday: weekdayCN(today),
    users: calc.users,
    rules: calc.rules,
    isTie: calc.isTie,
    winner: calc.winner,
    totals: {},
    days: [],
  };
  for (const u of db.users) {
    view.totals[u.id] = {
      score: calc[u.id].score,
      total: calc[u.id].total,
      absentDays: calc[u.id].absentDays || 0, // 本周缺勤天数
    };
  }
  let d = calc.start;
  while (d <= calc.end) {
    const row = { date: d, weekday: weekdayCN(d), users: {} };
    const raw = db.days[d] || {};
    const dayPast = d < today;
    const inScope = !enabledFrom || d >= enabledFrom;
    for (const u of db.users) {
      const has = !!(raw && raw[u.id]);
      const ud = has ? raw[u.id] : emptyUserDay();
      const acted = actedOf(has ? ud : null);
      const absent = !acted && inScope && dayPast; // 缺勤只判已过完、且在启用日之后的日子
      const evs = calc[u.id].events.filter((e) => e.date === d);
      row.users[u.id] = {
        exists: has,     // 本人当天是否真的建过档（不再受“对方记录”影响）
        acted,           // 本人当天有没有动过 App
        absent,          // 是否缺勤
        wake: ud.wake,
        screenOver: ud.screenOver,
        subjects: ud.subjects || {},
        leaves: ud.leaves,
        events: evs,
      };
    }
    view.days.push(row);
    d = dateAdd(d, 1);
  }
  return view;
}

const server = http.createServer(async (req, res) => {
  loadDB();
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  try {
    /* ---------- API ---------- */
    if (p === '/api/state') {
      const cur = cycleStartOf(todayStr());
      const view = publicCycleView(cur);
      view.history = historyCycles();
      return send(res, 200, view);
    }
    if (p === '/api/cycle' && method === 'GET') {
      const start = url.searchParams.get('start');
      if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return send(res, 400, { err: 'bad date' });
      const view = publicCycleView(cycleStartOf(start));
      view.history = historyCycles();
      return send(res, 200, view);
    }
    if (p === '/api/day' && method === 'POST') {
      const body = await readBody(req);
      const { date, user, wake, screenOver } = body;
      const uid = getUid(user);
      if (!date || !uid) return send(res, 400, { err: 'missing fields' });
      const locked = lockMsg(date);
      if (locked) return send(res, 403, { err: locked });
      const ud = ensureUserDay(date, uid); // 只给写入方建档，避免连带影响对方
      if (typeof wake === 'boolean') ud.wake = wake ? 'late' : 'ok';
      else if (wake === 'late' || wake === 'ok') ud.wake = wake;
      else if (wake === null || wake === '') ud.wake = null;
      // 屏幕：二选一（超时 / 未超时），null 表示未记录
      if (screenOver !== undefined) ud.screenOver = (screenOver === null || screenOver === '') ? null : !!screenOver;
      // 三科打卡：{ subject: '政治', done: true|false|null }
      if (body.subject) {
        const cat = String(body.subject);
        if (subjectNames().includes(cat)) ud.subjects[cat] = body.done === null ? null : !!body.done;
      }
      // 直接返回写完后该周的最新视图，省掉前端的第二次 GET
      return send(res, 200, { ok: true, view: publicCycleView(cycleStartOf(date)) });
    }
    if (p === '/api/leave' && method === 'POST') {
      const body = await readBody(req);
      const { date, user, type, overtime, overHours, reason } = body;
      const uid = getUid(user);
      if (!date || !uid || !type) return send(res, 400, { err: 'missing' });
      const locked = lockMsg(date);
      if (locked) return send(res, 403, { err: locked });
      const ud = ensureUserDay(date, uid);
      ud._t = (ud._t || 0) + 1;
      const isOver = type === 'event' ? false : !!overtime;
      const over = isOver ? Math.max(1, Math.round(Number(overHours) || 1)) : 0;
      ud.leaves.push({
        id: `l${Date.now()}_${ud._t}`,
        type: type === 'event' ? 'event' : 'normal',
        overtime: isOver,
        overHours: over,
        reason: String(reason || '').trim(),
        ts: Date.now(),
      });
      return send(res, 200, { ok: true, view: publicCycleView(cycleStartOf(date)) });
    }
    if (p === '/api/leave-remove' && method === 'POST') {
      const body = await readBody(req);
      const { date, user, leaveId } = body;
      const uid = getUid(user);
      if (!date || !uid) return send(res, 400, { err: 'missing' });
      const locked = lockMsg(date);
      if (locked) return send(res, 403, { err: locked });
      const d0 = getDay(date); // 没有档案就没有可删的请假，不要顺手建档
      if (d0[uid]) {
        d0[uid].leaves = d0[uid].leaves.filter((l) => l.id !== leaveId);
        saveDB();
      }
      return send(res, 200, { ok: true, view: publicCycleView(cycleStartOf(date)) });
    }
    if (p === '/api/rules' && method === 'POST') {
      const body = await readBody(req);
      const src = body.rules || body;
      const numKeys = ['startScore', 'wakeDeduct', 'screenLimitMinutes', 'screenRate', 'leaveFreePerWeek', 'leaveMaxHours', 'leaveHourRate'];
      for (const k of numKeys) {
        if (src[k] !== undefined) {
          const v = Number(src[k]);
          if (!isNaN(v)) db.rules[k] = k === 'screenLimitMinutes' ? Math.max(1, Math.round(v)) : Math.max(0, v);
        }
      }
      if (src.penaltyText !== undefined) db.rules.penaltyText = String(src.penaltyText);
      // 每日结算点（0 = 当晚 24:00，4 = 次日凌晨 4:00）
      if (src.dayCutoffHour !== undefined) {
        const v = Number(src.dayCutoffHour);
        if (!isNaN(v)) db.rules.dayCutoffHour = Math.min(12, Math.max(0, Math.round(v)));
      }
      // 缺勤起算日：早于它一律不判缺勤
      if (src.enabledFrom !== undefined) {
        const s = String(src.enabledFrom).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) db.rules.enabledFrom = s;
      }
      // 各科任务扣分（taskDeducts 对象）
      if (src.taskDeducts && typeof src.taskDeducts === 'object') {
        if (!db.rules.taskDeducts || typeof db.rules.taskDeducts !== 'object') db.rules.taskDeducts = {};
        for (const cat of Object.keys(src.taskDeducts)) {
          const v = Number(src.taskDeducts[cat]);
          if (!isNaN(v) && v >= 0 && cat) db.rules.taskDeducts[String(cat).slice(0, 10)] = v;
        }
        // 默认科目兜底
        for (const def of ['政治', '英语', '专业课']) {
          if (db.rules.taskDeducts[def] === undefined) db.rules.taskDeducts[def] = def === '专业课' ? 2 : 1;
        }
      }
      saveDB();
      invalidateHist(); // 规则变更会影响历史周的重算结果
      return send(res, 200, { ok: true, rules: db.rules });
    }
    if (p === '/api/names' && method === 'POST') {
      const body = await readBody(req);
      const n = body.names;
      if (Array.isArray(n) && n.length === 2) {
        db.users.forEach((u, i) => { if (n[i] && String(n[i]).trim()) u.name = String(n[i]).trim().slice(0, 8); });
        saveDB();
      }
      return send(res, 200, { ok: true, users: db.users });
    }
    // 只读自检：用来确认「账本到底读写的哪个文件」——发布后核对数据目录是否落在部署包之外
    if (p === '/api/health') {
      let snapshots = 0;
      try { snapshots = listSnapshots().length; } catch (e) { snapshots = -1; }
      return send(res, 200, {
        ok: true,
        now: new Date().toISOString(),
        today: todayStr(),
        dataDir: DATA_DIR,
        dbFile: DB_FILE,
        dbExists: fs.existsSync(DB_FILE),
        dataDirFrom: process.env.DATA_DIR ? 'env' : (DATA_DIR === path.join(ROOT, 'data') ? 'default' : 'auto'),
        insidePackage: DATA_DIR.startsWith(ROOT), // true = 账本还在部署包内（发布会被覆盖）
        legacyDbFile: LEGACY_DB_FILE,
        legacyExists: fs.existsSync(LEGACY_DB_FILE),
        snapshots,
        readOnly: readOnlyMode,
        days: db ? Object.keys(db.days).sort() : [],
        enabledFrom: db && db.rules ? db.rules.enabledFrom : null,
        // 时间戳信号：用它可以判断「发版是否清掉了数据目录」——
        // 若重新发布后 dbMtime 不变，说明 .data 存活；若变成新时间，说明被清后重新迁移了
        dbMtime: (() => { try { return fs.statSync(DB_FILE).mtime.toISOString(); } catch (e) { return null; } })(),
        dataDirMtime: (() => { try { return fs.statSync(DATA_DIR).mtime.toISOString(); } catch (e) { return null; } })(),
        snapshotFiles: (() => { try { return listSnapshots(); } catch (e) { return []; } })(),
        // 启动足迹：bootCount 递增 = 数据目录存活；归 1 = 被清后重建
        bootCount: bootCount(),
        recentBoots: readBootLog(6),
      });
    }
    if (p === '/api/export') {
      const body = JSON.stringify(db, null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="couple-score-backup.json"' });
      return res.end(body);
    }
    if (p === '/api/import' && method === 'POST') {
      const body = await readBody(req);
      if (body && body.users && body.rules && body.days) {
        db = body;
        db.rules = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_RULES)), db.rules || {});
        saveDB();
        invalidateHist();
        return send(res, 200, { ok: true });
      }
      return send(res, 400, { err: 'invalid backup' });
    }

    /* ---------- 静态文件 ---------- */
    let fp = p === '/' ? '/index.html' : p;
    const full = path.normalize(path.join(PUBLIC_DIR, fp));
    if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, { err: 'forbidden' });
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      // SPA 回退
      const idx = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(idx)) {
        const c = fs.readFileSync(idx);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': c.length });
        return res.end(c);
      }
      return send(res, 404, { err: 'not found' });
    }
    const ext = path.extname(full).toLowerCase();
    const map = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
    const c = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': map[ext] || 'application/octet-stream', 'Content-Length': c.length, 'Cache-Control': 'no-cache' });
    return res.end(c);
  } catch (e) {
    return send(res, 500, { err: String(e && e.message || e) });
  }
});

loadDB(); // 启动即加载，便于在日志里报告数据位置与损坏状态

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Couple Score server running at http://localhost:${PORT}`);
  console.log(`  数据目录 : ${DATA_DIR}`);
  console.log(`  账本文件 : ${DB_FILE}`);
  console.log(`  每日快照 : ${BACKUP_DIR}（保留最近 7 份）`);
  console.log(`  缺勤起算 : ${db && db.rules ? db.rules.enabledFrom : '-'}`);
  if (readOnlyMode) console.log('  ⚠️ 只读模式：账本损坏且无可用快照，已拒绝一切写盘');
});
