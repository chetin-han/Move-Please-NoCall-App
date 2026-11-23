/* 저기요 시험판 — 요청자 화면 (QR을 찍으면 열림: c.html?id=차량ID) */
const params = new URLSearchParams(location.search), carId = params.get('id');
const APP = $('#app'), OV = $('#ov');
let me = null, info = null, verified = false, cur = null, msgs = [], urls = [], unread = 0;
let ov = null, ovKey = '', photoI = 0, photoList = [], callNum, freeInput = false;
let mode = 'move', vErr = '';
let mv = { reason: null, floor: null, zone: '', memo: '', blobs: [], previews: [] };
let ac = { sub: null, name: '', plate: '', phone: '', desc: '', when: null, what: null, where: '', blobs: [], previews: [], agree: false };
let et = { sub: null };
let ringTimer = null, rings = 0, lastRes = null, sending = false, view = 'main', recs = [], rec = null, chan = null;
/* 이용 시간: 차번호 확인 후 15분, 남은 시간 5분 이내면 10분씩 연장 (서버도 같은 규칙으로 막음) */
const EXT_WIN = 5 * 60000;
let exp = 0, warned = false, expired = null, again = false;

/* ---------- 시작 ---------- */
async function boot() {
  try { me = await ensureUser(); }
  catch (e) { APP.innerHTML = `<div class="fatal">접속에 실패했어요.<br><small>${esc(e.message)}</small></div>`; return; }
  if (carId) {
    await loadInfo();
    if (info) {
      const { data: left } = await sb.rpc('car_pass_left', { cid: carId });
      setLeft(left); warned = verified && exp - Date.now() <= EXT_WIN;
      if (verified) await resumeActive();
    }
  }
  render();
  setInterval(tick, 500);
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !cur) return;
    const { data } = await sb.from('requests').select('*').eq('id', cur.id).maybeSingle();
    if (data) { await setCur(data); render(); }
  });
}
function setLeft(sec) { exp = sec > 0 ? Date.now() + sec * 1000 : 0; verified = exp > Date.now(); }
/* 확인 전에 보낸 요청이 아직 진행 중이면 이어서 보여 줌 */
async function resumeActive() {
  const { data: mine } = await sb.from('requests').select('*').eq('car_id', carId).eq('requester', me.id)
    .in('status', ['ringing', 'replied', 'resolving']).order('created_at', { ascending: false }).limit(1);
  if (mine?.[0]) { rings = 0; lastRes = null; await setCur(mine[0]); }
}
/* 15분(연장 포함)이 지나면 화면을 닫고 숫자 확인부터 다시 */
async function expire() {
  const hadReq = !!(cur && ['ringing', 'replied', 'resolving'].includes(cur.status));
  verified = false; exp = 0; expired = hadReq ? 'req' : 'plain'; again = false;
  stopRing(); if (chan) sb.removeChannel(chan); chan = null;
  cur = null; msgs = []; urls = []; unread = 0; sending = false; resetForms();
  ov = null; view = 'main'; rec = null; vErr = '';
  vib([300, 100, 300]);
  await loadInfo(); render(); scrollTo(0, 0);
}
async function loadInfo() { const { data } = await sb.rpc('car_public', { cid: carId }); info = data?.[0] || null; }
async function setCur(r) {
  const changed = !cur || cur.id !== r.id;
  cur = r;
  if (changed) { unread = 0; callNum = undefined; freeInput = false; }
  const { data } = await sb.from('messages').select('*').eq('request_id', r.id).order('id');
  msgs = data || [];
  urls = await photoUrls(r.photos);
  if (changed) subscribeCur();
  if (r.status === 'ringing') startRing(); else stopRing();
}
function subscribeCur() {
  if (chan) sb.removeChannel(chan);
  chan = sb.channel('req-' + cur.id)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'requests', filter: `id=eq.${cur.id}` }, p => {
      const prev = cur.status; cur = { ...cur, ...p.new };
      if (prev !== cur.status && ['replied', 'resolving', 'done'].includes(cur.status)) vib([300, 100, 300]);
      if (cur.status === 'ringing') startRing(); else stopRing();
      render();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `request_id=eq.${cur.id}` }, p => {
      const m = p.new; if (msgs.some(x => x.id === m.id)) return;
      msgs.push(m);
      if (m.sender === 'o') { if (ov !== 'chat') unread++; vib([200]); }
      updateMsgs();
    })
    .subscribe();
}
/* 응답이 올 때까지 차주 폰에 알림을 다시 보냄 (긴급 4초 · 보통 6초 · 정보 20초) */
const ringGap = () => ({ urgent: 4000, normal: 6000, info: 20000 }[cur?.level] || 6000);
function startRing() {
  if (ringTimer) return;
  const fire = async () => {
    if (!cur || cur.status !== 'ringing') { stopRing(); return; }
    const res = await notify('ring', cur.id);
    if (res && !res.skipped) { if (res.sent > 0) rings++; lastRes = res; updateRingInfo(); }
  };
  fire(); ringTimer = setInterval(fire, ringGap());
}
function stopRing() { if (ringTimer) { clearInterval(ringTimer); ringTimer = null; } }
function updateRingInfo() {
  setText('#r-rings', rings);
  const n = $('#r-nosub'); if (n) n.hidden = !(lastRes && (lastRes.subs === 0 || lastRes.error));
}

