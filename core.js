/* 저기요 시험판 — 차주 앱·요청자 화면이 함께 쓰는 기능 */
const CFG = window.MOVECALL_CONFIG;
/* 내 PC에서 시험할 때만: ?as=a 처럼 붙이면 탭마다 다른 사람으로 로그인 (구글 로그인 없이 익명으로 차주 시험) */
const DEV = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const DEV_AS = DEV ? (new URLSearchParams(location.search).get('as') || sessionStorage.getItem('dev-as') || '') : '';
if (DEV_AS) sessionStorage.setItem('dev-as', DEV_AS);
const sb = window.supabase.createClient(CFG.url, CFG.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: 'movecall-auth' + (DEV_AS ? '-' + DEV_AS : '') }
});

/* ---------- 작은 도우미 ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const hhmm = d => { d = new Date(d); return `${d.getHours()}:${pad(d.getMinutes())}`; };
const ymdhm = d => { d = new Date(d); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const DAYS = '일월화수목금토';
const dateStr = d => `${d.getMonth() + 1}월 ${d.getDate()}일 ${DAYS[d.getDay()]}요일`;
const secs = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`; };
const mmss = ms => { const s = Math.ceil(ms / 1000); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
/* 010-1234-5678, 0507 안심번호(0507-1234-5678)는 12자리 */
const fmtPhone = v => {
  const raw = String(v).replace(/\D/g, ''), d = raw.slice(0, /^050/.test(raw) ? 12 : 11);
  if (/^050/.test(d) && d.length > 4) return d.slice(0, 4) + '-' + (d.length > 8 ? d.slice(4, 8) + '-' + d.slice(8) : d.slice(4));
  if (d.length < 4) return d; if (d.length < 8) return d.slice(0, 3) + '-' + d.slice(3); return d.slice(0, 3) + '-' + d.slice(3, d.length - 4) + '-' + d.slice(-4);
};
const phoneOK = v => { const d = String(v).replace(/\D/g, ''); return /^050\d{9}$/.test(d) || /^0\d{8,10}$/.test(d); };
const callTypeOf = v => /^050/.test(String(v).replace(/\D/g, '')) ? 'safe' : 'real';
const setText = (s, v) => $$(s).forEach(e => { if (e.textContent !== String(v)) e.textContent = v; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = /Android|iPhone|iPad|iPod/.test(navigator.userAgent) || isIOS;
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canVib = () => !!navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive);
const vib = p => { if (canVib()) try { navigator.vibrate(p); } catch (e) { } };

const LOGO = '<img class="logo" src="icons/icon-192.png?v=2" alt="">';
const BRAND = LOGO + '<span class="wm">저기요</span>';
const clock = ms => { const x = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(x / 60)}:${pad(x % 60)}`; };
const plateHTML = (t, cls) => `<span class="plate${cls ? ' ' + cls : ''}">${esc(t)}</span>`;
/* 사람이 한 말은 따옴표로 */
const sayHTML = (lines, cite, cls) => lines.length ? `<blockquote class="say${cls ? ' ' + cls : ''}">${lines.map(l => '“' + esc(l) + '”').join('<br>')}${cite ? `<cite>${esc(cite)}</cite>` : ''}</blockquote>` : '';

function toast(text, ms = 2600) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = text;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}

/* ---------- 정해진 문구 ---------- */
const REASONS = { exit: '출차해야 해요', block: '차가 길을 막고 있어요', work: '하역·공사 작업이 있어요', etc: '기타' };
const WHO = { hit: '제가 부딪혔어요', saw: '사고를 목격했어요' };
const WHO_LONG = { hit: '상대 차량 운전자가 직접 알림', saw: '목격자가 알림' };
const FLOORS = ['B4', 'B3', 'B2', 'B1', '1층', '2층', '3층', '4층 이상', '지상·야외'];
/* 기타 알림: 긴급은 맨 위. level = urgent(긴급·반복) / normal(반복) / info(가끔 반복) */
const ETC_GROUPS = [
  { g: '긴급 상황', urgent: true, items: [
    { k: 'child', t: '차 안에 아이·반려동물이 있어요', lv: 'urgent', tel: '119' },
    { k: 'fire', t: '연기·화재·침수가 보여요', lv: 'urgent', tel: '119' },
    { k: 'theft', t: '도난·파손이 의심돼요', lv: 'urgent', tel: '112' }] },
  { g: '차량 상태', items: [
    { k: 'light', t: '라이트·실내등이 켜져 있어요', lv: 'info' },
    { k: 'window', t: '창문·선루프·트렁크가 열려 있어요', lv: 'normal' },
    { k: 'tire', t: '타이어 펑크·바람 빠짐이 보여요', lv: 'info' },
    { k: 'leak', t: '차 밑으로 액체가 새요', lv: 'normal' },
    { k: 'alarm', t: '경보기가 계속 울려요', lv: 'normal' }] },
  { g: '단속·충전', items: [
    { k: 'tow', t: '단속·견인 차량이 왔어요', lv: 'normal' },
    { k: 'fireline', t: '소방차 전용구역·소화전 앞이라 위험해요', lv: 'normal' },
    { k: 'charge', t: '충전 완료, 충전구역을 비워 주세요', lv: 'normal' }] },
  { g: '분실물', items: [{ k: 'lost', t: '차 위·옆에 물건을 두고 가셨어요', lv: 'info' }] }
];
const ETC = Object.fromEntries(ETC_GROUPS.flatMap(g => g.items.map(i => [i.k, i])));
const BB_WHEN = ['방금 전', '1시간 이내', '오늘', '어제', '2~3일 전'];
const BB_WHAT = ['제 차 사고', '사고 목격', '기타 사건'];
/* 차주 답장 (종류별) */
const REPLY_SETS = {
  move: [
    { k: 'now', t: '지금 가요', sub: '2분 안에', min: 2, icon: '' },
    { k: 'soon', t: '곧 갈게요', sub: '5분 안에', min: 5, icon: '' },
    { k: 'ten', t: '10분 걸려요', sub: '조금만 기다려 주세요', min: 10, icon: '' },
    { k: 'neutral', t: '중립이에요, 살살 밀어 주세요', sub: '', min: 0, icon: '' },
    { k: 'cant', t: '지금은 못 가요', sub: '', min: 0, icon: '', alt: true }],
  acc: [
    { k: 'acc_go', t: '확인했어요, 지금 갈게요', min: 5, icon: '' },
    { k: 'acc_call', t: '확인했어요, 전화드릴게요', min: 0, icon: '' },
    { k: 'acc_wait', t: '10분 안에 갈게요, 기다려 주세요', min: 10, icon: '' }],
  bb: [
    { k: 'bb_check', t: '확인해 볼게요', min: 0, icon: '' },
    { k: 'bb_send', t: '영상이 있어요, 연락드릴게요', min: 0, icon: '' },
    { k: 'bb_none', t: '그 시간 영상이 없어요', min: 0, icon: '', alt: true }],
  etcUrgent: [
    { k: 'etc_go', t: '지금 가 볼게요', min: 5, icon: '' },
    { k: 'etc_report', t: '신고 부탁드려요 (112·119)', min: 0, icon: '' },
    { k: 'etc_thx', t: '알려 주셔서 감사해요', min: 0, icon: '', alt: true }],
  etc: [
    { k: 'etc_go', t: '지금 가 볼게요', min: 5, icon: '' },
    { k: 'etc_thx', t: '확인했어요, 감사해요', min: 0, icon: '' },
    { k: 'etc_known', t: '이미 알고 있어요', min: 0, icon: '', alt: true }]
};
const replySet = r => r.kind === 'etc' ? (r.level === 'urgent' ? REPLY_SETS.etcUrgent : REPLY_SETS.etc)
  : r.kind === 'move' && r.feedback ? REPLY_SETS.move.filter(x => x.k !== 'neutral') : REPLY_SETS[r.kind] || [];
const REP = k => Object.values(REPLY_SETS).flat().find(r => r.k === k);
const FEEDBACK = { pushfail: '밀어봤는데 안 돼요', notneutral: '중립이 아닌 것 같아요', nospace: '밀 공간이 없어요', notyet: '아직 해결되지 않았어요' };
const THANKS = {
  move: ['덕분에 잘 나갔어요, 감사합니다', '빨리 와 주셔서 감사해요', '바쁘신데 고맙습니다'],
  other: ['확인해 주셔서 감사해요', '빠르게 답해 주셔서 감사해요', '좋은 하루 보내세요']
};
/* 채팅은 골라서 보내는 문구 위주 */
const QUICK = {
  r: ['어디쯤 오세요?', '천천히 오셔도 괜찮아요', '조금 급해요', '차 옆에서 기다릴게요', '해결됐어요, 감사합니다'],
  rAcc: ['정말 죄송합니다', '차 옆에서 기다릴게요', '보험 접수할게요', '사진 더 보내 드릴까요?', '연락 기다릴게요'],
  rBb: ['연락 기다릴게요', '영상 받을 방법을 알려 주세요', '급하지 않아요, 편할 때 확인해 주세요', '감사합니다'],
  rEtc: ['확인 부탁드려요', '사진 보내 드릴까요?', '신고했어요', '감사합니다'],
  o: ['거의 다 왔어요', '엘리베이터 기다리는 중이에요', '조금만 기다려 주세요', '차 옮겼어요', '죄송합니다, 금방 갈게요'],
  oAcc: ['알려 주셔서 감사해요', '지금 내려가고 있어요', '보험사 연락처 보내 주세요', '잠시만 기다려 주세요', '전화드릴게요'],
  oBb: ['확인해서 연락드릴게요', '전화번호로 연락드릴게요', '영상이 없네요, 죄송해요', '보험사·경찰에 요청해 주세요'],
  oEtc: ['알려 주셔서 감사해요', '지금 가 볼게요', '이미 알고 있어요', '신고 부탁드려요']
};
const quickFor = (r, side) => ({ move: '', acc: 'Acc', bb: 'Bb', etc: 'Etc' }[r.kind] || '');
const QUICK_OF = (r, side) => QUICK[side + quickFor(r)] || QUICK[side];
/* 차주 상태 메시지: 요청자가 편한 마음으로 연락할 수 있게 안심시키는 문구 */
const NEAR_MIN = [1, 3, 5, 10, 15, 20, 30];
const ampm = d => { d = new Date(d); return `${d.getHours() < 12 ? '오전' : '오후'} ${d.getHours() % 12 || 12}:${pad(d.getMinutes())}`; };
const koTime = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}시${m ? ` ${m}분` : ''}`; };
function statusText(c) {
  if (!c || !c.status_code || !c.status_at) return '';
  if (c.status_code === 'near') {
    if (Date.now() - new Date(c.status_at) > 12 * 3600e3) return '';   // 12시간 지나면 숨김
    return `${c.status_min || 5}분 거리에 있어요. 연락 주시면 바로 갈게요`;
  }
  if (c.status_code === 'custom') {
    if (Date.now() - new Date(c.status_at) > 12 * 3600e3) return '';   // 직접 쓴 말도 12시간 뒤 숨김
    return c.status_text || '';
  }
  if (c.status_code === 'meeting') {
    if (!timeValid(c.status_until, c.status_at, 0)) return '';         // 회의가 끝나면 숨김
    return `${koTime(c.status_until)}까지 회의 중이라 확인이 늦을 수 있어요. 연락 주시면 빨리 올게요`;
  }
  return '';
}
const leaveText = c => timeValid(c.leave_at, c.leave_set_at || c.status_at, 30) ? `${koTime(c.leave_at)}에 나갈 예정이에요` : '';
const STATUS = { ringing: '응답 대기', replied: '답장함', resolving: '해결 확인 중', done: '완료', cancelled: '취소' };
const CALL_LABEL = { safe: '0507 안심번호', real: '휴대폰 번호', none: '전화 받지 않음' };
const ROLE_LABEL = { owner: '본 차주', co: '공동차주', temp: '임시 운전자' };
const KIND_LABEL = { move: '주차 이동 요청', acc: '사고 알림', bb: '블랙박스 영상 요청', etc: '기타 알림' };
const locText = l => l ? [l.floor, l.zone].filter(Boolean).join(' ') + (l.memo ? ` (${l.memo})` : '') : '';
const headOf = r => r.kind === 'acc' ? `사고 알림 ${r.acc?.name || ''}`.trim()
  : r.kind === 'bb' ? '블랙박스 영상 요청'
  : r.kind === 'etc' ? (ETC[r.sub]?.t || '기타 알림')
  : (REASONS[r.reason] || '이동 요청');

