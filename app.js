/* 词频通 — 核心逻辑 */
(function(){
'use strict';

var ALL = (window.VOCAB_DATA && window.VOCAB_DATA.words) || [];
var LS = 'cetcore_v1';

/* ---------- 状态 ---------- */
var S = {
  level: 'both',
  placementDone: false,
  skipThreshold: 0,
  vocabSize: 0,          // 入学测试估算的词汇量（词频排名近似）
  mastered: {},          // word -> {n}
  tooEasy: {},           // word -> ts（加入时间）
  tooEasyLog: [],        // [{w, ts}] 按时间，最新在后
  wrong: {},             // word -> {n, rep, last, first, level}
  wrongLog: [],          // [{w, ts, date, type}] 每次答错记录，用于按日期浏览
  daily: {},             // 'YYYY-MM-DD' -> {new, correct, total}
  streak: 0,
  accent: 2,             // 2=美式 1=英式
  lastActive: '',
  session: null,         // 当前测验（持久化，切页/刷新不变）
  current: null,
  placePool: [],         // 词汇量测试候选词池（按难度升序）
  placeAsked: {},        // word -> true（已问过）
  placeIdx: 0,
  placeCorrect: 0,
  placeAnswers: [],
  theta: 0,              // 能力值（log10 词频刻度）：越大=认识越生僻的词
  thetaN: 0,             // 已用于更新的答题次数（决定每次更新的步长）
  adaptiveLog: [],       // [{ts, theta, known, w}] 能力变化轨迹（调试/展示用）
  /* 下面这些必须在这里声明：load() 只认识 S 里已有的键，
     以前没声明 → 每次刷新/更新版本都被丢掉，题目就从 address 从头开始 */
  adaptiveSeen: {},      // word -> ts 做过的时间（永久，不再 7 天过期）
  learned: {},           // word -> {n, ok, first, last} 永久学习账本（每题都记）
  batchCursor: 0,        // 顺序选题游标（拼写测验用）
  batchNo: 0,            // 第几套
  lastResult: null       // 上一套结算
};

function load(){
  try{
    var raw = localStorage.getItem(LS);
    if(raw){
      var o = JSON.parse(raw);
      for(var k in S){ if(o[k]!==undefined) S[k]=o[k]; }
      // 关键：把存档里「S 没声明」的字段也带进来，避免以后加字段又被丢
      for(var k2 in o){ if(!(k2 in S)) S[k2]=o[k2]; }
      // 迁移：旧的 tooEasy 是 true，转成时间戳
      if(!Array.isArray(S.tooEasyLog)) S.tooEasyLog=[];
      Object.keys(S.tooEasy).forEach(function(w){
        if(S.tooEasy[w]===true){ S.tooEasy[w]=Date.now(); S.tooEasyLog.push({w:w,ts:S.tooEasy[w]}); }
      });
      if(!Array.isArray(S.wrongLog)) S.wrongLog=[];
      if(!S.adaptiveSeen || typeof S.adaptiveSeen!=='object') S.adaptiveSeen={};
      if(!S.learned || typeof S.learned!=='object') S.learned={};
      // 老数据：把 wrong/mastered 回填进学习账本，保证「做过的词」跨版本不丢
      Object.keys(S.wrong).forEach(function(w){
        if(!S.learned[w]) S.learned[w]={n:S.wrong[w].n||1, ok:0, first:S.wrong[w].first||Date.now(), last:S.wrong[w].last||Date.now()};
      });
      Object.keys(S.mastered).forEach(function(w){
        if(!S.learned[w]) S.learned[w]={n:S.mastered[w].n||1, ok:S.mastered[w].n||1, first:Date.now(), last:Date.now()};
      });
      // 能力值兜底：老存档没有 theta（=0）时，用跳过阈值反推一个合理初值，
      // 否则 θ=0 会被算成「只认识最简单的词」，选题永远从词库最前面开始。
      if(!S.thetaN && S.placementDone && S.skipThreshold>0 && !(S.theta>0.2)){
        S.theta=Math.log(S.skipThreshold)/Math.LN10+0.5;
        S.thetaN=Math.max(10, Object.keys(S.learned).length);
      }
    }
  }catch(e){}
}
function save(){ try{ localStorage.setItem(LS, JSON.stringify(S)); }catch(e){} }
function today(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function ts(){ return Date.now(); }
function dayDiff(a,b){ return Math.round((new Date(b)-new Date(a))/86400000); }
function shuffle(a){ for(var i=a.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=a[i];a[i]=a[j];a[j]=t; } return a; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

/* ---------- 词池 ---------- */
function eligible(w){
  if(S.tooEasy[w.w]) return false;
  if(S.placementDone && S.skipThreshold>0 && w.f>0 && w.f<=S.skipThreshold) return false;
  return true;
}
function trainedPool(){
  return ALL.filter(function(w){
    if(S.level==='4' && w.l!==4) return false;
    if(S.level==='6' && w.l!==6) return false;
    return eligible(w);
  });
}
function freqSorted(){ return trainedPool().slice().sort(function(a,b){ return (a.f||99999)-(b.f||99999); }); }

/* ---------- 大学英语（教材单元词库） ----------
   数据来自 book_data.js（window.BOOK_DATA.words），字段：
   w 单词 / i 音标 / p 词性 / e 英文释义 / z 中文释义 / m 难度标记
   b 'comprehensive'|'viewing' / u 单元号 / t 单元名 / g 页码
   这里统一转成和 CET 词条一样的形状（m 是 [{p,t}]），
   这样 showQuiz / reveal / 总览 / 错题本都能直接复用。 */
var COLLEGE = (function(){
  var raw = (window.BOOK_DATA && window.BOOK_DATA.words) || [];
  return raw.map(function(x){
    return {
      w: x.w,
      ipa: x.i || '',
      m: [{p: String(x.p||'').replace(/\.+$/,''), t: x.z || ''}],
      z: x.z || '',
      en: x.e || '',
      df: x.e ? [x.e] : [],
      ph: [], sen: [],
      mark: x.m || '',
      book: x.b,
      unit: x.u,
      unitTitle: x.t,
      page: x.g,
      isCollege: true
    };
  });
})();
var COLLEGE_MAP = {};
COLLEGE.forEach(function(x){ COLLEGE_MAP[x.w.toLowerCase()] = x; });
var BOOK_NAME = {comprehensive:'综合教程', viewing:'视听说教程'};
var collegeBook = 'comprehensive';

/* ---------- 释义排序：常考词性在前 ----------
   考试里最常考的是实词（名/动/形/副），虚词（冠/介/连/代/数/助）很少单独考。
   源数据多数已经是实词在前，这里做一层兜底：把虚词性释义挪到后面，
   实词内部保持原顺序（源数据本身就是按考频排的，不擅自重排实词）。 */
var FUNC_POS = {art:1, prep:1, conj:1, pron:1, num:1, aux:1, int:1, pref:1, abbr:1};
function posBase(p){
  p=String(p||'').toLowerCase().replace(/\./g,'').trim();
  p=p.split('&')[0].trim();
  return p;
}
function sortMeanings(list){
  if(!list || list.length<2) return list;
  var func=[], content=[];
  list.forEach(function(x){ (FUNC_POS[posBase(x.p)] ? func : content).push(x); });
  return content.concat(func);
}
/* 四六级词库同样处理一遍（在 DOM 就绪前做一次，之后所有渲染都吃排好序的） */
ALL.forEach(function(w){ if(w.m && w.m.length>1) w.m=sortMeanings(w.m); });

/* 某本书的单元列表：[{u, title, words:[...]}] */
function collegeUnits(book){
  var by = {};
  COLLEGE.forEach(function(x){
    if(x.book!==book) return;
    (by[x.unit] = by[x.unit] || {u:x.unit, title:x.unitTitle, words:[]}).words.push(x);
  });
  return Object.keys(by).map(function(k){ return by[k]; })
    .sort(function(a,b){ return a.u-b.u; });
}
/* 单元进度：done = 已认识过的词数 */
function unitProgress(words){
  var done = 0;
  words.forEach(function(x){ if(S.mastered[x.w]) done++; });
  return {done: done, total: words.length};
}
function setBook(b){ collegeBook=b; renderCollege(); }

function renderCollege(){
  document.querySelectorAll('.book-bar .range-chip').forEach(function(el){
    if(el.getAttribute('data-book')) el.classList.toggle('on', el.getAttribute('data-book')===collegeBook);
    if(el.getAttribute('data-wb')) el.classList.toggle('on', el.getAttribute('data-wb')===wrongBook);
  });
  var box = document.getElementById('unitList');
  if(!box) return;
  if(!COLLEGE.length){
    box.innerHTML = '<div class="empty"><p>教材词库未加载</p></div>';
    return;
  }
  var units = collegeUnits(collegeBook);
  box.innerHTML = units.map(function(u){
    var p = unitProgress(u.words);
    var pct = p.total ? Math.round(p.done/p.total*100) : 0;
    var n = collegeCursorLeft(collegeBook, u.u);
    return '<button class="unit-row" onclick="App.startCollege('+u.u+')">'+
      '<span class="unit-no">'+u.u+'</span>'+
      '<span class="unit-main"><b>Unit '+u.u+' · '+esc(u.title)+'</b>'+
        '<span class="unit-meta">'+p.total+' 个词 · 已掌握 '+p.done+' · 待学 '+n+'</span></span>'+
      '<span class="unit-pct">'+pct+'%</span></button>';
  }).join('');
  var st = document.getElementById('collegeStat');
  if(st) st.textContent = BOOK_NAME[collegeBook] + ' · ' + COLLEGE.length + ' 词';
}

/* 单元里还没学的词（按书上页码顺序）；cur 为游标对象 */
function collegePoolLeft(book, unit){
  var words = COLLEGE.filter(function(x){ return x.book===book && x.unit===unit; })
    .slice().sort(function(a,b){ return (a.page||0)-(b.page||0); });
  return words.filter(function(x){ return !S.mastered[x.w] && !S.tooEasy[x.w]; });
}
function collegeCursorLeft(book, unit){ return collegePoolLeft(book, unit).length; }

/* 开始某单元的一批（20 词）；不传 unit 则挑第一个还有词的单元 */
function startCollege(unit){
  var units = collegeUnits(collegeBook);
  if(!units.length){ toast('教材词库还没有加载'); return; }
  var target = null;
  if(unit){
    target = units.filter(function(u){ return u.u===unit; })[0];
  }else{
    for(var i=0;i<units.length;i++){
      if(collegePoolLeft(collegeBook, units[i].u).length){ target=units[i]; break; }
    }
    if(!target) target = units[0];
  }
  if(!target){ toast('没有可背的单元'); return; }
  var left = collegePoolLeft(collegeBook, target.u);
  if(!left.length){
    toast('Unit '+target.u+' 的词都背完了');
    return;
  }
  var batch = left.slice(0, 20);
  startQuiz('college', {queue: batch});
}

/* ---------- FSRS 记忆模型（间隔重复） ----------
   参考 open-spaced-repetition/FSRS（Anki 新版 / 墨墨 / 不背单词 同类）。
   每个错题记录三个量（替换旧的固定 1/2/4/8/16/32 天翻倍）：
   - 稳定性 S（天）：回忆概率降到 90% 所需的天数，越记越牢则越大
   - 难度 D（1~10）：越大越难记
   - 可检索性 R(t)：距上次复习 t 天后还能想起来的概率
   R(t) = (1 + 19/81 · t/S)^(-0.5)；下次复习间隔由目标回忆率反解。
   二元评分：认识=成功(Easy)、不认识=失败(Again)。 */
var FSRS_FACTOR=19/81;      // ≈0.2346
var FSRS_TARGET_R=0.9;      // 目标保持 90% 回忆率
var FSRS_W6=0.86;           // 难度更新系数
var FSRS_W8=1.49, FSRS_W9=0.14, FSRS_W10=0.94;  // 稳定性增长参数（FSRS 默认）

function fsrsR(days,S){
  S=Math.max(0.3,S||0.5);
  return Math.pow(1+FSRS_FACTOR*Math.max(0,days)/S,-0.5);
}
function fsrsInterval(S,targetR){
  S=Math.max(0.3,S||0.5);
  var r=Math.min(0.99,Math.max(0.01,targetR||FSRS_TARGET_R));
  return S/FSRS_FACTOR*(Math.pow(r,-2)-1);       // 天
}
function fsrsUpdate(x,known,days){
  var S=Math.max(0.3,x.S||0.5);
  var D=Math.max(1,Math.min(10,x.D||5));
  var R=fsrsR(days,S);
  if(known){
    // 成功：难度下降，稳定性增长（越容易、当前可检索性越低，增益越大）
    D=Math.max(1,D-FSRS_W6);
    S=S*(1+Math.exp(FSRS_W8)*(11-D)*Math.pow(S,-FSRS_W9)*(Math.exp(FSRS_W10*(1-R))-1));
  }else{
    // 失败：难度上升，稳定性回退（一个曾记住的词被遗忘，降到约 0.6 天）
    D=Math.min(10,D+2*FSRS_W6);
    S=Math.max(0.5,S/1.7);
  }
  x.S=Math.max(0.3,Math.min(36500,S));
  x.D=D; x.last=ts();
  return x;
}

/* ---------- 视图 ---------- */
function go(v){
  document.querySelectorAll('.view').forEach(function(el){ el.classList.remove('active'); });
  var el=document.getElementById('view-'+v); if(el) el.classList.add('active');
  document.querySelectorAll('.bottom-nav button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-nav')===v); });
  if(v==='home') renderHome();
  if(v==='wrongbook') renderWrong();
  if(v==='tooeasy') renderTooEasy();
  if(v==='dashboard') renderDash();
  if(v==='settings') renderSettings();
  if(v==='overview') renderOverview();
  if(v==='college') renderCollege();
  window.scrollTo(0,0);
}
function toast(msg){
  var t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(t._tm); t._tm=setTimeout(function(){ t.classList.remove('show'); },2200);
}

/* ---------- 发音 ---------- */
var audioCache={};
var currentAudio=null;
function audioUrl(word){
  return 'https://dict.youdao.com/dictvoice?audio='+encodeURIComponent(word)+'&type='+(S.accent==1?1:2);
}
function getAudio(word){
  var key=(S.accent==1?1:2)+'|'+word.toLowerCase();
  var a=audioCache[key];
  if(!a){
    a=new Audio(); a.preload='auto'; a.src=audioUrl(word); a.load();
    var ks=Object.keys(audioCache);
    if(ks.length>60){ for(var i=0;i<12;i++){ try{ audioCache[ks[i]].pause(); }catch(e){} delete audioCache[ks[i]]; } }
    audioCache[key]=a;
  }
  return a;
}
function preloadAudio(w){ if(!w) return; try{ getAudio(w.w); }catch(e){} }
function speak(silent){
  var w=S.current; if(!w) return;
  try{
    if(currentAudio){ currentAudio.pause(); currentAudio.currentTime=0; }
    var a=getAudio(w.w); currentAudio=a;
    var p=a.play();
    if(p && p.catch){ p.catch(function(){ if(!silent) toast('音频加载中，请再点一次'); }); }
  }catch(e){ if(!silent) toast('发音失败，请检查网络'); }
}
function autoSpeak(w){
  setTimeout(function(){
    if(S.current && S.current.w===w.w) speak(true);
  }, 180);
}
/* 播放某个指定单词（首页预测卡片、总览页点词时用） */
function speakWord(word){
  var w=trainedPool().filter(function(x){ return x.w===word; })[0]
     || COLLEGE.filter(function(x){ return x.w===word; })[0]
     || S.current;
  if(!w) return;
  try{
    if(currentAudio){ currentAudio.pause(); currentAudio.currentTime=0; }
    var a=getAudio(w.w); currentAudio=a;
    var p=a.play();
    if(p && p.catch) p.catch(function(){});
  }catch(e){}
}
function toggleAccent(){
  S.accent=S.accent==1?2:1; save();
  preloadAudio(S.current); updateAccentUI();
  toast(S.accent==1?'已切换英式发音':'已切换美式发音');
  if(S.current) autoSpeak(S.current);
}
function updateAccentUI(){
  var t=S.accent==1?'英':'美';
  ['accentBtn','accentBtnPlace'].forEach(function(id){
    var b=document.getElementById(id);
    if(b){ b.textContent=t; b.classList.toggle('uk',S.accent==1); }
  });
}

/* ---------- 单词不换行 + 自适应字号 ---------- */
function fitWord(el){
  if(!el) return;
  el.style.whiteSpace='nowrap';
  var base=44;
  el.style.fontSize=base+'px';
  var parent=el.parentElement;
  var max=parent?parent.clientWidth-8:window.innerWidth-48;
  var w=el.scrollWidth;
  if(w>max && w>0){ el.style.fontSize=Math.max(18, Math.floor(base*max/w))+'px'; }
  el.style.overflow='visible';
}
window.addEventListener('resize',function(){
  fitWord(document.getElementById('quizWord'));
  fitWord(document.getElementById('placeWord'));
});

/* ---------- 首屏 ---------- */
function renderHome(){
  var wrongN=Object.keys(S.wrong).length;
  document.getElementById('wrongCount').textContent=wrongN?wrongN+' 个待强化':'遗忘曲线强化';  var masteredN=Object.keys(S.mastered).length;
  var teN=Object.keys(S.tooEasy).length;
  var vocabTxt = S.vocabSize ? (S.vocabSize>=99999?'≥2万':('≈'+S.vocabSize)) : '—';
  document.getElementById('homeStats').innerHTML=
    '<div class="hstat"><b>'+vocabTxt+'</b><span>词汇量</span></div>'+
    '<div class="hstat"><b>'+wrongN+'</b><span>错题本</span></div>'+
    '<div class="hstat"><b>'+S.streak+'</b><span>连续打卡</span></div>';
  var teStat=document.getElementById('tooEasyStat');
  if(teStat) teStat.textContent=teN?teN+' 个已标记':'太简单';
  var colStat=document.getElementById('collegeStat');
  if(colStat){
    var colDone=0;
    COLLEGE.forEach(function(x){ if(S.mastered[x.w]) colDone++; });
    colStat.textContent = COLLEGE.length ? ('已背 '+colDone+'/'+COLLEGE.length) : '教材单元';
  }
  // 自适应预测卡片：显示模型认为的「重点但可能不会」的词
  var predBox=document.getElementById('predictBox');
  if(predBox){
    var hard=predictedHard(8);
    if(S.thetaN>=5 && hard.length){
      predBox.style.display='block';
      predBox.innerHTML='<div class="predict-title">下一个可能卡住的词 <span class="predict-sub">已答 '+(S.thetaN||0)+' 题·模型预测</span></div>'+
        hard.map(function(x){
          return '<div class="predict-item" onclick="App.speakWord(\''+esc(x.w.w).replace(/'/g,"\\'")+'\')">'+
            '<b>'+esc(x.w.w)+'</b><span class="predict-p">'+(x.w.ipa||'')+'</span>'+
            '<span class="predict-badge">'+(x.p<0.3?'很可能不会':(x.p<0.5?'可能不会':'拿不准'))+'</span></div>';
        }).join('');
    }else predBox.style.display='none';
  }
  document.querySelectorAll('.level-chip').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-lv')===String(S.level)); });
}
function setLevel(lv){
  S.level=lv; save();
  document.querySelectorAll('.level-chip,.seg button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-lv')===String(lv)); });
  renderHome(); toast('已切换范围：'+(lv==='both'?'四级+六级':lv+'级'));
}

