/* 무브콜 시험판 — 차주 앱 (가입 · 대기 · 상태 알리기 · 요청 응답 · 메시지 · 기록) */
const params = new URLSearchParams(location.search);
const APP = $('#app'), OV = $('#ov');
let me = null, car = null, active = null, aMsgs = [], aUrls = [], unread = 0;
let view = 'home', recs = [], rec = null;
let ov = null, ovKey = '', photoI = 0, photoList = [], freeInput = false;
let su = null, lastBuzz = 0, pState = 'unsupported', deferredInstall = null, chan = null;

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (!car) render(); });

const pushWhy = w => ({
  denied: '알림이 차단돼 있어요. 폰 설정 → 앱(크롬 또는 무브콜) → 알림에서 허용해 주세요.',
  default: '알림 허용 창에서 "허용"을 눌러 주세요.',
  'ios-not-installed': '아이폰은 홈 화면에 추가한 무브콜 앱에서만 알림을 켤 수 있어요.',
  unsupported: '이 브라우저는 폰 알림을 지원하지 않아요. 크롬(안드로이드) 또는 홈 화면에 추가한 앱(아이폰)으로 열어 주세요.'
})[w] || ('알림을 켜지 못했어요: ' + w);
const OPEN = ['ringing', 'replied', 'resolving'];

