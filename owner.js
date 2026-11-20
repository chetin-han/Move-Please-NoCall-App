/* 무브콜 시험판 — 차주 앱 (가입 · 대기 · 요청 응답 · 메시지 · 기록) */
const params = new URLSearchParams(location.search);
const APP = $('#app'), OV = $('#ov');
let me = null, car = null, active = null, aMsgs = [], aUrls = [], unread = 0;
let view = 'home', recs = [], rec = null;            // 기록 화면
let ov = null, ovKey = '', photoI = 0, photoList = [];  // 겹쳐 뜨는 화면
let su = null, lastBuzz = 0, pState = 'unsupported', deferredInstall = null, chan = null;

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (!car) render(); });

const pushWhy = w => ({
  denied: '알림이 차단돼 있어요. 폰 설정 → 앱(크롬 또는 무브콜) → 알림에서 허용해 주세요.',
  default: '알림 허용 창에서 "허용"을 눌러 주세요.',
  'ios-not-installed': '아이폰은 홈 화면에 추가한 무브콜 앱에서만 알림을 켤 수 있어요.',
  unsupported: '이 브라우저는 폰 알림을 지원하지 않아요. 크롬(안드로이드) 또는 홈 화면에 추가한 앱(아이폰)으로 열어 주세요.'
})[w] || ('알림을 켜지 못했어요: ' + w);

/* ---------- 시작 ---------- */
async function boot() {
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch (e) { } }
  try { me = await ensureUser(); }
  catch (e) {
    APP.innerHTML = `<div class="fatal">로그인에 실패했어요.<br><small>${esc(e.message)}</small><br><br>Supabase에서 익명 로그인(Allow anonymous sign-ins)이 켜져 있는지 확인해 주세요.</div>`;
    return;
  }
  pState = await pushState();
  await loadCar();
  if (car) { await loadActive(); subscribe(); await handleParams(); }
  render();
  setInterval(tick, 500);
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !car) return;
    pState = await pushState(); await loadActive(); render();
  });
}
async function loadCar() {
  const { data } = await sb.from('cars').select('*').eq('owner', me.id).order('created_at', { ascending: false }).limit(1);
  car = data?.[0] || null;
}
async function loadActive() {
  const { data } = await sb.from('requests').select('*').eq('car_id', car.id).in('status', ['ringing', 'replied'])
    .order('created_at', { ascending: false }).limit(1);
  await setActive(data?.[0] || null);
}
async function setActive(r) {
  const changed = !active || !r || active.id !== r.id;
  active = r;
  if (!r) { aMsgs = []; aUrls = []; return; }
  if (changed) unread = 0;
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
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'requests', filter: `car_id=eq.${car.id}` }, p => {
      const r = p.new;
      if (!active || r.id !== active.id) return;
      if (['ringing', 'replied'].includes(r.status)) active = { ...active, ...r };
      else {
        if (r.status === 'cancelled') toast('요청자가 요청을 취소했어요');
        active = null; aMsgs = []; aUrls = []; if (ov === 'chat') ov = null;
      }
      render();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => {
      const m = p.new;
      if (active && m.request_id === active.id && !aMsgs.some(x => x.id === m.id)) {
        aMsgs.push(m);
        if (m.sender === 'r') { if (ov !== 'chat') unread++; vib([200]); }
        updateMsgs();
      }
      if (rec && m.request_id === rec.r.id && !rec.msgs.some(x => x.id === m.id)) rec.msgs.push(m);
    })
    .subscribe();
}
/* 알림의 버튼(곧 갈게요 등)을 누르고 들어온 경우 바로 답장 */
async function handleParams() {
  const rid = params.get('rid'), reply = params.get('reply'), chat = params.get('chat');
  if (rid && (!active || active.id !== rid)) {
    const { data } = await sb.from('requests').select('*').eq('id', rid).maybeSingle();
    if (data && ['ringing', 'replied'].includes(data.status)) await setActive(data);
  }
  if (reply && active && active.id === rid && active.status === 'ringing' && REP(reply)) await doReply(reply, true);
  if (chat && active) ov = 'chat';
  if (rid || reply || chat) history.replaceState(null, '', location.pathname);
}

