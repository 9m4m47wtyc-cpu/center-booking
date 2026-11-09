/* 화면 흐름: 로그인 → 달력(방·차량·검사도구 탭) → 날짜를 누르면 그날 시간표 → (예약 / 내 예약 바꾸기·취소 / 관리자 기능) */
'use strict';

const $ = s => document.querySelector(s);
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SESSION_KEY = 'pub.session';
const LAST_NAME_KEY = 'pub.lastName';
const CAT_KEY = 'pub.cat';

const S = {
  session: null,     // { token, name, isAdmin }
  staff: [],
  items: [],         // 예약할 항목 [{ id, cat, name }] — 시트 '항목' 탭
  cat: 'room',       // 지금 보는 분류
  month: Core.nowKST().date.slice(0, 7),   // 보고 있는 달 'YYYY-MM'
  day: '',           // 시간표 창에 연 날짜
  dayScroll: 0,      // 시간표 창에서 내려 본 위치 (예약 창에서 돌아올 때 그대로)
  cache: null,       // { from, to, bookings: [] } — 달력에 보이는 6주
  loading: false
};

/* ---------- 작은 도구 ---------- */
function store(key, val) {
  try { if (val === undefined) return JSON.parse(localStorage.getItem(key)); if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); }
  catch (e) { return null; }
}
function dateLabel(d) { const t = Core.parseDate(d); return `${t.getUTCMonth() + 1}월 ${t.getUTCDate()}일 (${WD[t.getUTCDay()]})`; }
function hourLabel(h) { return `${pad(h)}:00–${pad(h + 1)}:00`; }
function itemById(id) { return S.items.find(i => i.id === id) || null; }
function itemsOf(cat) { return S.items.filter(i => i.cat === cat); }
function catName(cat) { const c = Core.catById(cat); return c ? c.name : ''; }
/* 달력에 보이는 6주: 그달 1일이 들어 있는 주의 일요일부터 42일 */
function monthRange(m) { const first = m + '-01', from = Core.addDays(first, -Core.weekday(first)); return { from, to: Core.addDays(from, 41) }; }
function shiftMonth(m, n) { const t = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1); }
let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg; el.className = 'toast' + (isErr ? ' err' : ''); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 4500 : 2500);
}
function show(id) { ['#login', '#main'].forEach(s => { $(s).hidden = s !== id; }); }
function openSheet(html) { $('#sheetBody').innerHTML = html; $('#sheet').hidden = false; $('#sheetBody').scrollTop = 0; }
function closeSheet() { $('#sheet').hidden = true; $('#sheetBody').innerHTML = ''; }
function sheetMsg(msg) { const el = $('#sheetBody .msg'); if (el) el.textContent = msg; }

/* 서버 오류 공통 처리: 로그인 만료면 로그인 화면으로 */
function handleErr(e, where) {
  if (e.code === 'auth') { logout(); $('#loginMsg').textContent = e.message; return; }
  if (where === 'sheet' && !$('#sheet').hidden) sheetMsg(e.message); else toast(e.message, true);
}

