/* 무브콜 시험판 — 차주 앱·요청자 화면이 함께 쓰는 기능 */
const CFG = window.MOVECALL_CONFIG;
const sb = window.supabase.createClient(CFG.url, CFG.key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'movecall-auth' }
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
const fmtPhone = v => { const d = String(v).replace(/\D/g, '').slice(0, 11); if (d.length < 4) return d; if (d.length < 8) return d.slice(0, 3) + '-' + d.slice(3); return d.slice(0, 3) + '-' + d.slice(3, d.length - 4) + '-' + d.slice(-4); };
const setText = (s, v) => $$(s).forEach(e => { if (e.textContent !== String(v)) e.textContent = v; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobile = /Android|iPhone|iPad|iPod/.test(navigator.userAgent) || isIOS;
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canVib = () => !!navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive);
const vib = p => { if (canVib()) try { navigator.vibrate(p); } catch (e) { } };

function toast(text, ms = 2600) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = text;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}

/* ---------- 정해진 문구 ---------- */
const REASONS = { exit: '출차해야 해요', block: '차가 앞을 막고 있어요', work: '하역·공사 작업이 있어요', etc: '기타' };
const WHO = { hit: '제가 부딪혔어요', saw: '사고를 목격했어요' };
const WHO_LONG = { hit: '상대 차량 운전자가 직접 알림', saw: '목격자가 알림' };
const REPLIES = [
  { k: 'now', t: '지금 가요', sub: '2분 안에', min: 2, icon: '🏃' },
  { k: 'soon', t: '곧 갈게요', sub: '5분 안에', min: 5, icon: '🙆' },
  { k: 'ten', t: '10분 걸려요', sub: '조금만 기다려 주세요', min: 10, icon: '⏱️' },
  { k: 'cant', t: '지금은 못 가요', sub: '', min: 0, icon: '🙏' }
];
const ACC_REPLIES = [
  { k: 'acc_go', t: '확인했어요, 지금 갈게요', min: 5, icon: '🏃' },
  { k: 'acc_call', t: '확인했어요, 전화드릴게요', min: 0, icon: '📞' },
  { k: 'acc_wait', t: '10분 안에 갈게요, 기다려 주세요', min: 10, icon: '⏱️' }
];
const REP = k => [...REPLIES, ...ACC_REPLIES].find(r => r.k === k);
const QUICK = {
  r: ['어디쯤 오세요?', '천천히 오셔도 괜찮아요', '조금 급해요 🙏', '감사합니다!'],
  rAcc: ['정말 죄송합니다 🙏', '차 옆에서 기다릴게요', '보험 접수할게요', '사진 더 보내 드릴까요?'],
  o: ['거의 다 왔어요', '엘리베이터 기다리는 중이에요', '조금만 기다려 주세요 🙏', '차 옮겼어요'],
  oAcc: ['알려 주셔서 감사해요', '지금 내려가고 있어요', '보험사 연락처 보내 주세요', '잠시만 기다려 주세요']
};
const STATUS = { ringing: '응답 대기', replied: '답장함', done: '완료', cancelled: '취소' };
const CALL_LABEL = { safe: '안심번호', real: '내 휴대폰 번호', none: '전화 받지 않음' };
const headOf = r => r.kind === 'acc' ? `🚨 사고 알림 · ${r.acc?.name || ''}` : `🚗 ${REASONS[r.reason] || '이동 요청'}`;