/* ---------- 화면 조각 ---------- */
const APPBAR = `<div class="appbar">${BRAND}<button class="linkbtn" data-act="records">내 기록</button></div>`;
/* 확인 뒤에는 오른쪽 위에 남은 시간, 5분 이하일 때만 '연장' */
const BAR = () => verified ? `<div class="appbar">${BRAND}<span class="sess" id="r-sess"><b id="r-left">--:--</b><button data-act="extend" id="r-ext" hidden>연장</button></span></div>` : APPBAR;
const label = () => `${info.plate_masked} ${info.color || ''} ${info.kind || ''}`.trim();
function ownerStatus() {
  const parts = [statusText(info), leaveText(info)].filter(Boolean);
  return sayHTML(parts, parts.length ? `차주가 남긴 말, ${ampm(info.status_at || info.leave_set_at)}` : '', 'box');
}
const CONTACT = extra => `<div class="links"><button data-act="chat">메시지<span class="unread" id="r-unread" hidden></span></button>${info.call_type === 'none' ? '' : '<button data-act="dial">전화</button>'}${extra || ''}</div>
  <div class="lastmsg" id="r-last"></div>`;
const photosHTML = (o, max) => o.previews.map((src, i) => `<div class="ph"><img src="${src}" alt="첨부 사진 ${i + 1}"><button class="x" data-act="rm-photo" data-i="${i}" aria-label="사진 빼기">✕</button></div>`).join('')
  + (o.blobs.length < max ? `<label class="ph add">사진<br>추가<input type="file" class="pfile" accept="image/*"${max > 1 ? ' multiple' : ''} hidden></label>` : '');
const curPhotoObj = () => mode === 'move' ? mv : ac;
const curPhotoMax = () => mode === 'move' ? 1 : 3;
const rowOpt = (f, k, t, cur, cls) => `<button class="row-opt${cls ? ' ' + cls : ''}${cur === k ? ' on' : ''}" data-act="pick" data-f="${f}" data-k="${k}">${t}</button>`;

const okMove = () => !!mv.reason;   // 위치는 선택
const okAcc = () => {
  if (!ac.sub || !ac.agree) return false;
  const ph = ac.phone.replace(/\D/g, '').length >= 10;
  if (ac.sub === 'bb') return !!(ac.when && ac.what && ph);
  return !!(ac.name.trim() && ph && (ac.sub === 'saw' || ac.plate.trim()));
};
const okEtc = () => !!et.sub;
const updSend = () => {
  const b = $('#send'); if (!b || sending) return;
  b.disabled = !(mode === 'move' ? okMove() : mode === 'acc' ? okAcc() : okEtc());
};