/* ---------- 화면 ---------- */
const OTOP = `<div class="o-top"><div class="o-date" id="o-date"></div><div class="o-clock" id="o-clock"></div></div>`;
const NH = t => `<div class="noti-h"><span class="logo">P</span>무브콜${t ? ' · ' + t : ''}<span class="now">지금</span></div>`;
const chatBtn = () => `<button class="btn soft" data-act="chat">💬 ${active.kind === 'acc' ? '신고자' : '요청자'}와 메시지<span class="unread" id="o-unread" hidden></span></button><div class="lastmsg" id="o-last"></div>`;
const carUrl = () => new URL('c.html?id=' + car.id, location.href).href;
function accCard(r, urls) {
  const a = r.acc || {};
  return `<span class="reason">${WHO[a.who] || ''} · ${WHO_LONG[a.who] || ''}</span>
    <div class="info">
      <div><span>이름</span><b>${esc(a.name)}</b></div>
      <div><span>차량번호</span><b>${a.plate ? esc(a.plate) : '-'}</b></div>
      <div><span>전화번호</span><a href="tel:${esc(String(a.phone || '').replace(/\D/g, ''))}" data-act="log-call">${esc(a.phone)} 📞</a></div>
    </div>
    ${a.desc ? `<div class="quote">“${esc(a.desc)}”</div>` : ''}
    ${urls.length ? `<div class="thumbs">${urls.map((u, i) => `<img src="${u}" data-act="photo" data-i="${i}" alt="사고 사진 ${i + 1}">`).join('')}</div>
      <button class="btn soft sm" data-act="save-photos">📥 사고 사진 ${urls.length}장 저장</button>` : '<p class="muted" style="margin-top:8px">첨부 사진 없음</p>'}`;
}
const W = {
  welcome: () => `<div class="welcome">
      <span class="logo big">P</span>
      <h2>무브콜</h2>
      <p class="lead">QR 스티커 하나로<br>주차 이동 요청과 사고 알림을 받아요</p>
      <ul>
        <li>📳 요청이 오면 답할 때까지 알림이 반복돼요 — 회의 중엔 진동으로</li>
        <li>🛡 내 번호를 드러내지 않고 연락받아요</li>
        <li>🚨 사고가 나면 상대 연락처·사진과 함께 긴급 알림</li>
      </ul>
      ${isIOS && !isStandalone ? `<div class="tipbox">📱 <b>아이폰은 먼저 앱으로 설치해 주세요.</b><br>Safari 아래쪽 <b>공유 버튼(□↑) → 홈 화면에 추가</b>를 누른 뒤, 홈 화면의 무브콜 아이콘으로 열어서 가입하세요. 그래야 알림을 받을 수 있어요.</div>` : ''}
      ${deferredInstall ? '<button class="btn ghost" data-act="install">📲 홈 화면에 앱으로 설치</button>' : ''}
      ${!isIOS && !isStandalone && !deferredInstall ? '<div class="tipbox">📲 크롬 메뉴(⋮) → <b>홈 화면에 추가</b>로 설치해 두면 앱처럼 쓸 수 있어요.</div>' : ''}
      <div class="spacer"></div>
      <button class="btn primary" data-act="signup">가입하기</button>
      <p style="margin-top:10px;opacity:.6;font-size:12px">시험판 · 입력한 정보는 시험이 끝나면 삭제돼요</p>
    </div>`,

  idle: () => `${OTOP}
    <div class="widget"><b>무브콜 · 대기 중</b><br>내 차 ${esc(car.plate)} (${esc(car.color)} ${esc(car.kind)})<br>요청이 오면 알림과 진동으로 알려 드려요
      <div class="numrow">📞 ${CALL_LABEL[car.call_type]}${car.call_type === 'none' ? '' : ' · ' + esc(car.phone)}<button data-act="open-set">변경</button></div>
      ${pState === 'on' ? '' : `<div class="warnline">⚠ 폰 알림이 꺼져 있어요. 이 화면을 닫으면 요청을 못 받아요. <button class="linkbtn" data-act="enable-push">알림 켜기</button></div>`}
      <div class="row2"><button data-act="sticker">🔲 내 QR</button><button data-act="records">🗂 기록</button><button data-act="test-push">📳 알림 시험</button></div>
    </div>
    <div class="o-foot">${isIOS ? '아이폰은 폰 알림으로 진동해요' : '이 화면이 켜져 있을 때는 화면에서도 진동해요 (화면을 한 번 눌러 두세요)'}<br>
      <button class="linkbtn" data-act="leave">가입 해지 · 시험 데이터 삭제</button></div>`,

  ring: () => `${OTOP}
    <div class="noti">
      ${NH('주차 이동 요청')}
      <div class="noti-t">🚗 차를 빼 주실 수 있나요?</div>
      <span class="reason">${esc(REASONS[active.reason] || '')}</span>
      ${active.msg ? `<div class="quote">“${esc(active.msg)}”</div>` : ''}
      <div id="o-extra"></div>
      <div class="vib">📳 요청 후 <span id="o-el">0초</span> · 답할 때까지 계속 울려요</div>
      <div class="replies">${REPLIES.map(r => `<button class="rp${r.k === 'cant' ? ' alt' : ''}" data-act="reply" data-k="${r.k}">${r.icon} ${r.t}${r.sub ? `<small>${r.sub}</small>` : ''}</button>`).join('')}</div>
    </div>
    <div class="o-foot">요청 시각 ${hhmm(active.created_at)}</div>`,

  accRing: () => `
    <div class="al-top"><div class="al-ic">🚨</div><div class="al-t">긴급 · 내 차 사고 알림</div>
      <div class="al-s">${esc(car.plate)} · 알림 후 <span id="o-el">0초</span> · 확인할 때까지 계속</div></div>
    <div class="noti">
      ${NH('긴급 알림')}
      ${accCard(active, aUrls)}
      <div id="o-extra"></div>
      <div class="replies col">${ACC_REPLIES.map((r, i) => `<button class="rp${i === 0 ? ' red' : ''}" data-act="reply" data-k="${r.k}">${r.icon} ${r.t}</button>`).join('')}</div>
    </div>`,

  replied: () => {
    const rp = REP(active.reply); return `${OTOP}
    <div class="noti">
      ${NH('')}
      <div class="noti-t">답장을 보냈어요</div>
      <div class="sent">${rp.icon} “${rp.t}”</div>
      <p class="muted" style="margin-top:4px">요청자 화면에 바로 표시됐어요 · 남은 시간</p>
      <div class="cd small" id="o-cd">--:--</div>
      ${chatBtn()}
      <button class="btn primary" data-act="done">🚗 차 옮겼어요</button>
    </div>`;
  },

  cant: () => `${OTOP}
    <div class="noti">${NH('')}<div class="noti-t">답장을 보냈어요</div><div class="sent">🙏 “지금은 못 가요”</div>
      <p class="muted" style="margin-top:4px">요청자 화면에 바로 표시됐어요</p>
      ${chatBtn()}
      <button class="btn ghost" data-act="done">그래도 옮겼어요</button></div>`,

  accReplied: () => {
    const rp = REP(active.reply); return `
    <div class="noti" style="margin-top:4px">
      ${NH('사고 알림')}
      <div class="noti-t">신고자에게 답장을 보냈어요</div>
      <div class="sent" style="font-size:16px">${rp.icon} “${rp.t}”</div>
      ${accCard(active, aUrls)}
      ${chatBtn()}
      <button class="btn primary" data-act="done">✅ 현장 확인 완료</button>
    </div>`;
  },

  records: () => `<div class="appbar"><button class="back" data-act="home" aria-label="뒤로">‹</button>기록<span class="appbar-sub">${esc(car.plate)}</span></div>${recordListHTML(recs)}`,
  record: () => `<div class="appbar"><button class="back" data-act="records" aria-label="뒤로">‹</button>기록 상세</div>${recordDetailHTML(rec.r, rec.msgs, 'o', car.plate, rec.urls)}`
};

