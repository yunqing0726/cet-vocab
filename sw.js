/* 词频�?Service Worker �?离线缓存
   缓存版本升级：改 CACHE 名称即可触发旧缓存清�?*/
var CACHE = 'cet-vocab-v2';
var CORE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './data.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      return c.addAll(CORE).catch(function(){ /* 单个资源失败不阻断安�?*/ });
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if(k.indexOf('cet-vocab-')===0 && k!==CACHE) return caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET') return;
  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return;   // 外部接口(有道发音)直接放行

  // 归一化：去掉版本查询参数，让 ?v=... 能命中不带参数的缓存
  var clean = new URL(url.href);
  clean.search = '';
  var cleanReq = new Request(clean.href, { method:'GET' });

  // 导航：网络优先，失败回缓存（保证有网时拿到新版页面）
  if(req.mode === 'navigate'){
    e.respondWith(
      fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ c.put(cleanReq, copy); });
        return res;
      }).catch(function(){
        return caches.match(cleanReq).then(function(r){ return r || caches.match('./index.html'); });
      })
    );
    return;
  }

  // 静态资源：缓存优先，未命中则网络并写入
  e.respondWith(
    caches.match(cleanReq).then(function(hit){
      if(hit) return hit;
      return fetch(req).then(function(res){
        if(res && res.status===200){
          var copy = res.clone();
          caches.open(CACHE).then(function(c){ c.put(cleanReq, copy); });
        }
        return res;
      });
    })
  );
});
