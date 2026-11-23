/* 저기요(가칭) — 접속할 때 나오는 로고 인트로 (약 5.6초, 화면을 누르면 건너뜀)
   후드 뒷모습 → 손이 닿은 곳이 로고가 됨 → "톡톡" → 돌아봄 → 얼굴 쪽으로 빠르게 들어감 → 착한 옆얼굴 → 첫 화면 */
(function () {
  const q = new URLSearchParams(location.search);
  if (q.get('rid') || q.get('reply') || q.get('chat')) return;                    // 알림을 눌러 들어온 경우는 바로 화면으로
  try { if (sessionStorage.getItem('jg-intro')) return; sessionStorage.setItem('jg-intro', '1'); } catch (e) { }   // 같은 탭에서 새로고침할 때는 다시 안 나옴
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const el = document.createElement('div');
  el.className = 'ji';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="ji-col"><div class="ji-tile"><div class="ji-cam"><img class="a" src="intro/scene_a.jpg" alt=""><img class="b" src="intro/scene_b.jpg" alt="" onerror="this.remove()"></div>'
    + '<img class="ji-face" src="intro/scene_c.jpg?v=2" alt="" onerror="this.remove()"></div><div class="ji-word">저기요<i>가칭</i></div><span class="ji-tok a">톡</span><span class="ji-tok b">톡</span></div>';
  document.body.appendChild(el);
  const col = el.firstChild, $ = s => el.querySelector(s);
  let timers = [], done = false, actx = null;

  /* 그림 속 위치(0~1): 화면 가운데에 둘 곳, 로고로 쓰는 부분, 돌아본 얼굴 */
  const MID = 0.485, LOGO = { x: 0.37, y: 0.513, s: 0.4 }, FACE = { x: 0.44, y: 0.27 }, CLOSE = 0.32;
  function layout() {
    const W = col.clientWidth, H = col.clientHeight, S = Math.max(H, W * 1.25), sq = Math.min(W, H);
    const left = W / 2 - MID * S, top = (H - S) / 2;
    const cam = $('.ji-cam'), face = $('.ji-face');
    cam.style.cssText = `left:${left}px;top:${top}px;width:${S}px;height:${S}px`;
    face.style.cssText = `left:${W / 2 - CLOSE * S}px;top:${top}px;width:${S}px;height:${S}px`;
    const k = sq / (LOGO.s * S), z = 5.5;
    el.style.setProperty('--cam', `translate(${W / 2 - left - k * LOGO.x * S}px,${H / 2 - top - k * LOGO.y * S}px) scale(${k})`);
    el.style.setProperty('--zoom', `translate(${W / 2 - left - z * FACE.x * S}px,${H / 2 - top - z * FACE.y * S}px) scale(${z})`);
    el.style.setProperty('--clip', `inset(${(H - sq) / 2}px ${(W - sq) / 2}px ${(H - sq) / 2}px ${(W - sq) / 2}px round ${0.24 * sq}px)`);
    const tileTop = H / 2 - 0.22 * H - 0.15 * sq, tileRight = W / 2 + 0.15 * sq;
    $('.ji-word').style.top = (tileTop + 0.3 * sq + 20) + 'px';
    $('.ji-tok.a').style.cssText = `left:${tileRight - 3}px;top:${tileTop - 12}px`;
    $('.ji-tok.b').style.cssText = `left:${tileRight + 24}px;top:${tileTop + 16}px`;
  }

  /* "톡" 소리: 손끝으로 옷 위를 가볍게 두드리는 낮고 짧은 소리. 브라우저가 막으면 조용히 넘어감 */
  function tok(vol) {
    try {
      if (!actx || actx.state !== 'running') return;
      const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(300, t); o.frequency.exponentialRampToValueAtTime(130, t + .07);
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.3 * vol, t + .005); g.gain.exponentialRampToValueAtTime(.0001, t + .12);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + .14);
      const len = Math.floor(actx.sampleRate * .025), buf = actx.createBuffer(1, len, actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const n = actx.createBufferSource(), f = actx.createBiquadFilter(), g2 = actx.createGain();
      n.buffer = buf; f.type = 'lowpass'; f.frequency.value = 800; g2.gain.value = .07 * vol;
      n.connect(f).connect(g2).connect(actx.destination); n.start(t);
    } catch (e) { }
  }
  function finish() {
    if (done) return; done = true;
    timers.forEach(clearTimeout); removeEventListener('resize', layout);
    el.remove();
    try { actx && actx.close(); } catch (e) { }
  }
  function play() {
    if (done) return;
    layout(); addEventListener('resize', layout);
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume().catch(() => { }); } catch (e) { }
    el.classList.add('play');
    timers = [setTimeout(() => tok(1), 2620), setTimeout(() => tok(.8), 2920), setTimeout(finish, 5650)];
  }
  el.addEventListener('click', finish);

  /* 첫 그림이 준비되면 시작. 1.5초 안에 못 불러오면 인트로 없이 바로 화면으로 */
  const a = $('.ji-cam .a');
  const giveUp = setTimeout(finish, 1500);
  const go = () => { clearTimeout(giveUp); play(); };
  if (a.complete && a.naturalWidth) go(); else { a.addEventListener('load', go); a.addEventListener('error', finish); }
})();