/* ---------- 로그인(익명) ---------- */
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
const stickerHTML = url => `<div class="stk"><div class="stk-top"><span class="logo">P</span>무브콜</div>${qrSVG(url, 'qrbig')}<div class="stk-t">주차 이동 · 사고 알림</div><div class="stk-s">휴대폰 카메라로 QR을 찍어 주세요<br>전화번호 없이 차주에게 바로 연락돼요</div></div>`;
async function stickerBlob(url) {
  const W = 600, H = 860, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const rr = (x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };
  const F = 'Pretendard, "Malgun Gothic", sans-serif';
  g.fillStyle = '#2f6bff'; rr(0, 0, W, H, 48); g.fill();
  g.fillStyle = '#fff'; rr(24, 24, W - 48, H - 48, 32); g.fill();
  g.fillStyle = '#2f6bff'; rr(196, 64, 56, 56, 14); g.fill();
  g.textBaseline = 'middle'; g.fillStyle = '#fff'; g.font = `800 32px ${F}`; g.textAlign = 'center'; g.fillText('P', 224, 93);
  g.fillStyle = '#16181d'; g.textAlign = 'left'; g.font = `800 38px ${F}`; g.fillText('무브콜', 266, 94);
  const q = qrMake(url), n = q.getModuleCount(), size = 420, cell = size / n, qx = (W - size) / 2, qy = 150;
  g.fillStyle = '#111';
  for (let r = 0; r < n; r++) for (let cc = 0; cc < n; cc++) if (q.isDark(r, cc)) g.fillRect(qx + cc * cell, qy + r * cell, Math.ceil(cell), Math.ceil(cell));
  g.textAlign = 'center'; g.fillStyle = '#16181d'; g.font = `800 42px ${F}`; g.fillText('주차 이동 · 사고 알림', W / 2, 640);
  g.fillStyle = '#6b7280'; g.font = `500 26px ${F}`;
  g.fillText('휴대폰 카메라로 QR을 찍어 주세요', W / 2, 700); g.fillText('전화번호 없이 차주에게 바로 연락돼요', W / 2, 742);
  return await new Promise(res => c.toBlob(res, 'image/png'));
}

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
  const files = blobs.map((b, i) => new File([b], `무브콜_사고사진_${stamp(r.created_at)}_${i + 1}.jpg`, { type: b.type || 'image/jpeg' }));
  const res = await saveFiles(files);
  if (res === 'downloaded') toast(`사진 ${files.length}장을 저장했어요`);
}

/* ---------- 메시지 목록 ---------- */
const nameOf = (sender, r) => sender === 'o' ? '차주' : sender === 'r' ? (r.kind === 'acc' ? '신고자' : '요청자') : '기록';
function msgHTML(r, msgs, side, photoSrcs) {
  let first;
  if (r.kind === 'acc') {
    const a = r.acc || {};
    first = { sender: 'r', at: r.created_at, html: `🚨 사고 알림 · ${WHO[a.who] || ''}<br>${esc(a.name)}${a.plate ? ' · ' + esc(a.plate) : ''} · ${esc(a.phone)}${a.desc ? '<br>' + esc(a.desc) : ''}${(photoSrcs || []).length ? '<br>' + photoSrcs.map(p => `<img src="${p}" alt="">`).join('') : ''}` };
  } else first = { sender: 'r', at: r.created_at, text: `🚗 ${REASONS[r.reason] || ''}${r.msg ? ' · ' + r.msg : ''}` };
  const items = [first];
  if (r.replied_at && REP(r.reply)) items.push({ sender: 'o', at: r.replied_at, text: `${REP(r.reply).icon} ${REP(r.reply).t}` });
  msgs.forEach(m => items.push({ sender: m.sender, at: m.created_at, text: m.text }));
  if (r.status === 'done' && r.done_at) items.push({ sender: 'sys', at: r.done_at, text: r.kind === 'acc' ? '✅ 차주가 현장 확인을 마쳤어요' : '✅ 차주가 차를 옮겼어요' });
  if (r.status === 'cancelled') items.push({ sender: 'sys', at: Date.now(), text: '요청이 취소됐어요' });
  items.sort((a, b) => new Date(a.at) - new Date(b.at));
  return items.map(m => {
    if (m.sender === 'sys') return `<div class="m sys">${esc(m.text)}</div>`;
    return `<div class="m ${m.sender === side ? 'me' : 'them'}">${m.html || esc(m.text)}<span class="tm">${hhmm(m.at)}</span></div>`;
  }).join('');
}

