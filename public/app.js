/* 情侣互督计分器 - 前端逻辑（事件委托版） */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  let S = null;            // 服务端 state
  let me = localStorage.getItem('couple_me') || null; // 'a' | 'b'
  let viewDate = null;     // 当前选中的日期
  let activeCycle = null;  // 当前查看的比赛周 start
  let activeTab = 'me';    // 'me' | 'other'

  let mutSeq = 0;            // 写请求序号：只采纳最新一次写操作返回的视图
  const busyKeys = new Set(); // 'date|uid'：正在后台同步中的记录块

  /* ============ API ============ */
  async function api(path, method, body) {
    const opt = { method: method || 'GET', headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(path, opt);
    const j = await res.json();
    if (!res.ok) throw new Error(j.err || '请求失败');
    return j;
  }
  async function loadState() {
    const url = activeCycle ? '/api/cycle?start=' + encodeURIComponent(activeCycle) : '/api/state';
    const j = await api(url);
    adoptView(j);
    if (!activeCycle) activeCycle = j.start;
    renderAll();
  }

  // 采纳（服务端返回的）最新视图：保留 history 与当前查看位置，避免跳动
  function adoptView(j) {
    const hist = (S && S.history) || j.history || [];
    const prev = viewDate;
    S = j;
    S.history = hist;
    const dates = S.days.map((d) => d.date);
    if (!prev || !dates.includes(prev)) viewDate = S.isCurrent ? S.today : S.end;
    if (viewDate > S.today) viewDate = S.today;
  }

  // 本地判定：本人当天有没有动过 App（镜像服务端 actedOf）
  // 起床 / 屏幕 / 任一科打卡 / 请假，任一有值即算“动过”。
  function actedLocal(ud) {
    if (!ud) return false;
    return (ud.wake !== null && ud.wake !== undefined)
      || (ud.screenOver !== null && ud.screenOver !== undefined)
      || Object.values(ud.subjects || {}).some((v) => v === true || v === false)
      || (ud.leaves || []).length > 0;
  }

  // 本地重算当前周的比分 / 每日账目（镜像服务端 deductOfCycle，只算视图这一周，毫秒级）
  function localCalc() {
    const rules = S.rules;
    const startScore = Number(rules.startScore) || 0;
    const wakeDeduct = Number(rules.wakeDeduct) || 0;
    const screenRate = Number(rules.screenRate) || 0;
    const leaveHourRate = Number(rules.leaveHourRate) || 1;
    const leaveFree = Number(rules.leaveFreePerWeek) || 0;
    const subs = Object.keys(rules.taskDeducts || {});
    const today = S.today;
    const enabledFrom = rules.enabledFrom || null;
    const out = {};
    for (const u of S.users) {
      const uid = u.id;
      let total = 0;
      let lvIndex = 0;     // 本周普通请假序号（跨天累计）
      let absentDays = 0;  // 本周缺勤天数
      for (const row of S.days) {
        const d = row.date;
        const ud = row.users[uid] || {};
        const evs = [];
        const acted = actedLocal(ud);                        // 本人当天有没有动过 App
        const inScope = !enabledFrom || d >= enabledFrom;    // 启用日之前不判缺勤
        const dayPast = d < today;                           // 今天没过完，不结算
        const absent = !acted && inScope && dayPast;
        ud.acted = acted;   // 回填给渲染层（服务端视图里也有，乐观更新后需本地纠正）
        ud.absent = absent;
        // 与 service 一致：没有档案、也不算缺勤的空白日直接跳过
        if (!ud.exists && !absent) { row.users[uid].events = evs; continue; }
        if (absent) {
          absentDays++;
          evs.push({ date: d, label: '缺勤（当天未打开）', points: 0, note: '整天未打开 App，三科按未完成计' });
        }
        // 起床：只有本人动过 App 才判晚起（缺勤不额外扣这一项）
        if (acted && ud.wake === 'late') {
          total += wakeDeduct;
          evs.push({ date: d, label: '晚起', points: wakeDeduct, note: '' });
        }
        // 三科打卡：动过的人「没点」算漏点；整天没动的人整体按未完成
        for (const cat of subs) {
          const st = acted && ud.subjects ? ud.subjects[cat] : null;
          const deduct = Number(rules.taskDeducts[cat]) || 1;
          if (st === false || (st == null && dayPast)) {
            total += deduct;
            evs.push({ date: d, label: cat + ' 未完成', points: deduct, note: absent ? '缺勤，按未完成计' : (st === false ? '本人标记未完成' : '当日未打卡，按未完成计') });
          } else if (st === true) {
            evs.push({ date: d, label: cat + ' 完成', points: 0, note: '' });
          }
        }
        if (acted) {
          // 屏幕：二选一，超时固定扣 screenRate
          if (ud.screenOver === true) {
            total += screenRate;
            evs.push({ date: d, label: '娱乐软件超时', points: screenRate, note: '超过 ' + fmtMin(rules.screenLimitMinutes) });
          }
          // 请假：没超时只消耗一次额度；超时每超 1 小时扣 leaveHourRate；超出免费次数后第 N 次固定再扣 1 分
          const leaves = (ud.leaves || []).slice().sort((x, y) => (x.ts || 0) - (y.ts || 0));
          for (const lv of leaves) {
            if (lv.type === 'event') {
              evs.push({ date: d, label: '突发事件请假(豁免)', points: 0, note: lv.reason || '' });
              continue;
            }
            lvIndex++;
            const overH = lv.overtime ? (Number(lv.overHours) || 0) : 0;
            const overPts = overH * leaveHourRate;
            const basePts = lvIndex > leaveFree ? 1 : 0;
            const pts = overPts + basePts;
            if (pts === 0) {
              evs.push({ date: d, label: '请假(免费额度 ' + lvIndex + '/' + leaveFree + ')', points: 0, note: '未超时 · ' + (lv.reason || '') });
            } else {
              total += pts;
              const why = [];
              if (overPts) why.push('超时' + overH + 'h');
              if (basePts) why.push('第' + lvIndex + '次');
              evs.push({ date: d, label: '请假扣分(' + why.join('+') + ')', points: pts, note: (lv.overtime ? '超时' : '未超时') + ' · ' + (lv.reason || '') });
            }
          }
        }
        row.users[uid].events = evs;
      }
      out[uid] = { score: startScore - total, total, absentDays };
    }
    S.totals = out;
    const [u1, u2] = S.users;
    const r1 = out[u1.id], r2 = out[u2.id];
    S.winner = r1.score === r2.score ? null : (r1.score > r2.score ? u1.id : u2.id);
    S.isTie = r1.score === r2.score;
  }

  // 乐观更新：把一次写入直接作用到本地 S 的原始行上（与服务端 /api/day、/api/leave* 逻辑对齐）
  function applyLocal(body) {
    const row = S.days.find((d) => d.date === body.date);
    if (!row) return false;
    const ud = row.users[body.user];
    if (!ud) return false;
    if (body.wake !== undefined) ud.wake = body.wake; // 'late' | 'ok' | null
    if (body.screenOver !== undefined) ud.screenOver = body.screenOver; // true 超时 | false 没超时 | null 未记录
    if (body.subject) {
      ud.subjects = ud.subjects || {};
      ud.subjects[body.subject] = body.done === null ? null : !!body.done;
    }
    if (body.type === 'normal' || body.type === 'event') { // 新增请假
      ud._t = (ud._t || 0) + 1;
      const isEvent = body.type === 'event';
      const isOver = isEvent ? false : !!body.overtime;
      ud.leaves = (ud.leaves || []).concat([{
        id: 'tmp_' + Date.now() + '_' + ud._t,
        type: isEvent ? 'event' : 'normal',
        overtime: isOver,
        overHours: isOver ? Math.max(1, Math.round(Number(body.overHours) || 1)) : 0,
        reason: String(body.reason || '').trim(),
        ts: Date.now(),
      }]);
    }
    if (body.leaveId) ud.leaves = (ud.leaves || []).filter((l) => l.id !== body.leaveId);
    // 只有写入方建档（对齐服务端 ensureUserDay）；不再顺手给两人建档，避免连带判对方漏点
    ud.exists = true;
    return true;
  }

  // 写操作：先乐观更新本地（即时反馈），再后台同步；服务端视图返回后兜底校准
  async function mut(path, body, then) {
    const key = (body.date || viewDate) + '|' + (body.user || '');
    busyKeys.add(key);
    const seq = ++mutSeq;
    try {
      if (applyLocal(body)) { localCalc(); renderAll(); }
    } catch (e) { /* 本地预览失败不阻塞，仍以服务端结果为准 */ }
    try {
      const j = await api(path, 'POST', body);
      if (seq !== mutSeq) return; // 已有更新的写入在途，丢弃过期响应
      if (j && j.view) { adoptView(j); renderAll(); }
      else await loadState();
      if (then) then();
    } catch (e) {
      if (seq !== mutSeq) return;
      toast(e.message);
      await loadState(); // 回滚到服务端真实状态
    } finally {
      busyKeys.delete(key);
      syncBusy();
    }
  }
  function syncBusy() {
    $$('.block').forEach((b) => b.classList.toggle('busy', busyKeys.has(b.dataset.key)));
  }

  /* ============ 工具 ============ */
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), 2200);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(d) { const [, m, dd] = d.split('-'); return `${+m}/${+dd}`; }
  function fmtMin(m) {
    if (m == null) return '未记录';
    const h = Math.floor(m / 60), mm = m % 60;
    if (h === 0) return `${mm} 分钟`;
    return mm === 0 ? `${h} 小时` : `${h} 小时 ${mm} 分`;
  }
  // 请假“超了几小时”→ 预估扣分（每超 1 小时扣 leaveHourRate，默认 1）
  function updateOvCalc(block) {
    const inp = block.querySelector('#lvOverHours');
    const out = block.querySelector('#lvOverCalc');
    if (!inp || !out) return;
    const n = Math.max(1, Math.round(Number(inp.value) || 1));
    const rate = Number((S.rules && S.rules.leaveHourRate) || 1);
    out.textContent = '≈ 扣 ' + n * rate + ' 分';
  }
  const otherOf = (uid) => S.users.find((u) => u.id !== uid);
  const meObj = () => (me ? S.users.find((u) => u.id === me) : null);
  // 每日结算点文案：0 → 当晚 24:00；4 → 次日凌晨 4:00
  const cutoffLabel = () => {
    const c = Number((S.rules && S.rules.dayCutoffHour) || 0);
    return c === 0 ? '当晚 24:00' : `次日凌晨 ${c}:00`;
  };
  const wdOf = (y, m, d) => '日一二三四五六'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  // 本周结算时刻（固定 +8 时区）：比赛周最后一天的下一天 cutoff 点
  const settleOf = () => {
    const [y, m, d] = S.end.split('-').map(Number);
    const c = Number((S.rules && S.rules.dayCutoffHour) || 0);
    return { ts: Date.UTC(y, m - 1, d + 1, c) - 8 * 3600e3, label: `周${wdOf(y, m, d + 1)} ${c}:00` };
  };
  const weekEnded = () => Date.now() >= settleOf().ts;

  /* ============ 顶层渲染 ============ */
  function renderAll() {
    renderIdentity();
    renderTopbar();
    renderScore();
    renderTabs();
    renderDayNav();
    renderPanel();
    renderHistory();
    syncBusy();
  }

  function renderIdentity() {
    const box = $('#identityBtns');
    box.innerHTML = S.users.map((u) => `
      <button class="id-btn ${me === u.id ? 'active' : ''}" data-act="pickid" data-uid="${u.id}">
        ${esc(u.name)}<small>${me === u.id ? '✓' : ''}</small>
      </button>`).join('');
    $('#identity-title').textContent = me ? `今天我是 ${esc(meObj().name)}` : '选择你的身份';
  }

  function renderTopbar() {
    const s = S.start.split('-'), e = S.end.split('-');
    $('#weekRange').textContent = `${+s[1]}月${+s[2]}日 ~ ${+e[1]}月${+e[2]}日`;
    const cd = $('#weekCountdown');
    if (S.isCurrent) {
      const settle = settleOf();
      const left = settle.ts - Date.now();
      if (left <= 0) {
        cd.textContent = '本周已结算 · 谁输谁请客';
      } else {
        const hours = Math.floor(left / 3600e3);
        const mins = Math.max(1, Math.round((left % 3600e3) / 60000));
        if (hours >= 48) cd.textContent = `距结算还有 ${Math.ceil(hours / 24)} 天 · ${settle.label}`;
        else if (hours >= 24) cd.textContent = `明天结算 · ${settle.label}`;
        else if (hours >= 1) cd.textContent = `距结算还有 ${hours} 小时 · ${settle.label}`;
        else cd.textContent = `距结算还有 ${mins} 分钟 · ${settle.label}`;
      }
    } else {
      cd.textContent = '历史周 · 回看模式';
    }
    $('#weekRange').style.cursor = S.isCurrent ? 'default' : 'pointer';
  }

  function renderScore() {
    const todayEnds = weekEnded(); // 是否已过本周结算时刻（含每日结算点）
    const wrap = $('#scoreCards');
    wrap.innerHTML = S.users.map((u) => {
      const t = S.totals[u.id];
      const isWin = S.winner === u.id && !S.isTie && todayEnds;
      return `
      <div class="score-card ${isWin ? 'winner' : ''}" data-uid="${u.id}">
        ${isWin ? '<div class="crown">👑</div>' : ''}
        <div class="name">${esc(u.name)}${me === u.id ? '<span class="you-tag">我</span>' : ''}</div>
        <div class="num ${t.total > 0 ? 'down' : ''}">${t.score}</div>
        <div class="sub-line">
          <span>本周已扣 ${t.total} 分</span>
          <span class="absent-chip ${t.absentDays > 0 ? 'has' : ''}">本周缺勤 ${t.absentDays || 0} 天</span>
        </div>
      </div>`;
    }).join('');

    const banner = $('#winnerBanner');
    const [u1, u2] = S.users;
    const r1 = S.totals[u1.id], r2 = S.totals[u2.id];
    if (r1.score === r2.score) {
      banner.classList.add('hidden');
    } else {
      const leader = r1.score > r2.score ? u1 : u2;
      const diff = Math.abs(r1.score - r2.score);
      const tail = todayEnds ? '本周结束，败者惩罚生效！' : `（暂领先 ${diff} 分，${settleOf().label} 结算才算数）`;
      banner.innerHTML = `📣 目前 <b>${esc(leader.name)}</b> 领先 ${diff} 分 ${tail}<br><span style="font-size:12px;color:#a08040">败者惩罚：${esc(S.rules.penaltyText || '未设置')}</span>`;
      banner.classList.remove('hidden');
    }
  }

  function renderTabs() {
    const meU = meObj() || S.users[0];
    const otU = otherOf(meU.id);
    $('#segTabs').innerHTML = `
      <button data-act="tab" data-tab="me" class="${activeTab === 'me' ? 'active' : ''}">🙋 我的记录</button>
      <button data-act="tab" data-tab="other" class="${activeTab === 'other' ? 'active' : ''}">👀 TA的 · ${esc(otU.name)}</button>`;
  }

  function renderDayNav() {
    const nav = $('#dayNav');
    const today = S.today;
    nav.innerHTML = S.days.map((d) => {
      const future = d.date > today;
      const anyMiss = Object.keys(d.users).some((uid) => (d.users[uid].events || []).some((e) => e.points > 0));
      const isToday = d.date === today;
      return `
      <div class="day ${d.date === viewDate ? 'active' : ''} ${isToday ? 'today' : ''} ${anyMiss && !future ? 'has-miss' : ''}"
           style="${future ? 'opacity:.4' : ''}" data-act="day" data-date="${d.date}">
        <div class="w">周${d.weekday}</div>
        <div class="d">${fmtDate(d.date)}</div>
      </div>`;
    }).join('');
  }

  function renderPanel() {
    const meP = $('#panelA'), otherP = $('#panelB');
    if (activeTab === 'me') {
      meP.classList.remove('hidden'); otherP.classList.add('hidden');
      const uid = meObj() ? meObj().id : S.users[0].id;
      meP.innerHTML = userBlock(uid, 'me');
    } else {
      otherP.classList.remove('hidden'); meP.classList.add('hidden');
      const base = meObj() ? meObj().id : S.users[0].id;
      otherP.innerHTML = userBlock(otherOf(base).id, 'other');
    }
  }

  /* ============ 单人当日块 ============ */
  function userBlock(uid, mode) {
    const day = S.days.find((d) => d.date === viewDate);
    if (!day) return '<div class="block">无数据</div>';
    const ud = day.users[uid];
    const u = S.users.find((x) => x.id === uid);
    const isMeHere = me === uid;
    const future = viewDate > S.today;
    const inCurrent = S.isCurrent;
    // 只有“我自己、当前周、不是未来”才能编辑自己的记录
    const canEdit = inCurrent && isMeHere && !future;
    const isHistory = !S.isCurrent;

    // 起床
    const wakeBtns = [['ok', '✓ 正常'], ['late', '✗ 晚起']].map(([v, lb]) => {
      const on = ud.wake === v;
      return `<button class="pick ${on ? 'on-' + v : ''}" data-act="wake" data-v="${v}" ${canEdit ? '' : 'disabled'}>${lb}</button>`;
    }).join('') + `<button class="pick ${ud.wake === null ? 'on-none' : ''}" data-act="wake" data-v="" ${canEdit ? '' : 'disabled'}>未记录</button>`;

    // 屏幕（娱乐软件）：二选一 —— 超时 / 没超时（三态：超时 / 没超时 / 未记录）
    const scrState = ud.screenOver === true ? '超时' : ud.screenOver === false ? '没超时' : '未记录';
    const scr = `
      <div class="pickrow">
        <button class="pick ${ud.screenOver === false ? 'on-ok' : ''}" data-act="scrSet" data-v="0" ${canEdit ? '' : 'disabled'}>✓ 没超时</button>
        <button class="pick ${ud.screenOver === true ? 'on-late' : ''}" data-act="scrSet" data-v="1" ${canEdit ? '' : 'disabled'}>✗ 超时</button>
        <button class="pick ${(ud.screenOver === null || ud.screenOver === undefined) ? 'on-none' : ''}" data-act="scrSet" data-v="" ${canEdit ? '' : 'disabled'}>未记录</button>
      </div>
      <div class="hint">今日：<b>${scrState}</b> ｜ 超过 ${S.rules.screenLimitMinutes} 分钟算「超时」，超时固定扣 ${S.rules.screenRate} 分</div>`;

    // 三科打卡：政治 / 英语 / 专业课（固定，每科 完成/未完成；自己点自己，对方可查）
    const cats = Object.keys(S.rules.taskDeducts || {});
    const checkRow = (cat) => {
      const st = (ud.subjects && ud.subjects[cat]) ?? null;
      const deduct = S.rules.taskDeducts[cat] || 1;
      const doneBtn = `<button class="pick ${st === true ? 'on-ok' : ''}" data-act="subject" data-cat="${esc(cat)}" data-done="1" ${canEdit ? '' : 'disabled'}>✓ 完成</button>`;
      const missBtn = `<button class="pick ${st === false ? 'on-late' : ''}" data-act="subject" data-cat="${esc(cat)}" data-done="0" ${canEdit ? '' : 'disabled'}>✗ 未完成</button>`;
      const stat = st === true ? '<span class="task-state-tag ts-ok">已完成</span>'
        : st === false ? '<span class="task-state-tag ts-no">未完成</span>'
        : ud.absent ? '<span class="task-state-tag ts-no">缺勤 → 按未完成</span>'
        : (viewDate < S.today ? '<span class="task-state-tag ts-no">漏点 → 按未完成</span>' : '<span class="task-state-tag ts-pending">待打卡</span>');
      return `<div class="subj-line">
        <div class="subj-name">${esc(cat)}<em>未完成扣 ${deduct} 分</em></div>
        <div class="pickrow">${doneBtn}${missBtn}</div>
        <div class="subj-stat">${stat}</div>
      </div>`;
    };
    const subjArea = cats.map(checkRow).join('');
    const subjHint = isMeHere && canEdit ? `<div class="hint">✅ 打卡你当天实际完成的科目；${cutoffLabel()} 才切换新的一天，在此之前都能补录，之后漏打的科目按「未完成」扣分</div>` : '';

    // 请假
    let lvList = '';
    if ((ud.leaves || []).length) {
      lvList = '<ul class="leavelist">' + ud.leaves.map((lv) => {
        const isEvt = lv.type === 'event';
        const del = isMeHere && canEdit ? `<button class="lv-del" data-act="lvDel" data-lid="${lv.id}">✕</button>` : '';
        let desc;
        if (isEvt) desc = '突发事件 · ' + (lv.reason ? esc(lv.reason) : '豁免');
        else if (lv.overtime) desc = '超时 ' + (lv.overHours || 0) + ' 小时' + (lv.reason ? ' · ' + esc(lv.reason) : '');
        else desc = '没超时' + (lv.reason ? ' · ' + esc(lv.reason) : '');
        return `<li><span class="lv-badge ${isEvt ? 'lv-event' : 'lv-normal'}">${isEvt ? '突发事件' : '请假'}</span>
          <span>${desc}</span>${del}</li>`;
      }).join('') + '</ul>';
    } else {
      lvList = '<div class="hint">无请假记录</div>';
    }
    const lvForm = isMeHere && canEdit ? `
      <div class="lvform">
        <div class="pickrow" id="lvOverRow">
          <button class="pick on-ok" data-act="lvOver" data-v="0">✓ 没超时</button>
          <button class="pick" data-act="lvOver" data-v="1">✗ 超时</button>
        </div>
        <div class="mini-form hidden" id="lvOverHoursWrap" style="margin-top:8px">
          <span class="ov-label">超了</span>
          <input type="number" id="lvOverHours" min="1" step="1" value="1">
          <span class="ov-label">小时</span>
          <span class="ov-calc" id="lvOverCalc">≈ 扣 1 分</span>
        </div>
        <div class="mini-form" style="margin-top:8px">
          <input type="text" id="lvReason" placeholder="理由（可选）">
        </div>
        <div class="mini-form" style="margin-top:8px">
          <button class="btn btn-blue" data-act="lvNormal">🏖 提交请假</button>
          <button class="btn btn-green" data-act="lvEvent">⚠️ 突发事件(豁免)</button>
        </div>
        <div class="hint"><b>没超时</b> → 只消耗一次额度；<b>超时</b> → 每超 1 小时扣 ${S.rules.leaveHourRate || 1} 分。每周前 ${S.rules.leaveFreePerWeek} 次免费，之后每次即使没超时也固定扣 1 分。突发情况豁免。</div>
      </div>` : '';

    // 记账明细（服务端已算好）
    const evs = (ud.events || []).map((e) => `
      <li><span>${esc(e.label)}${e.note ? '<span class="enote">' + esc(e.note) + '</span>' : ''}</span>
      <span class="pts ${e.points > 0 ? 'neg' : 'free'}">${e.points > 0 ? '-' + e.points : '免扣'}</span></li>`).join('');
    const evBlock = evs ? '<ul class="events">' + evs + '</ul>' : '<div class="hint">今天还没有扣分项 ✓</div>';

    const who = isMeHere ? '我的' : u.name + ' 的';
    const title = isMeHere ? '🙋 我的记录' : `👀 ${esc(u.name)} 的记录`;
    const dateLabel = day.date === S.today ? `今天 · 周${day.weekday}` : `${fmtDate(day.date)} · 周${day.weekday}`;

    let lockNote = '';
    if (isHistory) lockNote = '<div class="locked-note">🔒 历史周已结算，仅供回看</div>';
    else if (future) lockNote = '<div class="locked-note">⏳ 还没到这一天，先安心过好今天吧</div>';
    else if (!isMeHere && !me) lockNote = '<div class="locked-note">👆 先在上方选择你的身份，才能记录和互相对账</div>';
    else if (!isMeHere && me) lockNote = '';

    // ===== 当日扣分摘要（置于面板最前）=====
    const hits = (ud.events || []).filter((e) => e.points > 0);
    const dayDeduct = hits.reduce((s, e) => s + e.points, 0);
    // 服务端视图 / localCalc 都会回填这两个标记
    const acted = !!ud.acted;      // 本人当天有没有动过 App
    const absent = !!ud.absent;    // 是否缺勤（整天未打开，且已过完）
    const dayWord = day.date === S.today ? '今天' : fmtDate(day.date);
    let dsCls, dsSub, dsTag;
    if (absent) {
      dsCls = 'ds-absent';
      dsSub = '⚠️ 缺勤（当天未打开）· 三科已按「未完成」计分';
      dsTag = '<span class="ds-tag">⚠️ 缺勤（当天未打开）</span>';
    } else if (!acted) {
      dsCls = dayDeduct > 0 ? 'ds-neg' : 'ds-warn';
      if (day.date === S.today) {
        dsSub = isMeHere
          ? `⚠️ 你今天还没有进行任何操作，快去记录打卡吧（${cutoffLabel()}前都算今天）`
          : `⚠️ ${esc(u.name)} 今天还没有进行任何操作，记得提醒 TA`;
      } else {
        dsSub = dayDeduct > 0
          ? '这一天没有任何记录，漏打的科目已按「未完成」计分'
          : '这一天没有任何记录';
      }
    } else if (dayDeduct > 0) {
      dsCls = 'ds-neg';
      dsSub = hits.slice(0, 4).map((e) => `${esc(e.label)} <b>-${e.points}</b>`).join('　')
        + (hits.length > 4 ? `　+${hits.length - 4}` : '');
    } else {
      dsCls = 'ds-zero';
      dsSub = '本日零扣分，保持住 💪';
    }
    if (!absent && dayDeduct > 0) dsTag = `<span class="ds-tag">${hits.length} 项扣分</span>`;
    const daySum = future ? '' : `
      <div class="daysum ${dsCls}">
        <div class="ds-top">
          <span class="ds-label">${esc(dayWord)}扣除</span>
          <span class="ds-num">${dayDeduct}</span>
          <span class="ds-unit">分</span>
          ${dsTag || ''}
        </div>
        <div class="ds-sub">${dsSub}</div>
      </div>`;

    return `
    <div class="block" data-uid="${uid}" data-key="${viewDate}|${uid}">
      <h4>${title}<span class="who">${esc(dateLabel)}</span></h4>
      ${daySum}
      ${lockNote}

      <div class="rowlabel">🌅 起床</div>
      <div class="pickrow">${wakeBtns}</div>
      ${future ? '' : `<div class="hint">${ud.wake === null ? '起床情况还没记录' : ud.wake === 'late' ? `已记录晚起，扣 ${S.rules.wakeDeduct} 分` : '已记录正常起床，不扣分'}</div>`}

      <div style="height:14px"></div>
      <div class="rowlabel">📱 娱乐软件（只算娱乐软件）· 今天有没有超时</div>
      ${scr}

      <div style="height:14px"></div>
      <div class="rowlabel">✅ 每日打卡 · 政治 / 英语 / 专业课${isMeHere ? '' : '<span class="who" style="margin-left:6px">TA 的记录，供你监督</span>'}</div>
      <div class="subj-list">
        ${subjArea}
      </div>
      ${subjHint}

      <div style="height:14px"></div>
      <div class="rowlabel">🏖 请假</div>
      ${lvList}
      ${lvForm}

      <div style="height:14px"></div>
      <div class="rowlabel">🧾 当日记账明细</div>
      ${evBlock}
    </div>`;
  }

  /* ============ 历史 ============ */
  function renderHistory() {
    const wrap = $('#historyList');
    const hist = S.history || [];
    if (!hist.length) {
      wrap.innerHTML = '<div class="hist-empty">还没有完成过比赛周，本周就是第一战 🥊</div>';
      return;
    }
    const latest = hist.slice().reverse().slice(0, 30);
    wrap.innerHTML = latest.map((h) => {
      const s = h.start.split('-'), e = h.end.split('-');
      const nameA = S.users.find((u) => u.id === 'a').name;
      const nameB = S.users.find((u) => u.id === 'b').name;
      const winTxt = h.isTie ? '平局' : (h.winner === 'a' ? nameA : nameB) + ' 胜';
      const active = activeCycle === h.start ? ' style="outline:2px solid #d9a441"' : '';
      return `
      <div class="hist-item" data-act="hist" data-start="${h.start}" ${active}>
        <div class="range">${+s[1]}月${+s[2]}日 ~ ${+e[1]}月${+e[2]}日</div>
        <div class="winner-name">${esc(winTxt)}</div>
        <div class="scores">${h.scores.a} : ${h.scores.b}</div>
      </div>`;
    }).join('');
  }

  /* ============ 全局事件委托 ============ */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const block = e.target.closest('.block');

    switch (act) {
      case 'pickid': {
        me = el.dataset.uid;
        localStorage.setItem('couple_me', me);
        activeTab = 'me';
        renderAll();
        toast('身份已切换为 ' + (meObj() ? meObj().name : ''));
        break;
      }
      case 'tab': {
        activeTab = el.dataset.tab;
        renderPanel();
        $$('#segTabs button').forEach((b) => b.classList.toggle('active', b === el));
        break;
      }
      case 'day': {
        const d = el.dataset.date;
        if (d <= S.today) { viewDate = d; renderDayNav(); renderPanel(); }
        break;
      }
      case 'wake': {
        const v = el.dataset.v === '' ? null : el.dataset.v;
        if (!block) return;
        mut('/api/day', { date: viewDate, user: block.dataset.uid, wake: v });
        break;
      }
      case 'scrSet': {
        if (!block) return;
        const v = el.dataset.v === '' ? null : el.dataset.v === '1'; // true 超时 / false 没超时 / null 未记录
        mut('/api/day', { date: viewDate, user: block.dataset.uid, screenOver: v });
        break;
      }
      case 'subject': {
        if (!block) return;
        const cat = el.dataset.cat;
        const doneVal = el.dataset.done === '1';
        // 再点当前状态 = 撤销回「没点」
        const cur = (S.days.find((dd) => dd.date === viewDate).users[block.dataset.uid].subjects || {})[cat];
        const next = cur === doneVal ? null : doneVal;
        mut('/api/day', { date: viewDate, user: block.dataset.uid, subject: cat, done: next });
        break;
      }
      case 'lvOver': {
        if (!block) return;
        const isOver = el.dataset.v === '1';
        block.querySelectorAll('#lvOverRow .pick').forEach((b) => {
          const bOver = b.dataset.v === '1';
          b.classList.toggle('on-late', bOver && isOver);
          b.classList.toggle('on-ok', !bOver && !isOver);
        });
        const wrap = block.querySelector('#lvOverHoursWrap');
        if (wrap) wrap.classList.toggle('hidden', !isOver);
        if (isOver) updateOvCalc(block);
        break;
      }
      case 'lvNormal':
      case 'lvEvent': {
        if (!block) return;
        const isEvent = act === 'lvEvent';
        const rEl = block.querySelector('#lvReason');
        const r = rEl ? rEl.value : '';
        if (isEvent) {
          mut('/api/leave', { date: viewDate, user: block.dataset.uid, type: 'event', reason: r });
        } else {
          const row = block.querySelector('#lvOverRow');
          const isOver = !!(row && row.querySelector('.pick.on-late'));
          const hEl = block.querySelector('#lvOverHours');
          const hours = isOver ? Math.max(1, Math.round(Number(hEl && hEl.value) || 1)) : 0;
          mut('/api/leave', { date: viewDate, user: block.dataset.uid, type: 'normal', overtime: isOver, overHours: hours, reason: r });
        }
        break;
      }
      case 'lvDel': {
        if (!block) return;
        mut('/api/leave-remove', { date: viewDate, user: block.dataset.uid, leaveId: el.dataset.lid });
        break;
      }
      case 'hist': {
        activeCycle = el.dataset.start;
        viewDate = null;
        loadState().then(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
        break;
      }
    }
  });

  /* ============ 顶部“回本周” ============ */
  document.addEventListener('click', (e) => {
    if (e.target.closest('#weekRange') && activeCycle) {
      activeCycle = null; viewDate = null;
      loadState();
    }
  });

  /* ============ 请假“超几小时”实时换算 ============ */
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'lvOverHours') {
      const block = e.target.closest('.block');
      if (block) updateOvCalc(block);
    }
  });

  /* ============ 设置弹层 ============ */
  function fillSettings() {
    $('#nameA').value = S.users.find((u) => u.id === 'a').name;
    $('#nameB').value = S.users.find((u) => u.id === 'b').name;
    const r = S.rules;
    const td = r.taskDeducts || {};
    $('#rStartScore').value = r.startScore;
    $('#rWake').value = r.wakeDeduct;
    // 每日结算点：只有 0（当晚 24:00）与 4（次日凌晨 4:00）两个选项，非 0 一律落到 4
    $('#rCutoff').value = Number(r.dayCutoffHour) === 0 ? '0' : '4';
    $('#rTaskPol').value = td['政治'] != null ? td['政治'] : 1;
    $('#rTaskEng').value = td['英语'] != null ? td['英语'] : 1;
    $('#rTaskMaj').value = td['专业课'] != null ? td['专业课'] : 2;
    $('#rScreenLimit').value = r.screenLimitMinutes;
    $('#rScreenRate').value = r.screenRate;
    $('#rLeaveFree').value = r.leaveFreePerWeek;
    $('#rLeaveHourRate').value = r.leaveHourRate != null ? r.leaveHourRate : 1;
    $('#rEnabledFrom').value = r.enabledFrom || '';
    $('#rPenalty').value = r.penaltyText;
  }
  function openSettings() { if (!S) return; fillSettings(); $('#settingsModal').classList.remove('hidden'); }

  async function saveSettings() {
    const names = [$('#nameA').value.trim(), $('#nameB').value.trim()];
    if (!names[0] || !names[1]) return toast('两个昵称都要填');
    await api('/api/names', 'POST', { names });
    const rules = {
      startScore: $('#rStartScore').value,
      wakeDeduct: $('#rWake').value,
      dayCutoffHour: $('#rCutoff').value,
      taskDeducts: {
        '政治': $('#rTaskPol').value,
        '英语': $('#rTaskEng').value,
        '专业课': $('#rTaskMaj').value,
      },
      screenLimitMinutes: $('#rScreenLimit').value,
      screenRate: $('#rScreenRate').value,
      leaveFreePerWeek: $('#rLeaveFree').value,
      leaveHourRate: $('#rLeaveHourRate').value,
      penaltyText: $('#rPenalty').value,
    };
    const ef = $('#rEnabledFrom').value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(ef)) rules.enabledFrom = ef;
    await api('/api/rules', 'POST', { rules });
    $('#settingsModal').classList.add('hidden');
    toast('已保存');
    await loadState();
  }

    // 启动
  function init() {
    // 支持 URL 参数覆盖身份与初始 tab（截图/调试用）
    const params = new URLSearchParams(location.search);
    if (params.get('me') === 'a' || params.get('me') === 'b') {
      me = params.get('me'); localStorage.setItem('couple_me', me);
    }
    if (params.get('tab') === 'other' || params.get('tab') === 'me') activeTab = params.get('tab');
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnCloseModal').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
    $('#btnSaveRules').addEventListener('click', saveSettings);
    $('#settingsModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#settingsModal').classList.add('hidden'); });

    $('#btnExport').addEventListener('click', () => {
      fetch('/api/export').then((r) => r.blob()).then((b) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = 'couple-score-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
        toast('备份已下载');
      });
    });
    $('#btnImport').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data.users || !data.rules || !data.days) return toast('不是有效的备份文件');
        if (!confirm('恢复备份会覆盖当前所有记录，确定？')) return;
        await api('/api/import', 'POST', data);
        activeCycle = null; viewDate = null;
        await loadState();
        toast('恢复成功');
      } catch (err) { toast('备份文件解析失败'); }
      e.target.value = '';
    });

    const skipWelcome = new URLSearchParams(location.search).get('skipwelcome') === '1';
    if (!localStorage.getItem('couple_welcome') && !skipWelcome) {
      setTimeout(() => {
        openSettings();
        toast('欢迎！先设置双方昵称和规则 🥳');
        localStorage.setItem('couple_welcome', '1');
      }, 400);
    }
    loadState();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