/* ---------- 词汇量测试（词频分带抽样 + 反S曲线拟合） ----------
   参考：Paul Nation VST 词频分带 + Neural Pensieve 的反 S 曲线（逻辑斯蒂）拟合。
   思路：把词按词频升序（f 越小越常见），在对数域上把「认识概率」拟合成
   P(认识)=1/(1+exp((log f - μ)/σ))，μ 处认识概率 50% 即「词汇量边界」。
   相比旧的「累计正确率首次跌破 0.7」边界法，拟合更平滑、抗单题运气。 */
var PLACE_BANDS=8, PLACE_PER_BAND=4;      // 8 带 × 4 词 = 32 题
var PLACE_MAX=8;                          // 上限：认为词量 ≥ 约 2 万
function placementPool(){
  // 只用有真实词频的词做估算（f<90000 表示有 Google 词频排名，99999 是「无排名」哨兵值）
  return trainedPool().filter(function(w){ return w.f>0 && w.f<90000; })
    .slice().sort(function(a,b){ return (a.f||0)-(b.f||0); });
}
function startPlacement(){
  // 先清阈值再建词池，否则重测时旧 skipThreshold 会把简单词过滤掉，样本偏难
  S.placementDone=false; S.skipThreshold=0;
  var pool=placementPool(), sample=[];
  if(pool.length>=8){
    // 等量分带：排序后按词频均分 8 段（在词频对数分布下等效于对数分带）
    for(var band=0; band<PLACE_BANDS; band++){
      var lo=Math.floor(band*pool.length/PLACE_BANDS), hi=Math.floor((band+1)*pool.length/PLACE_BANDS);
      var seg=pool.slice(lo,hi); shuffle(seg);
      sample=sample.concat(seg.slice(0,PLACE_PER_BAND));
    }
  }else{ sample=pool.slice(); shuffle(sample); }
  shuffle(sample);
  S.placePool=sample; S.placeAsked={}; S.placeIdx=0; S.placeCorrect=0; S.placeAnswers=[];
  S.session={type:'placement'}; save();
  go('placement'); showPlace();
}
function placeAnswer(known){
  if(known) S.placeCorrect++;
  S.placeAnswers=S.placeAnswers||[];
  S.placeAnswers.push({f:S.current.f||2, ok:!!known});
  S.placeIdx++; save(); showPlace();
}
/* 逻辑斯蒂拟合：网格搜索使似然最大的 (μ, σ)。
   points: [{x:log10(f), y:0|1}]，x 越大=词越生僻=越不可能认识 */