/* ---------- 로그인 ---------- */
/* 차주: 구글 계정 (휴대폰을 바꿔도 내 차를 그대로 쓰고, 공동차주 초대에 필요) */
const backUrl = extra => location.origin + location.pathname + (extra || '');
async function googleLogin(extra) {
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: backUrl(extra) } });
  if (error) throw error;
}
/* 예전 익명 가입 차주: 같은 계정에 구글을 연결해서 차량·기록을 그대로 유지 */
async function linkGoogle(extra) {
  const { error } = await sb.auth.linkIdentity({ provider: 'google', options: { redirectTo: backUrl(extra) } });
  if (error) throw error;
}
/* 요청자: 익명 (가입 없이 바로 사용) */
async function ensureUser() {
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) return session.user;
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return data.user;
}

/* ---------- 알림 ---------- */
function notify(kind, request_id, extra) {
  return sb.functions.invoke('notify', { body: { kind, request_id, ...(extra || {}) } })
    .then(r => r.error ? { error: String(r.error.message || r.error) } : r.data)
    .catch(e => ({ error: String(e) }));
}
const b64u = s => { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...b].map(c => c.charCodeAt(0))); };
async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'granted') return Notification.permission;  // default | denied
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  return sub ? 'on' : 'nosub';
}
async function enablePush(uid) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return { ok: false, why: isIOS && !isStandalone ? 'ios-not-installed' : 'unsupported' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, why: perm };
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(CFG.vapid) });
  const j = sub.toJSON();
  await sb.from('push_subs').delete().eq('endpoint', j.endpoint);
  const { error } = await sb.from('push_subs').insert({ endpoint: j.endpoint, sub: j, user_id: uid });
  if (error) return { ok: false, why: error.message };
  return { ok: true };
}

