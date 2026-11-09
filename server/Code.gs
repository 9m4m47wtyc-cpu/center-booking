/* 공용 예약 — 구글 앱스 스크립트 서버.
   같은 앱스 스크립트 프로젝트에 'core' 파일(= js/core.js 내용)이 함께 있어야 한다.
   처음 한 번: 위쪽 함수 목록에서 setup을 골라 실행한다. (탭과 예시 항목이 생긴다)
   그다음 '배포 → 새 배포 → 웹 앱'(실행: 나, 액세스: 모든 사용자)으로 배포하고 받은 주소를 config.js에 넣는다. */

var TABS = {
  '직원': { head: ['이름', '관리자', '잠김', '틀린 횟수', '비밀번호(자동)', '소금(자동)'], checks: [2, 3] },
  '항목': { head: ['분류', '이름', '코드(자동)'] },
  '예약': { head: ['코드', '날짜', '시', '항목코드', '용도', '예약자', '만든 때', '바꾼 때'] },
  '일정': { head: ['코드', '날짜', '시간', '제목', '넣은 사람', '만든 때', '바꾼 때'] },
  '기록': { head: ['때', '한 사람', '한 일', '예약자', '전', '후'] }
};

function setup() {
  Object.keys(TABS).forEach(tab_);
  var items = tab_('항목');
  if (items.getLastRow() < 2) items.getRange(2, 1, Core.SAMPLE_ITEMS.length, 2).setValues(Core.SAMPLE_ITEMS);
  new SheetStore().secret();
}

function doPost(e) {
  var lock = LockService.getScriptLock(), res;
  if (!lock.tryLock(20000)) {
    res = { ok: false, error: '지금 쓰는 사람이 많아요. 잠시 후 다시 해 주세요.' };
  } else {
    try { res = Core.handle(JSON.parse(e.postData.contents), new SheetStore(), Date.now(), rand_); }
    catch (err) { res = { ok: false, error: '서버에서 오류가 생겼어요. (' + err.message + ')' }; }
    finally { lock.releaseLock(); }
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}
/* 웹 앱 주소를 브라우저로 열었을 때: 배포가 됐는지 확인용 */
function doGet() { return ContentService.createTextOutput('공용 예약 서버가 동작하고 있어요.'); }

function rand_() { return Utilities.getUuid().replace(/-/g, ''); }

/* 탭이 없으면 만든다: 제목 줄 + 글자 형식(날짜·숫자로 멋대로 바뀌지 않게) + 체크박스 */
function tab_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(name);
  if (sh) return sh;
  var t = TABS[name], checks = t.checks || [];
  sh = ss.insertSheet(name);
  for (var c = 1; c <= t.head.length; c++) {
    if (checks.indexOf(c) >= 0) sh.getRange(2, c, 100, 1).insertCheckboxes();
    else sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@');
  }
  sh.getRange(1, 1, 1, t.head.length).setValues([t.head]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (name === '항목') sh.getRange(2, 1, 100, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(Core.CATS.map(function (x) { return x.name; }), true).build());
  return sh;
}
/* 누가 시트에서 직접 고쳐 날짜·시간 값이 됐어도 '2026-01-31'·'14:00' 같은 글자로 읽는다 */
function txt_(v, pattern) {
  return v instanceof Date ? Utilities.formatDate(v, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), pattern) : String(v);
}
function row_(b) { return [b.id, b.date, b.hour, b.item, b.purpose, b.owner, b.created, b.updated]; }

/* ---------- 구글 시트 저장소 ----------
   한 번의 요청 동안만 읽은 값을 들고 있는다. (요청은 잠금 안에서 하나씩 처리된다) */
function SheetStore() { this.c = {}; }
SheetStore.prototype.rows_ = function (name) {
  if (!this.c[name]) {
    var sh = tab_(name), n = sh.getLastRow() - 1;
    this.c[name] = { sh: sh, vals: n > 0 ? sh.getRange(2, 1, n, TABS[name].head.length).getValues() : [] };
  }
  return this.c[name];
};
SheetStore.prototype.secret = function () {
  var p = PropertiesService.getScriptProperties(), s = p.getProperty('SECRET');
  if (!s) { s = rand_() + rand_(); p.setProperty('SECRET', s); }
  return s;
};