function fitLogistic(points){
  if(!points.length) return {u:2.3, s:1.0};
  var uBest=2.3, sBest=1.0, best=-Infinity;
  for(var u=0.3; u<=4.4; u+=0.05){
    for(var s=0.25; s<=2.0; s+=0.05){
      var ll=0;
      for(var i=0;i<points.length;i++){
        var z=Math.max(-50, Math.min(50, (points[i].x-u)/s));
        var p=1/(1+Math.exp(z));
        ll += points[i].y*Math.log(p+1e-9) + (1-points[i].y)*Math.log(1-p+1e-9);
      }
      if(ll>best){ best=ll; uBest=u; sBest=s; }
    }
  }
  return {u:uBest, s:sBest};
}
function finishPlacement(){
  S.placementDone=true;
  var ans=(S.placeAnswers||[]).filter(function(a){ return a.f>0 && a.f<90000; });
  var pts=ans.map(function(a){ return {x:Math.log(a.f)/Math.LN10, y:a.ok?1:0}; });
  var fit=fitLogistic(pts);
  var u0=fit.u, s=Math.max(0.3, fit.s);
  var vocabSize=Math.round(Math.pow(10,u0));          // 50% 边界 = 估计词汇量
  var allKnown=ans.length>0 && ans.every(function(a){ return a.ok; });
  var allUnknown=ans.length>0 && ans.every(function(a){ return !a.ok; });
  // skip 阈值取「认识概率 0.7」处：u70 = u0 - ln(0.7/0.3)·s ≈ u0 - 0.847s
  var u70=u0 - 0.847*s;
  var proposed=Math.max(0, Math.round(Math.pow(10,u70)));
  if(allKnown){ proposed=99999; vocabSize=99999; }    // 全认识：跳过全部词
  if(allUnknown){ proposed=0; vocabSize=Math.round(Math.pow(10,u0)); }
  // 保底：至少保留 50% 词可背（不受 skipThreshold 影响，用完整词池算上限）
  var keepSkip=S.skipThreshold; S.skipThreshold=0; var sorted=freqSorted(); S.skipThreshold=keepSkip;
  if(sorted.length){
    var capIndex=Math.floor(sorted.length*0.5);
    var maxAllowed=sorted[Math.min(capIndex,sorted.length-1)].f;
    if(maxAllowed>=sorted[sorted.length-1].f) proposed=0;
    else if(proposed>maxAllowed) proposed=maxAllowed;
  }else proposed=0;
  S.skipThreshold=proposed;
  S.vocabSize=vocabSize;
  // 用入学测试的拟合结果初始化自适应能力值 θ（同一 log10 词频刻度）
  if(!allKnown && !allUnknown){ S.theta=Math.max(-0.3,Math.min(5.0,u0)); S.thetaN=ans.length; }
  else if(allKnown){ S.theta=5.0; S.thetaN=ans.length; }
  else { S.theta=-0.3; S.thetaN=ans.length; }
  var rate=Math.round(S.placeCorrect/Math.max(1,S.placePool.length)*100);
  S.session=null; save();
  showPlaceResult(vocabSize, rate, ans.length);
}
function showPlaceResult(vocabSize, rate, asked){
  var box=document.getElementById('placeResult');
  var wordEl=document.getElementById('placeWord'); if(wordEl) wordEl.style.display='none';
  var ipaEl=document.getElementById('placeIpa'); if(ipaEl) ipaEl.style.display='none';
  var actions=document.getElementById('placeActions'); if(actions) actions.style.display='none';
  var card=document.getElementById('placeCard'); if(card) card.style.display='none';
  var hint=document.getElementById('placeHint'); if(hint) hint.style.display='none';
  var tip=document.getElementById('placeTip'); if(tip) tip.style.display='none';
  var prog=document.getElementById('placeProgress'); if(prog) prog.textContent='完成';
  var sizeText = vocabSize>=99999 ? '≥ 20000' : ('≈ '+vocabSize);
  if(box){
    box.innerHTML =
      '<div class="pr-big">'+sizeText+'</div>'+
      '<div class="pr-unit">个单词（按词频估算）</div>'+
      '<div class="pr-sub">本次问了 '+asked+' 个词，正确率 '+rate+'%</div>'+
      '<button class="btn btn-primary wide" onclick="App.go(\'home\')">开始学习<svg class="btn-ic"><use href="#i-arrow"/></svg></button>'+
      '<button class="btn btn-ghost wide" onclick="App.resetPlacement()">重新测试</button>';
    box.style.display='block';
  }
  toast('词汇量约 '+(vocabSize>=99999?'2万+':vocabSize)+' 词，将跳过词频前 '+S.skipThreshold+' 的已掌握词');
}
function showPlace(){
  // 重置结果/卡片显示，重新开始测试
  var box=document.getElementById('placeResult'); if(box) box.style.display='none';
  var wordEl=document.getElementById('placeWord'); if(wordEl) wordEl.style.display='';
  var ipaEl=document.getElementById('placeIpa'); if(ipaEl) ipaEl.style.display='';
  var actions=document.getElementById('placeActions'); if(actions) actions.style.display='';
  var card=document.getElementById('placeCard'); if(card) card.style.display='';
  var hint=document.getElementById('placeHint'); if(hint) hint.style.display='';
  var tip=document.getElementById('placeTip'); if(tip) tip.style.display='';
  var w=S.placePool[S.placeIdx];
  if(!w){ finishPlacement(); return; }
  S.current=w; preloadAudio(w); autoSpeak(w);
  document.getElementById('placeProgress').textContent=(S.placeIdx+1)+' / '+S.placePool.length;
  document.getElementById('placeWord').textContent=w.w;
  fitWord(document.getElementById('placeWord'));
  document.getElementById('placeIpa').textContent=w.ipa||'';
}

/* ---------- 测验（可持久化、多阶段） ---------- */
function wrongDue(){
  var now=ts();
  return trainedPool().filter(function(w){
    var x=S.wrong[w.w]; if(!x) return false;
    var d=(now-(x.last||x.first))/86400000;
    var interval=fsrsInterval(x.S,FSRS_TARGET_R);
    return d>=interval;
  });
}
function wrongSorted(){
  var now=ts();
  return trainedPool().filter(function(w){ return !!S.wrong[w.w]; }).sort(function(a,b){
    var x=S.wrong[a.w],y=S.wrong[b.w];
    var da=(now-(x.last||x.first))/86400000, db=(now-(y.last||y.first))/86400000;
    var ia=fsrsInterval(x.S,FSRS_TARGET_R), ib=fsrsInterval(y.S,FSRS_TARGET_R);
    return (db-ib)-(da-ia) || (y.n-x.n);
  });
}
/* 大学英语的错题列表（按 FSRS 到期优先） */
function collegeWrongSorted(){
  var now=ts();
  return COLLEGE.filter(function(w){ return !!S.wrong[w.w]; }).sort(function(a,b){
    var x=S.wrong[a.w],y=S.wrong[b.w];
    var da=(now-(x.last||x.first))/86400000, db=(now-(y.last||y.first))/86400000;
    var ia=fsrsInterval(x.S,FSRS_TARGET_R), ib=fsrsInterval(y.S,FSRS_TARGET_R);
    return (db-ib)-(da-ia) || (y.n-x.n);
  });
}
/* ---------- 自适应选题引擎（能力值 θ + 词难度 b 的 IRT/ELO 混合） ----------
   参考 Duolingo Birdbrain（ELO）与标准 IRT（最大信息量选题/@Python adaptivetesting）：
   - 每个词的难度 b = log10(词频 f)，词越生僻 b 越大（与 app 的词频刻度一致）
   - 你的能力 θ 也用同一刻度：θ 越大，代表能认出越生僻的词
   - 认识概率（3 参数逻辑斯蒂的简化 2PL）：P = 1/(1+exp((b-θ)/s))，s≈0.55
   每答一题用 ELO 式增量更新 θ（答对则上升、答错则下降），步长随答题数衰减。
   选题：给候选词打分，同时考虑「重点程度」「预测不会」「恰好卡在边界」。
   ---------- */
var ADAPT_S=0.55;          // 逻辑斯蒂斜率（越小曲线越平缓、越宽容）
var ADAPT_K0=0.55;         // θ 更新初始步长（对数刻度）
var ADAPT_BOUNDARY=0.55;   // 学习边界的目标认识概率

function wordB(w){
  var f=(w&&w.f)||99999;
  if(f>=90000) f=20000;                     // 无词频排名的词当作中偏难
  return Math.log(Math.max(2,f))/Math.LN10; // log10 刻度
}
function predictP(w,theta){
  var t=(theta==null)?(S.theta||0):theta;
  var z=(wordB(w)-t)/ADAPT_S;
  z=Math.max(-8,Math.min(8,z));
  return 1/(1+Math.exp(z));
}
function updateTheta(known,w){
  var b=wordB(w), p=predictP(w);
  var k=ADAPT_K0/Math.sqrt(1+(S.thetaN||0)*0.35);   // 步长随答题数衰减
  var err=(known?1:0)-p;
  S.theta=Math.max(-0.5,Math.min(5.2,(S.theta||0)+k*err));
  S.thetaN=(S.thetaN||0)+1;
  S.adaptiveLog=S.adaptiveLog||[];
  S.adaptiveLog.push({ts:ts(), theta:Math.round(S.theta*1000)/1000, known:!!known, w:w.w});
  if(S.adaptiveLog.length>500) S.adaptiveLog.shift();
}
/* 重点程度：在当前可背词池里，词频越靠前越重点（0~1）。
   注意必须用「当前词池」的实际词频范围归一化，否则跳过简单词后
   所有剩余词的绝对重要性都偏低，会被过滤掉。 */
var _impRange=null, _impKey='';
function impRange(){
  var key=String(S.level)+'|'+String(S.skipThreshold);
  if(_impRange && _impKey===key) return _impRange;
  var pool=trainedPool();
  var logs=pool.map(function(w){ return wordB(w); }).sort(function(a,b){ return a-b; });
  _impKey=key;
  if(!logs.length) return (_impRange={lo:0.3,hi:4.3});
  _impRange={lo:logs[0], hi:logs[logs.length-1]};
  if(_impRange.hi-_impRange.lo<0.3) _impRange.hi=_impRange.lo+0.3;
  return _impRange;
}
function importanceOf(w){
  var rg=impRange();
  var b=wordB(w);
  return Math.max(0,Math.min(1,1-(b-rg.lo)/(rg.hi-rg.lo)));
}
/* 自适应选题：从词池里挑下一批。
   做法：先筛出「预测你还不认识」的重点词（p<0.62 且不是最偏的），
   再按词频把候选分层，每层按 score 取若干个 —— 这样既盯着你不会的，
   又不会每次都只拿同一段相邻词，整批覆盖不同频段。 */
