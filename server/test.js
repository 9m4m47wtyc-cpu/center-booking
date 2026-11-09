/* 규칙·시트 서버 점검: node server/test.js
   구글 시트를 흉내 낸 가짜 시트 위에서 js/core.js + server/Code.gs를 그대로 돌려 본다.
   (setup → 로그인 → 예약 → 겹침 막기 → 바꾸기·기록 → 취소 → 잠김·초기화 → 날짜·코드 지키기) */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert'), crypto = require('crypto');

const sheets = new Map(), props = new Map();
const ctx = vm.createContext({});
const CtxDate = vm.runInContext('Date', ctx);   // 서버 코드의 instanceof Date가 알아보도록 같은 세계의 Date를 쓴다

/* ---------- 가짜 구글 시트: 글자 형식(@)이 아닌 칸은 진짜처럼 날짜·숫자로 바꿔 버린다 ---------- */
function fakeSheet() {
  let cells = new Map();
  const text = new Set(), key = (r, c) => r + ',' + c;
  function put(r, c, v) {
    if (!text.has(c) && typeof v === 'string') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v = new CtxDate(v + 'T00:00:00+09:00');
      else if (/^\d+$/.test(v)) v = Number(v);
    }
    cells.set(key(r, c), v);
  }
  function range(r, c, nr = 1, nc = 1) {
    const R = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) =>
        cells.has(key(r + i, c + j)) ? cells.get(key(r + i, c + j)) : '')),
      setValues: vals => { vals.forEach((row, i) => row.forEach((v, j) => put(r + i, c + j, v))); return R; },
      setValue: v => { put(r, c, v); return R; },
      setNumberFormat: f => { for (let j = 0; j < nc; j++) f === '@' ? text.add(c + j) : text.delete(c + j); return R; },
      insertCheckboxes: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) cells.set(key(r + i, c + j), false); return R; },
      setDataValidation: () => R,
      setFontWeight: () => R
    };
    return R;
  }
  const sh = {
    getMaxRows: () => 1000,
    getLastRow: () => { let last = 0; for (const [k, v] of cells) if (v !== '') last = Math.max(last, +k.split(',')[0]); return last; },
    getRange: range,
    appendRow: vals => { range(sh.getLastRow() + 1, 1, 1, vals.length).setValues([vals]); },
    deleteRow: r => {
      const next = new Map();
      for (const [k, v] of cells) { const [rr, cc] = k.split(',').map(Number); if (rr !== r) next.set(key(rr > r ? rr - 1 : rr, cc), v); }
      cells = next;
    },
    setFrozenRows: () => {}
  };
  return sh;
}
Object.assign(ctx, {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: n => sheets.get(n) || null,
      insertSheet: n => { const s = fakeSheet(); sheets.set(n, s); return s; },
      getSpreadsheetTimeZone: () => 'Asia/Seoul'
    }),
    newDataValidation: () => ({ requireValueInList() { return this; }, build: () => ({}) })
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) || null, setProperty: (k, v) => props.set(k, v) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    formatDate: d => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10)   // 'yyyy-MM-dd' (한국 시간)만 쓴다
  }
});
for (const f of ['js/core.js', 'server/Code.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });

const C = ctx.Core;
const call = req => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(req) } }).text);
const cell = (tab, r, c) => sheets.get(tab).getRange(r, c).getValues()[0][0];
const notSunday = d => { while (C.weekday(d) === 0) d = C.addDays(d, 1); return d; };

/* 준비 */
ctx.setup();
assert.deepStrictEqual([...sheets.keys()], ['직원', '항목', '예약', '기록']);
sheets.get('직원').getRange(2, 1, 2, 2).setValues([['김관리', true], ['이직원', false]]);

/* 로그인: 처음엔 비밀번호를 정한다 */
assert.deepStrictEqual(call({ action: 'staff' }).staff.map(s => s.name), ['김관리', '이직원']);
const admin = call({ action: 'login', name: '김관리', pin: '1234' });
const staff = call({ action: 'login', name: '이직원', pin: '0000' });
assert(admin.ok && admin.isAdmin && staff.ok && !staff.isAdmin);
assert.strictEqual(call({ action: 'list', token: staff.token.slice(0, -1) + 'x', from: '2026-01-01', to: '2026-01-02' }).code, 'auth');