/* ---------- QR ---------- */
function qrMake(text) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q; }
function qrSVG(text, cls) {
  const q = qrMake(text), n = q.getModuleCount(); let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return `<svg class="${cls || 'qr'}" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}
const stickerHTML = url => `<div class="stk"><div class="stk-top">${BRAND}</div>${qrSVG(url, 'qrbig')}<div class="stk-s">QR을 찍으면 차주에게 바로 연락돼요<br>메시지는 전화번호 없이 주고받아요</div></div>`;
async function stickerBlob(url) {
  const W = 600, H = 860, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const rr = (x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };
  const F = 'Pretendard, "Malgun Gothic", sans-serif';
  try { await document.fonts.load('400 76px Gaegu', '저기요'); } catch (e) { }
  const logo = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = 'icons/icon-512.png?v=2'; });
  g.fillStyle = '#1B6B4E'; rr(0, 0, W, H, 48); g.fill();
  g.fillStyle = '#fff'; rr(24, 24, W - 48, H - 48, 32); g.fill();
  g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = '#1C211F'; g.font = `400 76px Gaegu, ${F}`;
  const tw = g.measureText('저기요').width, lx = (W - (84 + 18 + tw)) / 2;
  if (logo) g.drawImage(logo, lx, 58, 84, 84);
  g.fillText('저기요', lx + 102, 102);
  const q = qrMake(url), n = q.getModuleCount(), size = 420, cell = size / n, qx = (W - size) / 2, qy = 176;
  g.fillStyle = '#111';
  for (let r = 0; r < n; r++) for (let cc = 0; cc < n; cc++) if (q.isDark(r, cc)) g.fillRect(qx + cc * cell, qy + r * cell, Math.ceil(cell), Math.ceil(cell));
  g.textAlign = 'center'; g.fillStyle = '#1C211F'; g.font = `800 30px ${F}`; g.fillText('QR을 찍으면 차주에게 바로 연락돼요', W / 2, 668);
  g.fillStyle = '#68716C'; g.font = `500 26px ${F}`; g.fillText('메시지는 전화번호 없이 주고받아요', W / 2, 718);
  return await new Promise(res => c.toBlob(res, 'image/png'));
}

/* ---------- 폰에만 두는 사진 (주차기록) ---------- */
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('jg-local', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photos');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction('photos', mode), st = t.objectStore('photos'), q = fn(st);
    t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error);
  }));
  return {
    put: (k, blob) => run('readwrite', st => st.put(blob, k)),
    get: k => run('readonly', st => st.get(k)),
    del: k => run('readwrite', st => st.delete(k)),
    clear: () => run('readwrite', st => st.clear())
  };
})();

/* ---------- 사진 ---------- */
function resizeImage(file, max = 1600, q = 0.85) {
  return new Promise(res => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const sc = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas');
      c.width = Math.round(im.width * sc); c.height = Math.round(im.height * sc);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      c.toBlob(b => res(b), 'image/jpeg', q);
    };
    im.onerror = () => { URL.revokeObjectURL(url); res(null); };
    im.src = url;
  });
}
async function uploadPhoto(blob, uid) {
  const path = `${uid}/${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw error;
  return path;
}
async function photoUrls(paths) {
  if (!paths?.length) return [];
  const { data, error } = await sb.storage.from('photos').createSignedUrls(paths, 3600);
  if (error || !data) return [];
  return data.map(d => d.signedUrl);
}
async function fetchBlobs(urls) {
  const out = [];
  for (const u of urls) { try { const r = await fetch(u); if (r.ok) out.push(await r.blob()); } catch (e) { } }
  return out;
}

/* ---------- 폰에 저장 (모바일은 공유 창 → '이미지 저장', PC는 내려받기) ---------- */
async function saveFiles(files) {
  if (isMobile && navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'aborted'; }
  }
  for (const f of files) {
    const u = URL.createObjectURL(f), a = document.createElement('a');
    a.href = u; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 5000); await sleep(350);
  }
  return 'downloaded';
}
const stamp = d => { d = new Date(d); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; };
async function savePhotos(r, urls) {
  const blobs = await fetchBlobs(urls);
  if (!blobs.length) { toast('사진을 불러오지 못했어요'); return; }
  const files = blobs.map((b, i) => new File([b], `저기요_사고사진_${stamp(r.created_at)}_${i + 1}.jpg`, { type: b.type || 'image/jpeg' }));
  const res = await saveFiles(files);
  if (res === 'downloaded') toast(`사진 ${files.length}장을 저장했어요`);
}