function pickAdaptive(type, size){
  size=size||20;
  var pool=trainedPool();
  if(!pool.length) return [];
  var theta=S.theta||0;
  var seen=S.adaptiveSeen||{};
  var scored=pool.map(function(w){
    var p=predictP(w,theta);
    var imp=importanceOf(w);
    // 重点 × 预测不会；同时给「刚好卡在 30% 认识率」的词一点加成（最有学习价值）
    var s=imp*(1-p);
    s+=0.35*Math.exp(-Math.pow((p-0.30)/0.25,2));
    // 做过的词：认识的永久降权（不再重复考），不认识的保留但降低权重
    var lb=S.learned&&S.learned[w.w];
    if(lb){
      if(lb.ok>0 && lb.ok>=lb.n*0.6) s*=0.05;      // 大多答对 → 基本不再出
      else s*=0.5;
    }
    if(seen[w.w]) s*=0.75;
    return {w:w, s:s, p:p, imp:imp, f:(w.f||99999)};
  });
  // 到期错题优先（FSRS）
  var dueSet={};
  wrongDue().slice(0,6).forEach(function(w){ dueSet[w.w]=1; });
  var dueList=scored.filter(function(x){ return dueSet[x.w.w]; })
                    .sort(function(a,b){ return b.s-a.s; }).slice(0,6);
  var duePicked=dueList.map(function(x){ return x.w; });
  var dueUsed={}; duePicked.forEach(function(w){ dueUsed[w.w]=1; });

  // 候选：预测「你还不太认识」的词（p<0.62），排除已选中的错题
  var cand=scored.filter(function(x){
    return !dueUsed[x.w.w] && x.p<0.62 && x.imp>0.05;
  });
  if(cand.length<size) cand=scored.filter(function(x){ return !dueUsed[x.w.w]; });
  cand.sort(function(a,b){ return a.f-b.f; });     // 按词频升序分层

  var need=Math.max(0,size-duePicked.length);
  var strata=Math.min(4, Math.max(1, Math.floor(cand.length/need) || 1));
  var picked=duePicked.slice();
  var perStratum=Math.ceil(need/strata);
  for(var st=0; st<strata && picked.length<size; st++){
    var lo=Math.floor(st*cand.length/strata), hi=Math.floor((st+1)*cand.length/strata);
    var seg=cand.slice(lo,hi).sort(function(a,b){ return b.s-a.s; });
    for(var i=0;i<seg.length && i<perStratum && picked.length<size;i++) picked.push(seg[i].w);
  }
  // 兜底：还不够就从全局最高分补
  if(picked.length<size){
    scored.slice().sort(function(a,b){ return b.s-a.s; }).forEach(function(x){
      if(picked.length<size && picked.indexOf(x.w)<0) picked.push(x.w);
    });
  }
  // 记录已见（永久保留，不再按 7 天清理；做题记录是学习的资产）
  S.adaptiveSeen=S.adaptiveSeen||{};
  picked.forEach(function(w){ S.adaptiveSeen[w.w]=ts(); });
  return shuffle(picked.slice(0,size)).sort(function(a,b){ return (a.f||99999)-(b.f||99999); });
}
/* 供 UI 用：当前模型认为「最值得优先攻克」的重点词前 N 个。
   风险 = 重点程度 × 预测不认识程度；不硬性要求预测不认识，
   否则水平高的用户永远看不到卡片。 */