/* ---------- 로그인 ---------- */
async function loadStaff() {
  const sel = $('#loginName');
  try {
    const res = await Api.call('staff');
    S.staff = res.staff;
    if (!S.staff.length) { sel.innerHTML = '<option value="">명단이 비어 있어요</option>'; $('#loginMsg').textContent = '관리자가 구글 시트의 직원 탭에 이름을 적어야 해요.'; return; }
    const last = store(LAST_NAME_KEY);
    sel.innerHTML = '<option value="">이름을 고르세요</option>' +
      S.staff.map(s => `<option value="${esc(s.name)}"${s.name === last ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    onNamePick();
  } catch (e) {
    sel.innerHTML = '<option value="">불러오지 못했어요</option>';
    $('#loginMsg').textContent = e.message;
  }
}
function pickedStaff() { return S.staff.find(s => s.name === $('#loginName').value) || null; }
function onNamePick() {
  const s = pickedStaff();
  const isNew = !!s && !s.hasPin;
  $('#pin2Row').hidden = !isNew;
  $('#loginHint').textContent = !s ? '' : s.locked ? '🔒 잠긴 상태예요. 관리자에게 비밀번호 초기화를 요청해 주세요.'
    : isNew ? '처음 사용(또는 초기화됨): 앞으로 쓸 비밀번호 4자리를 정해 주세요.' : '';
  $('#loginBtn').textContent = isNew ? '비밀번호 정하고 시작하기' : '시작하기';
  $('#loginMsg').textContent = '';
}
async function login() {
  const s = pickedStaff(), pin = $('#pin1').value.trim(), msg = $('#loginMsg');
  if (!s) { msg.textContent = '이름을 골라 주세요.'; return; }
  if (!/^\d{4}$/.test(pin)) { msg.textContent = '비밀번호는 숫자 4자리예요.'; return; }
  if (!s.hasPin && pin !== $('#pin2').value.trim()) { msg.textContent = '두 번 입력한 비밀번호가 달라요.'; return; }
  const btn = $('#loginBtn'); btn.disabled = true; msg.textContent = '';
  try {
    const res = await Api.call('login', { name: s.name, pin });
    S.session = { token: res.token, name: res.name, isAdmin: res.isAdmin };
    store(SESSION_KEY, S.session); store(LAST_NAME_KEY, s.name);
    $('#pin1').value = ''; $('#pin2').value = '';
    enterMain();
  } catch (e) {
    if (e.code === 'locked' || e.code === 'badpin') { $('#pin1').value = ''; await loadStaff(); }   // 잠김 표시 갱신
    msg.textContent = e.message;
  } finally { btn.disabled = false; }
}
function logout() {
  S.session = null; S.cache = null; store(SESSION_KEY, null);
  closeSheet(); show('#login'); $('#loginDemo').hidden = !Api.demo; loadStaff();
}

/* ---------- 달력 ---------- */
function enterMain() {
  $('#who').textContent = S.session.name + (S.session.isAdmin ? ' · 관리자' : '') + ' ▾';
  $('#demoBanner').hidden = !Api.demo;
  S.month = Core.nowKST().date.slice(0, 7);
  S.cat = store(CAT_KEY) || S.cat;
  show('#main');
  load(true);
}
async function load(force) {
  if (!S.session) return;
  const { from, to } = monthRange(S.month);
  const fresh = S.cache && S.cache.from === from;
  if (!force && fresh) { render(); return; }
  if (!fresh) { S.cache = null; render(); }
  try {
    S.loading = true;
    const res = await Api.call('list', { token: S.session.token, from, to });
    if (monthRange(S.month).from !== from) return;    // 그 사이에 다른 달로 옮겨 간 경우
    S.items = res.items;
    if (!itemsOf(S.cat).length) { const c = Core.CATS.find(c => itemsOf(c.id).length); if (c) S.cat = c.id; }
    S.cache = { from, to, bookings: res.bookings };
  } catch (e) { handleErr(e); }
  finally { S.loading = false; if (S.session) render(); }
}
function bookingAt(date, hour, item) {
  return S.cache ? S.cache.bookings.find(b => b.date === date && b.hour === hour && b.item === item) : null;
}
/* 그날 지금 분류의 예약: 시간 순, 같은 시간이면 항목 탭 순서 */
function bookingsOn(date, cat) {
  const order = itemsOf(cat).map(i => i.id);
  return (S.cache ? S.cache.bookings : []).filter(b => b.date === date && order.includes(b.item))
    .sort((a, b) => a.hour - b.hour || order.indexOf(a.item) - order.indexOf(b.item));
}
function renderCats() {
  $('#cats').innerHTML = Core.CATS.filter(c => itemsOf(c.id).length).map(c =>
    `<button class="cat${c.id === S.cat ? ' on' : ''}" data-act="cat" data-cat="${c.id}" aria-pressed="${c.id === S.cat}">${esc(c.name)}</button>`).join('');
}
function render() {
  const today = Core.nowKST().date;
  $('#monthText').innerHTML = `${+S.month.slice(0, 4)}년 ${+S.month.slice(5)}월` + (S.month === today.slice(0, 7) ? '<span class="badge">이번 달</span>' : '');
  renderCats();
  const cal = $('#cal');
  if (!S.cache) { cal.innerHTML = '<div class="loading">달력을 불러오는 중…</div>'; return; }
  if (!itemsOf(S.cat).length) { cal.innerHTML = '<div class="closed-day">예약할 항목이 아직 없어요.<br>관리자가 구글 시트의 \'항목\' 탭에 적어 주세요.</div>'; return; }
  let days = '';
  for (let i = 0; i < 42; i++) {
    const d = Core.addDays(S.cache.from, i), list = bookingsOn(d, S.cat);
    const shown = list.length > 3 ? list.slice(0, 2) : list;
    const cls = ['day', d.slice(0, 7) !== S.month && 'out', d < today && 'past', i % 7 === 0 && 'sun', i % 7 === 6 && 'sat', d === today && 'today']
      .filter(Boolean).join(' ');
    days += `<button class="${cls}" data-act="day" data-date="${d}" aria-label="${esc(dateLabel(d))}, 예약 ${list.length}건">`
      + `<span class="num">${+d.slice(8)}</span>`
      + shown.map(b => `<span class="bk${b.owner === S.session.name ? ' mine' : ''}">${b.hour}시<span class="nm"> ${esc(itemById(b.item).name)}</span></span>`).join('')
      + (list.length > shown.length ? `<span class="more">+${list.length - shown.length}건</span>` : '')
      + '</button>';
  }
  cal.innerHTML = '<div class="cal-head">' + WD.map(w => `<span>${w}</span>`).join('') + '</div><div class="cal">' + days + '</div>';
}
function moveMonth(n) { S.month = shiftMonth(S.month, n); load(false); }
function pickCat(btn) { S.cat = btn.dataset.cat; store(CAT_KEY, S.cat); render(); }

/* ---------- 그날 시간표 (아래에서 올라오는 창) ---------- */
function openDay(date, keepScroll) {
  if (!Core.hoursFor(date).length) { toast('일요일은 예약할 수 없어요.', true); return; }
  S.day = date;
  const cols = itemsOf(S.cat);
  const head = '<tr><th class="time"></th>' + cols.map(it => `<th>${esc(it.name)}</th>`).join('') + '</tr>';
  const rows = Core.hoursFor(date).map(h => '<tr><th class="time">' + pad(h) + '시</th>' + cols.map(it => {
    const b = bookingAt(date, h, it.id);
    const st = Core.slotStatus(date, h, it.cat);
    const label = `${it.name} ${hourLabel(h)}`;
    const data = `data-act="cell" data-date="${date}" data-hour="${h}" data-item="${esc(it.id)}"`;
    if (b) {
      const mine = b.owner === S.session.name;
      return `<td><button class="cell booked${mine ? ' mine' : ''}${st === 'past' ? ' past' : ''}" ${data}
        aria-label="${esc(label)} ${esc(b.owner)} ${esc(b.purpose)}"><span class="owner">${esc(b.owner)}</span><span class="purpose">${esc(b.purpose)}</span></button></td>`;
    }
    if (st === 'ok') return `<td><button class="cell free" ${data} aria-label="${esc(label)} 비어 있음, 예약하기"><span class="plus">+</span></button></td>`;
    return `<td><button class="cell off" ${data} aria-label="${esc(label)} 예약 불가"></button></td>`;
  }).join('') + '</tr>').join('');
  openSheet(`
    <h2>${esc(dateLabel(date))}</h2>
    <p class="info">${esc(catName(S.cat))} · 빈칸(+)을 누르면 예약해요</p>
    <div class="day-grid${cols.length > 4 ? ' wide' : ''}"><table class="grid" style="--cols:${cols.length}"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
    <div class="row"><button class="btn" data-act="close">닫기</button></div>`);
  if (keepScroll) $('#sheetBody').scrollTop = S.dayScroll;
}
function backToDay() { openDay(S.day, true); }

function onCell(btn) {
  const date = btn.dataset.date, hour = Number(btn.dataset.hour), it = itemById(btn.dataset.item);
  S.dayScroll = $('#sheetBody').scrollTop;
  const b = bookingAt(date, hour, it.id);
  if (b) return openDetail(b);
  const st = Core.slotStatus(date, hour, it.cat);
  if (st === 'ok') return openBook(date, hour, it);
  toast(Core.statusMsg(st, it.cat), true);
}
function purposeChips(cat, selected) {
  return '<div class="chips" role="radiogroup" aria-label="용도">' + Core.catById(cat).purposes.map(p =>
    `<label class="chip"><input type="radio" name="purpose" value="${esc(p)}"${p === selected ? ' checked' : ''}><span>${esc(p)}</span></label>`).join('') + '</div>';
}
function pickedPurpose() { const el = document.querySelector('input[name="purpose"]:checked'); return el ? el.value : ''; }

function openBook(date, hour, it) {
  openSheet(`
    <h2>${esc(it.name)}</h2>
    <p class="info">${esc(catName(it.cat))} · ${esc(dateLabel(date))} · ${hourLabel(hour)}</p>
    <div class="field">용도</div>
    ${purposeChips(it.cat, '')}
    <p class="msg" role="alert"></p>
    <div class="row">
      <button class="btn" data-act="back">← 뒤로</button>
      <button class="btn primary" data-act="doBook" data-date="${date}" data-hour="${hour}" data-item="${esc(it.id)}">예약하기</button>
    </div>`);
}
async function doBook(btn) {
  const purpose = pickedPurpose();
  if (!purpose) { sheetMsg('용도를 골라 주세요.'); return; }
  btn.disabled = true;
  try {
    await Api.call('book', { token: S.session.token, date: btn.dataset.date, hour: Number(btn.dataset.hour), item: btn.dataset.item, purpose });
    toast('예약했어요.');
    await load(true); backToDay();
  } catch (e) { handleErr(e, 'sheet'); btn.disabled = false; load(true); }
}

function canEdit(b) { return (b.owner === S.session.name || S.session.isAdmin) && !Core.isPast(b.date, b.hour); }
function openDetail(b) {
  const it = itemById(b.item), mine = b.owner === S.session.name;
  const edit = canEdit(b);
  openSheet(`
    <h2>${esc(it.name)}</h2>
    <p class="info">${esc(catName(it.cat))} · ${esc(dateLabel(b.date))} · ${hourLabel(b.hour)}</p>
    <dl><dt>예약자</dt><dd>${esc(b.owner)}${mine ? ' (나)' : ''}</dd><dt>용도</dt><dd>${esc(b.purpose)}</dd></dl>
    ${edit && !mine ? '<p class="note">관리자 권한으로 다른 사람의 예약을 바꾸거나 취소하면 시트의 \'기록\' 탭에 남아요.</p>' : ''}
    ${!edit && Core.isPast(b.date, b.hour) ? '<p class="note">이미 지났거나 시작한 예약은 바꾸거나 취소할 수 없어요.</p>' : ''}
    <p class="msg" role="alert"></p>
    ${edit ? `<div class="row">
                <button class="btn danger" data-act="askCancel" data-id="${esc(b.id)}">예약 취소</button>
                <button class="btn primary" data-act="edit" data-id="${esc(b.id)}">바꾸기</button>
              </div>` : ''}
    <div class="row"><button class="btn" data-act="back">← 뒤로</button></div>`);
}
function findCached(id) { return S.cache && S.cache.bookings.find(b => b.id === id); }
function askCancel(btn) {
  const b = findCached(btn.dataset.id); if (!b) return;
  openSheet(`
    <h2>예약을 취소할까요?</h2>
    <p class="info">${esc(itemById(b.item).name)} · ${esc(dateLabel(b.date))} · ${hourLabel(b.hour)}<br>${esc(b.owner)} · ${esc(b.purpose)}</p>
    <p class="msg" role="alert"></p>
    <div class="row">
      <button class="btn" data-act="back">그대로 두기</button>
      <button class="btn primary" data-act="doCancel" data-id="${esc(b.id)}" style="background:var(--danger);border-color:var(--danger)">취소하기</button>
    </div>`);
}
async function doCancel(btn) {
  btn.disabled = true;
  try {
    await Api.call('cancel', { token: S.session.token, id: btn.dataset.id });
    toast('예약을 취소했어요.');
    await load(true); backToDay();
  } catch (e) { handleErr(e, 'sheet'); btn.disabled = false; load(true); }
}

/* 바꾸기: 날짜·시간·같은 분류 안의 항목·용도 */
function openEdit(btn) {
  const b = findCached(btn.dataset.id); if (!b) return;
  const it = itemById(b.item);
  openSheet(`
    <h2>예약 바꾸기</h2>
    <p class="info">지금: ${esc(it.name)} · ${esc(dateLabel(b.date))} · ${hourLabel(b.hour)}</p>
    <label class="field">날짜 <input type="date" id="eDate" value="${b.date}" min="${Core.nowKST().date}"></label>
    <label class="field">시간 <select id="eHour"></select></label>
    <label class="field">${esc(catName(it.cat))} <select id="eItem">${itemsOf(it.cat).map(i => `<option value="${esc(i.id)}"${i.id === b.item ? ' selected' : ''}>${esc(i.name)}</option>`).join('')}</select></label>
    <div class="field">용도</div>
    ${purposeChips(it.cat, b.purpose)}
    <p class="msg" role="alert"></p>
    <div class="row">
      <button class="btn" data-act="back">← 뒤로</button>
      <button class="btn primary" data-act="doEdit" data-id="${esc(b.id)}">저장</button>
    </div>`);
  fillEditHours(b.hour);
}
function fillEditHours(keep) {
  const date = $('#eDate').value, it = itemById($('#eItem').value);
  $('#eDate').max = Core.lastBookable(it.cat, Core.nowKST().date);
  const hours = Core.parseDate(date) ? Core.hoursFor(date) : [];
  const want = keep != null ? keep : Number($('#eHour').value);
  $('#eHour').innerHTML = hours.length
    ? hours.map(h => {
        const past = Core.isPast(date, h);
        return `<option value="${h}"${h === want && !past ? ' selected' : ''}${past ? ' disabled' : ''}>${hourLabel(h)}${past ? ' (지남)' : ''}</option>`;
      }).join('')
    : '<option value="">이 날은 예약할 수 없어요</option>';
}
async function doEdit(btn) {
  const date = $('#eDate').value, hour = Number($('#eHour').value), item = $('#eItem').value, purpose = pickedPurpose();
  if (!Core.parseDate(date) || !$('#eHour').value) { sheetMsg('날짜와 시간을 확인해 주세요.'); return; }
  if (!purpose) { sheetMsg('용도를 골라 주세요.'); return; }
  const b = findCached(btn.dataset.id), cat = itemById(item).cat;
  const moved = !b || b.date !== date || b.hour !== hour || b.item !== item;
  if (moved) {
    const st = Core.slotStatus(date, hour, cat);
    if (st !== 'ok') { sheetMsg(Core.statusMsg(st, cat)); return; }
  }
  btn.disabled = true;
  try {
    await Api.call('update', { token: S.session.token, id: btn.dataset.id, date, hour, item, purpose });
    toast('예약을 바꿨어요.');
    const sameDay = date === S.day;
    S.day = date;
    if (date < S.cache.from || date > S.cache.to) S.month = date.slice(0, 7);   // 달력에 안 보이는 날로 옮긴 경우
    await load(true); openDay(S.day, sameDay);
  } catch (e) { handleErr(e, 'sheet'); btn.disabled = false; load(true); }
}

/* ---------- 내 메뉴 ---------- */
function openMenu() {
  const a = S.session.isAdmin;
  openSheet(`
    <h2>${esc(S.session.name)}</h2>
    <p class="info">${a ? '관리자' : '직원'}${Api.demo ? ' · 체험 모드' : ''}</p>
    <div class="menu-list">
      <button class="btn" data-act="refresh">🔄 달력 새로 불러오기</button>
      ${a ? '<button class="btn" data-act="resetMenu">🔑 직원 비밀번호 초기화 (관리자)</button>' : ''}
      ${Api.demo ? '<button class="btn" data-act="demoReset">↺ 체험 자료 처음으로 되돌리기</button>' : ''}
      <button class="btn" data-act="logout">↩ 로그아웃</button>
      <button class="btn" data-act="close">닫기</button>
    </div>`);
}
async function openReset() {
  openSheet('<h2>비밀번호 초기화</h2><p class="info">명단을 불러오는 중…</p>');
  try {
    const res = await Api.call('staff');
    openSheet(`
      <h2>비밀번호 초기화</h2>
      <p class="info">초기화하면 그 직원은 다음 로그인 때 새 비밀번호를 직접 정합니다. 잠긴 상태도 풀립니다.</p>
      <label class="field">직원 <select id="rTarget"><option value="">고르세요</option>${res.staff.map(s =>
        `<option value="${esc(s.name)}">${esc(s.name)}${s.locked ? ' 🔒잠김' : ''}${!s.hasPin ? ' (비밀번호 없음)' : ''}</option>`).join('')}</select></label>
      <p class="note">초기화한 뒤에는 그 직원이 바로 로그인해 새 비밀번호를 정하도록 알려 주세요. 그 전에는 다른 사람이 먼저 정할 수 있어요.</p>
      <p class="msg" role="alert"></p>
      <div class="row"><button class="btn" data-act="close">닫기</button><button class="btn primary" data-act="doReset">초기화</button></div>`);
  } catch (e) { handleErr(e, 'sheet'); }
}
async function doReset(btn) {
  const target = $('#rTarget').value;
  if (!target) { sheetMsg('직원을 골라 주세요.'); return; }
  btn.disabled = true;
  try {
    await Api.call('resetPin', { token: S.session.token, target });
    closeSheet(); toast(`${target}님의 비밀번호를 초기화했어요.`);
    if (target === S.session.name) logout();
  } catch (e) { handleErr(e, 'sheet'); btn.disabled = false; }
}

/* ---------- 버튼 연결 ---------- */
const ACTIONS = {
  login, menu: openMenu, close: closeSheet, back: backToDay,
  prev: () => moveMonth(-1), next: () => moveMonth(1),
  today: () => { S.month = Core.nowKST().date.slice(0, 7); load(false); },
  cat: pickCat, day: btn => openDay(btn.dataset.date), cell: onCell,
  doBook, edit: openEdit, doEdit, askCancel, doCancel,
  refresh: () => { closeSheet(); load(true); toast('새로 불러왔어요.'); },
  resetMenu: openReset, doReset,
  demoReset: () => { DemoStore.load(); DemoStore.reset(); logout(); },
  logout: () => logout()
};
document.addEventListener('click', e => {
  if (e.target.id === 'sheet') { closeSheet(); return; }       // 바깥 어두운 부분을 누르면 닫기
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const fn = ACTIONS[btn.dataset.act];
  if (fn) fn(btn);
});
document.addEventListener('change', e => {
  if (e.target.id === 'loginName') onNamePick();
  if (e.target.id === 'eDate' || e.target.id === 'eItem') fillEditHours();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
  if (e.key === 'Enter' && !$('#login').hidden && (e.target.id === 'pin1' || e.target.id === 'pin2')) login();
});

/* 1분마다: 지난 날을 흐리게, 창이 열려 있지 않으면 다른 직원의 예약도 새로 불러오기 */
setInterval(() => {
  if (!S.session || $('#main').hidden) return;
  if ($('#sheet').hidden && document.visibilityState === 'visible') load(true); else render();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.session && !$('#main').hidden && $('#sheet').hidden) load(true);
});

/* ---------- 시작 ---------- */
(async function start() {
  S.session = store(SESSION_KEY);
  if (!S.session || !S.session.token) { logout(); return; }
  enterMain();
  try {   // 관리자 지정이 바뀌었을 수 있으니 확인
    const me = await Api.call('me', { token: S.session.token });
    if (S.session && (me.isAdmin !== S.session.isAdmin)) { S.session.isAdmin = me.isAdmin; store(SESSION_KEY, S.session); enterMain(); }
  } catch (e) { if (e.code === 'auth') handleErr(e); }
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