const V = {
  bad: () => `${APPBAR}
    <h2 class="big">${carId ? '등록되지 않은 QR이에요' : 'QR 주소가 올바르지 않아요'}</h2>
    <p class="lead">차주가 가입을 해지했거나 주소가 잘못됐어요.</p>`,

  /* 번호판 자체가 입력칸: 가려진 자리에 숫자를 채움 */
  verify: () => `${APPBAR}
    <div class="hero"><img src="intro/scene_a.jpg?v=2" alt=""></div>
    <p class="carnote">${esc([info.color, info.kind].filter(Boolean).join(' ') || '이 차')} 차주에게 조심스럽게 알려 드릴게요</p>
    <h2 class="big" style="margin-top:6px">가려진 숫자 ${(info.hide_idx || []).length}개를<br>채워 주세요</h2>
    <span class="plate big">${[...info.plate_hint].map((ch, i) => ch === '●'
      ? `<input class="dg" data-pos="${i + 1}" inputmode="numeric" maxlength="2" autocomplete="off" aria-label="가려진 숫자">`
      : ch === ' ' ? '<i class="gap"></i>' : esc(ch)).join('')}</span>
    ${vErr ? `<div class="errline">${esc(vErr)}</div>` : ''}
    <div class="spacer"></div>
    <button class="btn primary" data-act="verify" id="vbtn" disabled>확인</button>`,

  /* 시간이 끝난 뒤: 감사 인사와 가입 안내 */
  bye: () => `${APPBAR}
    <h2 class="big" style="margin-top:40px">이용해 주셔서<br>감사합니다</h2>
    <p class="lead">15분이 지나 화면을 닫았습니다.${expired === 'req' ? ' 보낸 요청은 다시 들어오면 이어서 볼 수 있어요.' : ''}</p>
    <div class="spacer"></div>
    <p class="pitch">내 차 앞유리에도 붙여 두면<br>전화번호 없이 연락받을 수 있어요</p>
    <a class="btn primary" href="./">내 차에도 붙이기</a>
    <button class="btn ghost" data-act="again">이 차에 다시 연락하기</button>`,

  form: () => {
    const head = `${BAR()}
      <div class="carline">${plateHTML(info.plate_masked)}<span>${esc([info.color, info.kind].filter(Boolean).join(' '))}</span></div>
      ${ownerStatus()}
      <div class="tabs">
        <button class="${mode === 'move' ? 'on' : ''}" data-act="mode" data-k="move">이동 요청</button>
        <button class="${mode === 'acc' ? 'on' : ''}" data-act="mode" data-k="acc">사고</button>
        <button class="${mode === 'etc' ? 'on' : ''}" data-act="mode" data-k="etc">그 밖에</button>
      </div>`;
    const sendBtn = (cls, txt, ok) => `<button class="btn ${cls}" data-act="send" id="send"${ok && !sending ? '' : ' disabled'}>${sending ? '보내는 중' : txt}</button>`;
    if (mode === 'move') return `${head}
      <div class="rows">${Object.entries(REASONS).map(([k, t]) => rowOpt('mv.reason', k, t, mv.reason)).join('')}</div>
      <div class="h">차 위치 <span class="opt-tag">선택</span></div>
      <div class="floors">${FLOORS.map(f => `<button class="fl${mv.floor === f ? ' on' : ''}" data-act="pick" data-f="mv.floor" data-k="${f}">${f}</button>`).join('')}</div>
      <input class="zone" id="mv-zone" maxlength="20" placeholder="상세위치 (기둥 번호 등)" value="${esc(mv.zone)}" autocomplete="off">
      <input class="fi" id="mv-memo" maxlength="30" placeholder="메모 (선택)" value="${esc(mv.memo)}" autocomplete="off">
      <div class="photos" id="photos">${photosHTML(mv, 1)}</div>
      <div class="spacer"></div>
      ${sendBtn('primary', '알림 보내기', okMove())}`;
    if (mode === 'acc') {
      const isBb = ac.sub === 'bb';
      return `${head}
      <div class="rows">
        ${rowOpt('ac.sub', 'hit', '제가 사고를 냈어요 (문콕·접촉)', ac.sub)}
        ${rowOpt('ac.sub', 'saw', '사고를 목격했어요', ac.sub)}
        ${rowOpt('ac.sub', 'bb', '블랙박스 영상을 부탁드려요', ac.sub)}
      </div>
      ${!ac.sub ? '' : isBb ? `
        <div class="h">언제</div>
        <div class="chips c3">${BB_WHEN.map(w => `<button class="chip${ac.when === w ? ' on' : ''}" data-act="pick" data-f="ac.when" data-k="${w}">${w}</button>`).join('')}</div>
        <div class="h">무슨 일</div>
        <div class="chips c3">${BB_WHAT.map(w => `<button class="chip${ac.what === w ? ' on' : ''}" data-act="pick" data-f="ac.what" data-k="${w}">${w}</button>`).join('')}</div>
        <input class="fi" id="ac-where" maxlength="30" placeholder="장소 (선택)" value="${esc(ac.where)}" style="margin-top:10px" autocomplete="off">
        <div class="h">영상을 받을 연락처</div>
        <input class="fi" id="ac-name" maxlength="10" placeholder="이름 (선택)" value="${esc(ac.name)}" autocomplete="name">
        <input class="fi" id="ac-phone" type="tel" inputmode="numeric" maxlength="13" placeholder="전화번호" value="${esc(ac.phone)}" autocomplete="tel">
        <label class="agree"><input type="checkbox" id="ac-agree"${ac.agree ? ' checked' : ''}> <span>차주에게 내 연락처를 전달하는 데 동의해요</span></label>
        <div class="spacer"></div>
        ${sendBtn('primary', '영상 확인 요청 보내기', okAcc())}` : `
        <div class="h">내 정보</div>
        <input class="fi" id="ac-name" maxlength="10" placeholder="이름" value="${esc(ac.name)}" autocomplete="name">
        <input class="fi" id="ac-plate" maxlength="12" placeholder="${ac.sub === 'saw' ? '내 차량번호 (목격자는 비워도 돼요)' : '내 차량번호'}" value="${esc(ac.plate)}" autocomplete="off">
        <input class="fi" id="ac-phone" type="tel" inputmode="numeric" maxlength="13" placeholder="전화번호" value="${esc(ac.phone)}" autocomplete="tel">
        <div class="photos" id="photos">${photosHTML(ac, 3)}</div>
        <textarea id="ac-desc" maxlength="60" placeholder="사고 내용 (선택)">${esc(ac.desc)}</textarea>
        <label class="agree"><input type="checkbox" id="ac-agree"${ac.agree ? ' checked' : ''}> <span>차주에게 내 이름·차량번호·전화번호와 사진을 전달하는 데 동의해요</span></label>
        <div class="spacer"></div>
        ${sendBtn('danger', '긴급 알림 보내기', okAcc())}`}`;
    }
    const sel = ETC[et.sub];
    return `${head}
      ${ETC_GROUPS.map(g => `<div class="grp${g.urgent ? ' urgent' : ''}">${g.g}</div>
        <div class="rows">${g.items.map(i => rowOpt('et.sub', i.k, i.t, et.sub, g.urgent ? 'urgent' : '')).join('')}</div>`).join('')}
      ${sel?.lv === 'urgent' ? `<div class="hint">위급하면 먼저 신고해 주세요.</div>${telBtns(sel.tel)}` : ''}
      <div class="spacer"></div>
      ${sendBtn(sel?.lv === 'urgent' ? 'danger' : 'primary', sel?.lv === 'urgent' ? '긴급 알림 보내기' : '알림 보내기', okEtc())}`;
  },

  /* 기다리는 중: 가장 궁금한 '지난 시간'을 가장 크게 */
  wait: () => {
    const u = cur.level === 'urgent';
    return `${BAR()}
      <img class="tapmark${u ? ' fast' : ''}" src="icons/icon-192.png?v=2" alt="">
      <div class="clock" id="r-el">0:00</div>
      <h2 class="big" style="margin-top:10px">${cur.feedback ? '직접 와 달라고 다시 알리고 있어요' : u ? '긴급 알림을 보내고 있어요' : '차주 폰이 울리고 있어요'}</h2>
      <p class="lead">알림 <b id="r-rings">${rings}</b>번 보냄. 이 화면을 열어 두세요.</p>
      ${ownerStatus()}
      ${cur.kind === 'etc' && u ? telBtns(ETC[cur.sub]?.tel) : ''}
      <div class="hint" id="r-nosub" hidden>차주 폰의 알림이 꺼져 있는 것 같아요. 메시지나 전화도 해 보세요.</div>
      <div class="hint" id="r-hint" hidden>${cur.kind === 'acc' ? '연락이 닿지 않으면 떠나기 전에 경찰(112)에도 알려 두세요.' : '답이 늦으면 메시지나 전화를 해 보세요.'}</div>
      <div class="spacer"></div>
      ${CONTACT()}
      <button class="btn ghost" data-act="cancel">호출 취소하기</button>`;
  },

  replied: () => {
    const rp = REP(cur.reply) || { t: '확인했어요', min: 0 };
    const took = `차주가 ${secs(new Date(cur.replied_at) - new Date(cur.created_at))} 만에 답했어요`;
    if (cur.reply === 'neutral') return `${BAR()}
      ${sayHTML([rp.t], took, 'big')}
      <div class="caution"><b>천천히, 무리하지 마세요.</b> 경사진 곳이거나 혼자 밀기 어려우면 밀지 마세요. 전자식 주차브레이크 차는 중립이어도 안 밀릴 수 있어요.</div>
      <div class="rows">
        <button class="row-opt" data-act="fb" data-k="pushfail">밀어봤는데 안 돼요</button>
        <button class="row-opt" data-act="fb" data-k="notneutral">중립이 아닌 것 같아요</button>
        <button class="row-opt" data-act="fb" data-k="nospace">밀 공간이 없어요</button>
      </div>
      <div class="spacer"></div>
      ${CONTACT()}
      <button class="btn primary" data-act="resolve">해결됐어요</button>
      <button class="btn ghost" data-act="cancel">호출 취소하기</button>`;
    return `${BAR()}
      ${sayHTML([rp.t], took, 'big')}
      ${rp.min ? `<div class="clock" id="r-cd">--:--</div><p class="lead">도착 예상까지</p>` : ''}
      ${cur.reply === 'acc_call' ? '<p class="lead">차주가 곧 전화할 거예요.</p>' : ''}
      ${cur.reply === 'etc_report' ? `<p class="lead">차주가 신고를 부탁했어요.</p>${telBtns(ETC[cur.sub]?.tel || 'both')}` : ''}
      ${cur.reply === 'cant' ? '<p class="lead">지금은 바로 오기 어렵다고 해요. 메시지나 전화로 이야기해 보세요.</p>' : ''}
      <div class="spacer"></div>
      ${CONTACT()}
      <button class="btn primary" data-act="resolve">해결됐어요</button>
      <button class="btn ghost" data-act="cancel">호출 취소하기</button>`;
  },

  resolving: () => {
    const left = new Date(cur.resolve_req_at).getTime() + 5 * 60000 - Date.now();
    return `${BAR()}
      <h2 class="big">차주가 해결됐다고 알렸어요</h2>
      <div class="clock" id="r-auto">${mmss(Math.max(0, left))}</div>
      <p class="lead">뒤에 자동으로 완료돼요</p>
      <div class="spacer"></div>
      ${CONTACT()}
      <button class="btn primary" data-act="resolve">네, 해결됐어요</button>
      <button class="btn ghost" data-act="fb" data-k="notyet">아직 안 됐어요</button>`;
  },

  done: () => {
    const cancelled = cur.status === 'cancelled';
    const sentThanks = msgs.some(m => m.sender === 'r' && m.text.startsWith('감사 인사: '));
    const th = cur.kind === 'move' ? THANKS.move : THANKS.other;
    const sub = cancelled ? '' : cur.kind === 'acc' ? '알려 주셔서 감사합니다. 이후 보험 처리는 차주와 직접 진행해 주세요.'
      : cur.done_at ? `요청부터 해결까지 ${secs(new Date(cur.done_at) - new Date(cur.created_at))}${cur.resolved_by === 'auto' ? ' (자동 완료)' : ''}` : '';
    return `${BAR()}
      <h2 class="big" style="margin-top:28px">${cancelled ? '호출을 취소했어요' : '해결됐어요'}</h2>
      ${sub ? `<p class="lead">${sub}</p>` : ''}
      ${cancelled ? '' : sentThanks ? '<p class="okline">감사 인사를 보냈어요</p>'
        : `<div class="h">차주에게 감사 인사</div><div class="rows">${th.map(t => `<button class="row-opt" data-act="thanks" data-t="${esc(t)}">${t}</button>`).join('')}</div>`}
      <div class="spacer"></div>
      <button class="btn ghost" data-act="this-rec">기록 보기</button>
      <button class="btn primary" data-act="restart">처음으로</button>`;
  },

  records: () => `<div class="appbar"><button class="back" data-act="main" aria-label="뒤로">‹</button>내 기록<span class="appbar-sub">이 폰에서 보낸 요청</span></div>${recordListHTML(recs)}`,
  record: () => `<div class="appbar"><button class="back" data-act="records" aria-label="뒤로">‹</button>기록 상세</div>${recordDetailHTML(rec.r, rec.msgs, 'r', null, rec.urls)}`
};