function predictedHard(n){
  n=n||8;
  var theta=S.theta||0;
  var seen=S.adaptiveSeen||{};
  return trainedPool().map(function(w){
    var p=predictP(w,theta), imp=importanceOf(w);
    var risk=imp*(1-p);
    return {w:w, p:p, imp:imp, risk:risk, b:wordB(w), seen:!!seen[w.w]};
  }).filter(function(x){
    // 只考虑重点词（词频前 70%）且还没掌握（不在 mastered / 不是太简单）
    return x.imp>0.3 && !S.mastered[x.w.w];
  }).sort(function(a,b){
    // 先挑没做过的，再按风险排序
    if(a.seen!==b.seen) return a.seen?1:-1;
    return b.risk-a.risk;
  }).slice(0,n);
}
/**/
/* 从词频顺序里连续取 20 词（老逻辑，错题本等场景保留） */
function pickBatch(type, size){
  size=size||20;
  var pool=freqSorted();                 // 已按词频升序，且已排除太简单/跳过的词
  if(!pool.length) return [];
  var set={};
  var cursor=S.batchCursor||0;
  if(cursor>=pool.length) cursor=0;
  var picked=[];
  for(var i=0;i<pool.length && picked.length<size;i++){
    var w=pool[(cursor+i)%pool.length];
    if(set[w.w]) continue;
    set[w.w]=1; picked.push(w);
  }
  // 到期错题最多并入 5 个（不足则补足到 size）
  wrongDue().slice(0,5).forEach(function(w){
    if(picked.length<size && !set[w.w]){ set[w.w]=1; picked.push(w); }
  });
  return shuffle(picked.slice(0,size)).sort(function(a,b){ return (a.f||99999)-(b.f||99999); });
}
function startQuiz(type, opts){
  opts=opts||{};
  // 已有同一类型的未完成测验 → 恢复，不重建（切页/刷新后测验不变）
  if(!opts.queue && S.session && S.session.type===type && S.session.queue && S.session.queue.length){
    go(S.session.mode==='overview'?'overview':'quiz');
    if(S.session.mode==='overview') renderOverview(); else showQuiz();
    return;
  }
  var queue=[];
  if(opts.queue){ queue=opts.queue.slice(); }
  else if(type==='wrong'){
    queue=wrongSorted().slice(0,20);
    if(!queue.length){ toast('错题本还是空的，先做几道题吧'); go('wrongbook'); return; }
  }else if(type==='college'){
    // 大学英语：opts.queue 由 startCollege 传入，正常不会走到这里
    var u=collegeUnits(collegeBook);
    queue = u.length ? collegePoolLeft(collegeBook, u[0].u).slice(0,20) : [];
    if(!queue.length){ toast('没有可背的单词'); go('college'); return; }
  }else{
    // 认识测验走自适应选题；拼写测验沿用顺序取词
    queue=(type==='normal') ? pickAdaptive(type, 20) : pickBatch(type, 20);
  }
  if(!queue.length){ toast('没有可测验的单词'); return; }
  S.session={ type:type, mode:'main', queue:queue, idx:0, correct:0,
              mainWords:queue.slice(), unknown:[], rec:{}, hist:[], round:0 };
  S.batchNo=(S.batchNo||0)+1;
  save(); go('quiz'); showQuiz();
}
function resumeQuiz(){
  if(!S.session || !S.session.queue){ toast('当前没有进行中的测验'); return; }
  go(S.session.mode==='overview'?'overview':'quiz');
  if(S.session.mode==='overview') renderOverview(); else showQuiz();
}
function restartQuiz(){
  if(!S.session) return;
  if(!confirm('重新开始会丢弃当前这一套的进度，确定吗？')) return;
  var t=S.session.type; S.session=null; save(); toast('已重新开始测验'); startQuiz(t);
}
function phaseLabel(){
  var ss=S.session;
  if(!ss) return '';
  var base = ss.type==='college' ? '大学英语' : '认识测验';
  if(ss.mode==='main') return base;
  if(ss.mode==='retest') return '再认一遍 · 第'+(ss.round||1)+'轮';
  if(ss.mode==='final') return '打乱小测';
  return base;
}
function showQuiz(){
  var ss=S.session;
  if(!ss || !ss.queue) return;
  if(ss.mode==='overview'){ go('overview'); renderOverview(); return; }
  var w=ss.queue[ss.idx];
  if(!w){ advancePhase(); return; }
  S.current=w; preloadAudio(w);
  if(ss.queue[ss.idx+1]) preloadAudio(ss.queue[ss.idx+1]);
  autoSpeak(w);
  var isSpell=ss.type==='spell';
  document.getElementById('quizTag').textContent=ss.type==='wrong'?'强化复习':phaseLabel();  var total=ss.mode==='final'?ss.mainWords.length:ss.queue.length;
  document.getElementById('quizProgress').textContent=(ss.idx+1)+' / '+total;
  document.getElementById('quizWord').textContent=isSpell?'—':w.w;
  fitWord(document.getElementById('quizWord'));
  document.getElementById('quizIpa').textContent=isSpell?((w.m[0]&&w.m[0].t)||''):(w.ipa||'');
  document.getElementById('quizHint').textContent=isSpell?'根据释义拼写单词':(ss.mode==='retest'?'这个单词记住了吗？':'这个单词你认识吗？');
  document.getElementById('answerReveal').style.display='none';
  document.getElementById('quizActions').style.display=isSpell?'none':'flex';
  document.getElementById('revealActions').style.display='none';
  document.getElementById('undoBtn').style.display='none';
  document.getElementById('spellBox').style.display=isSpell?'flex':'none';
  document.getElementById('spellInput').value='';
  document.getElementById('quizTip').textContent='';
  save();
  if(isSpell) setTimeout(function(){ document.getElementById('spellInput').focus(); },100);
}
function advancePhase(){
  var ss=S.session;
  if(ss.mode==='main'){
    if(ss.type==='spell'){ finishQuiz(); return; }
    if(ss.unknown.length){ ss.queue=shuffle(ss.unknown.slice()); ss.idx=0; ss.mode='retest'; ss.round=1;
      toast('对 '+ss.queue.length+' 个不认识的词再练一遍'); save(); showQuiz(); return; }
    // 全部认识 → 直接进本轮总览（不再重复考同一批 20 词）
    ss.mode='overview'; save(); go('overview'); renderOverview(); return;
  }
  if(ss.mode==='retest'){
    if(!ss.unknown.length){ ss.mode='overview'; save(); go('overview'); renderOverview(); return; }
    ss.queue=shuffle(ss.unknown.slice()); ss.idx=0; ss.round=(ss.round||1)+1;
    toast('还有 '+ss.queue.length+' 个词，再来一遍'); save(); showQuiz(); return;
  }
  if(ss.mode==='final'){
    ss.mode='overview'; save(); go('overview'); renderOverview(); return;
  }
}
function checkSpell(){
  var w=S.current, val=(document.getElementById('spellInput').value||'').trim().toLowerCase();
  reveal(val===w.w.toLowerCase());
}
function snapshot(w){
  var ss=S.session;
  var rec=ss.rec[w.w]||(ss.rec[w.w]={main:false,retest:false});
  return {
    word:w.w,
    prevWrong:JSON.parse(JSON.stringify(S.wrong[w.w]||null)),
    prevMastered:JSON.parse(JSON.stringify(S.mastered[w.w]||null)),
    prevDaily:JSON.parse(JSON.stringify(S.daily[today()]||null)),
    prevUnknown:JSON.stringify(ss.unknown),
    prevQueue:JSON.stringify(ss.queue),
    recMain:rec.main, recRetest:rec.retest,
    idx:ss.idx, correct:ss.correct, mode:ss.mode,
    logLen:S.wrongLog.length,
    prevTheta:S.theta, prevThetaN:S.thetaN, prevAdaptiveLogLen:(S.adaptiveLog||[]).length,
    isRetest:ss.mode!=='main'
  };
}
/* 撤销：答对/答错都能回到答这道题之前的界面（可连续回退） */
function undo(){
  var ss=S.session;
  if(!ss || !ss.hist || !ss.hist.length){ toast('没有可撤销的题目'); return; }
  var L=ss.hist.pop(), w=L.word;
  if(L.prevWrong) S.wrong[w]=L.prevWrong; else delete S.wrong[w];
  if(L.prevMastered) S.mastered[w]=L.prevMastered; else delete S.mastered[w];
  if(L.prevDaily) S.daily[today()]=L.prevDaily; else delete S.daily[today()];
  ss.unknown=JSON.parse(L.prevUnknown);
  ss.queue=JSON.parse(L.prevQueue);
  ss.rec[w]={main:L.recMain, retest:L.recRetest};
  ss.idx=L.idx; ss.correct=L.correct; ss.mode=L.mode;
  S.wrongLog.length=L.logLen;
  // 撤销时把能力值也回滚，否则撤销会双重计数
  if(L.prevTheta!==undefined){ S.theta=L.prevTheta; S.thetaN=L.prevThetaN; }
  if(L.prevAdaptiveLogLen!==undefined) (S.adaptiveLog||[]).length=L.prevAdaptiveLogLen;
  save(); showQuiz(); toast('已撤销「'+w+'」，可以重新作答');
}
function answer(known){ reveal(known); }
function reveal(known){
  var w=S.current, ss=S.session;
  ss.hist=ss.hist||[];
  ss.hist.push(snapshot(w));          // 入栈，支持答对/答错都能撤销
  if(ss.hist.length>30) ss.hist.shift();
  // 正确率只按主轮（第一遍）统计，重测轮是对主轮不认识词的强化，不计入正确率
  if(known && ss.mode==='main') ss.correct++;
  var isRetest=ss.mode!=='main';
  var rec=ss.rec[w.w];
  var key=isRetest?'retest':'main';
  var allowed=ss.type==='normal' ? !rec[key] : (!rec.main && !rec.retest);
  if(!known){
    rec[key]=true;
    var x=S.wrong[w.w]||{n:0,rep:0,first:ts(),S:0.5,D:5};
    if(allowed){
      x.n++; x.level=w.l; x.college=!!w.isCollege;
      fsrsUpdate(x, false, (ts()-(x.last||x.first))/86400000);
      S.wrong[w.w]=x;
      S.wrongLog.push({w:w.w, ts:ts(), date:today(), type:ss.type}); updateStreak();
    } else S.wrong[w.w]=x;
    // 加入本轮不认识列表
    if(!ss.unknown.some(function(y){ return y.w===w.w; })) ss.unknown.push(w);
  }else{
    if(S.wrong[w.w]){ var wx=S.wrong[w.w]; wx.rep=(wx.rep||0)+1;
      fsrsUpdate(wx, true, (ts()-(wx.last||wx.first))/86400000); }
    var m=S.mastered[w.w]||{n:0}; m.n++; S.mastered[w.w]=m;
    // 从本轮不认识列表移除
    ss.unknown=ss.unknown.filter(function(y){ return y.w!==w.w; });
  }
  var d=today(), day=S.daily[d]||{new:0,correct:0,total:0};
  day.total++; if(known) day.correct++;
  if(!S.mastered[w.w]||S.mastered[w.w].n===1) day.new++;
  S.daily[d]=day; updateStreak();
  // 永久学习账本：每个做过的词都记（跨版本不丢，选题靠它避开做过的词）
  var lb=S.learned[w.w]||{n:0, ok:0, first:ts(), last:0};
  lb.n++; if(known) lb.ok++; lb.last=ts();
  S.learned[w.w]=lb;
  // 自适应：每答一题都更新能力值（只有主轮计入，重测轮是对同批词的强化，不重复算能力）
  if(ss.mode==='main' && !w.isCollege && (ss.type==='normal'||ss.type==='wrong')) updateTheta(known, w);
  save();

  var mean=(w.m||[]).map(function(x){ return (x.p?'<span class="pos">'+esc(x.p)+'.</span>':'')+esc(x.t); }).join('；');
  document.getElementById('answerMean').innerHTML='<span class="pos" style="font-family:Times New Roman,serif">'+esc(w.w)+' '+esc(w.ipa||'')+'</span><br>'+(mean||'—');
  var pb=document.getElementById('answerPhrases');
  if(w.ph && w.ph.length){
    pb.innerHTML='<div class="phrase-title">常用短语</div>'+w.ph.slice(0,5).map(function(p){
      return '<div class="phrase-item"><b>'+esc(p.p)+'</b><span>'+esc(p.t)+'</span></div>';
    }).join(''); pb.style.display='block';
  }else pb.style.display='none';
  var ex=document.getElementById('answerEx'); var parts=[];
  if(w.sen && w.sen.length){ w.sen.slice(0,2).forEach(function(s){ parts.push('• '+s.e+'\n  '+s.c); }); }
  else if(w.df && w.df.length){ parts.push('用法：'+w.df.join('；')); }
  else if(w.ex){ parts.push('例：'+w.ex); }
  ex.textContent=parts.length?parts.join('\n'):'提示：'+w.w+' 的常见搭配请结合释义记忆';
  ex.style.display='block';
  var fb=document.getElementById('answerFreq');
  if(w.isCollege){
    var markTxt={'*':'提高目标','★':'提高目标','▲':'发展目标','Ⓐ':'学术词汇 AWL'}[w.mark]||'';
    fb.textContent='大学英语 · '+BOOK_NAME[w.book]+' Unit '+w.unit+(markTxt?' · '+markTxt:'');
  }else{
    fb.textContent=w.f>0&&w.f<90000?('词频排名 #'+w.f+' · '+(w.l===4?'四级':'六级')+'词'):((w.l===4?'四级':'六级')+'词汇');
  }
  document.getElementById('answerReveal').style.display='block';
  document.getElementById('quizActions').style.display='none';
  document.getElementById('revealActions').style.display='flex';
  document.getElementById('undoBtn').style.display='inline-flex';
  document.getElementById('quizTip').textContent=known?'✅ 回答正确':'❌ 已收入错题本，将按遗忘曲线安排复习';
}
function nextWord(){
  var ss=S.session; ss.idx++; save(); showQuiz();
}
function markTooEasy(){
  var w=S.current;
  if(!confirm('确定将「'+w.w+'」标记为太简单？以后不再出现。')) return;
  var t=ts(); S.tooEasy[w.w]=t; S.tooEasyLog.push({w:w.w,ts:t});
  delete S.wrong[w.w]; save(); toast('已标记，以后不再出现（可在「太简单」列表撤销）');
  // 从本测验队列移除
  var ss=S.session;
  ss.queue=ss.queue.filter(function(y){ return y.w!==w.w; });
  ss.unknown=ss.unknown.filter(function(y){ return y.w!==w.w; });
  ss.mainWords=ss.mainWords.filter(function(y){ return y.w!==w.w; });
  if(ss.idx>=ss.queue.length) ss.idx=0;
  save(); showQuiz();
}
function finishQuiz(){
  var ss=S.session; if(!ss) return;
  var rate=Math.round(ss.correct/Math.max(1,ss.mainWords.length)*100);
  var type=ss.type;
  // 推进批内游标，下一套从新词开始，不重复刚做完的这批
  S.batchCursor=(S.batchCursor||0)+20;
  S.lastResult={rate:rate, correct:ss.correct, total:ss.mainWords.length, type:type, no:S.batchNo||1};
  S.session=null; save();
  autoSnapshot();                        // 每做完一套自动存一份本地快照
  toast('第 '+(S.lastResult.no)+' 套完成！正确率 '+rate+'%（'+ss.correct+'/'+ss.mainWords.length+'）');
  showBatchSummary(S.lastResult);
}
/* 一套做完的结算页：可以继续下一套 */
function showBatchSummary(res){
  var box=document.getElementById('batchSummary');
  if(!box) return;
  var title=res.type==='wrong'?'强化复习':(res.type==='spell'?'拼写测试':(res.type==='college'?'大学英语':'认识测验'));
  var backView = res.type==='college' ? 'college' : 'home';
  var backLabel = res.type==='college' ? '回单元列表' : '回首页';
  box.innerHTML=
    '<div class="bs-title">第 '+res.no+' 套 · '+title+' 完成</div>'+
    '<div class="bs-rate">'+res.rate+'<span>%</span></div>'+
    '<div class="bs-detail">答对 '+res.correct+' / '+res.total+' 个单词</div>'+
    '<div class="bs-actions">'+
      '<button class="btn btn-primary" onclick="App.nextBatch()">继续下一套<svg class="btn-ic"><use href="#i-arrow"/></svg></button>'+
      '<button class="btn btn-ghost" onclick="App.go(\''+backView+'\')">'+backLabel+'</button>'+
    '</div>';
  go('batchdone');
}
function nextBatch(){
  var t=(S.lastResult&&S.lastResult.type)||'normal';
  S.session=null; save();
  if(t==='college'){ startCollege(); return; }
  startQuiz(t);
}
function finishOverview(){ finishQuiz(); }
function updateStreak(){
  var t=today();
  if(S.lastActive===t) return;
  if(S.lastActive && dayDiff(S.lastActive,t)===1) S.streak++;
  else if(S.lastActive && dayDiff(S.lastActive,t)>1) S.streak=1;
  else S.streak=Math.max(1,S.streak);
  S.lastActive=t;
}

