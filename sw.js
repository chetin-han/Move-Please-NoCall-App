/* 저기요 시험판 — 폰 알림 담당 (앱을 닫아 둬도 동작) */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: '저기요', body: e.data ? e.data.text() : '' }; }
  const ring = d.kind === 'ring', urgent = !!d.urgent;
  const ACTIONS = {
    move: [{ action: 'soon', title: '곧 갈게요 (5분)' }, { action: 'now', title: '지금 가요' }],
    acc: [{ action: 'acc_go', title: '지금 갈게요' }, { action: 'acc_call', title: '전화드릴게요' }],
    bb: [{ action: 'bb_check', title: '확인해 볼게요' }],
    etc: [{ action: 'etc_go', title: '지금 가 볼게요' }, { action: 'etc_thx', title: '확인했어요' }]
  };
  const actions = ring ? (ACTIONS[d.rkind] || []) : [];
  e.waitUntil(self.registration.showNotification(d.title || '저기요', {
    body: d.body || '',
    tag: d.tag || 'movecall',
    renotify: true,                       // 같은 요청이라도 매번 다시 울림
    requireInteraction: ring && d.level !== 'info',             // 누를 때까지 알림이 남아 있음
    vibrate: urgent ? [1000, 150, 1000, 150, 1000, 150, 1000] : [600, 200, 600, 200, 600],
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    data: { url: d.url || './' },
    actions
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope);
  if (e.action) url.searchParams.set('reply', e.action);
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope) && !c.url.includes('c.html')) {
        try { await c.navigate(url.href); } catch (err) { }
        return c.focus();
      }
    }
    return self.clients.openWindow(url.href);
  })());
});