/* ---------- 메시지 목록 ---------- */
const nameOf = (sender, r) => sender === 'o' ? '차주' : sender === 'r' ? (r.kind === 'acc' ? '신고자' : '요청자') : '기록';
function msgHTML(r, msgs, side, photoSrcs) {
  const a = r.acc || {}, pics = (photoSrcs || []).length ? '<br>' + photoSrcs.map(p => `<img src="${p}" alt="">`).join('') : '';
  let html;
  if (r.kind === 'acc') html = `사고 알림: ${WHO[r.sub || a.who] || ''}<br>${esc(a.name)}${a.plate ? ' ' + esc(a.plate) : ''} ${esc(a.phone)}${a.desc ? '<br>' + esc(a.desc) : ''}`;
  else if (r.kind === 'bb') html = `블랙박스 영상 요청<br>${esc(a.when || '')}, ${esc(a.what || '')}${a.where ? '<br>장소: ' + esc(a.where) : ''}<br>연락처: ${esc(a.name || '')} ${esc(a.phone || '')}`;
  else if (r.kind === 'etc') html = esc(ETC[r.sub]?.t || '');
  else html = `${esc(REASONS[r.reason] || '')}${r.loc ? '<br>' + esc(locText(r.loc)) : ''}${r.msg ? '<br>' + esc(r.msg) : ''}`;
  const items = [{ sender: 'r', at: r.created_at, html: html + pics }];
  if (r.replied_at && REP(r.reply)) items.push({ sender: 'o', at: r.replied_at, text: REP(r.reply).t });
  msgs.forEach(m => items.push({ sender: m.sender, at: m.created_at, text: m.text }));
  if (r.status === 'done' && r.done_at) items.push({ sender: 'sys', at: r.done_at, text: `해결 완료${r.resolved_by === 'auto' ? ' (자동 완료)' : r.resolved_by === 'r' ? ' (요청자 확인)' : ''}` });
  if (r.status === 'cancelled') items.push({ sender: 'sys', at: Date.now(), text: '요청이 취소됐어요' });
  items.sort((a, b) => new Date(a.at) - new Date(b.at));
  return items.map(m => {
    if (m.sender === 'sys') return `<div class="m sys">${esc(m.text)}</div>`;
    return `<div class="m ${m.sender === side ? 'me' : 'them'}">${m.html || esc(m.text)}<span class="tm">${hhmm(m.at)}</span></div>`;
  }).join('');
}