/* ---------- 太简单列表（时间顺序，最新在上，可撤销） ---------- */
function renderTooEasy(){
  var box=document.getElementById('tooEasyList');
  var list=(S.tooEasyLog||[]).slice().sort(function(a,b){ return b.ts-a.ts; });
  if(!list.length){
    box.innerHTML='<div class="empty"><p>还没有标记「太简单」的单词</p><p style="font-size:13px;margin-top:6px">测验时点「太简单」即可加入</p></div>';
    return;
  }
  box.innerHTML=list.map(function(it){
    var w=ALL.find(function(x){ return x.w===it.w; });
    var d=new Date(it.ts);
    var date=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+
      ' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
    return '<div class="te-item"><div><div class="te-word">'+esc(it.w)+'</div>'+
      '<div class="te-meta">'+date+' · '+((w&&w.m[0]&&w.m[0].t)||'')+'</div></div>'+
      '<button class="btn btn-ghost small-btn" onclick="App.undoTooEasy(\''+esc(it.w).replace(/'/g,"\\'")+'\')">撤销</button></div>';
  }).join('');
}
function undoTooEasy(word){
  delete S.tooEasy[word];
  S.tooEasyLog=(S.tooEasyLog||[]).filter(function(x){ return x.w!==word; });
  save(); renderTooEasy(); renderHome(); toast('已撤销「'+word+'」，它回到单词表了');
}

/* ---------- 错题本（时间范围筛选 + 按日期浏览） ---------- */
var wrongRange='all';        // '1'|'3'|'7'|'all'
var wrongBrowse=false;       // false=遗忘曲线排序 true=按日期浏览
var wrongBook='cet';         // 'cet'=四六级词库 'college'=大学英语词库（两本独立）
var browseYear=0, browseMonth=0;
function setWrongBook(b){ wrongBook=b; renderWrong(); }
/* 按来源取错题词条：四六级走 CET 词池，大学英语走教材词库 */
function wrongPoolByBook(){
  if(wrongBook==='college') return COLLEGE.slice();
  return trainedPool();
}
function wrongFiltered(){
  var now=ts();
  return wrongPoolByBook().filter(function(w){
    var x=S.wrong[w.w]; if(!x) return false;
    // 两本互不串：老数据没有 college 标记时按词是否在教材词库里判定
    var isCol = (x.college!==undefined) ? !!x.college : !!COLLEGE_MAP[w.w.toLowerCase()];
    if(wrongBook==='college' ? !isCol : isCol) return false;
    if(wrongRange==='all') return true;
    var days=parseInt(wrongRange,10);
    return (now-(x.last||x.first))/86400000 <= days;
  });
}
function setWrongRange(r){ wrongRange=String(r); renderWrong(); }
function setWrongBrowse(v){ wrongBrowse=!!v; renderWrong(); }
function browseMonthShift(n){
  var d=new Date(browseYear,browseMonth+n,1); browseYear=d.getFullYear(); browseMonth=d.getMonth(); renderWrong();
}
function renderWrong(){
  document.querySelectorAll('.range-chip').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-range')===wrongRange); });
  document.querySelectorAll('.book-bar .range-chip[data-wb]').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-wb')===wrongBook); });
  var browseBtn=document.getElementById('browseBtn'), browseBtn2=document.getElementById('browseBtn2');
  if(browseBtn){ browseBtn.classList.toggle('on',!wrongBrowse); }
  if(browseBtn2){ browseBtn2.classList.toggle('on',wrongBrowse); }
  var list=wrongFiltered();
  document.getElementById('reviewBtn').style.display=list.length?'block':'none';
  var box=document.getElementById('wrongList');
  if(!list.length){
    box.innerHTML='<div class="empty"><p>这个时间范围内没有错题</p><p style="font-size:13px;margin-top:6px">'+
      (wrongBook==='college'?'去「大学英语」里做几套，答错的词会收进这里':'答错的单词会自动收进来')+'</p></div>';
    if(wrongBrowse) renderWrongByDate();
    return;
  }
  if(wrongBrowse){ renderWrongByDate(); return; }
  var now=ts();
  box.innerHTML=list.sort(function(a,b){
    var x=S.wrong[a.w],y=S.wrong[b.w];
    var da=(now-(x.last||x.first))/86400000, db=(now-(y.last||y.first))/86400000;
    var ia=fsrsInterval(x.S,FSRS_TARGET_R), ib=fsrsInterval(y.S,FSRS_TARGET_R);
    return (db-ib)-(da-ia)||(y.n-x.n);
  }).map(function(w){
    var x=S.wrong[w.w];
    var days=(now-(x.last||x.first))/86400000;
    var interval=fsrsInterval(x.S,FSRS_TARGET_R);
    var overdue=days>=interval;
    var tag=overdue?'<span class="wrong-priority '+(days>interval*2?'forgot':'recent')+'">'+(days>interval*2?'长期遗忘':'待复习')+'</span>':'';
    var mean=(w.m[0]&&w.m[0].t)||'';
    return '<div class="wrong-item"><div><div class="wi-word">'+esc(w.w)+tag+'</div>'+
      '<div class="wi-meta">'+esc(mean)+' · '+(w.ipa||'')+'</div></div>'+
      '<div class="wi-count'+(days>interval*2?' long':'')+'">错 '+x.n+' 次</div></div>';
  }).join('');
}
function renderWrongByDate(){
  var box=document.getElementById('wrongList');
  if(!browseYear){ var n=new Date(); browseYear=n.getFullYear(); browseMonth=n.getMonth(); }
  var prefix=browseYear+'-'+String(browseMonth+1).padStart(2,'0');
  var byDate={};
  (S.wrongLog||[]).forEach(function(it){
    if(!it.date || it.date.indexOf(prefix)!==0) return;
    // 两本错题本按「这个词属于哪本」分开统计
    var x=S.wrong[it.w];
    var isCol = x && x.college!==undefined ? !!x.college : !!COLLEGE_MAP[String(it.w).toLowerCase()];
    if(wrongBook==='college' ? !isCol : isCol) return;
    (byDate[it.date]=byDate[it.date]||[]).push(it.w);
  });
  var dates=Object.keys(byDate).sort().reverse();
  var html='<div class="month-nav"><button onclick="App.browseMonthShift(-1)">‹ 上月</button>'+
    '<b>'+browseYear+' 年 '+(browseMonth+1)+' 月</b><button onclick="App.browseMonthShift(1)">下月 ›</button></div>';
  if(!dates.length){ html+='<div class="empty" style="padding:40px 10px"><p>这个月还没有错题记录</p></div>'; }
  dates.forEach(function(date){
    var ws=byDate[date];
    var d=new Date(date+'T00:00:00');
    var label=date+' 周'+['日','一','二','三','四','五','六'][d.getDay()];
    html+='<div class="date-group"><div class="date-head">'+label+' <span>'+ws.length+' 词</span></div>'+
      '<div class="date-words">'+ws.map(function(word){ return '<span class="date-word">'+esc(word)+'</span>'; }).join('')+'</div></div>';
  });
  box.innerHTML=html;
}
function reviewWrong(){
  var list=wrongFiltered();
  if(!list.length){ toast('这个时间范围内没有错题'); return; }
  startQuiz('wrong',{queue:shuffle(list.slice())});
}
/* ---------- 总览（20 词，注释可点开） ---------- */
function noteHTML(w){
  var mean=(w.m||[]).map(function(x){ return (x.p?'<span class="pos">'+esc(x.p)+'.</span>':'')+esc(x.t); }).join('；');
  var h='<div class="ov-note-mean">'+esc(w.w)+' '+(w.ipa||'')+'<br>'+(mean||'—')+'</div>';
  if(w.ph&&w.ph.length){
    h+='<div class="ov-note-ph">'+w.ph.slice(0,4).map(function(p){ return '<div><b>'+esc(p.p)+'</b> '+esc(p.t)+'</div>'; }).join('')+'</div>';
  }
  if(w.sen&&w.sen.length){ h+='<div class="ov-note-ex">'+esc(w.sen[0].e)+'<br>'+esc(w.sen[0].c)+'</div>'; }
  return h;
}
function renderOverview(){
  var ss=S.session; if(!ss) return;
  var list=ss.mainWords||ss.queue;
  var box=document.getElementById('overviewList');
  box.innerHTML=list.map(function(w,i){
    var mean=(w.m[0]&&w.m[0].t)||'';
    return '<div class="ov-item"><button class="ov-toggle" onclick="App.toggleNote('+i+')">'+
      '<span class="ov-num">'+(i+1)+'</span>'+
      '<span class="ov-w" onclick="event.stopPropagation();App.speakWord(\''+esc(w.w)+'\')" title="点击发音">'+esc(w.w)+'</span>'+
      '<span class="ov-ipa">'+(w.ipa||'')+'</span><span class="ov-mean">'+esc(mean)+'</span>'+
      '<span class="ov-caret">▾</span></button>'+
      '<div class="ov-note" id="ovnote'+i+'" style="display:none">'+noteHTML(w)+'</div></div>';
  }).join('');
  document.getElementById('overviewCount').textContent=list.length+' 个单词 · 点单词读音，点其他位置展开注释';
}
function toggleNote(i){
  var el=document.getElementById('ovnote'+i); if(!el) return;
  var open=el.style.display!=='none';
  el.style.display=open?'none':'block';
  var btn=el.previousElementSibling;
  if(btn) btn.classList.toggle('open',!open);
}

/* ---------- 看板 ---------- */
function renderDash(){
  var totalCorrect=0,totalAll=0;
  Object.keys(S.daily).forEach(function(k){ totalCorrect+=S.daily[k].correct||0; totalAll+=S.daily[k].total||0; });
  var rate=totalAll?Math.round(totalCorrect/totalAll*100):0;
  document.getElementById('dashCards').innerHTML=
    '<div class="dcard"><b>'+Object.keys(S.mastered).length+'</b><span>已掌握单词</span></div>'+
    '<div class="dcard green"><b>'+rate+'%</b><span>累计正确率</span></div>'+
    '<div class="dcard red"><b>'+Object.keys(S.wrong).length+'</b><span>错题待复习</span></div>'+
    '<div class="dcard"><b>'+S.streak+'</b><span>连续打卡天数</span></div>';
  var days=[],max=1;
  for(var i=6;i>=0;i--){
    var d=new Date(); d.setDate(d.getDate()-i);
    var key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    var n=(S.daily[key]&&S.daily[key].total)||0; if(n>max)max=n;
    days.push({label:['日','一','二','三','四','五','六'][d.getDay()],n:n});
  }
  document.getElementById('dashChart').innerHTML=days.map(function(x){
    return '<div class="chart-col"><div class="chart-bar" style="height:'+Math.max(2,Math.round(x.n/max*90))+'px"></div><div class="chart-label">'+x.label+'</div></div>';
  }).join('');
  var now=new Date(), y=now.getFullYear(), m=now.getMonth();
  var first=new Date(y,m,1).getDay(), len=new Date(y,m+1,0).getDate();
  var html=['日','一','二','三','四','五','六'].map(function(x){return '<div class="cal-day" style="background:transparent;font-size:12px">'+x+'</div>';}).join('');
  for(var i=0;i<first;i++) html+='<div></div>';
  for(var d=1;d<=len;d++){
    var key=y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    var on=S.daily[key]&&S.daily[key].total>0;
    html+='<div class="cal-day'+(on?' on':'')+(d===now.getDate()?' today':'')+'">'+d+'</div>';
  }
  document.getElementById('dashCalendar').innerHTML=html;
}

/* ---------- 设置 ---------- */
function renderSettings(){
  document.querySelectorAll('.seg button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-lv')===String(S.level)); });
  renderBackupInfo();
}
function resetPlacement(){
  if(!confirm('重新进行入学测试？')) return;
  S.placementDone=false; S.skipThreshold=0; S.session=null; save(); startPlacement();
}
function exportData(){
  var txt=JSON.stringify(S,null,2);
  var blob=new Blob([txt],{type:'application/json'});
  var a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='cet-vocab-backup-'+today()+'.json'; a.click();
  // 手机上「下载」经常要选目录，顺手复制到剪贴板，粘一下就能换设备
  autoSnapshot(true);
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(function(){
      toast('已导出，并复制到剪贴板（可直接粘到别的设备）');
    }).catch(function(){ toast('已导出备份文件'); });
  }else toast('已导出备份文件');
}

