/* 무브콜 시험판 — 요청자 화면 (QR을 찍으면 열림: c.html?id=차량번호) */
const params = new URLSearchParams(location.search), carId = params.get('id');
const APP = $('#app'), OV = $('#ov');
let me = null, info = null, cur = null, msgs = [], urls = [], unread = 0;
let ov = null, ovKey = '', photoI = 0, photoList = [], callNum;
let mode = 'move', form = { reason: null, msg: '' };
let acc = { who: null, name: '', plate: '', phone: '', desc: '', blobs: [], previews: [], agree: false };
let ringTimer = null, rings = 0, lastRes = null, sending = false, view = 'main', recs = [], rec = null, chan = null;

/* ---------- 시작 ---------- */
async function boot() {
  try { me = await ensureUser(); }
  catch (e) { APP.innerHTML = `<div class="fatal">접속에 실패했어요.<br><small>${esc(e.message)}</small></div>`; return; }
  if (carId) {
    const { data } = await sb.rpc('car_public', { cid: carId });
    info = data?.[0] || null;
    if (info) {
      const { data: mine } = await sb.from('requests').select('*').eq('car_id', carId).eq('requester', me.id)
        .in('status', ['ringing', 'replied']).order('created_at', { ascending: false }).limit(1);
      if (mine?.[0]) await setCur(mine[0]);
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
async function setCur(r) {
  const changed = !cur || cur.id !== r.id;
  cur = r;
  if (changed) { unread = 0; callNum = undefined; }
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
      if (prev === 'ringing' && cur.status === 'replied') vib([300, 100, 300]);
      if (cur.status !== 'ringing') stopRing();
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
/* 응답이 올 때까지 몇 초마다 차주 폰에 알림을 다시 보냄 */
function startRing() {
  if (ringTimer) return;
  const iv = cur.kind === 'acc' ? 4000 : 6000;
  const fire = async () => {
    if (!cur || cur.status !== 'ringing') { stopRing(); return; }
    const res = await notify('ring', cur.id);
    if (res && !res.skipped) { if (res.sent > 0) rings++; lastRes = res; updateRingInfo(); }
  };
  fire(); ringTimer = setInterval(fire, iv);
}
function stopRing() { if (ringTimer) { clearInterval(ringTimer); ringTimer = null; } }
function updateRingInfo() {
  setText('#r-rings', rings);
  const n = $('#r-nosub'); if (n) n.hidden = !(lastRes && (lastRes.subs === 0 || lastRes.error));
}

/* ---------- 화면 ---------- */
const APPBAR = `<div class="appbar"><span class="logo">P</span>무브콜<button class="linkbtn" data-act="records" style="color:var(--sub)">내 기록</button></div>`;
const label = () => `${info.plate_masked} ${info.color || ''} ${info.kind || ''}`.trim();
const LOCK = () => ({
  safe: '🔒 차주 전화번호는 보이지 않아요. 요청만 전달돼요.',
  real: '📞 차주가 휴대폰 번호로 전화 받기를 허용했어요.',
  none: '💬 차주는 메시지로만 연락받아요.'
})[info.call_type];
const CONTACT = () => `
  <div class="contact">
    <button class="cbtn" data-act="chat">💬 메시지<span class="unread" id="r-unread" hidden></span></button>
    <button class="cbtn call" data-act="dial"${info.call_type === 'none' ? ' disabled' : ''}>📞 전화걸기</button>
  </div>
  <div class="lastmsg" id="r-last"></div>`;
const accOK = () => !!(acc.who && acc.name.trim() && acc.phone.replace(/\D/g, '').length >= 10 && (acc.who === 'saw' || acc.plate.trim()) && acc.agree);
const updAccBtn = () => { const b = $('#a-send'); if (b && !sending) b.disabled = !accOK(); };
function photosHTML() {
  return acc.previews.map((src, i) => `<div class="ph"><img src="${src}" alt="첨부 사진 ${i + 1}"><button class="x" data-act="rm-photo" data-i="${i}" aria-label="사진 빼기">✕</button></div>`).join('')
    + (acc.blobs.length < 3 ? `<label class="ph add">📷<br>사진 추가<input type="file" id="a-file" accept="image/*" multiple hidden></label>` : '');
}

const V = {
  bad: () => `${APPBAR}<div class="card center" style="margin-top:30px"><div style="font-size:40px">🤔</div>
    <div class="big" style="margin-top:8px">${carId ? '등록되지 않은 QR이에요' : 'QR 주소가 올바르지 않아요'}</div>
    <p class="muted" style="margin-top:8px;line-height:1.6">차주가 가입을 해지했거나 주소가 잘못됐어요.</p></div>`,

  form: () => {
    const head = `${APPBAR}
      <div class="card">
        <div class="car"><div class="ic">🚗</div><div><div class="plate">${esc(info.plate_masked)}</div><div class="muted">${esc(info.color || '')} ${esc(info.kind || '')}</div></div></div>
        <div class="lockline">${LOCK()}</div>
      </div>
      <div class="seg">
        <button class="${mode === 'move' ? 'on' : ''}" data-act="mode" data-k="move">🚗 이동 요청</button>
        <button class="red ${mode === 'acc' ? 'on' : ''}" data-act="mode" data-k="acc">🚨 사고 알림</button>
      </div>`;
    if (mode === 'move') return `${head}
      <div class="h">어떤 이유인가요?</div>
      <div class="chips">${Object.entries(REASONS).map(([k, t]) => `<button class="chip${form.reason === k ? ' on' : ''}" data-act="reason" data-k="${k}">${t}</button>`).join('')}</div>
      <div class="h">남길 말 <span class="muted">(선택)</span></div>
      <textarea id="r-msg" maxlength="40" placeholder="예) 지하 2층 B-14 앞이에요">${esc(form.msg)}</textarea>
      <div class="cnt"><span id="r-msgcnt">${form.msg.length}</span>/40</div>
      <div class="spacer"></div>
      <button class="btn primary" data-act="send" id="r-send"${form.reason && !sending ? '' : ' disabled'}>${sending ? '보내는 중…' : '📳 차주에게 알림 보내기'}</button>`;
    return `${head}
      <div class="h">어떤 상황인가요?</div>
      <div class="chips">${Object.entries(WHO).map(([k, t]) => `<button class="chip red${acc.who === k ? ' on' : ''}" data-act="who" data-k="${k}">${t}</button>`).join('')}</div>
      <div class="h">내 정보 <span class="muted">(차주에게 전달돼요)</span></div>
      <input class="fi" id="a-name" maxlength="10" placeholder="이름" value="${esc(acc.name)}" autocomplete="name">
      <input class="fi" id="a-plate" maxlength="12" placeholder="${acc.who === 'saw' ? '내 차량번호 (목격자는 비워도 돼요)' : '내 차량번호 (예: 34나 5678)'}" value="${esc(acc.plate)}" autocomplete="off">
      <input class="fi" id="a-phone" type="tel" inputmode="numeric" maxlength="13" placeholder="전화번호 (예: 010-1234-5678)" value="${esc(acc.phone)}" autocomplete="tel">
      <div class="h">사고 사진 <span class="muted">(최대 3장)</span></div>
      <div class="photos" id="a-photos">${photosHTML()}</div>
      <div class="h">사고 내용 <span class="muted">(선택)</span></div>
      <textarea id="a-desc" maxlength="60" placeholder="예) 후진하다 뒷범퍼를 살짝 긁었어요">${esc(acc.desc)}</textarea>
      <label class="agree"><input type="checkbox" id="a-agree"${acc.agree ? ' checked' : ''}> <span>차주에게 내 이름·차량번호·전화번호와 사진을 전달하는 데 동의해요</span></label>
      <button class="btn danger" data-act="send-acc" id="a-send"${accOK() && !sending ? '' : ' disabled'}>${sending ? '보내는 중…' : '🚨 차주에게 긴급 알림 보내기'}</button>`;
  },

  wait: () => {
    const isAcc = cur.kind === 'acc';
    return `${APPBAR}
      <div class="pulse${isAcc ? ' red' : ''}">${isAcc ? '🚨' : '📳'}</div>
      <div class="big">${isAcc ? '차주에게 긴급 알림을 보내고 있어요' : '차주 폰에 알림을 보내고 있어요'}</div>
      <p class="center muted" style="margin-top:6px">알림 <b id="r-rings">${rings}</b>번 보냄 · <span id="r-el">0초</span> 지남</p>
      <ul class="tl">
        <li><span class="dot done">✓</span><div><div class="t">${isAcc ? '사고 알림 보냄' : '요청 보냄'}</div><div class="s">${hhmm(cur.created_at)} · ${isAcc ? `${WHO[cur.acc?.who] || ''} · 사진 ${(cur.photos || []).length}장` : esc(REASONS[cur.reason] || '')}</div></div></li>
        <li><span class="dot live${isAcc ? ' red' : ''}"></span><div><div class="t">차주 응답 기다리는 중</div><div class="s">답할 때까지 ${isAcc ? 4 : 6}초마다 다시 알려요 · 이 화면을 열어 두세요</div></div></li>
      </ul>
      <div class="hint" id="r-nosub" hidden>📵 차주 폰의 알림이 꺼져 있는 것 같아요. 차주가 무브콜 화면을 열어 두었다면 화면에서 알려 드려요. 메시지나 전화도 함께 해 보세요.</div>
      <div class="hint" id="r-hint" hidden>${isAcc ? '⚠ 차주와 연락이 닿지 않으면 현장을 떠나기 전에 경찰(112)에도 알려 두는 것이 안전해요.' : '💡 답이 늦으면 메시지를 남기거나 전화를 걸어 보세요.'}</div>
      <div class="spacer"></div>
      ${CONTACT()}
      ${isAcc ? '' : '<button class="btn ghost" data-act="cancel">요청 취소</button>'}`;
  },

  replied: () => {
    const rp = REP(cur.reply), isAcc = cur.kind === 'acc';
    return `${APPBAR}
      <div class="bubble"><div class="ic">${rp.icon}</div><div class="lb">“${rp.t}”</div>
        <div class="muted" style="margin-top:4px">차주가 ${secs(new Date(cur.replied_at) - new Date(cur.created_at))} 만에 답했어요</div></div>
      ${rp.min ? `<p class="center muted" style="margin-top:10px">도착 예상까지</p><div class="cd" id="r-cd">--:--</div>`
        : `<p class="center" style="margin-top:14px;font-size:14px;line-height:1.6">차주가 곧 전화할 거예요.<br><span class="muted">전화를 받을 수 있게 해 주세요.</span></p>`}
      <ul class="tl">
        <li><span class="dot done">✓</span><div><div class="t">${isAcc ? '사고 알림' : '요청'} 보냄 · 차주 확인</div><div class="s">${hhmm(cur.created_at)} → ${hhmm(cur.replied_at)}</div></div></li>
        <li><span class="dot live"></span><div><div class="t">${isAcc ? '차주가 현장 확인 중' : '차주가 오는 중'}</div><div class="s">${isAcc ? '연락처와 사진이 차주에게 전달됐어요' : '차를 옮기면 바로 알려 드려요'}</div></div></li>
      </ul>
      <div class="spacer"></div>
      ${CONTACT()}`;
  },

  cant: () => `${APPBAR}
    <div class="bubble gray"><div class="ic">🙏</div><div class="lb">“지금은 못 가요”</div>
      <div class="muted" style="margin-top:4px">차주가 ${secs(new Date(cur.replied_at) - new Date(cur.created_at))} 만에 답했어요</div></div>
    <p class="center" style="margin-top:16px;line-height:1.7;font-size:14px">차주가 지금은 바로 이동하기 어렵다고 답했어요.<br><span class="muted">메시지나 전화로 사정을 이야기해 보세요.</span></p>
    <div class="spacer"></div>
    ${CONTACT()}
    <button class="btn ghost" data-act="restart">처음으로</button>`,

  done: () => {
    const isAcc = cur.kind === 'acc', cancelled = cur.status === 'cancelled';
    return `${APPBAR}
      <div class="pulse ok">${cancelled ? '↩️' : '✅'}</div>
      <div class="big">${cancelled ? '요청을 취소했어요' : isAcc ? '차주가 현장을 확인했어요' : '차량이 이동했어요'}</div>
      <p class="center muted" style="margin-top:8px;line-height:1.6">${cancelled ? '' : isAcc ? '알려 주셔서 감사합니다.<br>이후 보험 처리는 차주와 직접 진행해 주세요.' : `요청부터 이동 완료까지 ${secs(new Date(cur.done_at) - new Date(cur.created_at))}`}</p>
      <div class="spacer"></div>
      <button class="btn soft" data-act="this-rec">🗂 이 기록 보기 · 저장</button>
      <button class="btn primary" data-act="restart">처음으로</button>`;
  },

  records: () => `<div class="appbar"><button class="back" data-act="main" aria-label="뒤로">‹</button>내 기록<span class="appbar-sub">이 폰에서 보낸 요청</span></div>${recordListHTML(recs)}`,
  record: () => `<div class="appbar"><button class="back" data-act="records" aria-label="뒤로">‹</button>기록 상세</div>${recordDetailHTML(rec.r, rec.msgs, 'r', null, rec.urls)}`
};

function render() {
  let h;
  if (view === 'records') h = V.records();
  else if (view === 'record' && rec) h = V.record();
  else if (!carId || !info) h = V.bad();
  else if (!cur) h = V.form();
  else if (cur.status === 'ringing') h = V.wait();
  else if (cur.status === 'replied') h = cur.reply === 'cant' ? V.cant() : V.replied();
  else h = V.done();
  APP.className = 'app'; APP.innerHTML = h;
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
  if (!cur || view !== 'main') return;
  if (cur.status === 'ringing') {
    const el = Date.now() - new Date(cur.created_at).getTime();
    setText('#r-el', secs(el));
    const h = $('#r-hint'); if (h) h.hidden = el < 20000;
  }
  if (cur.status === 'replied') {
    const rp = REP(cur.reply);
    if (rp?.min) { const rem = new Date(cur.replied_at).getTime() + rp.min * 60000 - Date.now(); setText('#r-cd', rem > 0 ? mmss(rem) : '곧 도착'); }
  }
}

/* ---------- 겹쳐 뜨는 화면 ---------- */
function chatOv() {
  const q = cur.kind === 'acc' ? QUICK.rAcc : QUICK.r;
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button>
      <div><b>차주와 메시지</b><div class="muted">${esc(info?.plate_masked || '')} 차주 · 번호는 서로 보이지 않아요</div></div></div>
    <div class="msgs" id="chat-msgs"></div>
    <div class="quick">${q.map(t => `<button data-act="quick" data-t="${esc(t)}">${t}</button>`).join('')}</div>
    <div class="inputbar"><input id="chat-in" maxlength="200" placeholder="메시지 입력" autocomplete="off" enterkeyhint="send"><button data-act="send-msg">전송</button></div></div>`;
}
const maskNum = n => { const d = n.replace(/\D/g, ''); return d.length >= 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}●●-●●${d.slice(-2)}` : n; };
function dialOv() {
  const t = info.call_type;
  return `<div class="ov"><div class="ov-h"><button class="back" data-act="close-ov" aria-label="닫기">‹</button><div><b>차주에게 전화</b><div class="muted">번호가 자동으로 들어가 있어요</div></div></div>
    <div class="dial">${callNum ? `
      <span class="tag${t === 'real' ? ' warn' : ''}">${t === 'safe' ? '🛡 안심번호 (시험판: 차주 번호로 연결)' : '⚠ 차주 휴대폰 번호'}</span>
      <div class="num">${esc(t === 'safe' ? maskNum(callNum) : callNum)}</div>
      <a class="callbtn" href="tel:${callNum.replace(/\D/g, '')}" data-act="log-call" aria-label="전화 걸기">📞</a>
      <div class="note">초록 버튼을 누르면 폰의 전화 앱이 열리고 번호가 자동으로 입력돼요.${t === 'safe' ? '<br>정식 서비스에서는 0507 안심번호로 연결돼 서로의 실제 번호가 남지 않아요.' : ''}</div>`
      : `<div class="note">차주가 전화 연결을 꺼 두었어요.<br>메시지로 연락해 주세요.</div>`}
    </div></div>`;
}
function renderOv(force) {
  if ((ov === 'chat' || ov === 'dial') && !cur) ov = null;
  const k = ov === 'photo' ? 'photo' + photoI : (ov || '') + '|' + (cur?.id || '');
  if (!force && k === ovKey) return; ovKey = k;
  OV.innerHTML = ov === 'chat' ? chatOv() : ov === 'dial' ? dialOv() : ov === 'photo' ? photoOvHTML(photoList, photoI) : '';
  if (ov === 'chat') { unread = 0; updateMsgs(); }
}

/* ---------- 동작 ---------- */
async function sendMove() {
  if (!form.reason || sending) return;
  sending = true; render();
  const { data, error } = await sb.from('requests').insert({ car_id: carId, car_label: label(), kind: 'move', reason: form.reason, msg: form.msg.trim() || null }).select().single();
  sending = false;
  if (error) { toast('보내지 못했어요: ' + error.message, 4000); render(); return; }
  rings = 0; lastRes = null; await setCur(data); render();
}
async function sendAcc() {
  if (!accOK() || sending) return;
  sending = true; render();
  try {
    const paths = [];
    for (let i = 0; i < acc.blobs.length; i++) { toast(`사진 올리는 중… ${i + 1}/${acc.blobs.length}`, 1200); paths.push(await uploadPhoto(acc.blobs[i], me.id)); }
    const { data, error } = await sb.from('requests').insert({
      car_id: carId, car_label: label(), kind: 'acc', photos: paths,
      acc: { who: acc.who, name: acc.name.trim(), plate: acc.plate.trim(), phone: acc.phone, desc: acc.desc.trim() }
    }).select().single();
    if (error) throw error;
    rings = 0; lastRes = null; sending = false; await setCur(data); render();
  } catch (e) { sending = false; toast('보내지 못했어요: ' + (e.message || e), 4000); render(); }
}
async function sendMsg(text) {
  text = String(text || '').trim(); if (!text || !cur) return;
  const { data, error } = await sb.from('messages').insert({ request_id: cur.id, sender: 'r', text }).select().single();
  if (error) { toast('보내지 못했어요: ' + error.message); return; }
  if (!msgs.some(x => x.id === data.id)) msgs.push(data);
  updateMsgs();
  notify('msg', cur.id, { text });   // 차주가 앱을 닫아 둬도 알림
}
async function openRecords() {
  const { data } = await sb.from('requests').select('*').eq('requester', me.id).order('created_at', { ascending: false }).limit(50);
  recs = data || []; view = 'records'; rec = null; render();
}
async function openRecord(id) {
  const r = recs.find(x => x.id === id) || (cur && cur.id === id ? cur : null); if (!r) return;
  const { data } = await sb.from('messages').select('*').eq('request_id', id).order('id');
  rec = { r, msgs: data || [], urls: await photoUrls(r.photos) }; view = 'record'; render(); scrollTo(0, 0);
}
function resetForm() {
  acc.previews.forEach(u => URL.revokeObjectURL(u));
  form = { reason: null, msg: '' };
  acc = { who: null, name: acc.name, plate: acc.plate, phone: acc.phone, desc: '', blobs: [], previews: [], agree: false };  // 내 정보는 다음에도 쓰도록 남김
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const k = b.dataset.k;
  switch (b.dataset.act) {
    case 'mode': mode = k; render(); break;
    case 'reason':
      form.reason = k; $$('[data-act="reason"]').forEach(c => c.classList.toggle('on', c.dataset.k === k));
      if ($('#r-send')) $('#r-send').disabled = false; break;
    case 'who':
      acc.who = k; $$('[data-act="who"]').forEach(c => c.classList.toggle('on', c.dataset.k === k));
      $('#a-plate').placeholder = k === 'saw' ? '내 차량번호 (목격자는 비워도 돼요)' : '내 차량번호 (예: 34나 5678)';
      updAccBtn(); break;
    case 'rm-photo': {
      const i = +b.dataset.i; URL.revokeObjectURL(acc.previews[i]); acc.blobs.splice(i, 1); acc.previews.splice(i, 1);
      $('#a-photos').innerHTML = photosHTML(); break;
    }
    case 'send': await sendMove(); break;
    case 'send-acc': await sendAcc(); break;
    case 'cancel':
      if (!cur || !confirm('요청을 취소할까요?')) return;
      await sb.from('requests').update({ status: 'cancelled' }).eq('id', cur.id);
      stopRing(); cur = { ...cur, status: 'cancelled' }; render(); break;
    case 'restart': stopRing(); if (chan) sb.removeChannel(chan); chan = null; cur = null; msgs = []; urls = []; resetForm(); view = 'main'; render(); scrollTo(0, 0); break;
    case 'chat': ov = 'chat'; renderOv(); setTimeout(() => $('#chat-in')?.focus(), 60); break;
    case 'dial':
      if (info.call_type === 'none') return;
      if (callNum === undefined) { const { data } = await sb.rpc('call_number', { rid: cur.id }); callNum = data || null; }
      ov = 'dial'; renderOv(true); break;
    case 'log-call': if (cur) sb.from('messages').insert({ request_id: cur.id, sender: 'sys', text: '📞 요청자가 전화를 걸었어요' }).then(() => { }); break;
    case 'close-ov': case 'close-photo': ov = null; renderOv(); break;
    case 'quick': await sendMsg(b.dataset.t); break;
    case 'send-msg': { const i = $('#chat-in'); const v = i.value; i.value = ''; await sendMsg(v); i.focus(); break; }
    case 'photo': photoList = rec ? rec.urls : urls; photoI = +b.dataset.i; ov = 'photo'; renderOv(); break;
    case 'save-photos': if (rec) await savePhotos(rec.r, rec.urls); break;
    case 'records': await openRecords(); break;
    case 'this-rec': recs = [cur]; await openRecord(cur.id); break;
    case 'rec': await openRecord(b.dataset.id); break;
    case 'main': view = 'main'; rec = null; render(); break;
    case 'export-png': await exportPNG(rec.r, rec.msgs, null, rec.urls); break;
    case 'export-text': await exportText(rec.r, rec.msgs, null); break;
  }
});
document.addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'r-msg') { form.msg = e.target.value; setText('#r-msgcnt', form.msg.length); }
  else if (id === 'a-name') acc.name = e.target.value;
  else if (id === 'a-plate') acc.plate = e.target.value;
  else if (id === 'a-phone') { const f = fmtPhone(e.target.value); if (e.target.value !== f) e.target.value = f; acc.phone = f; }
  else if (id === 'a-desc') acc.desc = e.target.value;
  else return;
  updAccBtn();
});
document.addEventListener('change', async e => {
  if (e.target.id === 'a-agree') { acc.agree = e.target.checked; updAccBtn(); }
  if (e.target.id === 'a-file') {
    const files = [...e.target.files].slice(0, 3 - acc.blobs.length);
    for (const f of files) { const b = await resizeImage(f); if (b) { acc.blobs.push(b); acc.previews.push(URL.createObjectURL(b)); } }
    const box = $('#a-photos'); if (box) box.innerHTML = photosHTML();
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'chat-in' && !e.isComposing) { e.preventDefault(); const v = e.target.value; e.target.value = ''; sendMsg(v); }
});

boot();