/* ---------- 기록 내보내기 ---------- */
function recordRows(r, plate) {
  const rows = [['구분', KIND_LABEL[r.kind] || '-'], ['차량', plate || r.car_label || '-'], ['요청 시각', ymdhm(r.created_at)]];
  const a = r.acc || {};
  if (r.kind === 'acc') rows.push(['알린 사람', WHO_LONG[r.sub || a.who] || '-'], ['이름', a.name || '-'], ['차량번호', a.plate || '-'], ['전화번호', a.phone || '-'], ['사고 내용', a.desc || '-'], ['사진', `${(r.photos || []).length}장`]);
  else if (r.kind === 'bb') rows.push(['언제', a.when || '-'], ['무슨 일', a.what || '-'], ['장소', a.where || '-'], ['요청자 연락처', `${a.name || ''} ${a.phone || ''}`.trim() || '-']);
  else if (r.kind === 'etc') rows.push(['내용', ETC[r.sub]?.t || '-']);
  else {
    rows.push(['사유', `${REASONS[r.reason] || '-'}${r.msg ? ' · ' + r.msg : ''}`]);
    rows.push(['주차위치', r.loc ? locText(r.loc) : '(자동 삭제됨)']);
  }
  const rp = REP(r.reply);
  rows.push(['차주 첫 응답', r.replied_at ? `${hhmm(r.replied_at)} (${secs(new Date(r.replied_at) - new Date(r.created_at))} 만에)${rp ? ' · ' + rp.t : ''}` : '없음']);
  if (r.feedback) rows.push(['요청자 피드백', FEEDBACK[r.feedback] || r.feedback]);
  rows.push(['처리 결과', r.status === 'done' ? `완료 (${hhmm(r.done_at)}${r.resolved_by === 'auto' ? ', 자동 완료' : r.resolved_by === 'r' ? ', 요청자 확인' : ''})` : STATUS[r.status] || r.status]);
  return rows;
}
function chatLines(r, msgs) {
  return msgs.map(m => `[${hhmm(m.created_at)}] ${nameOf(m.sender, r)}: ${m.text}`);
}
function recordText(r, msgs, plate) {
  const rows = recordRows(r, plate).map(([k, v]) => `${k}: ${v}`).join('\n');
  const chat = chatLines(r, msgs);
  return `[저기요 ${r.kind === 'acc' ? '사고 기록' : '주차 이동 요청 기록'}]\n${rows}${chat.length ? '\n\n[대화 기록]\n' + chat.join('\n') : ''}\n\n기록 번호 ${r.id.slice(0, 8)} · 저기요 시험판에서 내보냄 ${ymdhm(Date.now())}`;
}
async function recordPNG(r, msgs, plate, photoBlobs) {
  const W = 1000, P = 56, F = 'Pretendard, "Malgun Gothic", sans-serif';
  const imgs = [];
  for (const b of photoBlobs || []) { try { imgs.push(await createImageBitmap(b)); } catch (e) { } }
  const c = document.createElement('canvas'), g = c.getContext('2d');
  const rows = recordRows(r, plate), chat = chatLines(r, msgs);
  const wrap = (text, font, maxW) => {
    g.font = font; const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const ch of para) { const t = line + ch; if (g.measureText(t).width > maxW && line) { out.push(line); line = ch; } else line = t; }
      out.push(line);
    }
    return out;
  };
  const draw = dry => {
    let y = P; g.textBaseline = 'top';
    const T = (txt, font, color, x, yy) => { if (!dry) { g.font = font; g.fillStyle = color; g.fillText(txt, x, yy); } };
    if (!dry) { g.fillStyle = '#fff'; g.fillRect(0, 0, W, c.height); g.fillStyle = r.kind === 'acc' ? '#D43A2F' : '#1B6B4E'; g.fillRect(0, 0, W, 14); }
    T(r.kind === 'acc' ? '저기요 사고 기록' : '저기요 주차 이동 요청 기록', `800 40px ${F}`, '#16181d', P, y + 10); y += 74;
    T(`기록 번호 ${r.id.slice(0, 8)} · ${ymdhm(r.created_at)}`, `500 22px ${F}`, '#6b7280', P, y); y += 48;
    const labW = 200, valW = W - 2 * P - labW - 32;
    for (const [k, v] of rows) {
      const ls = wrap(v, `600 26px ${F}`, valW), h = ls.length * 36 + 22;
      if (!dry) { g.fillStyle = '#f3f4f6'; g.fillRect(P, y, labW, h); g.strokeStyle = '#e5e7eb'; g.lineWidth = 2; g.strokeRect(P, y, W - 2 * P, h); }
      T(k, `700 24px ${F}`, '#6b7280', P + 16, y + 13);
      ls.forEach((l, i) => T(l, `600 26px ${F}`, '#16181d', P + labW + 16, y + 12 + i * 36));
      y += h;
    }
    y += 36;
    if (chat.length) {
      T('대화 기록', `800 30px ${F}`, '#16181d', P, y); y += 50;
      for (const line of chat) { wrap(line, `500 24px ${F}`, W - 2 * P).forEach(l => { T(l, `500 24px ${F}`, '#333', P, y); y += 34; }); y += 6; }
      y += 24;
    }
    if (imgs.length) {
      T(`사진 ${imgs.length}장`, `800 30px ${F}`, '#16181d', P, y); y += 50;
      const gap = 16, cols = imgs.length > 1 ? 2 : 1, cw = (W - 2 * P - gap * (cols - 1)) / cols;
      for (let i = 0; i < imgs.length; i += cols) {
        let rowH = 0;
        for (let j = 0; j < cols && i + j < imgs.length; j++) {
          const im = imgs[i + j], h = cw * im.height / im.width;
          if (!dry) g.drawImage(im, P + j * (cw + gap), y, cw, h);
          rowH = Math.max(rowH, h);
        }
        y += rowH + gap;
      }
      y += 10;
    }
    T(`저기요 시험판에서 내보냄 · ${ymdhm(Date.now())}`, `500 20px ${F}`, '#9ca3af', P, y); y += 40;
    return y;
  };
  c.width = W; c.height = 6000; const H = draw(true);
  c.height = Math.ceil(H + P / 2); draw(false);
  return await new Promise(res => c.toBlob(res, 'image/png'));
}