function render(keepScroll) {
  const y = scrollY;
  let h;
  if (view === 'records') h = V.records();
  else if (view === 'record' && rec) h = V.record();
  else if (!carId || !info) h = V.bad();
  else if (!cur && !verified) h = expired && !again ? V.bye() : V.verify();
  else if (!cur) h = V.form();
  else if (cur.status === 'ringing') h = V.wait();
  else if (cur.status === 'replied') h = V.replied();
  else if (cur.status === 'resolving') h = V.resolving();
  else h = V.done();
  APP.className = 'app'; APP.innerHTML = h;
  if (keepScroll) scrollTo(0, y);
  updateMsgs(); updateRingInfo(); renderOv(); tick();
}
function updateMsgs() {
  const u = $('#r-unread'); if (u) { u.hidden = unread <= 0; u.textContent = unread; }
  const last = [...msgs].reverse().find(m => m.sender === 'o');
  setText('#r-last', last ? `차주: ${last.text}` : '');
  const box = $('#chat-msgs');
  if (box && cur) { const h = msgHTML(cur, msgs, 'r', urls); if (box.dataset.h !== h) { box.dataset.h = h; box.innerHTML = h; box.scrollTop = box.scrollHeight; } }
}
function tick() {
  if (verified) {
    const left = exp - Date.now();
    if (left <= 0) { expire(); return; }
    const w = left <= EXT_WIN, bar = $('#r-sess');
    if (bar) { bar.classList.toggle('warn', w); setText('#r-left', mmss(left)); $('#r-ext').hidden = !w; }
    if (w && !warned) { warned = true; vib([200, 100, 200]); toast('5분 뒤 화면이 닫혀요. 더 필요하면 위의 연장을 눌러 주세요', 4500); }
  }
  if (!cur || view !== 'main') return;
  if (cur.status === 'ringing') {
    const el = Date.now() - new Date(cur.feedback_at || cur.created_at).getTime();
    setText('#r-el', clock(el));
    const h = $('#r-hint'); if (h) h.hidden = el < 20000;
  }
  if (cur.status === 'replied') {
    const rp = REP(cur.reply);
    if (rp?.min) { const rem = new Date(cur.replied_at).getTime() + rp.min * 60000 - Date.now(); setText('#r-cd', rem > 0 ? mmss(rem) : '곧 도착'); }
  }
  if (cur.status === 'resolving') setText('#r-auto', mmss(Math.max(0, new Date(cur.resolve_req_at).getTime() + 5 * 60000 - Date.now())));
}

