/* 서버와 주고받기.
   config.js에 주소가 있으면 구글 앱스 스크립트로, 없으면 이 기기 안의 '체험 서버'로 보낸다.
   체험 서버도 같은 예약 규칙(core.js)을 쓴다. */
'use strict';

class ApiError extends Error {
  constructor(message, code) { super(message); this.code = code || 'error'; }
}

function randHex() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, x => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- 체험 모드 저장소 (이 기기에만) ---------- */
const DemoStore = {
  KEY: 'pub.demo',
  data: null,
  load() {
    if (this.data) return;
    try { this.data = JSON.parse(localStorage.getItem(this.KEY)); } catch (e) { this.data = null; }
    if (!this.data) this.data = this.seed();
    if (!this.data.events) this.data.events = [];   // 센터일정이 생기기 전에 만든 체험 자료
  },
  save() { try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); } catch (e) { /* 저장 못 해도 계속 */ } },
  seed() {
    const staff = ['체험 관리자', '체험 직원 1', '체험 직원 2', '체험 직원 3'].map((name, i) => ({
      name, isAdmin: i === 0, pinHash: '', salt: '', fails: 0, locked: false
    }));
    const items = Core.SAMPLE_ITEMS.map(([cat, name], i) => ({ id: 'i' + (i + 1), cat: Core.CATS.find(c => c.name === cat).id, name }));
    // 다른 사람 예약 예시: 분류마다 첫 항목 + 두 번째 항목에 하나씩, 가장 가까운 빈 시간에
    const now = Core.nowKST();
    const bookings = [];
    const picks = Core.CATS.map(c => items.find(i => i.cat === c.id)).filter(Boolean);
    if (items[1] && !picks.includes(items[1])) picks.push(items[1]);
    picks.forEach((it, k) => {
      const c = Core.catById(it.cat), hour = 14 + k;
      for (let d = 0; d < 7; d++) {
        const date = Core.addDays(now.date, d);
        if (Core.slotStatus(date, hour, c.id) !== 'ok') continue;
        bookings.push({ id: randHex(), date, hour, item: it.id, purpose: c.purposes[k % c.purposes.length], owner: '체험 직원 2', created: now.stamp, updated: '' });
        break;
      }
    });
    const events = [   // 센터일정 예시
      { id: randHex(), date: Core.addDays(now.date, 1), time: '10:00', title: '월례회의', owner: '체험 관리자', created: now.stamp, updated: '' },
      { id: randHex(), date: Core.addDays(now.date, 3), time: '', title: '외부 교육', owner: '체험 직원 2', created: now.stamp, updated: '' }
    ];
    return { secret: randHex() + randHex(), staff, items, bookings, events, log: [] };
  },
  reset() { this.data = this.seed(); this.save(); },

  secret() { return this.data.secret; },
  listStaff() { return this.data.staff; },
  getStaff(name) { return this.data.staff.find(s => s.name === name) || null; },
  saveStaff() { this.save(); },
  listItems() { return this.data.items; },
  findItem(id) { return this.data.items.find(i => i.id === id) || null; },
  listBookings(from, to) { return this.data.bookings.filter(b => b.date >= from && b.date <= to); },
  findBooking(id) { return this.data.bookings.find(b => b.id === id) || null; },
  findSlot(date, hour, item) { return this.data.bookings.find(b => b.date === date && b.hour === hour && b.item === item) || null; },
  addBooking(b) { this.data.bookings.push(b); this.save(); },
  updateBooking() { this.save(); },
  removeBooking(id) { this.data.bookings = this.data.bookings.filter(b => b.id !== id); this.save(); },
  listEvents(from, to) { return this.data.events.filter(e => e.date >= from && e.date <= to); },
  findEvent(id) { return this.data.events.find(e => e.id === id) || null; },
  addEvent(e) { this.data.events.push(e); this.save(); },
  updateEvent() { this.save(); },
  removeEvent(id) { this.data.events = this.data.events.filter(e => e.id !== id); this.save(); },
  addLog(x) { this.data.log.push(x); this.save(); }
};

const Api = {
  demo: !(typeof CONFIG !== 'undefined' && CONFIG.API_URL),

  async call(action, data) {
    const req = Object.assign({ action }, data || {});
    let res;
    if (this.demo) {
      DemoStore.load();
      await new Promise(r => setTimeout(r, 120));
      // 화면 쪽 객체가 바뀌지 않도록 복사해서 넘긴다
      res = JSON.parse(JSON.stringify(Core.handle(JSON.parse(JSON.stringify(req)), DemoStore, Date.now(), randHex)));
    } else {
      let r;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      try {
        // 글자 형식으로 보내야 구글 서버가 별도 확인 절차 없이 받는다
        r = await fetch(CONFIG.API_URL, { method: 'POST', body: JSON.stringify(req), redirect: 'follow', signal: ctl.signal });
      } catch (e) {
        throw new ApiError(e.name === 'AbortError' ? '서버 응답이 너무 늦어요. 잠시 후 다시 해 주세요.' : '인터넷 연결을 확인해 주세요.', 'network');
      } finally { clearTimeout(timer); }
      if (!r.ok) throw new ApiError(`서버 응답 오류가 생겼어요. (${r.status})`, 'network');
      try { res = await r.json(); }
      catch (e) { throw new ApiError('서버 주소가 올바르지 않은 것 같아요. config.js의 주소와 웹 앱 배포 설정을 확인해 주세요.', 'config'); }
    }
    if (!res || !res.ok) throw new ApiError((res && res.error) || '알 수 없는 오류가 생겼어요.', res && res.code);
    return res;
  }
};