function render() {
  let h, cls = 'app dark';
  if (!car) h = W.welcome();
  else if (view === 'records') { cls = 'app'; h = W.records(); }
  else if (view === 'record' && rec) { cls = 'app'; h = W.record(); }
  else if (!active) h = W.idle();
  else if (active.status === 'ringing') { if (active.kind === 'acc') { cls = 'app alert'; h = W.accRing(); } else h = W.ring(); }
  else h = active.kind === 'acc' ? W.accReplied() : active.reply === 'cant' ? W.cant() : W.replied();
  APP.className = cls; APP.innerHTML = h;
  updateMsgs(); renderOv(); tick();
}
function updateMsgs() {
  const u = $('#o-unread'); if (u) { u.hidden = unread <= 0; u.textContent = unread; }
  const last = [...aMsgs].reverse().find(m => m.sender === 'r');
  setText('#o-last', last && active ? `${nameOf('r', active)}: ${last.text}` : '');
  const ex = $('#o-extra'); if (ex) ex.innerHTML = aMsgs.filter(m => m.sender === 'r').map(m => `<div class="quote new">💬 ${esc(m.text)}</div>`).join('');
  const box = $('#chat-msgs');
  if (box && active) { const h = msgHTML(active, aMsgs, 'o', aUrls); if (box.dataset.h !== h) { box.dataset.h = h; box.innerHTML = h; box.scrollTop = box.scrollHeight; } }
}
function tick() {
  const now = new Date();
  setText('#o-clock', hhmm(now)); setText('#o-date', dateStr(now));
  if (active && active.status === 'ringing' && view === 'home') {
    const el = Date.now() - new Date(active.created_at).getTime(), iv = active.kind === 'acc' ? 2000 : 3000, c = Math.floor(el / iv);
    setText('#o-el', secs(el));
    if (c !== lastBuzz && !document.hidden) {
      lastBuzz = c;
      APP.classList.remove('buzz', 'hard'); void APP.offsetWidth; APP.classList.add('buzz'); if (active.kind === 'acc') APP.classList.add('hard');
      vib(active.kind === 'acc' ? [1000, 150, 1000] : [600, 200, 600]);
    }
  }
  if (active && active.status === 'replied') {
    const rp = REP(active.reply);
    if (rp?.min) { const rem = new Date(active.replied_at).getTime() + rp.min * 60000 - Date.now(); setText('#o-cd', rem > 0 ? mmss(rem) : '시간 지남'); }
  }
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
    <p class="muted" style="margin-top:14px;line-height:1.5">요청자 화면에는 차번호 뒤 두 자리가 가려져 보여요. (예: 12가 34●●)</p>`;
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
    const o = (k, t, d, rec, num) => `<button class="opt${su.type === k ? ' on' : ''}" data-act="su-type" data-k="${k}"><b>${su.type === k ? '◉' : '○'} ${t}</b>${rec ? '<span class="rec">권장</span>' : ''}<p>${d}</p>${num ? `<p><b style="font-size:13px">${num}</b></p>` : ''}</button>`;
    b = `<p class="muted" style="line-height:1.5">요청자가 '전화걸기'를 누르면 이 번호가 요청자 폰에 자동으로 입력돼요.</p>
      ${o('safe', '안심번호', '실제 번호 대신 0507 가상번호로 연결돼요. 요청자 통화 기록에도 내 번호가 남지 않아요.', true, '※ 시험판에서는 내 실제 번호로 연결돼요')}
      ${o('real', '내 휴대폰 번호', '요청자 폰 통화 기록에 내 실제 번호가 남아요.', false, esc(su.phone))}
      ${o('none', '전화 받지 않기', '전화걸기 버튼이 꺼지고 메시지로만 연락받아요.', false, '')}
      ${su.type === 'real' ? '<div class="warnbox">⚠ 실제 번호는 모르는 사람에게 그대로 노출돼요. 개인정보 보호를 위해 안심번호를 권장해요.</div>' : ''}`;
  } else if (su.step === 4) b = `
    <p class="muted" style="line-height:1.5">요청이 왔을 때 놓치지 않도록 폰 알림을 허용해 주세요. 앱을 닫아 둬도 답할 때까지 알림이 반복돼요.</p>
    ${isIOS && !isStandalone ? '<div class="warnbox">아이폰은 <b>홈 화면에 추가한 무브콜 앱</b>에서만 알림을 켤 수 있어요. 지금 브라우저에서 가입하면 앱을 열어 둔 동안만 알려 드려요.</div>' : ''}
    <div class="perm"><div class="tx"><b>🔔 알림 허용</b><p>요청·사고 알림을 진동과 함께 받아요</p></div><button class="${su.push === 'on' ? 'on' : ''}" data-act="su-push">${su.push === 'on' ? '허용함 ✓' : '허용하기'}</button></div>
    ${su.push === 'on' ? '<div class="perm"><div class="tx"><b>📳 알림 시험</b><p>지금 이 폰으로 시험 알림을 보내 봐요</p></div><button data-act="test-push">보내기</button></div>' : ''}
    ${su.pushMsg ? `<div class="${su.push === 'on' ? 'okline' : 'errline'}">${esc(su.pushMsg)}</div>` : ''}
    <div class="hint">💡 회의 중에도 받으려면 폰의 <b>방해금지 모드 예외 앱</b>에 ${isIOS ? '무브콜' : '크롬'}을 넣어 두세요.${isIOS ? '' : ' 크롬 알림의 소리·진동이 켜져 있는지도 확인해 주세요.'}</div>`;
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
      <button class="btn ghost" data-act="copy-url">🔗 주소 복사</button>
      <p class="muted center" style="margin-top:10px;line-height:1.5;font-size:12px">인쇄해서 앞유리 안쪽, 밖에서 잘 보이는 곳에 붙여 주세요.<br>시험할 때는 다른 폰으로 이 화면의 QR을 찍어도 돼요.</p></div></div>`;
}
function setOv() {
  const o = (k, t, d, rec) => `<button class="opt${car.call_type === k ? ' on' : ''}" data-act="set-num" data-k="${k}"><b>${car.call_type === k ? '◉' : '○'} ${t}</b>${rec ? '<span class="rec">권장</span>' : ''}<p>${d}</p></button>`;
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>요청자가 전화할 번호</b><div class="muted">언제든 바꿀 수 있어요</div></div></div>
    <div class="ov-body">
      ${o('safe', '안심번호', '0507 가상번호로 연결 (시험판에서는 내 실제 번호로 연결)', true)}
      ${o('real', '내 휴대폰 번호', '요청자 폰 통화 기록에 내 실제 번호가 남아요.', false)}
      ${o('none', '전화 받지 않기', '메시지로만 연락받아요.', false)}
      ${car.call_type === 'real' ? '<div class="warnbox">⚠ 실제 번호는 모르는 사람에게 그대로 노출돼요. 안심번호를 권장해요.</div>' : ''}
    </div></div>`;
}
function chatOv() {
  const q = active.kind === 'acc' ? QUICK.oAcc : QUICK.o;
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button>
      <div><b>${active.kind === 'acc' ? `신고자 ${esc(active.acc?.name || '')}님과 메시지` : '요청자와 메시지'}</b><div class="muted">번호는 서로 보이지 않아요</div></div></div>
    <div class="msgs" id="chat-msgs"></div>
    <div class="quick">${q.map(t => `<button data-act="quick" data-t="${esc(t)}">${t}</button>`).join('')}</div>
    <div class="inputbar"><input id="chat-in" maxlength="200" placeholder="메시지 입력" autocomplete="off" enterkeyhint="send"><button data-act="send-msg">전송</button></div></div>`;
}
function curOvKey() {
  if (ov === 'signup') return 'signup|' + suKey();
  if (ov === 'set') return 'set|' + car.call_type;
  if (ov === 'photo') return 'photo' + photoI;
  if (ov === 'chat') return 'chat|' + (active?.id || '');
  return ov || '';
}
function renderOv(force) {
  if (ov === 'chat' && !active) ov = null;
  const k = curOvKey(); if (!force && k === ovKey) return; ovKey = k;
  OV.innerHTML = ov === 'signup' ? signupOv() : ov === 'sticker' ? stickerOv() : ov === 'set' ? setOv()
    : ov === 'chat' ? chatOv() : ov === 'photo' ? photoOvHTML(photoList, photoI) : '';
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
async function doReply(k, fromNoti) {
  if (!active) return;
  vib(0);
  const { data, error } = await sb.from('requests').update({ status: 'replied', reply: k, replied_at: new Date().toISOString() })
    .eq('id', active.id).eq('status', 'ringing').select().maybeSingle();
  if (error) { toast('답장하지 못했어요: ' + error.message); return; }
  if (data) active = data; else await loadActive();
  render();
  if (fromNoti) toast(`“${REP(k).t}” 답장을 보냈어요`);
}
async function doDone() {
  if (!active) return;
  const { error } = await sb.from('requests').update({ status: 'done', done_at: new Date().toISOString() }).eq('id', active.id);
  if (error) { toast('저장하지 못했어요: ' + error.message); return; }
  toast(active.kind === 'acc' ? '현장 확인 완료를 알렸어요' : '이동 완료를 알렸어요');
  active = null; aMsgs = []; aUrls = []; ov = null; render();
}
async function sendMsg(text) {
  text = String(text || '').trim(); if (!text || !active) return;
  const { data, error } = await sb.from('messages').insert({ request_id: active.id, sender: 'o', text }).select().single();
  if (error) { toast('보내지 못했어요: ' + error.message); return; }
  if (!aMsgs.some(x => x.id === data.id)) aMsgs.push(data);
  updateMsgs();
}
async function openRecords() {
  const { data } = await sb.from('requests').select('*').eq('car_id', car.id).order('created_at', { ascending: false }).limit(50);
  recs = data || []; view = 'records'; rec = null; render();
}
async function openRecord(id) {
  const r = recs.find(x => x.id === id); if (!r) return;
  const { data } = await sb.from('messages').select('*').eq('request_id', id).order('id');
  rec = { r, msgs: data || [], urls: await photoUrls(r.photos) }; view = 'record'; render(); scrollTo(0, 0);
}
async function leave() {
  if (!confirm('시험 데이터(차량·요청·대화 기록)가 모두 지워집니다. 가입을 해지할까요?')) return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration(); const s = reg && await reg.pushManager.getSubscription();
    if (s) await s.unsubscribe();
  } catch (e) { }
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
    /* QR 스티커 · 번호 설정 */
    case 'sticker': ov = 'sticker'; renderOv(); break;
    case 'sticker-dl': {
      const blob = await stickerBlob(carUrl());
      const res = await saveFiles([new File([blob], `무브콜_QR스티커_${car.plate.replace(/\s/g, '')}.png`, { type: 'image/png' })]);
      if (res === 'downloaded') toast('스티커 이미지를 저장했어요');
      break;
    }
    case 'copy-url': try { await navigator.clipboard.writeText(carUrl()); toast('주소를 복사했어요'); } catch (err) { prompt('주소를 복사하세요', carUrl()); } break;
    case 'open-set': ov = 'set'; renderOv(); break;
    case 'set-num': {
      const { error } = await sb.from('cars').update({ call_type: k }).eq('id', car.id);
      if (error) { toast(error.message); break; }
      car.call_type = k; renderOv(); render(); break;
    }
    case 'close-ov': case 'close-photo': ov = null; renderOv(); break;
    /* 요청 응답 */
    case 'reply': await doReply(k); break;
    case 'done': await doDone(); break;
    case 'chat': ov = 'chat'; renderOv(); setTimeout(() => $('#chat-in')?.focus(), 60); break;
    case 'quick': await sendMsg(b.dataset.t); break;
    case 'send-msg': { const i = $('#chat-in'); const v = i.value; i.value = ''; await sendMsg(v); i.focus(); break; }
    case 'log-call': if (active) sb.from('messages').insert({ request_id: active.id, sender: 'sys', text: '📞 차주가 신고자에게 전화를 걸었어요' }).then(() => { }); break;
    case 'photo': photoList = view === 'record' && rec ? rec.urls : aUrls; photoI = +b.dataset.i; ov = 'photo'; renderOv(); break;
    case 'save-photos': { const t = view === 'record' && rec ? rec : { r: active, urls: aUrls }; if (t.r) await savePhotos(t.r, t.urls); break; }
    /* 기록 */
    case 'records': await openRecords(); break;
    case 'rec': await openRecord(b.dataset.id); break;
    case 'home': view = 'home'; rec = null; render(); break;
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