/* ---------- 시작 ---------- */
async function boot() {
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch (e) { } }
  try { me = await ensureUser(); }
  catch (e) {
    APP.innerHTML = `<div class="fatal">로그인에 실패했어요.<br><small>${esc(e.message)}</small></div>`;
    return;
  }
  pState = await pushState();
  await loadCar();
  if (car) { await loadActive(); subscribe(); await handleParams(); }
  render();
  setInterval(tick, 500);
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !car) return;
    pState = await pushState(); await loadCar(); await loadActive(); render();
  });
}
async function loadCar() {
  const { data } = await sb.from('cars').select('*').eq('owner', me.id).order('created_at', { ascending: false }).limit(1);
  car = data?.[0] || null;
}
async function loadActive() {
  const { data } = await sb.from('requests').select('*').eq('car_id', car.id).in('status', OPEN)
    .order('created_at', { ascending: false }).limit(1);
  await setActive(data?.[0] || null);
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
function subscribe() {
  if (chan) sb.removeChannel(chan);
  chan = sb.channel('owner-' + car.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'requests', filter: `car_id=eq.${car.id}` }, async p => {
      await setActive(p.new); view = 'home'; if (ov !== 'signup') ov = null; render();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'requests', filter: `car_id=eq.${car.id}` }, async p => {
      const r = p.new;
      if (active && r.id === active.id) {
        const prev = active.status;
        if (OPEN.includes(r.status)) {
          active = { ...active, ...r };
          if (prev !== 'ringing' && r.status === 'ringing') { lastBuzz = -1; vib([600, 200, 600]); }   // 요청자가 '안 돼요'·'아직' → 다시 울림
        } else {
          toast(r.status === 'cancelled' ? '요청자가 요청을 취소했어요' : r.resolved_by === 'auto' ? '5분이 지나 자동으로 완료됐어요' : '요청자가 해결됐다고 확인했어요');
          active = null; aMsgs = []; aUrls = []; if (ov === 'chat') ov = null;
        }
        render();
      } else if (!active && OPEN.includes(r.status)) { await setActive(r); render(); }   // 끝난 요청이 다시 열린 경우
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => {
      const m = p.new;
      if (m.sender === 'r' && m.text.startsWith('💐') && (!active || m.request_id !== active.id)) { toast('감사 인사가 도착했어요: ' + m.text, 4000); vib([200]); }
      if (active && m.request_id === active.id && !aMsgs.some(x => x.id === m.id)) {
        aMsgs.push(m);
        if (m.sender === 'r') { if (ov !== 'chat') unread++; vib([200]); }
        updateMsgs();
      }
      if (rec && m.request_id === rec.r.id && !rec.msgs.some(x => x.id === m.id)) rec.msgs.push(m);
    })
    .subscribe();
}
/* 알림 버튼(곧 갈게요 등)·앱 바로가기(상태 바꾸기)로 들어온 경우 */
async function handleParams() {
  const rid = params.get('rid'), reply = params.get('reply'), chat = params.get('chat'), st = params.get('st');
  if (rid && (!active || active.id !== rid)) {
    const { data } = await sb.from('requests').select('*').eq('id', rid).maybeSingle();
    if (data && OPEN.includes(data.status)) await setActive(data);
  }
  if (reply && active && active.id === rid && active.status === 'ringing' && REP(reply)) await doReply(reply, true);
  if (chat && active) ov = 'chat';
  if (st && (STATUS_MSG[st] || st === 'none')) await setStatus(st, true);
  if (rid || reply || chat || st) history.replaceState(null, '', location.pathname);
}

/* ---------- 화면 ---------- */
const OTOP = `<div class="o-top"><div class="o-date" id="o-date"></div><div class="o-clock" id="o-clock"></div></div>`;
const NH = t => `<div class="noti-h"><span class="logo">P</span>무브콜${t ? ' · ' + t : ''}<span class="now">지금</span></div>`;
const who = () => active.kind === 'move' ? '요청자' : active.kind === 'bb' ? '요청자' : active.kind === 'acc' ? '신고자' : '알린 분';
const whoWith = () => who() + (who().endsWith('분') ? '과' : '와');
const chatBtn = () => `<button class="btn soft" data-act="chat">💬 ${whoWith()} 메시지<span class="unread" id="o-unread" hidden></span></button><div class="lastmsg" id="o-last"></div>`;
const carUrl = () => new URL('c.html?id=' + car.id, location.href).href;
const statusUrl = st => new URL(`s.html?k=${car.status_key}&st=${st}`, location.href).href;
const fbBanner = () => active.feedback ? `<div class="fbanner">⚠ 요청자: “${FEEDBACK[active.feedback]}”${active.feedback === 'notyet' ? '' : '<br>직접 와 주셔야 해요'}</div>` : '';
function detailCard(r, urls) {
  const a = r.acc || {};
  if (r.kind === 'acc') return `<span class="reason">${WHO[r.sub || a.who] || ''} · ${WHO_LONG[r.sub || a.who] || ''}</span>
    <div class="info">
      <div><span>이름</span><b>${esc(a.name)}</b></div>
      <div><span>차량번호</span><b>${a.plate ? esc(a.plate) : '-'}</b></div>
      <div><span>전화번호</span><a href="tel:${esc(String(a.phone || '').replace(/\D/g, ''))}" data-act="log-call">${esc(a.phone)} 📞</a></div>
    </div>
    ${a.desc ? `<div class="quote">“${esc(a.desc)}”</div>` : ''}
    ${urls.length ? `<div class="thumbs">${urls.map((u, i) => `<img src="${u}" data-act="photo" data-i="${i}" alt="사고 사진 ${i + 1}">`).join('')}</div>
      <button class="btn soft sm" data-act="save-photos">📥 사고 사진 ${urls.length}장 저장</button>` : '<p class="muted" style="margin-top:8px">첨부 사진 없음</p>'}`;
  if (r.kind === 'bb') return `<span class="reason" style="background:var(--accent-soft);color:var(--accent)">📹 블랙박스 영상 요청</span>
    <div class="info">
      <div><span>언제</span><b>${esc(a.when || '-')}</b></div>
      <div><span>무슨 일</span><b>${esc(a.what || '-')}</b></div>
      ${a.where ? `<div><span>장소</span><b>${esc(a.where)}</b></div>` : ''}
      <div><span>연락처</span><a href="tel:${esc(String(a.phone || '').replace(/\D/g, ''))}" data-act="log-call">${esc(a.name || '')} ${esc(a.phone)} 📞</a></div>
    </div>`;
  if (r.kind === 'etc') return `<span class="reason"${r.level === 'urgent' ? '' : ' style="background:var(--accent-soft);color:var(--accent)"'}>${r.level === 'urgent' ? '🆘 긴급' : '📢 알림'}</span>
    <div class="quote" style="font-weight:700">${esc(ETC[r.sub]?.t || '')}</div>`;
  return `<span class="reason">${esc(REASONS[r.reason] || '')}</span>
    ${r.loc ? `<div class="quote">📍 요청자 위치: <b>${esc(locText(r.loc))}</b></div>` : ''}
    ${r.msg ? `<div class="quote">“${esc(r.msg)}”</div>` : ''}
    ${urls.length ? `<div class="thumbs">${urls.map((u, i) => `<img src="${u}" data-act="photo" data-i="${i}" alt="현장 사진">`).join('')}</div>` : ''}`;
}
const replyBtns = r => `<div class="replies${r.kind === 'move' && !r.feedback ? '' : ' col'}">${replySet(r).map(x => `<button class="rp${x.alt ? ' alt' : ''}${r.level === 'urgent' && !x.alt ? ' red' : ''}" data-act="reply" data-k="${x.k}">${x.icon} ${x.t}${x.sub ? `<small>${x.sub}</small>` : ''}</button>`).join('')}</div>`;
const statusLine = () => `${car.status_code ? `👤 ${STATUS_MSG[car.status_code]} <span style="opacity:.6">(${hhmm(car.status_at)})</span>` : '👤 상태 표시 안 함'}${leaveValid(car.leave_at, car.status_at) ? `<br>🕒 ${esc(car.leave_at)}에 나갈 예정` : ''}`;

const W = {
  welcome: () => `<div class="welcome">
      <span class="logo big">P</span>
      <h2>무브콜</h2>
      <p class="lead">QR 스티커 하나로<br>주차 이동 요청과 사고 알림을 받아요</p>
      <ul>
        <li>📳 요청이 오면 답할 때까지 알림이 반복돼요 — 회의 중엔 진동으로</li>
        <li>🛡 내 번호를 드러내지 않고 연락받아요</li>
        <li>🚨 사고·긴급 상황은 상대 연락처·사진과 함께 긴급 알림</li>
      </ul>
      ${isIOS && !isStandalone ? `<div class="tipbox">📱 <b>아이폰은 먼저 앱으로 설치해 주세요.</b><br>Safari 아래쪽 <b>공유 버튼(□↑) → 홈 화면에 추가</b>를 누른 뒤, 홈 화면의 무브콜 아이콘으로 열어서 가입하세요.</div>` : ''}
      ${deferredInstall ? '<button class="btn ghost" data-act="install">📲 홈 화면에 앱으로 설치</button>' : ''}
      ${!isIOS && !isStandalone && !deferredInstall ? '<div class="tipbox">📲 크롬 메뉴(⋮) → <b>홈 화면에 추가</b>로 설치해 두면 앱처럼 쓸 수 있어요.</div>' : ''}
      <div class="spacer"></div>
      <button class="btn primary" data-act="signup">가입하기</button>
      <p style="margin-top:10px;opacity:.6;font-size:12px">시험판 · 입력한 정보는 시험이 끝나면 삭제돼요</p>
    </div>`,

  idle: () => `${OTOP}
    <div class="widget"><b>무브콜 · 대기 중</b><br>내 차 ${esc(car.plate)} (${esc(car.color)} ${esc(car.kind)})
      <div class="numrow"><span>${statusLine()}</span><button data-act="open-status">바꾸기</button></div>
      <div class="numrow">📞 ${CALL_LABEL[car.call_type]}${car.call_type === 'none' ? '' : ' · ' + esc(car.phone)}<button data-act="open-set">변경</button></div>
      ${pState === 'on' ? '' : `<div class="warnline">⚠ 폰 알림이 꺼져 있어요. 이 화면을 닫으면 요청을 못 받아요. <button class="linkbtn" data-act="enable-push">알림 켜기</button></div>`}
      <div class="row2"><button data-act="sticker">🔲 내 QR</button><button data-act="records">🗂 기록</button><button data-act="test-push">📳 알림 시험</button></div>
    </div>
    <div class="o-foot">${isIOS ? '아이폰은 폰 알림으로 진동해요' : '이 화면이 켜져 있을 때는 화면에서도 진동해요 (화면을 한 번 눌러 두세요)'}<br>
      <button class="linkbtn" data-act="leave">가입 해지 · 시험 데이터 삭제</button></div>`,

  ring: () => {
    const u = active.level === 'urgent';
    const title = { move: active.feedback ? '🚗 직접 와 주셔야 해요' : '🚗 차를 빼 주실 수 있나요?', acc: '🚨 내 차 사고 알림', bb: '📹 블랙박스 영상 요청', etc: u ? '🆘 긴급 알림' : '📢 내 차 알림' }[active.kind];
    return `${u ? `<div class="al-top"><div class="al-ic">${active.kind === 'acc' ? '🚨' : '🆘'}</div><div class="al-t">긴급 · ${active.kind === 'acc' ? '내 차 사고 알림' : esc(ETC[active.sub]?.t || '')}</div>
        <div class="al-s">${esc(car.plate)} · 알림 후 <span id="o-el">0초</span> · 확인할 때까지 계속</div></div>` : OTOP}
      <div class="noti">
        ${NH(u ? '긴급 알림' : KIND_LABEL[active.kind])}
        ${u ? '' : `<div class="noti-t">${title}</div>`}
        ${fbBanner()}
        ${detailCard(active, aUrls)}
        <div id="o-extra"></div>
        ${u ? '' : `<div class="vib">📳 알림 후 <span id="o-el">0초</span> · 답할 때까지 ${active.level === 'info' ? '가끔' : '계속'} 울려요</div>`}
        ${replyBtns(active)}
        ${chatBtn()}
      </div>`;
  },

  replied: () => {
    const rp = REP(active.reply) || { icon: '💬', t: '', min: 0 };
    return `${active.kind === 'acc' ? '' : OTOP}
    <div class="noti"${active.kind === 'acc' ? ' style="margin-top:4px"' : ''}>
      ${NH(KIND_LABEL[active.kind])}
      <div class="noti-t">답장을 보냈어요</div>
      <div class="sent" style="font-size:17px">${rp.icon} “${rp.t}”</div>
      ${active.reply === 'neutral' ? '<p class="muted" style="margin-top:4px">요청자가 밀어 본 뒤 결과를 알려 줄 거예요</p>' : ''}
      ${rp.min ? `<p class="muted" style="margin-top:4px">요청자에게 보여 주는 남은 시간</p><div class="cd small" id="o-cd">--:--</div>` : ''}
      ${active.kind === 'move' ? '' : detailCard(active, aUrls)}
      ${chatBtn()}
      <button class="btn primary" data-act="resolve-req">✅ 해결 완료</button>
      <p class="muted center" style="font-size:12px;margin-top:6px">요청자가 확인하면 끝나요 · 답이 없으면 5분 뒤 자동 완료</p>
    </div>`;
  },

  resolving: () => `${OTOP}
    <div class="noti">
      ${NH(KIND_LABEL[active.kind])}
      <div class="noti-t">요청자 확인을 기다리는 중이에요</div>
      <p class="muted" style="margin-top:6px;line-height:1.6">요청자가 '해결됐어요'를 누르면 끝나요.<br><span id="o-auto">05:00</span> 뒤에는 자동으로 완료돼요.</p>
      ${chatBtn()}
    </div>`,

  records: () => {
    const since = Date.now() - 30 * 24 * 3600e3, list = recs.filter(r => new Date(r.created_at) > since);
    const answered = list.filter(r => r.replied_at), rate = list.length ? Math.round(answered.length / list.length * 100) : 0;
    const avg = answered.length ? answered.reduce((s, r) => s + (new Date(r.replied_at) - new Date(r.created_at)), 0) / answered.length : 0;
    return `<div class="appbar"><button class="back" data-act="home" aria-label="뒤로">‹</button>기록<span class="appbar-sub">${esc(car.plate)}</span></div>
      <div class="muted" style="margin-bottom:6px">최근 30일 내 응답 기록</div>
      <div class="stats"><div><b>${list.length}</b><span>받은 요청</span></div><div><b>${rate}%</b><span>응답률</span></div><div><b>${answered.length ? secs(avg) : '-'}</b><span>평균 응답</span></div></div>
      ${recordListHTML(recs)}`;
  },
  record: () => `<div class="appbar"><button class="back" data-act="records" aria-label="뒤로">‹</button>기록 상세</div>${recordDetailHTML(rec.r, rec.msgs, 'o', car.plate, rec.urls)}`
};

function render() {
  let h, cls = 'app dark';
  if (!car) h = W.welcome();
  else if (view === 'records') { cls = 'app'; h = W.records(); }
  else if (view === 'record' && rec) { cls = 'app'; h = W.record(); }
  else if (!active) h = W.idle();
  else if (active.status === 'ringing') { if (active.level === 'urgent') cls = 'app alert'; h = W.ring(); }
  else if (active.status === 'resolving') h = W.resolving();
  else h = W.replied();
  APP.className = cls; APP.innerHTML = h;
  updateMsgs(); renderOv(); tick();
}
function updateMsgs() {
  const u = $('#o-unread'); if (u) { u.hidden = unread <= 0; u.textContent = unread; }
  const last = [...aMsgs].reverse().find(m => m.sender === 'r');
  setText('#o-last', last && active ? `${who()}: ${last.text}` : '');
  const ex = $('#o-extra'); if (ex) ex.innerHTML = aMsgs.filter(m => m.sender === 'r').slice(-3).map(m => `<div class="quote new">💬 ${esc(m.text)}</div>`).join('');
  const box = $('#chat-msgs');
  if (box && active) { const h = msgHTML(active, aMsgs, 'o', aUrls); if (box.dataset.h !== h) { box.dataset.h = h; box.innerHTML = h; box.scrollTop = box.scrollHeight; } }
}
function tick() {
  const now = new Date();
  setText('#o-clock', hhmm(now)); setText('#o-date', dateStr(now));
  if (!active || view !== 'home') return;
  if (active.status === 'ringing') {
    const el = Date.now() - new Date(active.feedback_at || active.created_at).getTime();
    const iv = { urgent: 2000, normal: 3000, info: 20000 }[active.level] || 3000, c = Math.floor(el / iv);
    setText('#o-el', secs(el));
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
const freshSu = () => ({ step: 1, plate: '', kind: null, color: null, phone: '', codeSent: false, code: '', verified: false, agree: false, type: 'safe', push: null, pushMsg: '', saving: false });
const KINDS = ['승용', 'SUV', '승합', '트럭'], COLORS = ['흰색', '검정', '회색', '은색', '파랑', '빨강'];
const plateOK = v => /^\d{2,3}[가-힣]\d{4}$/.test(String(v).replace(/\s/g, ''));
const fmtPlate = v => { const t = String(v).replace(/\s/g, ''); return plateOK(t) ? t.slice(0, -4) + ' ' + t.slice(-4) : String(v).trim(); };
function suOK() {
  if (su.step === 1) return plateOK(su.plate) && !!su.kind && !!su.color;
  if (su.step === 2) return su.verified && su.agree;
  if (su.step === 4) return !su.saving;
  return true;
}
const updSuBtn = () => { const b = $('#su-next'); if (b) b.disabled = !suOK(); };
const suKey = () => [su.step, su.codeSent, !!su.code, su.verified, su.type, su.push, su.pushMsg, su.kind, su.color, su.saving].join(',');
const SU_T = ['', '차량 등록', '본인 확인', '연락 방식', '알림 허용', '내 QR 스티커'];

function signupOv() {
  let b = '';
  if (su.step === 1) b = `
    <div class="h">차량번호</div>
    <input class="fi" id="su-plate" maxlength="12" placeholder="예: 12가 3456" value="${esc(su.plate)}" autocomplete="off">
    <div class="h">차종</div>
    <div class="chips c4">${KINDS.map(k => `<button class="chip${su.kind === k ? ' on' : ''}" data-act="su-kind" data-k="${k}">${k}</button>`).join('')}</div>
    <div class="h">색상</div>
    <div class="chips c3">${COLORS.map(k => `<button class="chip${su.color === k ? ' on' : ''}" data-act="su-color" data-k="${k}">${k}</button>`).join('')}</div>
    <p class="muted" style="margin-top:14px;line-height:1.5">요청자는 QR을 찍은 뒤 번호판의 가려진 숫자를 맞춰야 요청할 수 있어요.</p>`;
  else if (su.step === 2) b = `
    <div class="h">휴대폰 번호</div>
    <div class="row"><input class="fi" id="su-phone" type="tel" inputmode="numeric" maxlength="13" placeholder="010-1234-5678" value="${esc(su.phone)}" autocomplete="tel"${su.verified ? ' disabled' : ''}>
      <button data-act="su-code" id="su-codebtn"${su.verified || su.phone.replace(/\D/g, '').length < 10 ? ' disabled' : ''}>${su.codeSent ? '다시 받기' : '인증번호 받기'}</button></div>
    ${su.codeSent && !su.verified ? `
      ${su.code ? `<div class="sms">💬 <b>[무브콜] 인증번호 ${su.code}</b><br><span class="muted">시험판이라 문자 대신 이 창에 보여 드리고, 아래 칸에 자동으로 넣었어요.</span></div>` : '<p class="muted" style="margin-top:10px">인증번호를 보내고 있어요…</p>'}
      <div class="row" style="margin-top:8px"><input class="fi" id="su-codein" inputmode="numeric" maxlength="6" placeholder="인증번호 6자리" value="${esc(su.code)}" autocomplete="one-time-code"><button data-act="su-verify">확인</button></div>` : ''}
    ${su.verified ? '<div class="okline">✓ 본인 확인이 끝났어요</div>' : ''}
    <label class="agree" style="margin-top:16px"><input type="checkbox" id="su-agree"${su.agree ? ' checked' : ''}> <span>(필수) 이용약관과 개인정보 수집·이용에 동의해요.<br>차량번호·휴대폰 번호는 연락 연결에만 쓰이고, 시험이 끝나면 삭제돼요.</span></label>`;
  else if (su.step === 3) {
    const o = (k, t, d, rc, num) => `<button class="opt${su.type === k ? ' on' : ''}" data-act="su-type" data-k="${k}"><b>${su.type === k ? '◉' : '○'} ${t}</b>${rc ? '<span class="rec">권장</span>' : ''}<p>${d}</p>${num ? `<p><b style="font-size:13px">${num}</b></p>` : ''}</button>`;
    b = `<p class="muted" style="line-height:1.5">요청자가 '전화걸기'를 누르면 이 번호가 요청자 폰에 자동으로 입력돼요.</p>
      ${o('safe', '안심번호', '실제 번호 대신 0507 가상번호로 연결돼요. 요청자 통화 기록에도 내 번호가 남지 않아요.', true, '※ 시험판에서는 내 실제 번호로 연결돼요')}
      ${o('real', '내 휴대폰 번호', '요청자 폰 통화 기록에 내 실제 번호가 남아요.', false, esc(su.phone))}
      ${o('none', '전화 받지 않기', '전화걸기 버튼이 꺼지고 메시지로만 연락받아요.', false, '')}
      ${su.type === 'real' ? '<div class="warnbox">⚠ 실제 번호는 모르는 사람에게 그대로 노출돼요. 안심번호를 권장해요.</div>' : ''}`;
  } else if (su.step === 4) b = `
    <p class="muted" style="line-height:1.5">요청이 왔을 때 놓치지 않도록 폰 알림을 허용해 주세요. 앱을 닫아 둬도 답할 때까지 알림이 반복돼요.</p>
    ${isIOS && !isStandalone ? '<div class="warnbox">아이폰은 <b>홈 화면에 추가한 무브콜 앱</b>에서만 알림을 켤 수 있어요.</div>' : ''}
    <div class="perm"><div class="tx"><b>🔔 알림 허용</b><p>요청·사고·긴급 알림을 진동과 함께 받아요</p></div><button class="${su.push === 'on' ? 'on' : ''}" data-act="su-push">${su.push === 'on' ? '허용함 ✓' : '허용하기'}</button></div>
    ${su.push === 'on' ? '<div class="perm"><div class="tx"><b>📳 알림 시험</b><p>지금 이 폰으로 시험 알림을 보내 봐요</p></div><button data-act="test-push">보내기</button></div>' : ''}
    ${su.pushMsg ? `<div class="${su.push === 'on' ? 'okline' : 'errline'}">${esc(su.pushMsg)}</div>` : ''}
    <div class="hint">💡 회의 중에도 받으려면 폰의 <b>방해금지 모드 예외 앱</b>에 ${isIOS ? '무브콜' : '크롬'}을 넣어 두세요.</div>`;
  else b = `<p class="muted center" style="line-height:1.5">가입이 끝났어요! 이 QR 스티커를 인쇄해서<br>앞유리 안쪽, 밖에서 잘 보이는 곳에 붙여 주세요.</p>
    ${stickerHTML(carUrl())}
    <button class="btn soft" data-act="sticker-dl" style="margin-top:14px">⬇ 스티커 이미지 저장</button>
    <p class="muted center" style="font-size:12px;margin-top:8px;line-height:1.5">시험할 때는 다른 폰 카메라로 이 화면의 QR을 찍어 보세요.</p>`;
  const next = su.step === 5 ? '시작하기' : su.step === 4 ? (su.saving ? '저장 중…' : '가입 완료하고 QR 받기') : '다음';
  return `<div class="ov">
    <div class="ov-h">${su.step < 5 ? '<button class="back" data-act="su-back" aria-label="뒤로">‹</button>' : ''}<b>${SU_T[su.step]}</b><span class="stepno">${su.step}/5</span></div>
    <div class="prog"><i style="width:${su.step * 20}%"></i></div>
    <div class="ov-body">${b}</div>
    <div class="ov-foot"><button class="btn primary" id="su-next" data-act="su-next"${suOK() ? '' : ' disabled'}>${next}</button></div>
  </div>`;
}
function stickerOv() {
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>내 QR 스티커</b><div class="muted">${esc(car.plate)} 전용</div></div></div>
    <div class="ov-body">${stickerHTML(carUrl())}<div class="urlbox">${esc(carUrl())}</div>
      <button class="btn primary" data-act="sticker-dl">⬇ 스티커 이미지 저장</button>
      <button class="btn ghost" data-act="copy" data-t="${esc(carUrl())}">🔗 주소 복사</button>
      <p class="muted center" style="margin-top:10px;line-height:1.5;font-size:12px">인쇄해서 앞유리 안쪽, 밖에서 잘 보이는 곳에 붙여 주세요.</p></div></div>`;
}
function setOv() {
  const o = (k, t, d, rc) => `<button class="opt${car.call_type === k ? ' on' : ''}" data-act="set-num" data-k="${k}"><b>${car.call_type === k ? '◉' : '○'} ${t}</b>${rc ? '<span class="rec">권장</span>' : ''}<p>${d}</p></button>`;
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>요청자가 전화할 번호</b><div class="muted">언제든 바꿀 수 있어요</div></div></div>
    <div class="ov-body">
      ${o('safe', '안심번호', '0507 가상번호로 연결 (시험판에서는 내 실제 번호로 연결)', true)}
      ${o('real', '내 휴대폰 번호', '요청자 폰 통화 기록에 내 실제 번호가 남아요.', false)}
      ${o('none', '전화 받지 않기', '메시지로만 연락받아요.', false)}
    </div></div>`;
}
function statusOv() {
  const o = k => `<button class="opt${(car.status_code || 'none') === k ? ' on' : ''}" data-act="set-status" data-k="${k}"><b>${(car.status_code || 'none') === k ? '◉' : '○'} ${STATUS_MSG[k] || '표시 안 함'}</b></button>`;
  const link = (st, t) => `<div class="linkrow"><span>${t}</span><button data-act="copy" data-t="${esc(statusUrl(st))}">링크 복사</button></div>`;
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>내 상태 알리기</b><div class="muted">요청자가 QR을 찍으면 바로 보여요</div></div></div>
    <div class="ov-body">
      ${Object.keys(STATUS_MSG).map(o).join('')}${o('none')}
      <div class="h">🕒 출차 예고</div>
      <div class="row"><input class="fi" id="leave-at" type="time" value="${esc(car.leave_at || '')}"><button data-act="set-leave">저장</button></div>
      ${car.leave_at ? `<p class="muted" style="margin-top:6px">지금: ${esc(car.leave_at)}에 나갈 예정이라고 보여요 <button class="linkbtn" data-act="clear-leave">지우기</button></p>` : '<p class="muted" style="margin-top:6px">"○시에 나가요"를 요청자에게 미리 보여 줘요</p>'}
      <div class="h">🤖 차 블루투스로 자동 바꾸기</div>
      <p class="muted" style="line-height:1.55">아래 링크를 열면 상태가 바로 바뀌어요. 폰의 자동화 기능에 걸어 두면 차에 타고 내릴 때 자동으로 바뀝니다.</p>
      ${link('driving', '🚗 운전 중 (차 블루투스 연결될 때)')}
      ${link('parked', '🅿️ 주차해 두었어요 (연결 끊길 때)')}
      ${link('meeting', '💼 회의 중')}
      <ol class="steps">
        <li><b>가장 쉬운 방법:</b> 홈 화면의 무브콜 아이콘을 <b>길게 누르면</b> '운전 중·주차함·회의 중' 바로가기가 나와요.</li>
        <li><b>안드로이드 자동화:</b> 삼성 <b>모드 및 루틴</b>(또는 무료 앱 MacroDroid)에서 조건을 <b>블루투스 기기 연결 → 내 차</b>로 정하고, 동작에 <b>웹 주소 열기</b>를 골라 위 '운전 중' 링크를 붙여 넣으세요. '연결 끊김' 루틴에는 '주차' 링크를 넣으세요. (메뉴 이름은 폰마다 조금 달라요)</li>
        <li><b>아이폰:</b> 단축어 앱 → 자동화 → <b>CarPlay(또는 블루투스) 연결 시</b> → <b>URL 열기</b>에 링크를 넣으세요.</li>
      </ol>
      <p class="muted" style="font-size:11.5px;margin-top:8px">링크는 내 차 전용이에요. 다른 사람에게 보내지 마세요.</p>
    </div></div>`;
}
function curOvKey() {
  if (ov === 'signup') return 'signup|' + suKey();
  if (ov === 'set') return 'set|' + car.call_type;
  if (ov === 'status') return 'status|' + car.status_code + '|' + car.leave_at;
  if (ov === 'photo') return 'photo' + photoI;
  if (ov === 'chat') return 'chat|' + (active?.id || '') + '|' + freeInput;
  return ov || '';
}
function renderOv(force) {
  if (ov === 'chat' && !active) ov = null;
  const k = curOvKey(); if (!force && k === ovKey) return; ovKey = k;
  OV.innerHTML = ov === 'signup' ? signupOv() : ov === 'sticker' ? stickerOv() : ov === 'set' ? setOv() : ov === 'status' ? statusOv()
    : ov === 'chat' ? chatOvHTML(`${whoWith()} 메시지`, `${KIND_LABEL[active.kind]} · 번호는 서로 보이지 않아요`, QUICK_OF(active, 'o'), freeInput)
    : ov === 'photo' ? photoOvHTML(photoList, photoI) : '';
  if (ov === 'chat') { unread = 0; updateMsgs(); }
}

/* ---------- 동작 ---------- */
async function createCar() {
  su.saving = true; renderOv();
  const { data, error } = await sb.from('cars').insert({
    plate: fmtPlate(su.plate), kind: su.kind, color: su.color, phone: su.phone, call_type: su.type, perm_noti: su.push === 'on'
  }).select().single();
  su.saving = false;
  if (error) { toast('저장하지 못했어요: ' + error.message, 4000); renderOv(true); return; }
  car = data; su.step = 5; renderOv();
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
async function setStatus(st, fromShortcut) {
  const { data, error } = await sb.from('cars').update({ status_code: st === 'none' ? null : st, status_at: new Date().toISOString() }).eq('id', car.id).select().single();
  if (error) { toast('바꾸지 못했어요: ' + error.message); return; }
  car = data; if (fromShortcut) toast('상태: ' + (STATUS_MSG[st] || '표시 안 함')); renderOv(); if (!fromShortcut) render();
}
async function sendMsg(text) {
  text = String(text || '').trim(); if (!text || !active) return;
  const { data, error } = await sb.from('messages').insert({ request_id: active.id, sender: 'o', text }).select().single();
  if (error) { toast('보내지 못했어요: ' + error.message); return; }
  if (!aMsgs.some(x => x.id === data.id)) aMsgs.push(data);
  updateMsgs();
}
async function openRecords() {
  const { data } = await sb.from('requests').select('*').eq('car_id', car.id).order('created_at', { ascending: false }).limit(100);
  recs = data || []; view = 'records'; rec = null; render(); scrollTo(0, 0);
}
async function openRecord(id) {
  const r = recs.find(x => x.id === id); if (!r) return;
  const { data } = await sb.from('messages').select('*').eq('request_id', id).order('id');
  rec = { r, msgs: data || [], urls: await photoUrls(r.photos) }; view = 'record'; render(); scrollTo(0, 0);
}
async function leave() {
  if (!confirm('시험 데이터(차량·요청·대화 기록)가 모두 지워집니다. 가입을 해지할까요?')) return;
  try { const reg = await navigator.serviceWorker?.getRegistration(); const s = reg && await reg.pushManager.getSubscription(); if (s) await s.unsubscribe(); } catch (e) { }
  await sb.from('push_subs').delete().eq('user_id', me.id);
  const { error } = await sb.from('cars').delete().eq('id', car.id);
  if (error) { toast('삭제하지 못했어요: ' + error.message); return; }
  if (chan) sb.removeChannel(chan);
  await sb.auth.signOut();
  location.replace(location.pathname);
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const k = b.dataset.k;
  switch (b.dataset.act) {
    case 'install': if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; render(); } break;
    /* 가입 */
    case 'signup': su = freshSu(); ov = 'signup'; renderOv(); break;
    case 'su-back': if (su.step > 1) su.step--; else ov = null; renderOv(); break;
    case 'su-next':
      if (!suOK()) return;
      if (su.step === 4) { await createCar(); return; }
      if (su.step === 5) { ov = null; await loadActive(); subscribe(); render(); return; }
      su.step++; renderOv(); break;
    case 'su-kind': su.kind = k; renderOv(); break;
    case 'su-color': su.color = k; renderOv(); break;
    case 'su-code':
      if (su.phone.replace(/\D/g, '').length < 10) return;
      su.codeSent = true; su.code = ''; renderOv();
      setTimeout(() => { if (ov === 'signup' && su.step === 2 && !su.verified) { su.code = String(Math.floor(100000 + Math.random() * 900000)); renderOv(); } }, 1200);
      break;
    case 'su-verify': {
      const ci = $('#su-codein');
      if (su.code && ci && ci.value.trim() === su.code) { su.verified = true; renderOv(); }
      else if (ci) ci.style.borderColor = 'var(--warn)';
      break;
    }
    case 'su-type': su.type = k; renderOv(); break;
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
    /* QR · 번호 · 상태 */
    case 'sticker': ov = 'sticker'; renderOv(); break;
    case 'sticker-dl': {
      const blob = await stickerBlob(carUrl());
      const res = await saveFiles([new File([blob], `무브콜_QR스티커_${car.plate.replace(/\s/g, '')}.png`, { type: 'image/png' })]);
      if (res === 'downloaded') toast('스티커 이미지를 저장했어요');
      break;
    }
    case 'copy': try { await navigator.clipboard.writeText(b.dataset.t); toast('복사했어요'); } catch (err) { prompt('복사하세요', b.dataset.t); } break;
    case 'open-set': ov = 'set'; renderOv(); break;
    case 'set-num': {
      const { error } = await sb.from('cars').update({ call_type: k }).eq('id', car.id);
      if (error) { toast(error.message); break; }
      car.call_type = k; renderOv(); render(); break;
    }
    case 'open-status': ov = 'status'; renderOv(); break;
    case 'set-status': await setStatus(k); break;
    case 'set-leave': case 'clear-leave': {
      const v = b.dataset.act === 'clear-leave' ? null : ($('#leave-at')?.value || null);
      const { data, error } = await sb.from('cars').update({ leave_at: v, status_at: new Date().toISOString() }).eq('id', car.id).select().single();
      if (error) { toast(error.message); break; }
      car = data; toast(v ? `${v}에 나갈 예정이라고 표시해요` : '출차 예고를 지웠어요'); renderOv(); render(); break;
    }
    case 'close-ov': case 'close-photo': ov = null; renderOv(); break;
    /* 요청 응답 */
    case 'reply': await doReply(k); break;
    case 'resolve-req': await resolveReq(); break;
    case 'chat': ov = 'chat'; renderOv(); break;
    case 'free-input': freeInput = true; renderOv(true); updateMsgs(); setTimeout(() => $('#chat-in')?.focus(), 60); break;
    case 'quick': await sendMsg(b.dataset.t); break;
    case 'send-msg': { const i = $('#chat-in'); const v = i.value; i.value = ''; await sendMsg(v); i.focus(); break; }
    case 'log-call': if (active) sb.from('messages').insert({ request_id: active.id, sender: 'sys', text: `📞 차주가 ${who()}에게 전화를 걸었어요` }).then(() => { }); break;
    case 'photo': photoList = view === 'record' && rec ? rec.urls : aUrls; photoI = +b.dataset.i; ov = 'photo'; renderOv(); break;
    case 'save-photos': { const t = view === 'record' && rec ? rec : { r: active, urls: aUrls }; if (t.r) await savePhotos(t.r, t.urls); break; }
    /* 기록 */
    case 'records': await openRecords(); break;
    case 'rec': await openRecord(b.dataset.id); break;
    case 'home': view = 'home'; rec = null; render(); break;
    case 'keep': {
      if (!rec) break;
      const v = !rec.r.keep_o; const { error } = await sb.from('requests').update({ keep_o: v }).eq('id', rec.r.id);
      if (!error) { rec.r.keep_o = v; toast(v ? '⭐ 보관했어요. 자동 삭제되지 않아요' : '보관을 해제했어요'); render(); }
      break;
    }
    case 'export-png': await exportPNG(rec.r, rec.msgs, car.plate, rec.urls); break;
    case 'export-text': await exportText(rec.r, rec.msgs, car.plate); break;
    case 'leave': await leave(); break;
  }
});
document.addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'su-plate') { su.plate = e.target.value; updSuBtn(); }
  else if (id === 'su-phone') {
    const f = fmtPhone(e.target.value); if (e.target.value !== f) e.target.value = f; su.phone = f;
    const b = $('#su-codebtn'); if (b) b.disabled = su.phone.replace(/\D/g, '').length < 10;
  }
});
document.addEventListener('change', e => { if (e.target.id === 'su-agree') { su.agree = e.target.checked; updSuBtn(); } });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'chat-in' && !e.isComposing) { e.preventDefault(); const v = e.target.value; e.target.value = ''; sendMsg(v); }
});

boot();