/* ---------- 기록 목록·상세 (두 화면 공통) ---------- */
function recordListHTML(list) {
  if (!list.length) return '<p class="lead">아직 기록이 없어요</p>';
  return `<div class="list">${list.map(r => `<button class="li" data-act="rec" data-id="${r.id}">
    <span class="kd ${r.kind}${r.level === 'urgent' ? ' urgent' : ''}"></span>
    <span class="tx"><span class="t">${esc(headOf(r))}</span><span class="s">${ymdhm(r.created_at)}${r.car_label ? ' ' + esc(r.car_label) : ''}</span></span>
    <span class="st ${r.status}">${STATUS[r.status] || ''}</span></button>`).join('')}</div>`;
}
function recordDetailHTML(r, msgs, side, plate, urls) {
  const kept = side === 'o' ? r.keep_o : r.keep_r;
  return `
    <div class="keepbar">${kept ? '보관 중 · 자동 삭제되지 않아요' : '끝난 뒤 30일이 지나면 자동 삭제돼요' + (r.kind === 'move' ? ' (주차위치·사진은 하루 뒤)' : '')}
      <button class="linkbtn" data-act="keep">${kept ? '보관 해제' : '보관하기'}</button></div>
    <div class="info">${recordRows(r, plate).map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
    ${urls.length ? `<div class="thumbs">${urls.map((u, i) => `<img src="${u}" data-act="photo" data-i="${i}" alt="사고 사진 ${i + 1}">`).join('')}</div>
      <button class="btn soft sm" data-act="save-photos">사고 사진 ${urls.length}장 저장</button>` : ''}
    <div class="h">대화 기록</div>
    <div class="msgs static">${msgHTML(r, msgs, side, [])}</div>
    <button class="btn primary" data-act="export-png">기록을 이미지로 저장</button>
    <button class="btn ghost" data-act="export-text">기록 텍스트 복사</button>`;
}
async function exportPNG(r, msgs, plate, urls) {
  toast('기록 이미지를 만들고 있어요…', 1500);
  const blobs = await fetchBlobs(urls);
  const png = await recordPNG(r, msgs, plate, blobs);
  const res = await saveFiles([new File([png], `저기요_${r.kind === 'acc' ? '사고기록' : '이동요청기록'}_${stamp(r.created_at)}.png`, { type: 'image/png' })]);
  if (res === 'downloaded') toast('기록 이미지를 저장했어요');
}
async function exportText(r, msgs, plate) {
  const t = recordText(r, msgs, plate);
  try { await navigator.clipboard.writeText(t); toast('기록을 복사했어요. 메모·메신저에 붙여 넣으세요'); }
  catch (e) { prompt('아래 내용을 길게 눌러 복사하세요', t); }
}
const photoOvHTML = (urls, i) => `<div class="photo-ov" data-act="close-photo"><img src="${urls[i]}" alt="사진 크게 보기"><p>사진 ${i + 1}/${urls.length} · 눌러서 닫기</p></div>`;