/* ---------- 겹쳐 뜨는 화면 ---------- */
const maskNum = n => { const d = n.replace(/\D/g, ''); return d.length >= 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}●●-●●${d.slice(-2)}` : n; };
function dialOv() {
  const t = info.call_type;
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>차주에게 전화</b></div></div>
    <div class="dial">${callNum ? `
      <span class="tag">${t === 'safe' ? '안심번호 (시험판에서는 차주 번호로 연결)' : '차주 휴대폰 번호'}</span>
      <div class="num">${esc(t === 'safe' ? maskNum(callNum) : callNum)}</div>
      <div class="note">누르면 폰의 전화 앱이 열리고 번호가 들어가 있어요.${t === 'safe' ? ' 정식 서비스에서는 0507 안심번호로 연결돼 서로의 번호가 남지 않아요.' : ''}</div>
      <div class="spacer"></div>
      <a class="btn primary" href="tel:${callNum.replace(/\D/g, '')}" data-act="log-call">전화 걸기</a>`
      : `<div class="note">차주가 전화 연결을 꺼 두었어요. 메시지로 연락해 주세요.</div>`}
    </div></div>`;
}
function renderOv(force) {
  if ((ov === 'chat' || ov === 'dial') && !cur) ov = null;
  const k = ov === 'photo' ? 'photo' + photoI : (ov || '') + '|' + (cur?.id || '') + '|' + freeInput;
  if (!force && k === ovKey) return; ovKey = k;
  OV.innerHTML = ov === 'chat' ? chatOvHTML('차주와 메시지', `${esc(info?.plate_masked || '')} 차주, 번호는 서로 보이지 않아요`, QUICK_OF(cur, 'r'), freeInput)
    : ov === 'dial' ? dialOv() : ov === 'photo' ? photoOvHTML(photoList, photoI) : '';
  if (ov === 'chat') { unread = 0; updateMsgs(); }
}