/* ---------- 本地自动快照（手机端不用手动导出） ----------
   浏览器的安全限制导致网页无法扫描手机「下载」目录，
   所以改成：app 自己把学习记录存成带时间戳的快照，设置页里直接恢复。 */
var LS_BAK=LS+'_bak';
var BAK_MAX=8;
function snapshotPayload(){
  return {
    level:S.level, placementDone:S.placementDone, skipThreshold:S.skipThreshold, vocabSize:S.vocabSize,
    mastered:S.mastered, tooEasy:S.tooEasy, tooEasyLog:S.tooEasyLog,
    wrong:S.wrong, wrongLog:S.wrongLog, daily:S.daily, streak:S.streak,
    accent:S.accent, lastActive:S.lastActive,
    theta:S.theta, thetaN:S.thetaN, adaptiveLog:S.adaptiveLog,
    adaptiveSeen:S.adaptiveSeen, learned:S.learned,
    batchCursor:S.batchCursor, batchNo:S.batchNo, lastResult:S.lastResult
  };
}
function readBackups(){ try{ return JSON.parse(localStorage.getItem(LS_BAK)||'[]')||[]; }catch(e){ return []; } }
function writeBackups(list){ try{ localStorage.setItem(LS_BAK, JSON.stringify(list)); }catch(e){} }
function autoSnapshot(force){
  try{
    var p=snapshotPayload();
    var cnt=(Object.keys(p.learned||{}).length)+(Object.keys(p.wrong||{}).length)+(Object.keys(p.mastered||{}).length);
    if(!cnt && !force) return;                     // 还没学东西就不占用空间
    var json=JSON.stringify(p);
    var list=readBackups();
    if(list.length && list[0].json===json) return;  // 内容没变不重复存
    list.unshift({ts:ts(), json:json, n:cnt, size:json.length});
    if(list.length>BAK_MAX) list.length=BAK_MAX;
    writeBackups(list);
    renderBackupInfo();
  }catch(e){}
}
function fmtAgo(t){
  var m=Math.round((ts()-t)/60000);
  if(m<1) return '刚刚';
  if(m<60) return m+' 分钟前';
  var h=Math.round(m/60);
  if(h<24) return h+' 小时前';
  return Math.round(h/24)+' 天前';
}
function renderBackupInfo(){
  var el=document.getElementById('backupInfo');
  if(!el) return;
  var list=readBackups();
  if(!list.length){
    el.innerHTML='<div class="bak-none">还没有自动备份。做一套测验后会自动存一份。</div>';
    return;
  }
  el.innerHTML='<div class="bak-head">检测到 <b>'+list.length+'</b> 份本地备份（最近 '+fmtAgo(list[0].ts)+'）</div>'+
    list.map(function(b,i){
      return '<div class="bak-item"><div class="bak-meta"><b>'+new Date(b.ts).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})+'</b>'+
        '<span>'+b.n+' 个词的记录 · '+Math.round(b.size/1024)+'KB</span></div>'+
        '<button class="btn btn-ghost small-btn" onclick="App.restoreSnapshot('+i+')">恢复</button></div>';
    }).join('');
}
function restoreSnapshot(i){
  var list=readBackups();
  var b=list[i]; if(!b){ toast('备份不存在'); return; }
  if(!confirm('用这份备份恢复？会与当前进度合并，不会删除现有记录。')) return;
  try{
    var inc=normalizeBackup(JSON.parse(b.json));
    var cnt=mergeBackup(inc);
    save(); renderHome(); renderBackupInfo();
    toast('已恢复：掌握 '+cnt.mastered+' · 错题 '+cnt.wrong+' · 太简单 '+cnt.tooEasy);
    go('home');
  }catch(e){ toast('备份损坏，无法恢复'); }
}
/* 从剪贴板一键导入（手机最省事的路径） */
function importFromClipboard(){
  if(!navigator.clipboard || !navigator.clipboard.readText){
    toast('这个浏览器不支持读剪贴板，请用「粘贴」'); openImport(); return;
  }
  navigator.clipboard.readText().then(function(txt){
    if(!txt || !txt.trim()){ toast('剪贴板是空的，先把备份内容复制过来'); return; }
    importFromText(txt, 'merge');
  }).catch(function(){
    toast('读取剪贴板被拒绝，请用「粘贴」手动粘'); openImport();
  });
}

/* ---------- 导入（兼容旧版备份 + 手机粘贴） ----------
   旧备份可能缺字段：没有 theta/thetaN/adaptiveLog、tooEasy 的值是 true、
   错题记录没有 FSRS 的 S/D、用 placeQueue 而不是 placePool。
   这里统一做一次归一化，缺什么补什么，保证导入后不会把新逻辑弄崩。 */
