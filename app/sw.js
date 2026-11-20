/* 마이웍스 서비스 워커 — 휴대폰 푸시 알림을 받아 띄우고, 연결이 끊겼을 때 마지막으로 연 화면을 보여 줍니다.
   · 화면(/app/)은 늘 서버에서 먼저 받습니다. 받지 못했을 때만 저장해 둔 것을 씁니다. 그래서 새 판이 늦게 뜨는 일이 없습니다.
   · 서버 요청(/api/)과 다른 주소는 건드리지 않습니다. */
const SHELL = "mw-shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !/^\/app\/?$/.test(url.pathname)) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) { const copy = res.clone(); e.waitUntil(caches.open(SHELL).then(c => c.put("/app/", copy))); }
      return res;
    } catch (err) {
      const hit = await caches.match("/app/");
      if (hit) return hit;
      throw err;
    }
  })());
});

/* 푸시 — 서버가 보낸 내용: { t: 제목, b: 본문, u: 누르면 열 화면(#/…), g: 묶음 } */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  const opt = { body: d.b || "", data: { u: d.u || "#/dashboard" }, icon: "/site/img/icon-192.png", badge: "/app/badge-96.png", lang: "ko" };
  if (d.g) { opt.tag = d.g; opt.renotify = true; }
  e.waitUntil(self.registration.showNotification(d.t || "마이웍스", opt));
});

/* 알림을 누르면 — 열려 있는 마이웍스가 있으면 그 화면으로, 없으면 새로 엽니다 */
self.addEventListener("notificationclick", e => {
  e.notification.close();
  let u = (e.notification.data && e.notification.data.u) || "#/dashboard";
  if (!/^#\//.test(u)) u = "#/dashboard";
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const c = list.find(x => { try { return new URL(x.url).pathname.startsWith("/app"); } catch (err) { return false; } });
    if (c) { c.postMessage({ mw: "go", u }); return c.focus(); }
    return self.clients.openWindow("/app/" + u);
  })());
});