/* 항목: 처음 5개(상담실1~3·집단상담실·차량). 관리자가 검사도구 줄을 더하면 그 분류도 생긴다. 'i'로 시작하는 코드가 시트에 적힌다 */
let day = C.addDays(C.nowKST().date, 1);
while (C.weekday(day) === 0 || C.weekday(day) === 6) day = C.addDays(day, 1);   // 평일 (10~20시가 다 열려 있는 날)
const itemTab = sheets.get('항목');
itemTab.getRange(itemTab.getLastRow() + 1, 1, 1, 2).setValues([['검사도구', 'TAT 카드']]);
let res = call({ action: 'list', token: staff.token, from: day, to: day });
assert.deepStrictEqual(res.items.map(i => i.name), ['상담실1', '상담실2', '상담실3', '집단상담실', '차량', 'TAT 카드']);
assert(res.items.every(i => /^i[0-9a-f]{7}$/.test(i.id)));
assert.strictEqual(cell('항목', 2, 3), res.items[0].id);
const [room1, room2] = res.items.filter(i => i.cat === 'room'), car = res.items.find(i => i.cat === 'car');
assert(call({ action: 'list', token: staff.token, from: day, to: C.addDays(day, 41) }).ok);              // 달력 한 장(6주)은 된다
assert.strictEqual(call({ action: 'list', token: staff.token, from: day, to: C.addDays(day, 43) }).ok, false);

/* 예약 + 겹침·용도·기간 막기 */
const book = (who, it, hour, purpose, date = day) => call({ action: 'book', token: who.token, date, hour, item: it.id, purpose });
assert(book(staff, room1, 10, '회의').ok);
assert.strictEqual(book(admin, room1, 10, '회의').code, 'taken');
assert.strictEqual(book(staff, car, 11, '회의').error, '용도를 골라 주세요.');   // 차량 용도에는 '회의'가 없다
assert(book(staff, car, 11, '가정방문').ok);
assert.strictEqual(book(staff, room1, 10, '회의', notSunday(C.addDays(day, 40))).code, 'far');
assert.strictEqual(book(staff, room1, 22, '회의').code, 'closed');
assert.strictEqual(cell('예약', 2, 2), day);   // 날짜가 시트에서 날짜 값으로 바뀌지 않고 글자로 남았다

/* 누가 시트 서식을 바꿔 날짜 값이 들어가도 그대로 읽힌다 */
sheets.get('예약').getRange(1, 2, 1000, 1).setNumberFormat('General');
sheets.get('예약').getRange(3, 2).setValue(day);
assert(cell('예약', 3, 2) instanceof CtxDate);
res = call({ action: 'list', token: staff.token, from: day, to: day });
assert.deepStrictEqual(res.bookings.map(b => b.date), [day, day]);
const mine = res.bookings.find(b => b.item === room1.id);

/* 관리자가 남의 예약을 옮기면 기록 탭에 남는다. 옮긴 칸은 다른 사람이 못 잡는다 */
assert(call({ action: 'update', token: admin.token, id: mine.id, date: day, hour: 12, item: room2.id, purpose: '부모상담' }).ok);
assert.strictEqual(sheets.get('기록').getLastRow(), 2);
assert.match(cell('기록', 2, 6), /12:00 상담실2 \(부모상담\)$/);
assert.strictEqual(book(admin, room2, 12, '회의').code, 'taken');
assert.strictEqual(call({ action: 'cancel', token: staff.token, id: book(admin, room1, 15, '회의').booking.id }).code, 'forbidden');

/* 자기 예약 취소 → 시트에서 줄이 지워진다 */
assert(call({ action: 'cancel', token: staff.token, id: mine.id }).ok);
assert.strictEqual(call({ action: 'list', token: staff.token, from: day, to: day }).bookings.length, 2);

/* 5번 틀리면 잠기고 기존 로그인도 끊긴다. 관리자가 초기화하면 풀린다 */
for (let i = 0; i < 4; i++) assert.strictEqual(call({ action: 'login', name: '이직원', pin: '9999' }).code, 'badpin');
assert.strictEqual(call({ action: 'login', name: '이직원', pin: '9999' }).code, 'locked');
assert.strictEqual(call({ action: 'list', token: staff.token, from: day, to: day }).code, 'auth');
assert(call({ action: 'resetPin', token: admin.token, target: '이직원' }).ok);
assert.deepStrictEqual(call({ action: 'staff' }).staff[1], { name: '이직원', hasPin: false, locked: false });

/* 항목 행을 통째로 복사해 코드가 겹치면 새 코드를 받는다 */
itemTab.getRange(itemTab.getLastRow() + 1, 1, 1, 3).setValues([itemTab.getRange(2, 1, 1, 3).getValues()[0]]);
assert.strictEqual(new Set(call({ action: 'list', token: admin.token, from: day, to: day }).items.map(i => i.id)).size, 7);

console.log('모든 점검 통과');