function normalizeBackup(o){
  if(!o || typeof o!=='object') throw new Error('不是有效的备份内容');
  var out={};
  // 词库范围 / 打卡
  if(o.level!==undefined) out.level=o.level;
  if(o.accent!==undefined) out.accent=o.accent;
  if(o.streak!==undefined) out.streak=o.streak;
  if(o.lastActive!==undefined) out.lastActive=o.lastActive;
  if(o.vocabSize!==undefined) out.vocabSize=o.vocabSize;
  if(o.placementDone!==undefined) out.placementDone=o.placementDone;
  if(o.skipThreshold!==undefined) out.skipThreshold=o.skipThreshold;

  // 已掌握
  if(o.mastered && typeof o.mastered==='object'){
    out.mastered={};
    Object.keys(o.mastered).forEach(function(k){
      var v=o.mastered[k];
      out.mastered[k]=(typeof v==='number')?{n:v}:(v&&typeof v==='object')?{n:v.n||1}:{n:1};
    });
  }

  // 太简单：旧版是 true，新版是时间戳
  if(o.tooEasy && typeof o.tooEasy==='object'){
    out.tooEasy={};
    Object.keys(o.tooEasy).forEach(function(k){
      var v=o.tooEasy[k];
      out.tooEasy[k]=(v===true)?Date.now():(typeof v==='number'?v:Date.now());
    });
  }
  if(Array.isArray(o.tooEasyLog)) out.tooEasyLog=o.tooEasyLog.slice();

  // 错题本：补 FSRS 的 S/D
  if(o.wrong && typeof o.wrong==='object'){
    out.wrong={};
    Object.keys(o.wrong).forEach(function(k){
      var v=o.wrong[k]||{};
      out.wrong[k]={
        n:v.n||1,
        rep:v.rep||0,
        first:v.first||Date.now(),
        last:v.last||v.first||Date.now(),
        level:v.level,
        S:(typeof v.S==='number'&&v.S>0)?v.S:0.5,
        D:(typeof v.D==='number'&&v.D>=1)?v.D:5
      };
    });
  }
  if(Array.isArray(o.wrongLog)) out.wrongLog=o.wrongLog.slice();
  if(o.daily && typeof o.daily==='object') out.daily=o.daily;
  // 自适应能力值
  if(typeof o.theta==='number') out.theta=o.theta;
  if(typeof o.thetaN==='number') out.thetaN=o.thetaN;
  if(Array.isArray(o.adaptiveLog)) out.adaptiveLog=o.adaptiveLog.slice();
  // 学习账本 / 做过的词（新版才有，旧备份没有就跳过）
  if(o.learned && typeof o.learned==='object') out.learned=o.learned;
  if(o.adaptiveSeen && typeof o.adaptiveSeen==='object') out.adaptiveSeen=o.adaptiveSeen;
  if(typeof o.batchCursor==='number') out.batchCursor=o.batchCursor;
  if(typeof o.batchNo==='number') out.batchNo=o.batchNo;
  // 测试进度（旧版用 placeQueue）
  if(Array.isArray(o.placePool)) out.placePool=o.placePool;
  else if(Array.isArray(o.placeQueue)) out.placePool=o.placeQueue;
  if(o.placeIdx!==undefined) out.placeIdx=o.placeIdx;
  if(o.placeCorrect!==undefined) out.placeCorrect=o.placeCorrect;
  if(Array.isArray(o.placeAnswers)) out.placeAnswers=o.placeAnswers;
  if(o.placeAsked) out.placeAsked=o.placeAsked;
  return out;
}
/* 把归一化后的备份并进当前状态：词条级合并，不丢当前进度 */
function mergeBackup(inc){
  var added={mastered:0, wrong:0, tooEasy:0, daily:0};
  if(inc.mastered) Object.keys(inc.mastered).forEach(function(k){
    if(!S.mastered[k]){ S.mastered[k]=inc.mastered[k]; added.mastered++; }
    else if((inc.mastered[k].n||0)>(S.mastered[k].n||0)) S.mastered[k].n=inc.mastered[k].n;
  });
  if(inc.wrong) Object.keys(inc.wrong).forEach(function(k){
    var a=inc.wrong[k], b=S.wrong[k];
    if(!b){ S.wrong[k]=a; added.wrong++; }
    else{
      // 同词取「更该复习」的那条：错得多的优先，其次 S 小的（更不牢）
      if((a.n||0)>(b.n||0) || ((a.n||0)===(b.n||0) && (a.S||0.5)<(b.S||0.5))){
        S.wrong[k]=a; added.wrong++;
      }
    }
  });
  if(inc.tooEasy) Object.keys(inc.tooEasy).forEach(function(k){
    if(!S.tooEasy[k]){ S.tooEasy[k]=inc.tooEasy[k]; added.tooEasy++; }
  });
  // 学习账本 + 做过的词：这是「哪些词已经考过」的依据，必须一起并进来
  if(inc.learned && typeof inc.learned==='object'){
    S.learned=S.learned||{};
    Object.keys(inc.learned).forEach(function(k){
      var a=inc.learned[k], b=S.learned[k];
      if(!b) S.learned[k]=a;
      else{
        b.n=Math.max(b.n||0,a.n||0);
        b.ok=Math.max(b.ok||0,a.ok||0);
        b.first=Math.min(b.first||Infinity, a.first||Infinity);
        b.last=Math.max(b.last||0,a.last||0);
      }
    });
  }
  if(inc.adaptiveSeen && typeof inc.adaptiveSeen==='object'){
    S.adaptiveSeen=S.adaptiveSeen||{};
    Object.keys(inc.adaptiveSeen).forEach(function(k){
      if(!S.adaptiveSeen[k] || inc.adaptiveSeen[k]>S.adaptiveSeen[k]) S.adaptiveSeen[k]=inc.adaptiveSeen[k];
    });
  }
  if(inc.daily) Object.keys(inc.daily).forEach(function(k){
    var a=inc.daily[k], b=S.daily[k];
    if(!b){ S.daily[k]=a; added.daily++; }
    else{
      b.new=Math.max(b.new||0,a.new||0);
      b.correct=Math.max(b.correct||0,a.correct||0);
      b.total=Math.max(b.total||0,a.total||0);
    }
  });
  // 日志类：按内容去重合并
  function mergeLog(key, idFn){
    if(!Array.isArray(inc[key])) return;
    S[key]=S[key]||[];
    var seen={};
    S[key].forEach(function(it){ seen[idFn(it)]=1; });
    inc[key].forEach(function(it){ var id=idFn(it); if(!seen[id]){ seen[id]=1; S[key].push(it); } });
    S[key].sort(function(a,b){ return (a.ts||0)-(b.ts||0); });
  }
  mergeLog('tooEasyLog', function(it){ return it.w+'|'+it.ts; });
  mergeLog('wrongLog', function(it){ return it.w+'|'+it.ts; });
  if(inc.adaptiveLog && inc.adaptiveLog.length){
    if(!S.adaptiveLog || !S.adaptiveLog.length) S.adaptiveLog=inc.adaptiveLog.slice();
  }
  // 标量：取更「有信息量」的值
  if(inc.level && !S.level) S.level=inc.level;
  if(inc.accent!==undefined && !S.accent) S.accent=inc.accent;
  S.streak=Math.max(S.streak||0, inc.streak||0);
  if(inc.lastActive && (!S.lastActive || inc.lastActive>S.lastActive)) S.lastActive=inc.lastActive;
  if(inc.vocabSize && !S.vocabSize) S.vocabSize=inc.vocabSize;
  if(inc.placementDone && !S.placementDone){
    S.placementDone=true;
    if(inc.skipThreshold!==undefined) S.skipThreshold=inc.skipThreshold;
    if(inc.vocabSize) S.vocabSize=inc.vocabSize;
  }
  // 自适应能力值：备份里有时直接用（比反推准）
  if(typeof inc.theta==='number'){
    if(!S.thetaN || S.thetaN===0 || Math.abs((inc.theta||0))>Math.abs(S.theta||0)){ S.theta=inc.theta; S.thetaN=inc.thetaN||S.thetaN||0; }
  }
  return added;
}
/* 覆盖式导入：完全用备份替换（保留当前词库范围） */
function replaceBackup(inc){
  var lv=S.level, acc=S.accent;
  var fresh=blankState();
  fresh.level=lv; fresh.accent=acc;
  for(var k in fresh){ if(inc[k]!==undefined) fresh[k]=inc[k]; }
  S=fresh;
  return {mastered:Object.keys(S.mastered).length, wrong:Object.keys(S.wrong).length,
          tooEasy:Object.keys(S.tooEasy).length, daily:Object.keys(S.daily).length};
}
var pendingImport=null;   // 待确认的导入内容
function importFromText(text, mode){
  var raw=String(text||'').trim();
  if(!raw){ toast('没有可导入的内容'); return; }
  var obj=null;
  // 1) 先按 JSON 解析（备份文件）
  try{ obj=JSON.parse(raw); }catch(e){ obj=null; }
  // 2) 不是 JSON → 当成「一行一个单词」的清单，标记为已掌握
  if(!obj){
    var words=raw.split(/[\s,，、;；]+/).map(function(x){ return x.trim(); }).filter(Boolean);
    var known={}, hit=0;
    ALL.forEach(function(w){ known[w.w.toLowerCase()]=w; });
    var added=0;
    words.forEach(function(x){
      var w=known[x.toLowerCase()]; if(!w) return;
      hit++;
      if(!S.mastered[w.w]){ S.mastered[w.w]={n:1}; added++; }
    });
    if(!hit){ toast('没认出可导入的单词，请检查内容'); return; }
    S.placementDone=S.placementDone||true;
    save(); renderHome();
    toast('已导入 '+added+' 个词（清单里 '+hit+' 个能对上词库）');
    return;
  }
  var inc=normalizeBackup(obj);
  var cnt={mastered:0,wrong:0,tooEasy:0,daily:0};
  if(mode==='replace') cnt=replaceBackup(inc);
  else cnt=mergeBackup(inc);
  // 旧格式里的 wrongLog / daily 里出现过的词，也算「做过」
  S.learned=S.learned||{};
  (S.wrongLog||[]).forEach(function(it){
    if(it && it.w && !S.learned[it.w]) S.learned[it.w]={n:1, ok:0, first:it.ts||Date.now(), last:it.ts||Date.now()};
  });
  save(); renderHome();
  toast('导入完成：掌握 '+cnt.mastered+' · 错题 '+cnt.wrong+' · 太简单 '+cnt.tooEasy+' · 打卡 '+cnt.daily+' 天');
  go('home');
}
function importData(e){
  var f=e.target.files[0]; if(!f) return;
  var r=new FileReader();
  r.onload=function(){ importFromText(r.result, 'merge'); };
  r.onerror=function(){ toast('文件读取失败'); };
  r.readAsText(f); e.target.value='';
}
function openImport(){
  var box=document.getElementById('importBox');
  if(!box) return;
  var on=box.style.display!=='none';
  box.style.display=on?'none':'block';
  if(!on){
    box.scrollIntoView({behavior:'smooth',block:'center'});
    setTimeout(function(){ var ta=document.getElementById('importText'); if(ta) ta.focus(); },300);
  }
}
function doPasteImport(){
  var ta=document.getElementById('importText');
  var mode=(document.getElementById('importMode')||{}).value||'merge';
  if(!ta) return;
  importFromText(ta.value, mode);
  ta.value='';
  var box=document.getElementById('importBox'); if(box) box.style.display='none';
}
/* 全新的空状态（clearAll 和首次进入都用它，保证字段齐全） */
function blankState(){
  return {level:'both',placementDone:false,skipThreshold:0,vocabSize:0,
    mastered:{},tooEasy:{},tooEasyLog:[],wrong:{},wrongLog:[],daily:{},streak:0,
    accent:2,lastActive:'',session:null,current:null,
    placePool:[],placeAsked:{},placeIdx:0,placeCorrect:0,placeAnswers:[],
    theta:0,thetaN:0,adaptiveLog:[],adaptiveSeen:{},learned:{},
    batchCursor:0,batchNo:0,lastResult:null};
}
/* 清空数据：两步确认。第一步系统弹窗，第二步要把按钮再按一次，
   这样误触/连点都不会直接清空（连点两次同位置的间隔太短，会被冷却挡住）。 */
var clearArmedUntil = 0;
function clearAll(){
  var btn = document.getElementById('clearBtn');
  var now = ts();
  if(now > clearArmedUntil){
    if(!confirm('清空会删除全部错题本、学习进度和打卡记录，且不可恢复。\n\n要继续吗？')) return;
    clearArmedUntil = now + 8000;            // 8 秒内有效
    if(btn){ btn.textContent = '再点一次确认'; btn.classList.add('armed'); }
    toast('再点一次「再点一次确认」才会清空（8 秒内有效）');
    setTimeout(function(){
      if(clearArmedUntil && ts() >= clearArmedUntil - 10 && btn){
        btn.textContent = '清空'; btn.classList.remove('armed'); clearArmedUntil = 0;
      }
    }, 8200);
    return;
  }
  // 第二步：真的清
  clearArmedUntil = 0;
  if(btn){ btn.textContent = '清空'; btn.classList.remove('armed'); }
  localStorage.removeItem(LS);
  localStorage.removeItem(LS + '_bak');
  var lv=S.level||'both', acc=S.accent||2;
  S=blankState(); S.level=lv; S.accent=acc;
  save(); toast('已清空全部数据'); go('home');
}

/* ---------- 启动 ---------- */
if(location.search.indexOf('test=1')>=0){ window.confirm=function(){return true;}; window.alert=function(){}; }
window.App={
  go:go, setLevel:setLevel, startQuiz:startQuiz, resumeQuiz:resumeQuiz, restartQuiz:restartQuiz,
  startCollege:startCollege, setBook:setBook, setWrongBook:setWrongBook,
  startPlacement:startPlacement, speak:speak, toggleAccent:toggleAccent, placeAnswer:placeAnswer, answer:answer, checkSpell:checkSpell,
  nextWord:nextWord, undo:undo, markTooEasy:markTooEasy, undoTooEasy:undoTooEasy,
  setWrongRange:setWrongRange, setWrongBrowse:setWrongBrowse, browseMonthShift:browseMonthShift,
  reviewWrong:reviewWrong, toggleNote:toggleNote, finishOverview:finishOverview, finishQuiz:finishQuiz,
  nextBatch:nextBatch, speakWord:speakWord,
  resetPlacement:resetPlacement, exportData:exportData, importData:importData, clearAll:clearAll,
  openImport:openImport, doPasteImport:doPasteImport, restoreSnapshot:restoreSnapshot,
  importFromClipboard:importFromClipboard, autoSnapshot:autoSnapshot, renderBackupInfo:renderBackupInfo
};
if(location.search.indexOf('test=1')>=0){
  window.App._setCurrent=function(w){ S.current=w; };
  window.App._audioSrc=function(){ return currentAudio?currentAudio.src:''; };
  window.App._state=function(){ return JSON.parse(JSON.stringify(S)); };
}

var booted=false;
function boot(){
  if(booted) return; booted=true;
  load();
  var lv=document.getElementById('view-loading');
  if(!ALL.length){
    if(lv) lv.innerHTML='<div class="empty"><p>词库未能加载</p><p style="font-size:12px;margin-top:8px">请检查网络后刷新页面</p><button class="btn btn-ghost" style="margin-top:16px;flex:0 0 auto;padding:8px 18px" onclick="location.reload()">重新加载</button></div>';
    return;
  }
  updateAccentUI();
  // 恢复未完成的测验（切页/刷新后不变）
  if(S.session && S.session.queue && S.session.queue.length && S.session.type!=='placement'){
    go(S.session.mode==='overview'?'overview':'quiz');
    if(S.session.mode==='overview') renderOverview(); else showQuiz();
  }else if(S.placePool && S.placeIdx<S.placePool.length && !S.placementDone){
    go('placement'); showPlace();
  }else{
    go('home');
    if(!S.placementDone){
      setTimeout(function(){ if(confirm('欢迎使用词频通！开始前需要做一个约 32 题的词汇量测试，估算你的词量并跳过已掌握的简单词。现在开始吗？')) startPlacement(); },400);
    }
  }
  window.scrollTo(0,0);
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
else boot();

/* PWA：注册 Service Worker */
if('serviceWorker' in navigator){
  window.addEventListener('load',function(){
    navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(function(){});
  });
}
})();