/* ---------- 기록 내보내기 ---------- */
function recordRows(r, plate) {
  const rows = [['구분', r.kind === 'acc' ? '사고 알림' : '주차 이동 요청'], ['차량', plate || r.car_label || '-'], ['요청 시각', ymdhm(r.created_at)]];
  if (r.kind === 'acc') {
    const a = r.acc || {};
    rows.push(['알린 사람', WHO_LONG[a.who] || '-'], ['이름', a.name || '-'], ['차량번호', a.plate || '-'], ['전화번호', a.phone || '-'], ['사고 내용', a.desc || '-'], ['사진', `${(r.photos || []).length}장`]);
  } else rows.push(['사유', `${REASONS[r.reason] || '-'}${r.msg ? ' · ' + r.msg : ''}`]);
  const rp = REP(r.reply);
  rows.push(['차주 답장', rp ? `${rp.t} (${hhmm(r.replied_at)}, ${secs(new Date(r.replied_at) - new Date(r.created_at))} 만에)` : '없음']);
  rows.push(['처리 결과', r.status === 'done' ? `완료 (${hhmm(r.done_at)})` : STATUS[r.status] || r.status]);
  return rows;
}
function chatLines(r, msgs) {
  return msgs.map(m => `[${hhmm(m.created_at)}] ${nameOf(m.sender, r)}: ${m.text}`);
}
function recordText(r, msgs, plate) {
  const rows = recordRows(r, plate).map(([k, v]) => `${k}: ${v}`).join('\n');
  const chat = chatLines(r, msgs);
  return `[무브콜 ${r.kind === 'acc' ? '사고 기록' : '주차 이동 요청 기록'}]\n${rows}${chat.length ? '\n\n[대화 기록]\n' + chat.join('\n') : ''}\n\n기록 번호 ${r.id.slice(0, 8)} · 무브콜 시험판에서 내보냄 ${ymdhm(Date.now())}`;
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
    if (!dry) { g.fillStyle = '#fff'; g.fillRect(0, 0, W, c.height); g.fillStyle = r.kind === 'acc' ? '#e5484d' : '#2f6bff'; g.fillRect(0, 0, W, 14); }
    T(r.kind === 'acc' ? '무브콜 사고 기록' : '무브콜 주차 이동 요청 기록', `800 40px ${F}`, '#16181d', P, y + 10); y += 74;
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
    T(`무브콜 시험판에서 내보냄 · ${ymdhm(Date.now())}`, `500 20px ${F}`, '#9ca3af', P, y); y += 40;
    return y;
  };
  c.width = W; c.height = 6000; const H = draw(true);
  c.height = Math.ceil(H + P / 2); draw(false);
  return await new Promise(res => c.toBlob(res, 'image/png'));
}

/* ---------- 기록 목록·상세 (두 화면 공통) ---------- */
function recordListHTML(list) {
  if (!list.length) return '<p class="muted center" style="margin-top:30px">아직 기록이 없어요</p>';
  return `<div class="list">${list.map(r => `<button class="li" data-act="rec" data-id="${r.id}">
    <span class="ic">${r.kind === 'acc' ? '🚨' : '🚗'}</span>
    <span class="tx"><span class="t">${esc(headOf(r).replace(/^.. /, ''))}</span><span class="s">${ymdhm(r.created_at)}${r.car_label ? ' · ' + esc(r.car_label) : ''}</span></span>
    <span class="st ${r.status}">${STATUS[r.status] || ''}</span></button>`).join('')}</div>`;
}
function recordDetailHTML(r, msgs, side, plate, urls) {
  return `
    <div class="info">${recordRows(r, plate).map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
    ${urls.length ? `<div class="thumbs">${urls.map((u, i) => `<img src="${u}" data-act="photo" data-i="${i}" alt="사고 사진 ${i + 1}">`).join('')}</div>
      <button class="btn soft sm" data-act="save-photos">📥 사고 사진 ${urls.length}장 저장</button>` : ''}
    <div class="h">대화 기록</div>
    <div class="msgs static">${msgHTML(r, msgs, side, [])}</div>
    <button class="btn primary" data-act="export-png">🖼 기록을 이미지로 저장</button>
    <button class="btn ghost" data-act="export-text">📋 기록 텍스트 복사</button>`;
}
async function exportPNG(r, msgs, plate, urls) {
  toast('기록 이미지를 만들고 있어요…', 1500);
  const blobs = await fetchBlobs(urls);
  const png = await recordPNG(r, msgs, plate, blobs);
  const res = await saveFiles([new File([png], `무브콜_${r.kind === 'acc' ? '사고기록' : '이동요청기록'}_${stamp(r.created_at)}.png`, { type: 'image/png' })]);
  if (res === 'downloaded') toast('기록 이미지를 저장했어요');
}
async function exportText(r, msgs, plate) {
  const t = recordText(r, msgs, plate);
  try { await navigator.clipboard.writeText(t); toast('기록을 복사했어요. 메모·메신저에 붙여 넣으세요'); }
  catch (e) { prompt('아래 내용을 길게 눌러 복사하세요', t); }
}
const photoOvHTML = (urls, i) => `<div class="photo-ov" data-act="close-photo"><img src="${urls[i]}" alt="사진 크게 보기"><p>사진 ${i + 1}/${urls.length} · 눌러서 닫기</p></div>`;