/* 직원: 이름 | 관리자 | 잠김 | 틀린 횟수 | 비밀번호 | 소금 */
SheetStore.prototype.listStaff = function () {
  return this.rows_('직원').vals.map(function (v, i) {
    return { row: i + 2, name: String(v[0]).trim(), isAdmin: v[1] === true, locked: v[2] === true,
             fails: Number(v[3]) || 0, pinHash: String(v[4]), salt: String(v[5]) };
  }).filter(function (s) { return s.name; });
};
SheetStore.prototype.getStaff = function (name) {
  return this.listStaff().filter(function (s) { return s.name === name; })[0] || null;
};
SheetStore.prototype.saveStaff = function (s) {
  var t = this.rows_('직원'), v = [!!s.locked, s.fails || 0, s.pinHash || '', s.salt || ''];
  t.vals[s.row - 2].splice(2, 4, v[0], v[1], v[2], v[3]);
  t.sh.getRange(s.row, 3, 1, 4).setValues([v]);
};

/* 항목: 분류 | 이름 | 코드 — 코드가 비었거나 (행을 복사해) 겹치면 새로 만들어 적는다 */
SheetStore.prototype.listItems = function () {
  var t = this.rows_('항목'), seen = {}, out = [];
  t.vals.forEach(function (v, i) {
    var cat = Core.CATS.filter(function (c) { return c.name === String(v[0]).trim(); })[0];
    var name = String(v[1]).trim(), id = String(v[2]).trim();
    if (!cat || !name) return;
    if (!id || seen[id]) { id = 'i' + rand_().slice(0, 7); v[2] = id; t.sh.getRange(i + 2, 3).setValue(id); }
    seen[id] = true;
    out.push({ id: id, cat: cat.id, name: name });
  });
  return out;
};
SheetStore.prototype.findItem = function (id) {
  return this.listItems().filter(function (x) { return x.id === id; })[0] || null;
};

/* 예약: 코드 | 날짜 | 시 | 항목코드 | 용도 | 예약자 | 만든 때 | 바꾼 때 */
// ponytail: 요청마다 예약 탭 전체를 읽는다. 몇 천 줄까지는 충분히 빠르고, 넘으면 지난 예약을 다른 탭으로 옮기면 된다.
SheetStore.prototype.bookings_ = function () {
  var t = this.rows_('예약');
  if (!t.list) t.list = t.vals.map(function (v, i) {
    return { row: i + 2, id: String(v[0]), date: txt_(v[1], 'yyyy-MM-dd'), hour: Number(v[2]), item: String(v[3]),
             purpose: String(v[4]), owner: String(v[5]), created: String(v[6]), updated: String(v[7]) };
  }).filter(function (b) { return b.id; });
  return t.list;
};
SheetStore.prototype.listBookings = function (from, to) {
  return this.bookings_().filter(function (b) { return b.date >= from && b.date <= to; });
};
SheetStore.prototype.findBooking = function (id) {
  return this.bookings_().filter(function (b) { return b.id === id; })[0] || null;
};
SheetStore.prototype.findSlot = function (date, hour, item) {
  return this.bookings_().filter(function (b) { return b.date === date && b.hour === hour && b.item === item; })[0] || null;
};
SheetStore.prototype.addBooking = function (b) { this.rows_('예약').sh.appendRow(row_(b)); };
SheetStore.prototype.updateBooking = function (b) { this.rows_('예약').sh.getRange(b.row, 1, 1, 8).setValues([row_(b)]); };
SheetStore.prototype.removeBooking = function (id) {
  var b = this.findBooking(id);
  if (b) this.rows_('예약').sh.deleteRow(b.row);
};
SheetStore.prototype.addLog = function (x) { tab_('기록').appendRow([x.time, x.actor, x.action, x.owner, x.before, x.after]); };

/* 센터일정: 코드 | 날짜 | 시간 | 제목 | 넣은 사람 | 만든 때 | 바꾼 때 */
function evRow_(e) { return [e.id, e.date, e.time, e.title, e.owner, e.created, e.updated]; }
SheetStore.prototype.events_ = function () {
  var t = this.rows_('일정');
  if (!t.list) t.list = t.vals.map(function (v, i) {
    return { row: i + 2, id: String(v[0]), date: txt_(v[1], 'yyyy-MM-dd'), time: txt_(v[2], 'HH:mm'), title: String(v[3]),
             owner: String(v[4]), created: String(v[5]), updated: String(v[6]) };
  }).filter(function (e) { return e.id; });
  return t.list;
};
SheetStore.prototype.listEvents = function (from, to) {
  return this.events_().filter(function (e) { return e.date >= from && e.date <= to; });
};
SheetStore.prototype.findEvent = function (id) {
  return this.events_().filter(function (e) { return e.id === id; })[0] || null;
};
SheetStore.prototype.addEvent = function (e) { this.rows_('일정').sh.appendRow(evRow_(e)); };
SheetStore.prototype.updateEvent = function (e) { this.rows_('일정').sh.getRange(e.row, 1, 1, 7).setValues([evRow_(e)]); };
SheetStore.prototype.removeEvent = function (id) {
  var e = this.findEvent(id);
  if (e) this.rows_('일정').sh.deleteRow(e.row);
};
