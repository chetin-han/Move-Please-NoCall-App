/* 저기요 시험판 — 차주 앱 (구글 로그인 · 차량 최대 3대 · 공동차주/임시 운전자 · 받는 사람 1명 · 요청 넘기기 · 기록) */
const params = new URLSearchParams(location.search);
const APP = $('#app'), OV = $('#ov');
const CUR_KEY = 'jg-car' + (DEV_AS ? '-' + DEV_AS : '');
let me = null, anon = null, legacy = false, prof = { name: '', phone: '', call_type: 'real' };
let cars = [], car = null, members = [], others = [];
let active = null, aMsgs = [], aUrls = [], unread = 0;
let view = 'home', recs = [], rec = null, parks = [], pk = null, pkOpen = null;
const purls = {};   // 폰에 저장한 주차 사진 → 화면 주소
let ov = null, ovKey = '', photoI = 0, photoList = [], freeInput = false;
let su = null, sd = null, st = null, ce = null, inv = null, invEnds = '', join = null;
let lastBuzz = 0, pState = 'unsupported', deferredInstall = null, chan = null, booted = false;
let joinCode = params.get('join'), authErr = params.get('error_description');

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (!car) render(); });

const pushWhy = w => ({
  denied: '알림이 차단돼 있어요. 폰 설정 → 앱(크롬 또는 저기요) → 알림에서 허용해 주세요.',
  default: '알림 허용 창에서 "허용"을 눌러 주세요.',
  'ios-not-installed': '아이폰은 홈 화면에 추가한 저기요 앱에서만 알림을 켤 수 있어요.',
  unsupported: '이 브라우저는 폰 알림을 지원하지 않아요. 크롬(안드로이드) 또는 홈 화면에 추가한 앱(아이폰)으로 열어 주세요.'
})[w] || ('알림을 켜지 못했어요: ' + w);
const OPEN = ['ringing', 'replied', 'resolving'];
const errText = e => {
  const m = String(e?.message || e || '');
  if (m.includes('plate_taken')) return '이미 등록된 차량번호예요. 그 차의 차주에게 공동차주 초대를 받아 주세요.';
  if (m.includes('limit3')) return '차량은 1인 최대 3대까지 등록할 수 있어요.';
  if (m.includes('temp_readonly')) return '임시 운전자는 차량 정보를 바꿀 수 없어요.';
  if (m.includes('used')) return '이미 사용된 초대예요. 초대한 분께 새 링크를 부탁해 주세요.';
  if (m.includes('expired')) return '기간이 지난 초대예요. 초대한 분께 새 링크를 부탁해 주세요.';
  if (m.includes('member')) return '이미 함께 쓰고 있는 차량이에요.';
  if (m.includes('bad_ends')) return '끝나는 시각은 10분 뒤부터 31일 안으로 골라 주세요.';
  if (/provider is not enabled|Unsupported provider/i.test(m)) return '구글 로그인이 아직 준비되지 않았어요. 관리자 설정이 필요해요.';
  if (/manual linking/i.test(m)) return '구글 계정 연결이 아직 준비되지 않았어요. 관리자 설정이 필요해요.';
  return m;
};

/* ---------- 시작 ---------- */
async function boot() {
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch (e) { } }
  let u = null;
  try { const { data: { session } } = await sb.auth.getSession(); u = session?.user || null; }
  catch (e) { APP.innerHTML = `<div class="fatal">로그인 정보를 불러오지 못했어요.<br><small>${esc(e.message)}</small></div>`; return; }
  cleanAuthParams();
  if (u && u.is_anonymous && !DEV_AS) {
    // 예전 익명 가입 차주: 구글 계정을 연결하면 차량·기록을 그대로 유지
    anon = u;
    const { data } = await sb.from('cars').select('id').eq('owner', u.id).limit(1);
    legacy = !!data?.length; u = null;
  }
  me = u;
  if (!me) { render(); if (authErr) toast(errText(authErr), 5000); return; }
  pState = await pushState();
  await loadCars();
  if (joinCode) await openJoin(joinCode);
  if (car) { await loadActive(); subscribe(); await handleParams(); loadParks().then(() => { if (!active && view === 'home') render(); }); }
  render();
  booted = true;
  setInterval(tick, 500);
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !me) return;
    pState = await pushState(); await loadCars(); if (car) await loadActive(); render();
  });
}
/* 구글 로그인 뒤 주소에 붙어 오는 값 정리 (초대 코드 등은 남김) */
function cleanAuthParams() {
  const u = new URL(location.href);
  ['code', 'error', 'error_code', 'error_description', 'state'].forEach(k => u.searchParams.delete(k));
  history.replaceState(null, '', u.pathname + u.search);
}
const googleName = () => String(me?.user_metadata?.full_name || me?.user_metadata?.name || '').trim().slice(0, 12);

async function loadCars(pick) {
  const [a, b, c] = await Promise.all([
    sb.rpc('my_cars'), sb.from('cars').select('*'),
    sb.from('car_members').select('name, phone, call_type, created_at').eq('uid', me.id).order('created_at', { ascending: false }).limit(1)
  ]);
  const meta = {}; (a.data || []).forEach(m => { meta[m.car_id] = m; });
  cars = (b.data || []).filter(x => meta[x.id]).map(x => ({ ...x, ...meta[x.id] }))
    .sort((x, y) => new Date(x.created_at) - new Date(y.created_at));
  const p = c.data?.[0];
  prof = { name: p?.name || googleName(), phone: p?.phone || '', call_type: p?.call_type || 'real' };
  const want = pick || car?.id || localStorage.getItem(CUR_KEY);
  car = cars.find(x => x.id === want) || cars[0] || null;
  if (car) localStorage.setItem(CUR_KEY, car.id);
  await loadMembers();
}
async function loadMembers() {
  if (!car) { members = []; return; }
  const { data } = await sb.from('car_members').select('*').eq('car_id', car.id).order('created_at');
  members = data || [];
}
async function switchCar(id) {
  const c = cars.find(x => x.id === id); if (!c) return;
  car = c; localStorage.setItem(CUR_KEY, id);
  parks = []; pk = null; rec = null; recs = []; inv = null; view = 'home';
  await loadMembers();
}
/* 내가 받는 진행 중 요청 (다른 차량이면 그 차량으로 자동 전환) */
async function loadActive() {
  if (!cars.length) { others = []; await setActive(null); return; }
  const { data } = await sb.from('requests').select('*').in('car_id', cars.map(c => c.id)).in('status', OPEN)
    .order('created_at', { ascending: false }).limit(20);
  const list = data || [];
  const mine = list.find(r => r.handler === me.id && r.car_id === car.id) || list.find(r => r.handler === me.id) || null;
  if (mine && mine.car_id !== car.id) await switchCar(mine.car_id);
  others = list.filter(r => r.car_id === car.id && r.handler !== me.id);
  await setActive(mine);
}
async function setActive(r) {
  const changed = !active || !r || active.id !== r.id;
  active = r;
  if (!r) { aMsgs = []; aUrls = []; return; }
  if (changed) { unread = 0; freeInput = false; }
  const { data } = await sb.from('messages').select('*').eq('request_id', r.id).order('id');
  aMsgs = data || [];
  aUrls = await photoUrls(r.photos);
}
function clearActive() { active = null; aMsgs = []; aUrls = []; if (ov === 'chat' || ov === 'fwd') ov = null; }
function subscribe() {
  if (chan) { sb.removeChannel(chan); chan = null; }
  if (!cars.length) return;
  const ids = cars.map(c => c.id).join(','), f = `car_id=in.(${ids})`;
  chan = sb.channel('owner-' + me.id.slice(0, 8) + '-' + Date.now())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'requests', filter: f }, async p => {
      const r = p.new;
      if (r.handler === me.id) {
        if (r.car_id !== car.id) await switchCar(r.car_id);
        await setActive(r); view = 'home'; if (ov !== 'signup' && ov !== 'join') ov = null;
      } else if (r.car_id === car.id) {
        others = [r, ...others.filter(x => x.id !== r.id)];
        if (!members.some(m => m.uid === r.handler)) await loadMembers();   // 새로 들어온 임시 운전자 등
      }
      render();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'requests', filter: f }, async p => {
      const r = p.new;
      if (active && r.id === active.id) {
        if (r.handler !== me.id) {   // 다른 사람에게 넘어감
          toast(`${nameOfUid(r.handler)}님이 이 요청을 맡았어요`); clearActive();
        } else if (OPEN.includes(r.status)) {
          const prev = active.status;
          active = { ...active, ...r };
          if (prev !== 'ringing' && r.status === 'ringing') { lastBuzz = -1; vib([600, 200, 600]); }   // 요청자가 '안 돼요'·'아직' → 다시 울림
        } else {
          toast(r.status === 'cancelled' ? '요청자가 요청을 취소했어요' : r.resolved_by === 'auto' ? '5분이 지나 자동으로 완료됐어요' : '요청자가 해결됐다고 확인했어요');
          clearActive();
        }
        render();
      } else if (!active && r.handler === me.id && OPEN.includes(r.status)) {   // 나에게 넘어온 요청, 다시 열린 요청
        if (r.car_id !== car.id) await switchCar(r.car_id);
        await setActive(r); view = 'home'; lastBuzz = -1; vib([600, 200, 600]);
        if (ov !== 'signup' && ov !== 'join') ov = null;
        render();
      }
      if (r.car_id === car?.id) {   // 다른 사람이 받는 중인 요청 목록 갱신 (넘겨받았거나 끝나면 빠짐)
        const had = others.some(x => x.id === r.id);
        others = others.filter(x => x.id !== r.id);
        if (r.handler !== me.id && OPEN.includes(r.status)) others.unshift(r);
        if (!active && (had || others.length)) render();
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cars', filter: `id=in.(${ids})` }, async () => {
      await loadCars(); if (!active) render(); else renderOv(true);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => {
      const m = p.new;
      if (m.sender === 'r' && m.text.startsWith('감사 인사: ') && (!active || m.request_id !== active.id)) { toast('감사 인사가 도착했어요: ' + m.text, 4000); vib([200]); }
      if (active && m.request_id === active.id && !aMsgs.some(x => x.id === m.id)) {
        aMsgs.push(m);
        if (m.sender === 'r') { if (ov !== 'chat') unread++; vib([200]); }
        updateMsgs();
      }
      if (rec && m.request_id === rec.r.id && !rec.msgs.some(x => x.id === m.id)) rec.msgs.push(m);
    })
    .subscribe();
}
/* 알림 버튼(곧 갈게요 등)·알림을 눌러 들어온 경우 */
async function handleParams() {
  const rid = params.get('rid'), reply = params.get('reply'), chat = params.get('chat'), cid = params.get('car');
  if (cid && !active && cid !== car.id && cars.some(c => c.id === cid)) { await switchCar(cid); await loadActive(); }
  if (rid && (!active || active.id !== rid)) {
    const { data } = await sb.from('requests').select('*').eq('id', rid).maybeSingle();
    if (data && OPEN.includes(data.status) && data.handler === me.id) {
      if (data.car_id !== car.id) await switchCar(data.car_id);
      await setActive(data);
    }
  }
  if (reply && active && active.id === rid && active.status === 'ringing' && REP(reply)) await doReply(reply, true);
  if (chat && active) ov = 'chat';
  if (rid || reply || chat || cid) history.replaceState(null, '', location.pathname);
}