/* ---------- 채팅 화면 (고르는 문구 위주, 직접 입력은 필요할 때만) ---------- */
function chatOvHTML(title, sub, phrases, showInput) {
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button>
      <div><b>${title}</b><div class="muted">${sub}</div></div></div>
    <div class="msgs" id="chat-msgs"></div>
    <div class="qgrid">${phrases.map(t => `<button data-act="quick" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    ${showInput
      ? `<div class="inputbar"><input id="chat-in" maxlength="200" placeholder="직접 입력" autocomplete="off" enterkeyhint="send"><button data-act="send-msg">전송</button></div>`
      : `<div class="freetoggle"><button class="linkbtn" data-act="free-input">직접 입력하기</button></div>`}
  </div>`;
}
const telBtns = tel => tel ? `<div class="telrow">
    ${tel === '119' || tel === 'both' ? '<a class="telbtn t119" href="tel:119">119 신고</a>' : ''}
    ${tel === '112' || tel === 'both' ? '<a class="telbtn t112" href="tel:112">112 신고</a>' : ''}</div>` : '';
/* '○시' 같은 시각이 아직 지나지 않았는지 (설정 시각 이후 처음 오는 그 시각 + 여유 분) */
function timeValid(t, setAt, graceMin) {
  if (!t || !setAt) return false;
  const base = new Date(setAt), [h, m] = t.split(':').map(Number), d = new Date(base);
  d.setHours(h, m, 0, 0); if (d < base) d.setDate(d.getDate() + 1);
  return Date.now() < d.getTime() + (graceMin || 0) * 60000;
}