/* ---------- 동작 ---------- */
async function insertReq(row) {
  const { data, error } = await sb.from('requests').insert({ car_id: carId, car_label: label(), ...row }).select().single();
  if (error) throw error;
  rings = 0; lastRes = null; await setCur(data);
}
async function send() {
  if (sending) return;
  sending = true; render(true);
  try {
    if (mode === 'move') {
      if (!okMove()) throw new Error('입력을 확인해 주세요');
      const photos = []; for (const b of mv.blobs) photos.push(await uploadPhoto(b, me.id));
      const loc = (mv.floor || mv.zone.trim() || mv.memo.trim()) ? { floor: mv.floor || null, zone: mv.zone.trim() || null, memo: mv.memo.trim() || null } : null;
      await insertReq({ kind: 'move', level: 'normal', reason: mv.reason, loc, photos });
    } else if (mode === 'acc') {
      if (!okAcc()) throw new Error('입력을 확인해 주세요');
      if (ac.sub === 'bb') await insertReq({ kind: 'bb', level: 'normal', sub: 'bb', acc: { when: ac.when, what: ac.what, where: ac.where.trim() || null, name: ac.name.trim() || null, phone: ac.phone } });
      else {
        const photos = [];
        for (let i = 0; i < ac.blobs.length; i++) { toast(`사진 올리는 중… ${i + 1}/${ac.blobs.length}`, 1200); photos.push(await uploadPhoto(ac.blobs[i], me.id)); }
        await insertReq({ kind: 'acc', level: 'urgent', sub: ac.sub, photos, acc: { who: ac.sub, name: ac.name.trim(), plate: ac.plate.trim(), phone: ac.phone, desc: ac.desc.trim() } });
      }
    } else {
      const it = ETC[et.sub]; if (!it) throw new Error('알림 내용을 골라 주세요');
      await insertReq({ kind: 'etc', level: it.lv, sub: it.k });
    }
    sending = false; render(); scrollTo(0, 0);
  } catch (e) {
    sending = false;
    const rls = /row-level security|violates/i.test(e.message || '');
    toast(rls ? '이용 시간이 끝나 보내지 못했어요. 숫자를 다시 확인해 주세요' : '보내지 못했어요: ' + (e.message || e), 4000);
    if (rls) await expire(); else render(true);
  }
}
async function updateCur(patch, sysText) {
  const { data, error } = await sb.from('requests').update(patch).eq('id', cur.id).select().single();
  if (error) { toast('저장하지 못했어요: ' + error.message); return false; }
  if (sysText) await sb.from('messages').insert({ request_id: cur.id, sender: 'sys', text: sysText });
  cur = data; if (cur.status === 'ringing') startRing(); else stopRing();
  render(); return true;
}
async function sendMsg(text) {
  text = String(text || '').trim(); if (!text || !cur) return;
  const { data, error } = await sb.from('messages').insert({ request_id: cur.id, sender: 'r', text }).select().single();
  if (error) { toast('보내지 못했어요: ' + error.message); return; }
  if (!msgs.some(x => x.id === data.id)) msgs.push(data);
  updateMsgs();
  notify('msg', cur.id, { text });
}
async function openRecords() {
  const { data } = await sb.from('requests').select('*').eq('requester', me.id).order('created_at', { ascending: false }).limit(50);
  recs = data || []; view = 'records'; rec = null; render(); scrollTo(0, 0);
}
async function openRecord(id) {
  const r = recs.find(x => x.id === id) || (cur && cur.id === id ? cur : null); if (!r) return;
  const { data } = await sb.from('messages').select('*').eq('request_id', id).order('id');
  rec = { r, msgs: data || [], urls: await photoUrls(r.photos) }; view = 'record'; render(); scrollTo(0, 0);
}
function resetForms() {
  [mv, ac].forEach(o => o.previews.forEach(u => URL.revokeObjectURL(u)));
  mv = { reason: null, floor: null, zone: '', memo: '', blobs: [], previews: [] };
  ac = { sub: null, name: ac.name, plate: ac.plate, phone: ac.phone, desc: '', when: null, what: null, where: '', blobs: [], previews: [], agree: false };
  et = { sub: null };
}
const setField = (path, v) => { const [o, f] = path.split('.'); ({ mv, ac, et })[o][f] = v; };

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const k = b.dataset.k;
  switch (b.dataset.act) {
    case 'verify': {
      const byPos = Object.fromEntries($$('.dg').map(i => [i.dataset.pos, i.value.trim()]));
      const ans = info.hide_idx.map(pos => byPos[pos] || '').join('');
      const { data } = await sb.rpc('car_check', { cid: carId, idx: info.hide_idx, ans });
      if (data > 0) { setLeft(data); warned = false; expired = null; again = false; vErr = ''; await resumeActive(); render(); scrollTo(0, 0); }
      else { vErr = '숫자가 맞지 않아요. 다른 자리로 다시 확인해 주세요.'; await loadInfo(); render(); }
      break;
    }
    case 'extend': {
      const { data } = await sb.rpc('car_extend', { cid: carId });
      if (data > 0) { setLeft(data); warned = exp - Date.now() <= EXT_WIN; toast('10분 연장했어요'); tick(); }
      else toast('남은 시간이 5분 이내일 때 연장할 수 있어요');
      break;
    }
    case 'again': again = true; vErr = ''; render(); scrollTo(0, 0); break;
    case 'mode': mode = k; render(); break;
    case 'pick': setField(b.dataset.f, k); render(true); break;
    case 'rm-photo': { const o = curPhotoObj(), i = +b.dataset.i; URL.revokeObjectURL(o.previews[i]); o.blobs.splice(i, 1); o.previews.splice(i, 1); $('#photos').innerHTML = photosHTML(o, curPhotoMax()); break; }
    case 'send': await send(); break;
    case 'cancel':
      if (!cur || !confirm('호출을 취소할까요? 차주 폰의 알림이 멈춰요.')) return;
      await updateCur({ status: 'cancelled' }); break;
    case 'fb': {
      const code = k;
      await updateCur({ status: 'ringing', reply: null, feedback: code, feedback_at: new Date().toISOString(), resolve_req_at: null },
        `요청자: ${FEEDBACK[code]}${code === 'notyet' ? '' : ' → 직접 와 주셔야 해요'}`);
      break;
    }
    case 'resolve': await updateCur({ status: 'done', done_at: new Date().toISOString(), resolved_by: 'r' }); break;
    case 'thanks': {
      const t = '감사 인사: ' + b.dataset.t;
      const { error } = await sb.from('messages').insert({ request_id: cur.id, sender: 'r', text: t });
      if (error) { toast('보내지 못했어요'); break; }
      msgs.push({ sender: 'r', text: t, created_at: new Date().toISOString(), id: -Date.now() });
      notify('thanks', cur.id, { text: b.dataset.t }); toast('감사 인사를 보냈어요'); render(); break;
    }
    case 'restart': stopRing(); if (chan) sb.removeChannel(chan); chan = null; cur = null; msgs = []; urls = []; resetForms(); view = 'main';
      verified = false; exp = 0; expired = null; again = false; vErr = '';   // 다시 요청하려면 숫자 확인부터
      await loadInfo(); render(); scrollTo(0, 0); break;
    case 'chat': ov = 'chat'; renderOv(); break;
    case 'free-input': freeInput = true; renderOv(true); updateMsgs(); setTimeout(() => $('#chat-in')?.focus(), 60); break;
    case 'dial':
      if (info.call_type === 'none') return;
      if (callNum === undefined) { const { data } = await sb.rpc('call_number', { rid: cur.id }); callNum = data || null; }
      ov = 'dial'; renderOv(true); break;
    case 'log-call': if (cur) sb.from('messages').insert({ request_id: cur.id, sender: 'sys', text: '요청자가 전화를 걸었어요' }).then(() => { }); break;
    case 'close-ov': case 'close-photo': ov = null; renderOv(); break;
    case 'quick': await sendMsg(b.dataset.t); break;
    case 'send-msg': { const i = $('#chat-in'); const v = i.value; i.value = ''; await sendMsg(v); i.focus(); break; }
    case 'photo': photoList = rec ? rec.urls : urls; photoI = +b.dataset.i; ov = 'photo'; renderOv(); break;
    case 'save-photos': if (rec) await savePhotos(rec.r, rec.urls); break;
    case 'keep': {
      if (!rec) break;
      const v = !rec.r.keep_r; const { error } = await sb.from('requests').update({ keep_r: v }).eq('id', rec.r.id);
      if (!error) { rec.r.keep_r = v; toast(v ? '보관했어요. 자동 삭제되지 않아요' : '보관을 해제했어요'); render(true); }
      break;
    }
    case 'records': await openRecords(); break;
    case 'this-rec': recs = [cur]; await openRecord(cur.id); break;
    case 'rec': await openRecord(b.dataset.id); break;
    case 'main': view = 'main'; rec = null; render(); break;
    case 'export-png': await exportPNG(rec.r, rec.msgs, null, rec.urls); break;
    case 'export-text': await exportText(rec.r, rec.msgs, null); break;
  }
});
document.addEventListener('input', e => {
  const t = e.target, id = t.id;
  if (t.classList.contains('dg')) {
    /* 한 칸에 한 자리. 빠르게 두 자리를 치거나 붙여 넣으면 다음 칸으로 넘김 */
    const all = $$('.dg'), at = all.indexOf(t), d = t.value.replace(/\D/g, '');
    t.value = d.slice(0, 1);
    for (let k = 1; k < d.length && all[at + k]; k++) all[at + k].value = d[k];
    const n = all[Math.min(at + d.length, all.length - 1)];
    if (d && n && n !== t) n.focus();
    const vb = $('#vbtn'); if (vb) vb.disabled = all.some(x => !x.value);
    return;
  }
  if (id === 'mv-zone') mv.zone = t.value;
  else if (id === 'mv-memo') mv.memo = t.value;
  else if (id === 'ac-name') ac.name = t.value;
  else if (id === 'ac-plate') ac.plate = t.value;
  else if (id === 'ac-phone') { const f = fmtPhone(t.value); if (t.value !== f) t.value = f; ac.phone = f; }
  else if (id === 'ac-desc') ac.desc = t.value;
  else if (id === 'ac-where') ac.where = t.value;
  else return;
  updSend();
});
document.addEventListener('change', async e => {
  if (e.target.id === 'ac-agree') { ac.agree = e.target.checked; updSend(); }
  if (e.target.classList.contains('pfile')) {
    const o = curPhotoObj(), max = curPhotoMax();
    for (const f of [...e.target.files].slice(0, max - o.blobs.length)) { const b = await resizeImage(f); if (b) { o.blobs.push(b); o.previews.push(URL.createObjectURL(b)); } }
    const box = $('#photos'); if (box) box.innerHTML = photosHTML(o, max);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'chat-in' && !e.isComposing) { e.preventDefault(); const v = e.target.value; e.target.value = ''; sendMsg(v); }
  if (e.key === 'Enter' && e.target.classList.contains('dg')) { const vb = $('#vbtn'); if (vb && !vb.disabled) vb.click(); }
});

boot();
