/* 词频通 Service Worker — 离线缓存
   缓存版本升级：改 CACHE 名称即可触发旧缓存清理
   注意：预缓存必须用 cache:'reload' 绕过浏览器 HTTP 缓存，
   否则 GitHub Pages 的 max-age 会让新版本装进旧文件。 */
var CACHE = 'cet-vocab-v17';
var CORE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './data.js',
  './book_data.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      return Promise.all(CORE.map(function(u){
        // cache:'reload' 强制走网络，避免命中旧的 HTTP 缓存
        return fetch(new Request(u, { cache:'reload' })).then(function(res){
          if(res && res.status===200) return c.put(u, res);
        }).catch(function(){ /* 单个资源失败不阻断安装 */ });
      }));
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
  var hasVersion = clean.search.indexOf('v=') >= 0;
  clean.search = '';
  var cleanReq = new Request(clean.href, { method:'GET' });

  function putCache(res){
    if(res && res.status===200){
      var copy = res.clone();
      caches.open(CACHE).then(function(c){ c.put(cleanReq, copy); });
    }
    return res;
  }

  // 导航 或 带版本参数(?v=)的资源：网络优先，失败回缓存
  // 这样 HTML 里 bump 版本号就能让用户拿到新文件
  if(req.mode === 'navigate' || hasVersion){
    e.respondWith(
      fetch(req).then(putCache).catch(function(){
        return caches.match(cleanReq).then(function(r){
          return r || (req.mode==='navigate' ? caches.match('./index.html') : undefined);
        });
      })
    );
    return;
  }

  // 其余静态资源：缓存优先，未命中则网络并写入
  e.respondWith(
    caches.match(cleanReq).then(function(hit){
      if(hit) return hit;
      return fetch(req).then(putCache);
    })
  );
});