/* ---------- 사람·차량 도우미 ---------- */
const myMem = () => members.find(m => m.uid === me.id) || { name: prof.name, phone: '', call_type: 'none' };
const liveMem = m => m.role !== 'temp' || new Date(m.ends_at) > Date.now();
const nameOfUid = uid => { if (uid === me?.id) return '나'; const m = members.find(x => x.uid === uid); return m ? (m.name || ROLE_LABEL[m.role]) : '다른 사용자'; };
const isFull = () => !!car && (car.my_role === 'owner' || car.my_role === 'co');
const ownCount = () => cars.filter(c => c.my_role !== 'temp').length;
const fwdTargets = () => members.filter(m => m.uid !== me.id && (m.role === 'owner' || m.role === 'co'));
const endText = d => {
  d = new Date(d); const t = new Date(), tm = new Date(Date.now() + 864e5);
  const day = d.toDateString() === t.toDateString() ? '오늘' : d.toDateString() === tm.toDateString() ? '내일' : `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${day} ${ampm(d)}`;
};
const localDT = d => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const inviteUrl = code => backUrl('?join=' + code);

/* ---------- 화면 ---------- */
const OBAR = right => `<div class="appbar">${BRAND}${right || ''}</div>`;
const carChip = () => `<button class="carchip" data-act="cars">${esc(car.plate)}<i>${cars.length > 1 ? cars.length + '대 ▾' : '▾'}</i></button>`;
const who = () => active.kind === 'move' ? '요청자' : active.kind === 'bb' ? '요청자' : active.kind === 'acc' ? '신고자' : '알린 분';
const whoWith = () => who() + (who().endsWith('분') ? '과' : '와');
const chatBtn = () => `<div class="links"><button data-act="chat">${whoWith()} 메시지<span class="unread" id="o-unread" hidden></span></button></div><div class="lastmsg" id="o-last"></div>`;
const fwdBtn = () => fwdTargets().length ? `<button class="btn soft sm" data-act="fwd">다른 공동차주에게 넘기기</button>` : '';
const carUrl = () => new URL('c.html?id=' + car.id, location.href).href;
const fbBanner = () => active.feedback ? `<div class="fbanner">요청자: “${FEEDBACK[active.feedback]}”${active.feedback === 'notyet' ? '' : '<br>직접 와 주셔야 해요'}</div>` : '';
const multiCarLine = () => cars.length > 1 ? `<div class="carline">${plateHTML(car.plate, 'mid')}<span>${esc(car.color || '')} ${esc(car.kind || '')}</span></div>` : '';
function detailCard(r, urls) {
  const a = r.acc || {}, tel = String(a.phone || '').replace(/\D/g, '');
  if (r.kind === 'acc') return `<span class="reason">${WHO[r.sub || a.who] || ''}</span>
    <div class="info">
      <div><span>이름</span><b>${esc(a.name)}</b></div>
      <div><span>차량번호</span><b>${a.plate ? esc(a.plate) : '-'}</b></div>
      <div><span>전화번호</span><a href="tel:${esc(tel)}" data-act="log-call">${esc(a.phone)}</a></div>
    </div>
    ${a.desc ? `<div class="quote">“${esc(a.desc)}”</div>` : ''}
    ${urls.length ? `<div class="thumbs">${urls.map((u, i) => `<img src="${u}" data-act="photo" data-i="${i}" alt="사고 사진 ${i + 1}">`).join('')}</div>
      <button class="btn soft sm" data-act="save-photos">사고 사진 ${urls.length}장 저장</button>` : ''}`;
  if (r.kind === 'bb') return `<div class="info">
      <div><span>언제</span><b>${esc(a.when || '-')}</b></div>
      <div><span>무슨 일</span><b>${esc(a.what || '-')}</b></div>
      ${a.where ? `<div><span>장소</span><b>${esc(a.where)}</b></div>` : ''}
      <div><span>연락처</span><a href="tel:${esc(tel)}" data-act="log-call">${esc(a.name || '')} ${esc(a.phone)}</a></div>
    </div>`;
  if (r.kind === 'etc') return '';
  /* 이동 요청: 주차 위치를 기둥 표지처럼 가장 크게 */
  return `${r.loc ? `<span class="sign"><b>${esc(r.loc.floor || '')}</b>${esc(r.loc.zone || '')}</span>${r.loc.memo ? `<p class="lead">${esc(r.loc.memo)}</p>` : ''}` : ''}
    <span class="reason">${esc(REASONS[r.reason] || '')}</span>
    ${r.msg ? `<div class="quote">“${esc(r.msg)}”</div>` : ''}
    ${urls.length ? `<div class="thumbs">${urls.map((u, i) => `<img src="${u}" data-act="photo" data-i="${i}" alt="현장 사진">`).join('')}</div>` : ''}`;
}
const replyBtns = r => `<div class="replies">${replySet(r).map(x => `<button class="rp${x.alt ? ' alt' : ''}" data-act="reply" data-k="${x.k}">${x.t}${x.min && !x.t.includes('분') ? `<em>${x.min}분</em>` : ''}</button>`).join('')}</div>`;
const statusLines = () => [statusText(car), leaveText(car)].filter(Boolean);
const NAV = on => `<nav class="nav">${[['home', '홈'], ['parking', '주차기록'], ['records', '요청기록']].map(([k, t]) => `<button class="${on === k ? 'on' : ''}" data-act="tab" data-k="${k}">${t}</button>`).join('')}</nav>`;
const parkWhere = p => [p.place, [p.floor, p.spot].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const dayText = d => { const x = new Date(d), t = new Date(), y = new Date(Date.now() - 864e5); return x.toDateString() === t.toDateString() ? '오늘' : x.toDateString() === y.toDateString() ? '어제' : dateStr(x); };
const whenText = d => `${dayText(d)} ${ampm(d)}`;
const freshPk = () => ({ place: parks[0]?.place || '', floor: null, spot: '', memo: '', blob: null, preview: '', saving: false });
const installTips = () => `${!isStandalone ? '<p class="fine" style="text-align:left;margin-top:12px"><a class="linkbtn" href="install.html">설치·알림 켜는 방법 자세히 보기</a></p>' : ''}${isIOS && !isStandalone ? `<div class="tipbox"><b>아이폰은 먼저 홈 화면에 추가해 주세요.</b><br>Safari 아래쪽 공유 버튼(□↑) → 홈 화면에 추가 → 홈 화면의 저기요 아이콘으로 열어야 알림을 받을 수 있어요.</div>` : ''}
  ${!isIOS && !isStandalone && !deferredInstall ? '<div class="tipbox">크롬 메뉴(⋮) → 홈 화면에 추가로 설치하면 앱처럼 쓰고 알림도 받아요.</div>' : ''}`;
/* 요청자가 전화할 번호 (0507 안심번호 권유) */
const phoneBlock = (p, phone, none) => `
  <button class="opt${!none ? ' on' : ''}" data-act="${p}-call" data-k="call"><b>전화 받기</b><p>요청자가 '전화 걸기'를 누르면 이 번호로 연결돼요</p></button>
  ${!none ? `<input class="fi" id="${p}-phone" type="tel" inputmode="numeric" maxlength="14" placeholder="0507-1234-5678 또는 010-1234-5678" value="${esc(phone)}" autocomplete="tel">
    <div class="tipbox"><b>0507 안심번호를 권해요.</b><br>무료로 발급받은 0507 번호를 넣으면 요청자 통화 기록에 내 실제 번호가 남지 않아요.</div>` : ''}
  <button class="opt${none ? ' on' : ''}" data-act="${p}-call" data-k="none"><b>전화 받지 않기</b><p>전화 걸기 버튼이 꺼지고 메시지로만 연락받아요</p></button>`;

const W = {
  /* 로그인 전 / 차량 없음 */
  welcome: () => {
    if (me) return `<div class="welcome">
      <img class="logo big" src="icons/icon-512.png?v=2" alt="">
      <h1 class="wm big">저기요</h1>
      <p class="lead">${esc(prof.name || googleName() || '')}${prof.name || googleName() ? '님, ' : ''}반가워요<br>내 차를 등록하고 QR 스티커를 받아요</p>
      <div class="tipbox">가족 차량을 함께 쓰거나 렌트·대리로 잠시 운전한다면, 차주에게 받은 <b>초대 링크</b>를 눌러 주세요.</div>
      ${installTips()}
      <div class="spacer"></div>
      <button class="btn primary" data-act="signup">내 차량 등록하기</button>
      <p class="fine"><button class="linkbtn" data-act="logout">로그아웃</button> · <button class="linkbtn" data-act="del-account">계정 탈퇴</button></p>
    </div>`;
    return `<div class="welcome">
      <img class="logo big" src="icons/icon-512.png?v=2" alt="">
      <h1 class="wm big">저기요</h1>
      <p class="lead">QR 스티커 하나로<br>주차 이동 요청과 사고 알림을 받아요</p>
      <ul>
        <li>답할 때까지 알림이 반복돼요</li>
        <li>메시지는 번호 없이, 전화는 0507 안심번호로도 받아요</li>
        <li>가족·공동차주와 차량을 함께 관리해요</li>
      </ul>
      ${joinCode ? '<div class="tipbox"><b>차량 함께 쓰기 초대를 받으셨어요.</b><br>구글 계정으로 로그인하면 바로 참여할 수 있어요.</div>' : ''}
      ${legacy ? '<div class="tipbox"><b>이제 구글 계정으로 로그인해요.</b><br>아래 버튼으로 구글 계정을 연결하면 등록한 차량과 기록이 그대로 옮겨져요.</div>' : ''}
      ${installTips()}
      <div class="spacer"></div>
      ${deferredInstall ? '<button class="btn ghost" data-act="install">홈 화면에 설치</button>' : ''}
      ${legacy ? '<button class="btn primary" data-act="link-google">구글 계정 연결하기</button>'
        : '<button class="btn primary" data-act="google">구글 계정으로 시작하기</button>'}
      ${DEV ? '<button class="btn soft sm" data-act="dev-anon">개발용: 익명으로 시험 (내 PC에서만 보임)</button>' : ''}
      <p class="fine">로그인하면 휴대폰을 바꿔도 내 차량을 그대로 쓸 수 있어요.<br>시험판입니다. 입력한 정보는 시험이 끝나면 삭제돼요.<br><a class="linkbtn" href="home.html">저기요 소개</a> · <a class="linkbtn" href="terms.html">이용약관</a> · <a class="linkbtn" href="privacy.html">개인정보처리방침</a></p>
    </div>`;
  },

  idle: () => {
    const said = statusLines(), last = parks[0], mm = myMem(), o = others[0];
    const recvLine = (car.recv === me.id ? `나${mm.name ? ' (' + esc(mm.name) + ')' : ''}` : car.recv_role === 'temp' ? `임시 운전자 ${esc(car.recv_name || '')}` : esc(car.recv_name || '다른 사용자'))
      + (car.recv_role === 'temp' ? ` · ${endText((members.find(m => m.uid === car.recv) || {}).ends_at || car.my_ends)}까지` : '');
    const liveCount = members.filter(liveMem).length;
    return `${OBAR(carChip())}
      ${car.my_role === 'temp' ? `<div class="hint"><b>임시 운전자</b>로 ${endText(car.my_ends)}까지 이 차에 온 연락을 받아요. 연락 내역은 본 차주도 볼 수 있어요.</div>` : ''}
      <div class="carline" style="margin-top:14px">${plateHTML(car.plate, 'mid')}<span>${esc(car.color || '')} ${esc(car.kind || '')}</span></div>
      <h2 class="big">이동주차 요청 내역이 없어요</h2>
      ${o ? `<div class="hint">${esc(nameOfUid(o.handler))}님이 요청을 받고 있어요 · ${esc(headOf(o))} <button class="linkbtn" data-act="tab" data-k="records">기록 보기</button></div>` : ''}
      ${pState === 'on' ? '' : `<div class="hint">폰 알림이 꺼져 있어요. 이 화면을 닫으면 요청을 못 받아요. <button class="linkbtn" data-act="enable-push">알림 켜기</button></div>`}
      <button class="pcard" data-act="tab" data-k="parking">${last
        ? `<span class="k">최근 주차 · ${whenText(last.created_at)}</span><span class="v">${esc(parkWhere(last) || '위치 메모 없음')}</span>${purls[last.photo_key] ? `<img src="${purls[last.photo_key]}" alt="">` : ''}`
        : `<span class="k">주차기록</span><span class="v">세운 곳을 남겨 두면 나중에 찾기 쉬워요</span>`}</button>
      <div class="setrow" style="margin-top:14px"><div><span class="k">지금 연락 받는 사람</span><span class="v">${recvLine}</span></div>
        ${isFull() && car.recv !== me.id && car.recv_role !== 'temp' ? '<button data-act="take-recv">내가 받기</button>' : ''}</div>
      ${isFull() ? `<div class="setrow"><div><span class="k">함께 쓰는 사람</span><span class="v">${liveCount}명${liveCount > 1 ? ' · 요청은 받는 사람 1명에게만 가요' : ''}</span></div><button data-act="members">관리</button></div>` : ''}
      <div class="setrow"><div><span class="k">요청자에게 남긴 말</span><span class="v${said.length ? ' voice' : ''}">${said.length ? said.map(t => '“' + esc(t) + '”').join('<br>') : '없음'}</span></div><button data-act="open-status">바꾸기</button></div>
      <div class="setrow"><div><span class="k">내 전화 연결 번호</span><span class="v">${CALL_LABEL[mm.call_type] || ''}${mm.call_type === 'none' ? '' : ' ' + esc(mm.phone || '')}</span></div><button data-act="open-set">바꾸기</button></div>
      <div class="spacer"></div>
      <button class="btn primary" data-act="sticker">내 QR 스티커</button>
      <button class="btn ghost" data-act="test-push">알림 시험</button>
      <p class="fine">
        ${car.my_role === 'owner' ? '<button class="linkbtn" data-act="car-edit">차를 바꿨어요 (QR 그대로)</button> · <button class="linkbtn" data-act="car-del">이 차량 삭제</button>'
          : '<button class="linkbtn" data-act="car-leave">이 차량에서 나가기</button>'}<br>
        <button class="linkbtn" data-act="logout">로그아웃</button> · <button class="linkbtn" data-act="del-account">계정 탈퇴</button>
      </p>
      ${NAV('home')}`;
  },

  /* 주차기록: 글자는 서버, 사진은 기록한 사람 폰에만 */
  parking: () => {
    const places = [...new Set(parks.map(p => p.place).filter(Boolean))].slice(0, 4), shared = members.filter(liveMem).length > 1;
    let lastDay = '';
    const list = parks.map(p => {
      const d = dayText(p.created_at), head = d !== lastDay ? `<div class="pday">${d}</div>` : ''; lastDay = d;
      return `${head}<button class="plog" data-act="pk-open" data-id="${p.id}">
        <span class="t">${hhmm(p.created_at)}</span>
        <span class="tx"><b>${esc(parkWhere(p) || '위치 메모 없음')}</b>${p.memo ? `<span>${esc(p.memo)}</span>` : ''}${shared && p.owner !== me.id ? `<span>${esc(nameOfUid(p.owner))}님 기록</span>` : ''}</span>
        ${p.photo_key && purls[p.photo_key] ? `<img src="${purls[p.photo_key]}" alt="">` : p.photo_key ? '<span class="nophoto">사진 없음</span>' : ''}</button>`;
    }).join('');
    return `${OBAR(carChip())}
      <h2 class="big" style="margin-top:8px">지금 세운 곳 남기기</h2>
      <div class="h">주차장</div>
      ${places.length ? `<div class="floors">${places.map(pl => `<button class="fl${pk.place === pl ? ' on' : ''}" data-act="pk-place" data-k="${esc(pl)}">${esc(pl)}</button>`).join('')}</div>` : ''}
      <input class="fi" id="pk-place" maxlength="30" placeholder="주차장 이름 (예: 회사 지하주차장)" value="${esc(pk.place)}" autocomplete="off">
      <div class="h">층</div>
      <div class="floors">${FLOORS.map(f => `<button class="fl${pk.floor === f ? ' on' : ''}" data-act="pk-floor" data-k="${f}">${f}</button>`).join('')}</div>
      <input class="zone" id="pk-spot" maxlength="20" placeholder="상세위치 (기둥 번호 등)" value="${esc(pk.spot)}" autocomplete="off">
      <input class="fi" id="pk-memo" maxlength="60" placeholder="메모 (선택)" value="${esc(pk.memo)}" autocomplete="off">
      <div class="photos" id="pk-photos">${pk.preview ? `<div class="ph"><img src="${pk.preview}" alt="주차 사진"><button class="x" data-act="pk-rmphoto" aria-label="사진 빼기">✕</button></div>`
        : '<label class="ph add">사진<br>찍기<input type="file" id="pk-file" accept="image/*" capture="environment" hidden></label>'}</div>
      <p class="fine" style="text-align:left">사진은 이 폰에만 저장돼요. 앱을 지우거나 브라우저 기록을 지우면 사진도 사라져요.${shared ? ' 함께 쓰는 사람에게는 글만 보여요.' : ''}</p>
      <button class="btn primary" data-act="pk-save" id="pk-save"${pk.saving ? ' disabled' : ''}>${pk.saving ? '저장하는 중' : '기록 남기기'}</button>
      <div class="h" style="margin-top:28px">지난 기록</div>
      ${parks.length ? `<div class="plist">${list}</div>` : '<p class="lead" style="margin-top:0">아직 주차기록이 없어요</p>'}
      ${NAV('parking')}`;
  },

  /* 요청 받음: 화면 전체가 초록(긴급은 빨강)으로 바뀜 */
  ring: () => {
    const u = active.level === 'urgent';
    const title = { move: active.feedback ? '직접 와 주셔야 해요' : '차를 빼 주실 수 있나요', acc: '내 차 사고 알림', bb: '블랙박스 영상 요청', etc: ETC[active.sub]?.t || '내 차 알림' }[active.kind];
    return `${OBAR('<span class="el" id="o-el">0:00</span>')}
      ${multiCarLine()}
      ${u ? '<p class="kicker">긴급</p>' : ''}
      <h2 class="big">${esc(title)}</h2>
      ${fbBanner()}
      ${detailCard(active, aUrls)}
      <div id="o-extra"></div>
      <div class="spacer"></div>
      ${replyBtns(active)}
      ${fwdBtn()}
      ${chatBtn()}`;
  },

  replied: () => {
    const rp = REP(active.reply) || { t: '', min: 0 };
    return `${OBAR()}
      ${multiCarLine()}
      <p class="kicker">${KIND_LABEL[active.kind]}</p>
      <h2 class="big">답장을 보냈어요</h2>
      ${sayHTML([rp.t])}
      ${active.reply === 'neutral' ? '<p class="lead">요청자가 밀어 본 뒤 결과를 알려 줄 거예요.</p>' : ''}
      ${rp.min ? `<div class="clock" id="o-cd">--:--</div><p class="lead">요청자에게 보이는 남은 시간</p>` : ''}
      ${active.kind === 'move' ? '' : detailCard(active, aUrls)}
      <div class="spacer"></div>
      ${chatBtn()}
      ${fwdBtn()}
      <button class="btn primary" data-act="resolve-req">해결 완료</button>
      <p class="fine">요청자가 확인하면 끝나요. 답이 없으면 5분 뒤 자동으로 완료돼요.</p>`;
  },

  resolving: () => `${OBAR()}
      ${multiCarLine()}
      <h2 class="big">요청자 확인을 기다리고 있어요</h2>
      <div class="clock" id="o-auto">05:00</div>
      <p class="lead">뒤에 자동으로 완료돼요</p>
      <div class="spacer"></div>
      ${chatBtn()}`,

  records: () => {
    const since = Date.now() - 30 * 24 * 3600e3, list = recs.filter(r => new Date(r.created_at) > since);
    const answered = list.filter(r => r.replied_at), rate = list.length ? Math.round(answered.length / list.length * 100) : 0;
    const avg = answered.length ? answered.reduce((s, r) => s + (new Date(r.replied_at) - new Date(r.created_at)), 0) / answered.length : 0;
    return `${OBAR(carChip())}
      <div class="h" style="margin-top:6px">요청기록 · 최근 30일</div>
      <div class="stats"><div><b>${list.length}</b><span>받은 요청</span></div><div><b>${rate}%</b><span>응답률</span></div><div><b>${answered.length ? secs(avg) : '-'}</b><span>평균 응답</span></div></div>
      ${car.my_role === 'temp' ? '<p class="muted" style="margin-top:8px">임시 운전자는 내가 받은 요청만 보여요.</p>' : ''}
      ${recordListHTML(recs)}
      ${NAV('records')}`;
  },
  record: () => `<div class="appbar"><button class="back" data-act="records" aria-label="뒤로">‹</button>기록 상세</div>
    ${rec.r.handler && members.length > 1 ? `<p class="muted" style="margin:2px 0 8px">받은 사람: ${esc(nameOfUid(rec.r.handler))}</p>` : ''}
    ${recordDetailHTML(rec.r, rec.msgs, 'o', car.plate, rec.urls)}`
};

function render(keepScroll) {
  const y = scrollY;
  let h, cls = 'app';
  if (!me || !car) h = W.welcome();
  else if (view === 'records' && !active) h = W.records();
  else if (view === 'parking' && !active) h = W.parking();
  else if (view === 'record' && rec && !active) h = W.record();
  else if (!active) h = W.idle();
  else if (active.status === 'ringing') { cls = active.level === 'urgent' ? 'app ring alert' : 'app ring'; h = W.ring(); }
  else if (active.status === 'resolving') h = W.resolving();
  else h = W.replied();
  APP.className = cls; APP.innerHTML = h;
  if (keepScroll) scrollTo(0, y);
  updateMsgs(); renderOv(); tick();
}
function updateMsgs() {
  const u = $('#o-unread'); if (u) { u.hidden = unread <= 0; u.textContent = unread; }
  const last = [...aMsgs].reverse().find(m => m.sender === 'r');
  setText('#o-last', last && active ? `${who()}: ${last.text}` : '');
  const ex = $('#o-extra'); if (ex) ex.innerHTML = aMsgs.filter(m => m.sender === 'r').slice(-3).map(m => `<div class="quote new">${esc(m.text)}</div>`).join('');
  const box = $('#chat-msgs');
  if (box && active) { const h = msgHTML(active, aMsgs, 'o', aUrls); if (box.dataset.h !== h) { box.dataset.h = h; box.innerHTML = h; box.scrollTop = box.scrollHeight; } }
}
function tick() {
  if (!active || view !== 'home') return;
  if (active.status === 'ringing') {
    const el = Date.now() - new Date(active.feedback_at || active.created_at).getTime();
    const iv = { urgent: 2000, normal: 3000, info: 20000 }[active.level] || 3000, c = Math.floor(el / iv);
    setText('#o-el', clock(el));
    if (c !== lastBuzz && !document.hidden) {
      lastBuzz = c;
      APP.classList.remove('buzz', 'hard'); void APP.offsetWidth; APP.classList.add('buzz'); if (active.level === 'urgent') APP.classList.add('hard');
      vib(active.level === 'urgent' ? [1000, 150, 1000] : [600, 200, 600]);
    }
  }
  if (active.status === 'replied') {
    const rp = REP(active.reply);
    if (rp?.min) { const rem = new Date(active.replied_at).getTime() + rp.min * 60000 - Date.now(); setText('#o-cd', rem > 0 ? mmss(rem) : '시간 지남'); }
  }
  if (active.status === 'resolving') setText('#o-auto', mmss(Math.max(0, new Date(active.resolve_req_at).getTime() + 5 * 60000 - Date.now())));
}

/* ---------- 겹쳐 뜨는 화면 ---------- */
/* 가입(첫 차량) 1~5단계, 차량 추가는 1·3·5단계만 */
const freshSu = add => ({ steps: add ? [1, 3, 5] : [1, 2, 3, 4, 5], i: 0, add, plate: '', kind: null, color: null, name: prof.name || googleName(),
  phone: '', codeSent: false, code: '', verified: false, agree: false, callPhone: prof.phone || '', callNone: !!prof.phone && prof.call_type === 'none',
  push: null, pushMsg: '', saving: false });
const sstep = () => su.steps[su.i];
const KINDS = ['승용', 'SUV', '승합', '트럭'], COLORS = ['흰색', '검정', '회색', '은색', '파랑', '빨강'];
const plateOK = v => /^\d{2,3}[가-힣]\d{4}$/.test(String(v).replace(/\s/g, ''));
const fmtPlate = v => { const t = String(v).replace(/\s/g, ''); return plateOK(t) ? t.slice(0, -4) + ' ' + t.slice(-4) : String(v).trim(); };
function suOK() {
  const s = sstep();
  if (s === 1) return plateOK(su.plate) && !!su.kind && !!su.color;
  if (s === 2) return su.verified && su.agree && !!su.name.trim();
  if (s === 3) return !su.saving && (su.callNone || phoneOK(su.callPhone));
  if (s === 4) return !su.saving;
  return true;
}
const updSuBtn = () => { const b = $('#su-next'); if (b) b.disabled = !suOK(); };
const suKey = () => [su.i, su.codeSent, !!su.code, su.verified, su.callNone, su.push, su.pushMsg, su.kind, su.color, su.saving].join(',');
const SU_T = ['', '차량 등록', '본인 확인', '연락 방식', '알림 허용', '내 QR 스티커'];

function signupOv() {
  const s = sstep(), lastInput = su.steps[su.steps.length - 2];
  let b = '';
  if (s === 1) b = `
    <div class="h">차량번호</div>
    <input class="fi" id="su-plate" maxlength="12" placeholder="예: 12가 3456" value="${esc(su.plate)}" autocomplete="off">
    <div class="h">차종</div>
    <div class="chips c4">${KINDS.map(k => `<button class="chip${su.kind === k ? ' on' : ''}" data-act="su-kind" data-k="${k}">${k}</button>`).join('')}</div>
    <div class="h">색상</div>
    <div class="chips c3">${COLORS.map(k => `<button class="chip${su.color === k ? ' on' : ''}" data-act="su-color" data-k="${k}">${k}</button>`).join('')}</div>
    <p class="muted" style="margin-top:14px;line-height:1.5">요청자는 QR을 찍은 뒤 번호판의 가려진 숫자를 맞혀야 요청할 수 있어요. 같은 차량번호는 1번만 등록돼요.</p>
    ${su.add ? `<p class="muted" style="margin-top:6px">차량 ${ownCount() + 1}번째 등록 · 1인 최대 3대</p>` : ''}`;
  else if (s === 2) b = `
    <div class="h">이름 또는 별명</div>
    <input class="fi" id="su-name" maxlength="12" placeholder="예: 아빠, 홍길동 (함께 쓰는 사람에게 보여요)" value="${esc(su.name)}" autocomplete="off">
    <div class="h">휴대폰 번호</div>
    <div class="row"><input class="fi" id="su-phone" type="tel" inputmode="numeric" maxlength="13" placeholder="010-1234-5678" value="${esc(su.phone)}" autocomplete="tel"${su.verified ? ' disabled' : ''}>
      <button data-act="su-code" id="su-codebtn"${su.verified || su.phone.replace(/\D/g, '').length < 10 ? ' disabled' : ''}>${su.codeSent ? '다시 받기' : '인증번호 받기'}</button></div>
    ${su.codeSent && !su.verified ? `
      ${su.code ? `<div class="sms"><b>[저기요] 인증번호 ${su.code}</b><br><span class="muted">시험판이라 실제 문자 인증은 하지 않고, 번호를 이 창에 보여 드려요.</span></div>` : '<p class="muted" style="margin-top:10px">인증번호를 보내고 있어요…</p>'}
      <div class="row" style="margin-top:8px"><input class="fi" id="su-codein" inputmode="numeric" maxlength="6" placeholder="인증번호 6자리" value="${esc(su.code)}" autocomplete="one-time-code"><button data-act="su-verify">확인</button></div>` : ''}
    ${su.verified ? '<div class="okline">✓ 번호를 확인했어요 (시험판: 실제 문자 인증 없음)</div>' : ''}
    <label class="agree" style="margin-top:16px"><input type="checkbox" id="su-agree"${su.agree ? ' checked' : ''}> <span>(필수) <a class="linkbtn" href="terms.html" target="_blank">이용약관</a>과 <a class="linkbtn" href="privacy.html" target="_blank">개인정보처리방침</a>에 동의해요.<br>차량번호·휴대폰 번호는 연락 연결에만 쓰이고, 시험이 끝나면 삭제돼요.</span></label>`;
  else if (s === 3) b = `<p class="muted" style="line-height:1.5">요청자가 '전화 걸기'를 누르면 이 번호가 요청자 폰에 자동으로 입력돼요.</p>${phoneBlock('sc', su.callPhone, su.callNone)}`;
  else if (s === 4) b = `
    <p class="muted" style="line-height:1.5">요청이 왔을 때 놓치지 않도록 폰 알림을 허용해 주세요. 앱을 닫아 둬도 답할 때까지 알림이 반복돼요.</p>
    ${isIOS && !isStandalone ? '<div class="warnbox">아이폰은 <b>홈 화면에 추가한 저기요 앱</b>에서만 알림을 켤 수 있어요.</div>' : ''}
    <div class="perm"><div class="tx"><b>알림 허용</b><p>요청·사고·긴급 알림을 진동과 함께 받아요</p></div><button class="${su.push === 'on' ? 'on' : ''}" data-act="su-push">${su.push === 'on' ? '허용함 ✓' : '허용하기'}</button></div>
    ${su.push === 'on' ? '<div class="perm"><div class="tx"><b>알림 시험</b><p>지금 이 폰으로 시험 알림을 보내 봐요</p></div><button data-act="test-push">보내기</button></div>' : ''}
    ${su.pushMsg ? `<div class="${su.push === 'on' ? 'okline' : 'errline'}">${esc(su.pushMsg)}</div>` : ''}
    <div class="hint">회의 중에도 받으려면 폰의 <b>방해금지 모드 예외 앱</b>에 ${isIOS ? '저기요' : '크롬'}을 넣어 두세요.</div>`;
  else b = `<p class="muted center" style="line-height:1.5">등록이 끝났어요! 이 QR 스티커를 인쇄해서<br>차량 앞·뒤쪽, 밖에서 잘 보이는 곳에 붙여 주세요.</p>
    ${stickerHTML(carUrl())}
    <button class="btn primary" data-act="sticker-pdf" style="margin-top:14px">인쇄용 PDF 받기 (명함 크기 4장)</button>
    <button class="btn soft" data-act="sticker-dl">스티커 이미지 저장</button>
    <p class="muted center" style="font-size:12px;margin-top:8px;line-height:1.5">QR은 이 차량에 고정이에요. 나중에 차를 바꿔도 같은 QR을 쓸 수 있어요.</p>`;
  const next = s === 5 ? '시작하기' : s === lastInput ? (su.saving ? '저장 중…' : '등록하고 QR 받기') : '다음';
  return `<div class="ov">
    <div class="ov-h">${s < 5 ? '<button class="back" data-act="su-back" aria-label="뒤로">‹</button>' : ''}<b>${SU_T[s]}</b><span class="stepno">${su.i + 1}/${su.steps.length}</span></div>
    <div class="prog"><i style="width:${(su.i + 1) / su.steps.length * 100}%"></i></div>
    <div class="ov-body">${b}</div>
    <div class="ov-foot"><button class="btn primary" id="su-next" data-act="su-next"${suOK() ? '' : ' disabled'}>${next}</button></div>
  </div>`;
}
function stickerOv() {
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>내 QR 스티커</b><div class="muted">${esc(car.plate)} 전용 · 차량마다 1개 고정</div></div></div>
    <div class="ov-body">${stickerHTML(carUrl())}<div class="urlbox">${esc(carUrl())}</div>
      <button class="btn primary" data-act="sticker-pdf">인쇄용 PDF 받기 (명함 크기 4장)</button>
      <p class="muted center" style="font-size:12px;margin-top:6px;line-height:1.5">공유 창에서 Gmail을 고르면 내 메일로 보낼 수 있어요</p>
      <button class="btn soft" data-act="sticker-dl">스티커 이미지 저장</button>
      <button class="btn ghost" data-act="copy" data-t="${esc(carUrl())}">주소 복사</button>
      <p class="muted center" style="margin-top:10px;line-height:1.5;font-size:12px">인쇄해서 차량 앞·뒤쪽, 밖에서 잘 보이는 곳에 붙여 주세요.</p></div></div>`;
}
/* 내 이름·전화 연결 번호 */
function setOv() {
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>내 이름 · 전화 연결 번호</b><div class="muted">내가 연결된 모든 차량에 적용돼요</div></div></div>
    <div class="ov-body">
      <div class="h">이름 또는 별명</div>
      <input class="fi" id="st-name" maxlength="12" placeholder="예: 아빠, 홍길동" value="${esc(st.name)}" autocomplete="off">
      <div class="h">요청자가 전화할 번호</div>
      ${phoneBlock('st', st.phone, st.none)}
      <button class="btn primary" data-act="st-save">저장</button>
    </div></div>`;
}
function statusOv() {
  const d = sd, sel = k => (d.code || 'none') === k;
  const preview = statusText({ status_code: d.code, status_min: d.min, status_until: d.until, status_text: d.text, status_at: new Date().toISOString() });
  const opt = (k, title, desc) => `<button class="opt${sel(k) ? ' on' : ''}" data-act="sd-code" data-k="${k}"><b>${title}</b>${desc ? `<p>${desc}</p>` : ''}</button>`;
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>요청자에게 남길 말</b><div class="muted">QR을 찍으면 가장 먼저 보여요</div></div></div>
    <div class="ov-body">
      <p class="muted" style="line-height:1.55">요청자가 마음 편히 연락할 수 있게, 지금 얼마나 빨리 올 수 있는지 알려 주세요.</p>
      ${opt('near', '가까이 있어요', '○분 거리에 있어요. 연락 주시면 바로 갈게요')}
      ${sel('near') ? `<div class="chips c4" style="margin-top:8px">${NEAR_MIN.map(m => `<button class="chip${d.min === m ? ' on' : ''}" data-act="sd-min" data-k="${m}">${m}분</button>`).join('')}</div>` : ''}
      ${opt('meeting', '회의·업무 중이에요', '○시까지 회의 중이라 확인이 늦을 수 있어요. 연락 주시면 빨리 올게요')}
      ${sel('meeting') ? `<div class="row" style="margin-top:8px"><span style="align-self:center;font-size:14px;font-weight:700;flex:none">끝나는 시각</span><input class="fi" id="sd-until" type="time" value="${esc(d.until || '')}"></div>` : ''}
      ${opt('custom', '직접 쓰기', '하고 싶은 말을 40자 안에서 남겨요')}
      ${sel('custom') ? `<input class="fi" id="sd-text" maxlength="40" placeholder="예: 점심 먹는 중이에요. 연락 주시면 10분 안에 갈게요" value="${esc(d.text || '')}" autocomplete="off">` : ''}
      ${opt('none', '남기지 않기', '')}
      <div class="ownerstat" id="sd-prev"${preview ? '' : ' hidden'}><div style="font-size:12px;color:var(--sub);margin-bottom:2px">요청자에게 이렇게 보여요</div>“<span id="sd-prev-t">${esc(preview)}</span>”</div>
      <button class="btn primary" data-act="save-status">저장</button>
      <p class="muted" style="font-size:12px;margin-top:8px;line-height:1.5">'가까이 있어요'와 직접 쓴 말은 12시간 뒤, '회의 중'은 끝나는 시각이 지나면 자동으로 사라져요.</p>
      <div class="h">출차 예고</div>
      <div class="row"><input class="fi" id="leave-at" type="time" value="${esc(car.leave_at || '')}"><button data-act="set-leave">저장</button></div>
      ${leaveText(car) ? `<p class="muted" style="margin-top:6px">${esc(leaveText(car))} <button class="linkbtn" data-act="clear-leave">지우기</button></p>` : '<p class="muted" style="margin-top:6px">"○시에 나가요"를 요청자에게 미리 보여 줘요</p>'}
    </div></div>`;
}
/* 내 차량 목록 · 전환 · 추가 */
function carsOv() {
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>내 차량</b><div class="muted">요청이 오면 그 차량 화면이 자동으로 열려요</div></div></div>
    <div class="ov-body">
      <div class="list">${cars.map(c => `<button class="li${c.id === car.id ? ' on' : ''}" data-act="car-pick" data-id="${c.id}">
        <span class="tx"><span class="t">${esc(c.plate)}</span><span class="s">${esc(c.color || '')} ${esc(c.kind || '')} · ${ROLE_LABEL[c.my_role]}${c.my_role === 'temp' ? ' · ' + endText(c.my_ends) + '까지' : ''}</span></span>
        ${c.id === car.id ? '<span class="st">보는 중</span>' : ''}</button>`).join('')}</div>
      ${ownCount() < 3 ? `<button class="btn soft" data-act="car-add">차량 추가 (${ownCount()}/3)</button>` : '<p class="muted" style="margin-top:12px">차량은 1인 최대 3대까지 등록할 수 있어요.</p>'}
      <p class="muted" style="margin-top:10px;line-height:1.5">QR 스티커는 차량마다 1개씩이에요. 공동차주로 초대받은 차량도 3대 안에 포함돼요(임시 운전자는 제외).</p>
    </div></div>`;
}
/* 함께 쓰는 사람 · 초대 */
function membersOv() {
  const owner = car.my_role === 'owner';
  const rows = members.filter(liveMem).map(m => {
    const isRecv = m.uid === car.recv;
    return `<div class="mrow"><div><b>${esc(m.name || ROLE_LABEL[m.role])}${m.uid === me.id ? ' (나)' : ''}${isRecv ? '<span class="recv">받는 중</span>' : ''}</b>
      <span>${ROLE_LABEL[m.role]}${m.role === 'temp' ? ' · ' + endText(m.ends_at) + '까지' : ''}</span></div>
      ${m.role !== 'temp' && !isRecv && car.recv_role !== 'temp' ? `<button class="linkbtn" data-act="set-recv" data-u="${m.uid}">받는 사람으로</button>` : ''}
      ${owner && m.uid !== me.id ? `<button class="linkbtn" data-act="mem-rm" data-u="${m.uid}">${m.role === 'temp' ? '지금 끝내기' : '내보내기'}</button>` : ''}</div>`;
  }).join('');
  const invBox = () => {
    const url = inviteUrl(inv.code);
    return `<div class="h">${inv.role === 'co' ? '공동차주' : '임시 운전자'} 초대 링크</div>
      <div class="invqr">${qrSVG(url, 'qrbig')}</div>
      <div class="urlbox">${esc(url)}</div>
      <button class="btn primary" data-act="inv-share">링크 보내기</button>
      <button class="btn ghost" data-act="copy" data-t="${esc(url)}">링크 복사</button>
      <p class="muted center" style="margin-top:10px;line-height:1.5">24시간 안에 1번만 쓸 수 있어요. 받는 분은 구글 계정으로 로그인해서 참여해요.${inv.role === 'temp' ? `<br><b>${endText(inv.ends)}까지</b> 이 분이 연락을 받아요.` : ''}<br>상대 폰 카메라로 위 QR을 찍어도 돼요.</p>
      <p class="center"><button class="linkbtn" data-act="inv-done">다른 초대 만들기</button></p>`;
  };
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>함께 쓰는 사람</b><div class="muted">${esc(car.plate)}</div></div></div>
    <div class="ov-body">
      <div class="mlist">${rows}</div>
      <p class="muted" style="margin-top:10px;line-height:1.55">요청은 <b>받는 사람 1명</b>에게만 가요. 공동차주는 이 차의 요청·주차기록을 모두 볼 수 있고, 받은 요청을 다른 공동차주에게 넘길 수 있어요.</p>
      ${inv ? invBox() : `
      <div class="h">공동차주 초대</div>
      <p class="muted" style="line-height:1.5">가족처럼 이 차를 함께 쓰는 사람</p>
      <button class="btn soft sm" data-act="inv-co">공동차주 초대 링크 만들기</button>
      <div class="h">임시 운전자 초대</div>
      <p class="muted" style="line-height:1.5">렌트·차 빌려주기 등. 정한 시각까지 이 분이 연락을 받고, 그동안의 연락 내역은 본 차주·공동차주도 볼 수 있어요. 시간이 지나면 자동으로 끝나요.</p>
      <div class="row" style="margin-top:6px"><span style="align-self:center;font-size:14px;font-weight:700;flex:none">끝나는 시각</span><input class="fi" id="inv-ends" type="datetime-local" value="${esc(invEnds)}"></div>
      <button class="btn soft sm" data-act="inv-temp">임시 운전자 초대 링크 만들기</button>`}
    </div></div>`;
}
/* 초대 수락 */
function joinOv() {
  const i = join.info, bad = { used: '이미 사용된 초대예요. 초대한 분께 새 링크를 부탁해 주세요.', expired: '기간이 지난 초대예요. 초대한 분께 새 링크를 부탁해 주세요.', notfound: '초대를 찾을 수 없어요. 링크를 다시 확인해 주세요.' }[i.status];
  const body = bad ? `<div class="warnbox">${bad}</div>` : `
    <p class="lead" style="margin-top:0">${esc(i.inviter || '차주')}님이 <b>${i.role === 'co' ? '공동차주' : '임시 운전자'}</b>로 초대했어요</p>
    <div class="carline" style="margin-top:10px">${plateHTML(i.plate, 'mid')}<span>${esc(i.color || '')} ${esc(i.kind || '')}</span></div>
    ${i.role === 'temp' ? `<div class="hint"><b>${endText(i.ends_at)}까지</b> 이 차에 온 연락을 내가 받아요. 그동안의 연락 내역은 본 차주도 볼 수 있고, 시간이 지나면 자동으로 끝나요.</div>`
      : `<div class="hint">이 차의 요청·주차기록을 함께 보고, '받는 사람'을 나로 바꿔 연락을 받을 수 있어요.</div>`}
    <div class="h">이름 또는 별명</div>
    <input class="fi" id="jn-name" maxlength="12" placeholder="예: 엄마, 홍길동" value="${esc(join.name)}" autocomplete="off">
    <div class="h">요청자가 전화할 번호</div>
    ${phoneBlock('jn', join.phone, join.none)}
    ${pState === 'on' ? '' : `<div class="perm"><div class="tx"><b>알림 허용</b><p>연락이 오면 진동과 함께 알려 드려요</p></div><button data-act="jn-push">허용하기</button></div>${isIOS && !isStandalone ? '<div class="warnbox">아이폰은 홈 화면에 추가한 저기요 앱에서만 알림을 켤 수 있어요.</div>' : ''}`}`;
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><b>차량 함께 쓰기</b></div>
    <div class="ov-body">${body}</div>
    <div class="ov-foot">${bad ? '<button class="btn ghost" data-act="close-ov">닫기</button>'
      : `<button class="btn primary" data-act="jn-ok"${join.saving ? ' disabled' : ''}>${join.saving ? '참여하는 중…' : '참여하기'}</button>`}</div></div>`;
}
/* 받은 요청 넘기기 */
function fwdOv() {
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>누구에게 넘길까요?</b><div class="muted">${esc(headOf(active))}</div></div></div>
    <div class="ov-body">
      <p class="muted" style="line-height:1.55">넘기면 그 사람 폰이 바로 울리고, 나는 이 요청을 더 받지 않아요. 대화 기록은 함께 볼 수 있어요.</p>
      ${fwdTargets().map(m => `<button class="opt" data-act="fwd-to" data-u="${m.uid}"><b>${esc(m.name || ROLE_LABEL[m.role])}</b><p>${ROLE_LABEL[m.role]}${m.uid === car.recv ? ' · 지금 받는 사람' : ''}</p></button>`).join('')}
    </div></div>`;
}
/* 차를 바꿨을 때: QR은 그대로, 차량 정보만 */
function carEditOv() {
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>차를 바꿨어요</b><div class="muted">QR 스티커는 그대로 써요</div></div></div>
    <div class="ov-body">
      <p class="muted" style="line-height:1.55">새 차 정보로 바꾸면 붙여 둔 QR이 새 차로 연결돼요. 지난 요청·주차기록과 함께 쓰는 사람은 그대로 남아요.</p>
      <div class="h">차량번호</div>
      <input class="fi" id="ce-plate" maxlength="12" placeholder="예: 12가 3456" value="${esc(ce.plate)}" autocomplete="off">
      <div class="h">차종</div>
      <div class="chips c4">${KINDS.map(k => `<button class="chip${ce.kind === k ? ' on' : ''}" data-act="ce-kind" data-k="${k}">${k}</button>`).join('')}</div>
      <div class="h">색상</div>
      <div class="chips c3">${COLORS.map(k => `<button class="chip${ce.color === k ? ' on' : ''}" data-act="ce-color" data-k="${k}">${k}</button>`).join('')}</div>
      <button class="btn primary" data-act="ce-save">저장</button>
    </div></div>`;
}
function curOvKey() {
  if (ov === 'signup') return 'signup|' + suKey();
  if (ov === 'set') return 'set|' + st.none;
  if (ov === 'status') return 'status|' + JSON.stringify(sd) + '|' + car.leave_at + '|' + car.leave_set_at;
  if (ov === 'photo') return 'photo' + photoI;
  if (ov === 'park') return 'park' + (pkOpen?.id || '');
  if (ov === 'chat') return 'chat|' + (active?.id || '') + '|' + freeInput;
  if (ov === 'cars') return 'cars|' + car?.id + '|' + cars.length;
  if (ov === 'members') return 'members|' + (inv?.code || '') + '|' + members.map(m => m.uid).join() + '|' + car?.recv;
  if (ov === 'join') return 'join|' + join?.none + '|' + join?.saving + '|' + pState;
  if (ov === 'fwd') return 'fwd|' + (active?.id || '');
  if (ov === 'caredit') return 'caredit|' + ce.kind + '|' + ce.color;
  return ov || '';
}
function renderOv(force) {
  if ((ov === 'chat' || ov === 'fwd') && !active) ov = null;
  if (['sticker', 'set', 'status', 'cars', 'members', 'caredit'].includes(ov) && !car) ov = null;
  const k = curOvKey(); if (!force && k === ovKey) return; ovKey = k;
  OV.innerHTML = ov === 'signup' ? signupOv() : ov === 'sticker' ? stickerOv() : ov === 'set' ? setOv() : ov === 'status' ? statusOv() : ov === 'park' && pkOpen ? parkOv()
    : ov === 'chat' ? chatOvHTML(`${whoWith()} 메시지`, `${KIND_LABEL[active.kind]}, 메시지에는 번호가 보이지 않아요`, QUICK_OF(active, 'o'), freeInput)
    : ov === 'photo' ? photoOvHTML(photoList, photoI) : ov === 'cars' ? carsOv() : ov === 'members' ? membersOv()
    : ov === 'join' ? joinOv() : ov === 'fwd' ? fwdOv() : ov === 'caredit' ? carEditOv() : '';
  if (ov === 'chat') { unread = 0; updateMsgs(); }
}

/* ---------- 동작 ---------- */
async function createCar() {
  su.saving = true; renderOv(true);
  const { data, error } = await sb.from('cars').insert({
    plate: fmtPlate(su.plate), kind: su.kind, color: su.color,
    phone: su.callNone ? null : su.callPhone, call_type: su.callNone ? 'none' : callTypeOf(su.callPhone), perm_noti: su.push === 'on'
  }).select().single();
  if (error) { su.saving = false; toast('저장하지 못했어요: ' + errText(error), 4500); renderOv(true); return; }
  await sb.rpc('update_my_member', { cid: data.id, nm: su.name || prof.name || '', ph: null, ct: null });
  await loadCars(data.id); subscribe();
  su.saving = false; su.i = su.steps.indexOf(5); renderOv(true);
}
async function afterCarsChange(pick) {
  await loadCars(pick);
  if (car) { await loadActive(); subscribe(); } else { if (chan) sb.removeChannel(chan); chan = null; clearActive(); }
  view = 'home'; ov = null; render(); scrollTo(0, 0);
  if (car) loadParks().then(() => { if (!active && view === 'home') render(); });
}
async function updActive(patch, sysText) {
  const { data, error } = await sb.from('requests').update(patch).eq('id', active.id).select().maybeSingle();
  if (error) { toast('저장하지 못했어요: ' + error.message); return null; }
  if (sysText) await sb.from('messages').insert({ request_id: active.id, sender: 'sys', text: sysText });
  return data;
}
async function doReply(k, fromNoti) {
  if (!active || active.status !== 'ringing') return;
  vib(0);
  const data = await updActive({ status: 'replied', reply: k, replied_at: active.replied_at || new Date().toISOString() });
  if (!data) return;
  active = data; render();
  if (fromNoti) toast(`“${REP(k).t}” 답장을 보냈어요`);
}
async function resolveReq() {
  if (!active) return;
  const data = await updActive({ status: 'resolving', resolve_req_at: new Date().toISOString() });
  if (data) { active = data; render(); toast('요청자에게 해결 확인을 보냈어요'); }
}
async function forwardTo(uid) {
  if (!active) return;
  const rid = active.id, name = nameOfUid(uid);
  const { error } = await sb.rpc('forward_request', { rid, to_uid: uid });
  if (error) { toast('넘기지 못했어요: ' + errText(error)); return; }
  notify('fwd', rid);
  clearActive(); ov = null; toast(`${name}님에게 넘겼어요. ${name}님 폰이 울려요`, 3500);
  await loadActive(); render();
}
async function saveStatus() {
  if (sd.code === 'meeting' && !sd.until) { toast('회의가 끝나는 시각을 골라 주세요'); return; }
  if (sd.code === 'custom' && !String(sd.text || '').trim()) { toast('남길 말을 적어 주세요'); return; }
  const patch = { status_code: sd.code, status_min: sd.code === 'near' ? (sd.min || 5) : null, status_until: sd.code === 'meeting' ? sd.until : null, status_text: sd.code === 'custom' ? sd.text.trim() : null, status_at: new Date().toISOString() };
  const { data, error } = await sb.from('cars').update(patch).eq('id', car.id).select().single();
  if (error) { toast('저장하지 못했어요: ' + error.message); return; }
  Object.assign(car, data); ov = null; toast(sd.code ? '남길 말을 저장했어요' : '남긴 말을 지웠어요'); render();
}
async function saveMe() {
  if (!st.name.trim()) { toast('이름이나 별명을 적어 주세요'); return; }
  if (!st.none && !phoneOK(st.phone)) { toast('전화번호를 확인해 주세요'); return; }
  for (const c of cars) {
    const { error } = await sb.rpc('update_my_member', { cid: c.id, nm: st.name, ph: st.none ? '' : st.phone, ct: st.none ? 'none' : callTypeOf(st.phone) });
    if (error) { toast('저장하지 못했어요: ' + errText(error)); return; }
  }
  await loadCars(); ov = null; toast('저장했어요'); render();
}
async function makeInvite(role) {
  let ends = null;
  if (role === 'temp') {
    if (!invEnds) { toast('끝나는 시각을 골라 주세요'); return; }
    ends = new Date(invEnds);
    if (!(ends > Date.now() + 10 * 60000)) { toast('끝나는 시각은 10분 뒤부터 골라 주세요'); return; }
  }
  const { data, error } = await sb.rpc('create_invite', { cid: car.id, r: role, ends: ends ? ends.toISOString() : null });
  if (error || !data) { toast('초대를 만들지 못했어요: ' + errText(error)); return; }
  inv = { code: data, role, ends }; renderOv();
}
async function openJoin(code) {
  const { data, error } = await sb.rpc('invite_info', { k: code });
  joinCode = null;
  const u = new URL(location.href); u.searchParams.delete('join'); history.replaceState(null, '', u.pathname + u.search);
  const info = data?.[0];
  if (error || !info) { toast('초대 정보를 불러오지 못했어요'); return; }
  if (info.status === 'member') { await loadCars(info.car_id); toast('이미 함께 쓰고 있는 차량이에요'); return; }
  join = { code, info, name: prof.name || googleName(), phone: prof.phone || '', none: !!prof.phone && prof.call_type === 'none', saving: false };
  ov = 'join';
}
async function acceptJoin() {
  if (!join.name.trim()) { toast('이름이나 별명을 적어 주세요'); return; }
  if (!join.none && !phoneOK(join.phone)) { toast('전화번호를 확인해 주세요'); return; }
  join.saving = true; renderOv();
  const { data, error } = await sb.rpc('accept_invite', { k: join.code, nm: join.name, ph: join.none ? '' : join.phone, ct: join.none ? 'none' : callTypeOf(join.phone) });
  join.saving = false;
  if (error) { toast('참여하지 못했어요: ' + errText(error), 4500); renderOv(true); return; }
  const role = join.info.role; join = null;
  await afterCarsChange(data);
  toast(role === 'temp' ? '참여했어요. 정한 시각까지 이 차의 연락을 받아요' : "참여했어요. '내가 받기'를 누르면 연락을 받아요", 4000);
}
async function loadParks() {
  const { data } = await sb.from('parking_logs').select('*').eq('car_id', car.id).order('created_at', { ascending: false }).limit(60);
  parks = data || [];
  for (const p of parks) if (p.photo_key && !(p.photo_key in purls)) {
    try { const b = await idb.get(p.photo_key); purls[p.photo_key] = b ? URL.createObjectURL(b) : ''; } catch (e) { purls[p.photo_key] = ''; }
  }
}
async function savePark() {
  if (!pk.place.trim() && !pk.floor && !pk.spot.trim() && !pk.memo.trim() && !pk.blob) { toast('주차장이나 위치를 적어 주세요'); return; }
  pk.saving = true; render(true);
  let key = null;
  if (pk.blob) { key = 'p-' + crypto.randomUUID(); try { await idb.put(key, pk.blob); purls[key] = URL.createObjectURL(pk.blob); } catch (e) { key = null; toast('이 폰에 사진을 저장하지 못했어요'); } }
  const { error } = await sb.from('parking_logs').insert({ car_id: car.id, place: pk.place.trim() || null, floor: pk.floor, spot: pk.spot.trim() || null, memo: pk.memo.trim() || null, photo_key: key });
  if (error) { pk.saving = false; if (key) idb.del(key).catch(() => { }); toast('저장하지 못했어요: ' + error.message); render(true); return; }
  await loadParks(); pk = freshPk(); toast('주차기록을 남겼어요'); render(); scrollTo(0, 0);
}
function parkOv() {
  const p = pkOpen, src = p.photo_key ? purls[p.photo_key] : '';
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>${whenText(p.created_at)}</b>${p.owner !== me.id ? `<div class="muted">${esc(nameOfUid(p.owner))}님 기록</div>` : ''}</div></div>
    <div class="ov-body">
      ${src ? `<img class="pbig" src="${src}" alt="주차 사진">` : p.photo_key ? `<p class="lead">${p.owner === me.id ? '이 폰에는 사진이 없어요' : '사진은 기록한 사람 폰에만 있어요'}</p>` : ''}
      <div class="info" style="margin-top:14px">
        <div><span>주차장</span><b>${esc(p.place || '-')}</b></div>
        <div><span>위치</span><b>${esc([p.floor, p.spot].filter(Boolean).join(' ') || '-')}</b></div>
        ${p.memo ? `<div><span>메모</span><b>${esc(p.memo)}</b></div>` : ''}
      </div>
      <div class="spacer"></div>
      ${p.owner === me.id || car.my_role === 'owner' ? '<button class="btn ghost" data-act="pk-del">이 기록 지우기</button>' : ''}
    </div></div>`;
}

async function sendMsg(text) {
  text = String(text || '').trim(); if (!text || !active) return;
  const { data, error } = await sb.from('messages').insert({ request_id: active.id, sender: 'o', text }).select().single();
  if (error) { toast('보내지 못했어요: ' + error.message); return; }
  if (!aMsgs.some(x => x.id === data.id)) aMsgs.push(data);
  updateMsgs();
}
async function openRecords() {
  await loadMembers();
  const { data } = await sb.from('requests').select('*').eq('car_id', car.id).order('created_at', { ascending: false }).limit(100);
  recs = data || []; view = 'records'; rec = null; render(); scrollTo(0, 0);
}
async function openRecord(id) {
  const r = recs.find(x => x.id === id); if (!r) return;
  const { data } = await sb.from('messages').select('*').eq('request_id', id).order('id');
  rec = { r, msgs: data || [], urls: await photoUrls(r.photos) }; view = 'record'; render(); scrollTo(0, 0);
}
/* 이 폰의 알림 구독만 해제 */
async function dropThisPush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration(); const s = reg && await reg.pushManager.getSubscription();
    if (s) { await sb.from('push_subs').delete().eq('endpoint', s.endpoint); await s.unsubscribe(); }
  } catch (e) { }
}
async function deleteCar() {
  const shared = members.filter(liveMem).length > 1;
  if (!confirm(`${car.plate} 차량과 요청·주차기록이 모두 지워지고, 붙여 둔 QR 스티커도 더 이상 쓸 수 없어요.${shared ? '\n함께 쓰는 사람도 이 차량을 볼 수 없게 돼요.' : ''}\n삭제할까요?`)) return;
  const r = await notify('delete-car', null, { car_id: car.id });   // 요청자가 올린 사진 파일까지 서버에서 함께 삭제
  if (!r?.ok) { toast('삭제하지 못했어요: ' + (r?.error || '알 수 없는 오류')); return; }
  car = null; toast('차량을 삭제했어요'); await afterCarsChange();
}
async function leaveCar() {
  if (!confirm(`${car.plate} 차량에서 나갈까요? 이 차의 연락을 더 이상 받지 않아요.`)) return;
  const { error } = await sb.rpc('remove_member', { cid: car.id, u: me.id });
  if (error) { toast('나가지 못했어요: ' + errText(error)); return; }
  car = null; toast('차량에서 나왔어요'); await afterCarsChange();
}
async function logout() {
  if (!confirm('로그아웃할까요? 이 폰으로는 요청 알림을 받지 않아요.')) return;
  await dropThisPush(); if (chan) sb.removeChannel(chan);
  await sb.auth.signOut(); localStorage.removeItem(CUR_KEY);
  location.replace(location.pathname);
}
async function deleteAccount() {
  if (!confirm('계정을 탈퇴하면 내가 등록한 차량(공동차주 포함)·요청·주차기록·사진이 모두 지워지고 되돌릴 수 없어요.\n탈퇴할까요?')) return;
  if (!confirm('정말 탈퇴할까요? 붙여 둔 QR 스티커도 쓸 수 없게 돼요.')) return;
  await dropThisPush(); if (chan) sb.removeChannel(chan);
  const r = await notify('delete-me');
  if (r?.error) { toast('탈퇴하지 못했어요: ' + r.error, 4500); return; }
  try { await idb.clear(); } catch (e) { }
  await sb.auth.signOut(); localStorage.removeItem(CUR_KEY);
  location.replace(location.pathname);
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const k = b.dataset.k;
  switch (b.dataset.act) {
    case 'install': if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; render(); } break;
    /* 로그인 */
    case 'google': try { await googleLogin(joinCode ? '?join=' + joinCode : ''); } catch (err) { toast(errText(err), 5000); } break;
    case 'link-google': try { await linkGoogle(joinCode ? '?join=' + joinCode : ''); } catch (err) { toast(errText(err), 5000); } break;
    case 'dev-anon': { const { error } = await sb.auth.signInAnonymously(); if (error) toast(error.message); else location.reload(); break; }
    case 'logout': await logout(); break;
    case 'del-account': await deleteAccount(); break;
    /* 차량 등록 · 추가 */
    case 'signup': su = freshSu(false); ov = 'signup'; renderOv(); break;
    case 'car-add': su = freshSu(true); ov = 'signup'; renderOv(); break;
    case 'su-back': if (su.i > 0) su.i--; else ov = null; renderOv(); break;
    case 'su-next': {
      if (!suOK()) return;
      const s = sstep();
      if (s === 5) { ov = null; await afterCarsChange(car?.id); return; }
      if (s === 2 && !su.callPhone) su.callPhone = su.phone;
      if (su.steps[su.i + 1] === 5) { await createCar(); return; }
      su.i++; renderOv(); break;
    }
    case 'su-kind': su.kind = k; renderOv(); break;
    case 'su-color': su.color = k; renderOv(); break;
    case 'su-code':
      if (su.phone.replace(/\D/g, '').length < 10) return;
      su.codeSent = true; su.code = ''; renderOv();
      setTimeout(() => { if (ov === 'signup' && sstep() === 2 && !su.verified) { su.code = String(Math.floor(100000 + Math.random() * 900000)); renderOv(); } }, 1200);
      break;
    case 'su-verify': {
      const ci = $('#su-codein');
      if (su.code && ci && ci.value.trim() === su.code) { su.verified = true; renderOv(); }
      else if (ci) ci.style.borderColor = 'var(--warn)';
      break;
    }
    case 'sc-call': su.callNone = k === 'none'; renderOv(); break;
    case 'su-push': {
      const r = await enablePush(me.id);
      su.push = r.ok ? 'on' : 'off'; su.pushMsg = r.ok ? '✓ 알림이 켜졌어요. 시험 알림을 보내 보세요.' : pushWhy(r.why);
      pState = await pushState(); renderOv(); break;
    }
    case 'test-push': {
      const r = await notify('test');
      const msg = r?.sent ? '시험 알림을 보냈어요. 폰 알림을 확인해 보세요.' : r?.error ? '알림 발송 실패: ' + r.error : '이 폰의 알림 구독이 없어요. 알림을 먼저 켜 주세요.';
      if (ov === 'signup') { su.pushMsg = msg; renderOv(true); } else toast(msg, 4000);
      break;
    }
    case 'enable-push': { const r = await enablePush(me.id); pState = await pushState(); toast(r.ok ? '알림이 켜졌어요' : pushWhy(r.why), 4500); render(); break; }
    /* 차량 전환 · 함께 쓰기 */
    case 'cars': ov = 'cars'; renderOv(); break;
    case 'car-pick': {
      const id = b.dataset.id; ov = null;
      if (id !== car.id) { await switchCar(id); await loadActive(); render(); scrollTo(0, 0); loadParks().then(() => { if (!active && view === 'home') render(); }); }
      else renderOv();
      break;
    }
    case 'members': await loadMembers(); inv = null; invEnds = localDT(Math.ceil((Date.now() + 864e5) / 36e5) * 36e5); ov = 'members'; renderOv(true); break;
    case 'inv-co': await makeInvite('co'); break;
    case 'inv-temp': await makeInvite('temp'); break;
    case 'inv-done': inv = null; renderOv(); break;
    case 'inv-share': {
      const url = inviteUrl(inv.code), text = `${car.plate} 차량을 저기요에서 ${inv.role === 'co' ? '함께 써요' : '잠시 맡겨요'}. 링크를 눌러 참여해 주세요.`;
      if (navigator.share) { try { await navigator.share({ title: '저기요 차량 초대', text, url }); } catch (err) { } }
      else { try { await navigator.clipboard.writeText(text + '\n' + url); toast('초대 문구와 링크를 복사했어요'); } catch (err) { prompt('복사하세요', url); } }
      break;
    }
    case 'set-recv': case 'take-recv': {
      const u = b.dataset.u || me.id;
      const { error } = await sb.rpc('set_receiver', { cid: car.id, u });
      if (error) { toast('바꾸지 못했어요: ' + errText(error)); break; }
      await loadCars(); toast(u === me.id ? '이제 내가 이 차의 연락을 받아요' : `이제 ${nameOfUid(u)}님이 연락을 받아요`); render(); renderOv(true); break;
    }
    case 'mem-rm': {
      const u = b.dataset.u, m = members.find(x => x.uid === u);
      if (!m || !confirm(`${m.name || ROLE_LABEL[m.role]}님을 ${m.role === 'temp' ? '지금 끝낼까요' : '내보낼까요'}? 이 차의 연락을 더 이상 받지 않아요.`)) break;
      const { error } = await sb.rpc('remove_member', { cid: car.id, u });
      if (error) { toast('처리하지 못했어요: ' + errText(error)); break; }
      await loadCars(); renderOv(true); render(); break;
    }
    case 'car-leave': await leaveCar(); break;
    case 'car-del': await deleteCar(); break;
    case 'car-edit': ce = { plate: car.plate, kind: car.kind, color: car.color }; ov = 'caredit'; renderOv(); break;
    case 'ce-kind': ce.kind = k; renderOv(); break;
    case 'ce-color': ce.color = k; renderOv(); break;
    case 'ce-save': {
      if (!plateOK(ce.plate)) { toast('차량번호를 확인해 주세요 (예: 12가 3456)'); break; }
      const { error } = await sb.from('cars').update({ plate: fmtPlate(ce.plate), kind: ce.kind, color: ce.color }).eq('id', car.id);
      if (error) { toast('저장하지 못했어요: ' + errText(error), 4500); break; }
      await loadCars(); ov = null; toast('새 차 정보로 바꿨어요. QR은 그대로 써요'); render(); break;
    }
    /* 초대 수락 */
    case 'jn-call': join.none = k === 'none'; renderOv(); break;
    case 'jn-push': { const r = await enablePush(me.id); pState = await pushState(); toast(r.ok ? '알림이 켜졌어요' : pushWhy(r.why), 4500); renderOv(); break; }
    case 'jn-ok': await acceptJoin(); break;
    /* 요청 넘기기 */
    case 'fwd': await loadMembers(); ov = 'fwd'; renderOv(); break;
    case 'fwd-to': await forwardTo(b.dataset.u); break;
    /* QR · 번호 · 상태 */
    case 'sticker': ov = 'sticker'; renderOv(); break;
    case 'sticker-dl': {
      const blob = await stickerBlob(carUrl());
      const res = await saveFiles([new File([blob], `저기요_QR스티커_${car.plate.replace(/\s/g, '')}.png`, { type: 'image/png' })]);
      if (res === 'downloaded') toast('스티커 이미지를 저장했어요');
      break;
    }
    case 'sticker-pdf': {
      if (b.disabled) break;
      b.disabled = true; const old = b.textContent; b.textContent = 'PDF 만드는 중…';
      try {
        const pdf = await stickerPDF(carUrl(), car.plate);
        const res = await saveFiles([new File([pdf], `저기요_QR명함_${car.plate.replace(/\s/g, '')}.pdf`, { type: 'application/pdf' })]);
        if (res === 'downloaded') toast('인쇄용 PDF를 저장했어요. A4에 실제 크기(100%)로 인쇄해 주세요', 4000);
      } catch (err) { toast('PDF를 만들지 못했어요: ' + (err?.message || err), 4000); }
      b.disabled = false; b.textContent = old; break;
    }
    case 'copy': try { await navigator.clipboard.writeText(b.dataset.t); toast('복사했어요'); } catch (err) { prompt('복사하세요', b.dataset.t); } break;
    case 'open-set': { const mm = myMem(); st = { name: mm.name || prof.name || '', phone: mm.phone || '', none: mm.call_type === 'none' }; ov = 'set'; renderOv(); break; }
    case 'st-call': st.none = k === 'none'; renderOv(); break;
    case 'st-save': await saveMe(); break;
    case 'open-status': sd = { code: statusText(car) ? car.status_code : null, min: car.status_min || 5, until: car.status_until || '', text: car.status_text || '' }; ov = 'status'; renderOv(); break;
    case 'sd-code': sd.code = k === 'none' ? null : k; renderOv(); break;
    case 'sd-min': sd.min = +k; renderOv(); break;
    case 'save-status': await saveStatus(); break;
    case 'set-leave': case 'clear-leave': {
      const v = b.dataset.act === 'clear-leave' ? null : ($('#leave-at')?.value || null);
      const { data, error } = await sb.from('cars').update({ leave_at: v, leave_set_at: new Date().toISOString() }).eq('id', car.id).select().single();
      if (error) { toast(error.message); break; }
      Object.assign(car, data); toast(v ? `${koTime(v)}에 나갈 예정이라고 표시해요` : '출차 예고를 지웠어요'); renderOv(); render(); break;
    }
    case 'close-ov': case 'close-photo': ov = null; if (join) join = null; renderOv(); break;
    /* 요청 응답 */
    case 'reply': await doReply(k); break;
    case 'resolve-req': await resolveReq(); break;
    case 'chat': ov = 'chat'; renderOv(); break;
    case 'free-input': freeInput = true; renderOv(true); updateMsgs(); setTimeout(() => $('#chat-in')?.focus(), 60); break;
    case 'quick': await sendMsg(b.dataset.t); break;
    case 'send-msg': { const i = $('#chat-in'); const v = i.value; i.value = ''; await sendMsg(v); i.focus(); break; }
    case 'log-call': if (active) sb.from('messages').insert({ request_id: active.id, sender: 'sys', text: `차주가 ${who()}에게 전화를 걸었어요` }).then(() => { }); break;
    case 'photo': photoList = view === 'record' && rec ? rec.urls : aUrls; photoI = +b.dataset.i; ov = 'photo'; renderOv(); break;
    case 'save-photos': { const t = view === 'record' && rec ? rec : { r: active, urls: aUrls }; if (t.r) await savePhotos(t.r, t.urls); break; }
    /* 기록 */
    case 'records': await openRecords(); break;
    case 'tab':
      if (k === 'home') { view = 'home'; rec = null; render(); scrollTo(0, 0); }
      else if (k === 'records') await openRecords();
      else { if (!pk) pk = freshPk(); view = 'parking'; render(); scrollTo(0, 0); loadParks().then(() => { if (view === 'parking') render(true); }); }
      break;
    case 'pk-place': pk.place = b.dataset.k; render(true); break;
    case 'pk-floor': pk.floor = pk.floor === k ? null : k; render(true); break;
    case 'pk-rmphoto': if (pk.preview) URL.revokeObjectURL(pk.preview); pk.blob = null; pk.preview = ''; render(true); break;
    case 'pk-save': await savePark(); break;
    case 'pk-open': pkOpen = parks.find(p => String(p.id) === b.dataset.id) || null; if (pkOpen) { ov = 'park'; renderOv(); } break;
    case 'pk-del': {
      if (!pkOpen || !confirm('이 주차기록을 지울까요? 사진도 함께 지워져요.')) break;
      const { error } = await sb.from('parking_logs').delete().eq('id', pkOpen.id);
      if (error) { toast(error.message); break; }
      if (pkOpen.photo_key) idb.del(pkOpen.photo_key).catch(() => { });
      parks = parks.filter(p => p.id !== pkOpen.id); pkOpen = null; ov = null; renderOv(); render(true); toast('지웠어요'); break;
    }
    case 'rec': await openRecord(b.dataset.id); break;
    case 'home': view = 'home'; rec = null; render(); break;
    case 'keep': {
      if (!rec) break;
      const v = !rec.r.keep_o; const { error } = await sb.from('requests').update({ keep_o: v }).eq('id', rec.r.id);
      if (!error) { rec.r.keep_o = v; toast(v ? '보관했어요. 자동 삭제되지 않아요' : '보관을 해제했어요'); render(); }
      break;
    }
    case 'export-png': await exportPNG(rec.r, rec.msgs, car.plate, rec.urls); break;
    case 'export-text': await exportText(rec.r, rec.msgs, car.plate); break;
  }
});
document.addEventListener('input', e => {
  const id = e.target.id, v = e.target.value;
  if (id === 'su-plate') { su.plate = v; updSuBtn(); }
  else if (id === 'su-name') { su.name = v; updSuBtn(); }
  else if (id === 'sd-text') {
    sd.text = v;
    const t = statusText({ status_code: 'custom', status_text: sd.text, status_at: new Date().toISOString() });
    setText('#sd-prev-t', t); const pv = $('#sd-prev'); if (pv) pv.hidden = !t;
  }
  else if (id === 'pk-place') pk.place = v;
  else if (id === 'pk-spot') pk.spot = v;
  else if (id === 'pk-memo') pk.memo = v;
  else if (id === 'jn-name') join.name = v;
  else if (id === 'st-name') st.name = v;
  else if (id === 'ce-plate') ce.plate = v;
  else if (id === 'su-phone') {
    const f = fmtPhone(v); if (v !== f) e.target.value = f; su.phone = f;
    const b = $('#su-codebtn'); if (b) b.disabled = su.phone.replace(/\D/g, '').length < 10;
  }
  else if (id === 'sc-phone' || id === 'jn-phone' || id === 'st-phone') {
    const f = fmtPhone(v); if (v !== f) e.target.value = f;
    if (id === 'sc-phone') { su.callPhone = f; updSuBtn(); } else if (id === 'jn-phone') join.phone = f; else st.phone = f;
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'su-agree') { su.agree = e.target.checked; updSuBtn(); }
  if (e.target.id === 'sd-until') { sd.until = e.target.value; renderOv(); }
  if (e.target.id === 'inv-ends') invEnds = e.target.value;
  if (e.target.id === 'pk-file' && e.target.files[0]) {
    resizeImage(e.target.files[0], 1280, 0.8).then(b => { if (!b) return; if (pk.preview) URL.revokeObjectURL(pk.preview); pk.blob = b; pk.preview = URL.createObjectURL(b); render(true); });
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'chat-in' && !e.isComposing) { e.preventDefault(); const v = e.target.value; e.target.value = ''; sendMsg(v); }
});

boot();
