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
  placeQueue: [],
  placeIdx: 0,
  placeCorrect: 0,
  placeAnswers: []
};

function load(){
  try{
    var raw = localStorage.getItem(LS);
    if(raw){
      var o = JSON.parse(raw);
      for(var k in S){ if(o[k]!==undefined) S[k]=o[k]; }
      // 迁移：旧的 tooEasy 是 true，转成时间戳
      if(!Array.isArray(S.tooEasyLog)) S.tooEasyLog=[];
      Object.keys(S.tooEasy).forEach(function(w){
        if(S.tooEasy[w]===true){ S.tooEasy[w]=Date.now(); S.tooEasyLog.push({w:w,ts:S.tooEasy[w]}); }
      });
      if(!Array.isArray(S.wrongLog)) S.wrongLog=[];
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
  document.getElementById('wrongCount').textContent=wrongN?wrongN+' 个待强化':'遗忘曲线强化';
  var masteredN=Object.keys(S.mastered).length;
  var teN=Object.keys(S.tooEasy).length;
  document.getElementById('homeStats').innerHTML=
    '<div class="hstat"><b>'+masteredN+'</b><span>已掌握</span></div>'+
    '<div class="hstat"><b>'+wrongN+'</b><span>错题本</span></div>'+
    '<div class="hstat"><b>'+S.streak+'</b><span>连续打卡</span></div>';
  var teStat=document.getElementById('tooEasyStat');
  if(teStat) teStat.textContent=teN?teN+' 个已标记':'太简单';
  document.querySelectorAll('.level-chip').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-lv')===String(S.level)); });
}
function setLevel(lv){
  S.level=lv; save();
  document.querySelectorAll('.level-chip,.seg button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-lv')===String(lv)); });
  renderHome(); toast('已切换范围：'+(lv==='both'?'四级+六级':lv+'级'));
}

/* ---------- 入学测试 ---------- */
var PLACE_TOTAL=100, PLACE_BANDS=10, PLACE_PER_BAND=10;
function startPlacement(){
  var p=freqSorted(); var sample=[];
  if(p.length>=PLACE_TOTAL){
    for(var band=0;band<PLACE_BANDS;band++){
      var lo=Math.floor(band*p.length/PLACE_BANDS), hi=Math.floor((band+1)*p.length/PLACE_BANDS);
      var seg=p.slice(lo,hi); shuffle(seg);
      sample=sample.concat(seg.slice(0,PLACE_PER_BAND));
    }
  }else sample=p.slice();
  shuffle(sample);
  S.placeQueue=sample; S.placeIdx=0; S.placeCorrect=0; S.placeAnswers=[];
  S.session={type:'placement'}; save();
  go('placement'); showPlace();
}
function showPlace(){
  var w=S.placeQueue[S.placeIdx];
  if(!w){ finishPlacement(); return; }
  S.current=w; preloadAudio(w); autoSpeak(w);
  document.getElementById('placeProgress').textContent=(S.placeIdx+1)+' / '+S.placeQueue.length;
  document.getElementById('placeWord').textContent=w.w;
  fitWord(document.getElementById('placeWord'));
  document.getElementById('placeIpa').textContent=w.ipa||'';
}
function placeAnswer(known){
  if(known) S.placeCorrect++;
  S.placeAnswers=S.placeAnswers||[];
  S.placeAnswers.push({f:S.current.f||99999, ok:!!known});
  S.placeIdx++; save(); showPlace();
}
function finishPlacement(){
  S.placementDone=true;
  var ans=(S.placeAnswers||[]).slice().sort(function(a,b){ return a.f-b.f; });
  var boundary=0;
  if(ans.length){
    var cum=0,n=0;
    for(var i=0;i<ans.length;i++){
      n++; if(ans[i].ok) cum++;
      if(cum/n<0.7){ boundary=ans[i].f; break; }
      boundary=ans[i].f;
    }
  }
  S.skipThreshold=Math.max(0,Math.round(boundary||0));
  var sorted=freqSorted(); var capIndex=Math.floor(sorted.length*0.5);
  if(capIndex<sorted.length && S.skipThreshold>sorted[capIndex].f) S.skipThreshold=sorted[capIndex].f;
  var rate=Math.round(S.placeCorrect/Math.max(1,S.placeQueue.length)*100);
  S.session=null; save();
  toast('测试完成！正确率 '+rate+'%，将跳过词频前 '+S.skipThreshold+' 的已掌握词');
  go('home');
}

/* ---------- 测验（可持久化、多阶段） ---------- */
function wrongDue(){
  var now=ts();
  return trainedPool().filter(function(w){
    var x=S.wrong[w.w]; if(!x) return false;
    var d=(now-(x.last||x.first))/86400000;
    var interval=Math.pow(2,Math.min(5,Math.max(0,x.rep||0)));
    return d>=interval;
  });
}
function wrongSorted(){
  var now=ts();
  return trainedPool().filter(function(w){ return !!S.wrong[w.w]; }).sort(function(a,b){
    var x=S.wrong[a.w],y=S.wrong[b.w];
    var da=(now-(x.last||x.first))/86400000, db=(now-(y.last||y.first))/86400000;
    var ia=Math.pow(2,Math.min(5,Math.max(0,x.rep||0))), ib=Math.pow(2,Math.min(5,Math.max(0,y.rep||0)));
    return (db-ib)-(da-ia) || (y.n-x.n);
  });
}
function startQuiz(type, opts){
  opts=opts||{};
  // 已有同一类型的未完成测验 → 恢复，不重建（切页/刷新后测验不变）
  if(S.session && S.session.type===type && S.session.queue && S.session.queue.length){
    go(S.session.mode==='overview'?'overview':'quiz');
    if(S.session.mode==='overview') renderOverview(); else showQuiz();
    return;
  }
  var queue=[];
  if(opts.queue){ queue=opts.queue.slice(); }
  else if(type==='wrong'){
    queue=wrongSorted().slice(0,20);
    if(!queue.length){ toast('错题本还是空的，先做几道题吧'); go('wrongbook'); return; }
  }else if(type==='spell'){
    queue=freqSorted().slice(0,20);
  }else{
    // 认识测验：优先高频词；到期错题并入后统一按词频排序
    var set={};
    freqSorted().forEach(function(w){ set[w.w]=w; });
    wrongDue().slice(0,5).forEach(function(w){ set[w.w]=w; });
    queue=Object.keys(set).map(function(k){ return set[k]; })
      .sort(function(a,b){ return (a.f||99999)-(b.f||99999); }).slice(0,20);
  }
  if(!queue.length){ toast('没有可测验的单词'); return; }
  S.session={ type:type, mode:'main', queue:queue, idx:0, correct:0,
              mainWords:queue.slice(), unknown:[], rec:{}, last:null, round:0 };
  save(); go('quiz'); showQuiz();
}
function resumeQuiz(){
  if(!S.session || !S.session.queue){ toast('当前没有进行中的测验'); return; }
  go(S.session.mode==='overview'?'overview':'quiz');
  if(S.session.mode==='overview') renderOverview(); else showQuiz();
}
function restartQuiz(){
  if(!S.session) return;
  var t=S.session.type; S.session=null; save(); toast('已重新开始测验'); startQuiz(t);
}
function phaseLabel(){
  var ss=S.session;
  if(!ss) return '';
  if(ss.mode==='main') return '认识测验';
  if(ss.mode==='retest') return '再认一遍 · 第'+(ss.round||1)+'轮';
  if(ss.mode==='final') return '打乱小测';
  return '认识测验';
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
  document.getElementById('quizTag').textContent=ss.type==='wrong'?'强化复习':phaseLabel();
  var total=ss.mode==='final'?ss.mainWords.length:ss.queue.length;
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
  ss.last=null; save();
  if(isSpell) setTimeout(function(){ document.getElementById('spellInput').focus(); },100);
}
function advancePhase(){
  var ss=S.session;
  if(ss.mode==='main'){
    if(ss.type==='spell'){ finishQuiz(); return; }
    if(ss.unknown.length){ ss.queue=shuffle(ss.unknown.slice()); ss.idx=0; ss.mode='retest'; ss.round=1;
      toast('对 '+ss.queue.length+' 个不认识的词再练一遍'); save(); showQuiz(); return; }
    if(ss.type==='normal'){ ss.queue=shuffle(ss.mainWords.slice()); ss.idx=0; ss.mode='final';
      toast('全部认识！最后做一次打乱小测'); save(); showQuiz(); return; }
    finishQuiz(); return;
  }
  if(ss.mode==='retest'){
    if(!ss.unknown.length){
      if(ss.type==='normal'){ ss.queue=shuffle(ss.mainWords.slice()); ss.idx=0; ss.mode='final';
        toast('全部认识！最后做一次打乱小测'); save(); showQuiz(); return; }
      finishQuiz(); return;
    }
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
  ss.last={
    word:w.w,
    prevWrong:JSON.parse(JSON.stringify(S.wrong[w.w]||null)),
    prevMastered:JSON.parse(JSON.stringify(S.mastered[w.w]||null)),
    prevDaily:JSON.parse(JSON.stringify(S.daily[today()]||null)),
    prevUnknown:JSON.stringify(ss.unknown),
    recMain:rec.main, recRetest:rec.retest,
    idx:ss.idx, correct:ss.correct,
    logLen:S.wrongLog.length,
    isRetest:ss.mode!=='main'
  };
}
function undo(){
  var ss=S.session; if(!ss || !ss.last){ toast('没有可撤销的操作'); return; }
  var L=ss.last, w=L.word;
  if(L.prevWrong) S.wrong[w]=L.prevWrong; else delete S.wrong[w];
  if(L.prevMastered) S.mastered[w]=L.prevMastered; else delete S.mastered[w];
  if(L.prevDaily) S.daily[today()]=L.prevDaily; else delete S.daily[today()];
  ss.unknown=JSON.parse(L.prevUnknown);
  ss.rec[w]={main:L.recMain, retest:L.recRetest};
  ss.idx=L.idx; ss.correct=L.correct;
  S.wrongLog.length=L.logLen;
  ss.last=null; save(); showQuiz(); toast('已撤销这道题');
}
function answer(known){ reveal(known); }
function reveal(known){
  var w=S.current, ss=S.session;
  snapshot(w);
  if(known) ss.correct++;
  var isRetest=ss.mode!=='main';
  var rec=ss.rec[w.w];
  var key=isRetest?'retest':'main';
  var allowed=ss.type==='normal' ? !rec[key] : (!rec.main && !rec.retest);
  if(!known){
    rec[key]=true;
    var x=S.wrong[w.w]||{n:0,rep:0,first:ts()};
    if(allowed){ x.n++; x.last=ts(); x.level=w.l; S.wrong[w.w]=x;
      S.wrongLog.push({w:w.w, ts:ts(), date:today(), type:ss.type}); updateStreak(); }
    else S.wrong[w.w]=x;
    // 加入本轮不认识列表
    if(!ss.unknown.some(function(y){ return y.w===w.w; })) ss.unknown.push(w);
  }else{
    if(S.wrong[w.w]){ var wx=S.wrong[w.w]; wx.rep=(wx.rep||0)+1; wx.last=ts(); }
    var m=S.mastered[w.w]||{n:0}; m.n++; S.mastered[w.w]=m;
    // 从本轮不认识列表移除
    ss.unknown=ss.unknown.filter(function(y){ return y.w!==w.w; });
  }
  var d=today(), day=S.daily[d]||{new:0,correct:0,total:0};
  day.total++; if(known) day.correct++;
  if(!S.mastered[w.w]||S.mastered[w.w].n===1) day.new++;
  S.daily[d]=day; updateStreak(); save();

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
  document.getElementById('answerFreq').textContent=w.f>0&&w.f<90000?('词频排名 #'+w.f+' · '+(w.l===4?'四级':'六级')+'词'):((w.l===4?'四级':'六级')+'词汇');
  document.getElementById('answerReveal').style.display='block';
  document.getElementById('quizActions').style.display='none';
  document.getElementById('revealActions').style.display='flex';
  document.getElementById('undoBtn').style.display=known?'none':'inline-flex';
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
  S.session=null; save();
  toast('测验完成！正确率 '+rate+'%（'+ss.correct+'/'+ss.mainWords.length+'）');
  go('home');
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
var browseYear=0, browseMonth=0;
function wrongFiltered(){
  var now=ts();
  return trainedPool().filter(function(w){
    var x=S.wrong[w.w]; if(!x) return false;
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
  var browseBtn=document.getElementById('browseBtn'), browseBtn2=document.getElementById('browseBtn2');
  if(browseBtn){ browseBtn.classList.toggle('on',!wrongBrowse); }
  if(browseBtn2){ browseBtn2.classList.toggle('on',wrongBrowse); }
  var list=wrongFiltered();
  document.getElementById('reviewBtn').style.display=list.length?'block':'none';
  var box=document.getElementById('wrongList');
  if(!list.length){
    box.innerHTML='<div class="empty"><p>这个时间范围内没有错题</p><p style="font-size:13px;margin-top:6px">答错的单词会自动收进来</p></div>';
    if(wrongBrowse) renderWrongByDate();
    return;
  }
  if(wrongBrowse){ renderWrongByDate(); return; }
  var now=ts();
  box.innerHTML=list.sort(function(a,b){
    var x=S.wrong[a.w],y=S.wrong[b.w];
    var da=(now-(x.last||x.first))/86400000, db=(now-(y.last||y.first))/86400000;
    var ia=Math.pow(2,Math.min(5,Math.max(0,x.rep||0))), ib=Math.pow(2,Math.min(5,Math.max(0,y.rep||0)));
    return (db-ib)-(da-ia)||(y.n-x.n);
  }).map(function(w){
    var x=S.wrong[w.w];
    var days=(now-(x.last||x.first))/86400000;
    var interval=Math.pow(2,Math.min(5,Math.max(0,x.rep||0)));
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
    if(it.date && it.date.indexOf(prefix)===0){ (byDate[it.date]=byDate[it.date]||[]).push(it.w); }
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
      '<span class="ov-num">'+(i+1)+'</span><span class="ov-w">'+esc(w.w)+'</span>'+
      '<span class="ov-ipa">'+(w.ipa||'')+'</span><span class="ov-mean">'+esc(mean)+'</span>'+
      '<span class="ov-caret">▾</span></button>'+
      '<div class="ov-note" id="ovnote'+i+'" style="display:none">'+noteHTML(w)+'</div></div>';
  }).join('');
  document.getElementById('overviewCount').textContent=list.length+' 个单词 · 点单词展开注释';
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
}
function resetPlacement(){
  if(!confirm('重新进行入学测试？')) return;
  S.placementDone=false; S.skipThreshold=0; S.session=null; save(); startPlacement();
}
function exportData(){
  var blob=new Blob([JSON.stringify(S,null,2)],{type:'application/json'});
  var a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='cet-vocab-backup-'+today()+'.json'; a.click(); toast('已导出备份文件');
}
function importData(e){
  var f=e.target.files[0]; if(!f) return;
  var r=new FileReader();
  r.onload=function(){
    try{ var o=JSON.parse(r.result); for(var k in S){ if(o[k]!==undefined) S[k]=o[k]; } save(); toast('导入成功'); go('home'); }
    catch(err){ toast('导入失败：文件格式错误'); }
  };
  r.readAsText(f); e.target.value='';
}
function clearAll(){
  if(!confirm('确定清空所有学习数据？此操作不可恢复！')) return;
  if(!confirm('再次确认：真的要删除全部错题本和进度吗？')) return;
  localStorage.removeItem(LS);
  S={level:'both',placementDone:false,skipThreshold:0,mastered:{},tooEasy:{},tooEasyLog:[],
     wrong:{},wrongLog:[],daily:{},streak:0,accent:2,lastActive:'',session:null,current:null,
     placeQueue:[],placeIdx:0,placeCorrect:0,placeAnswers:[]};
  save(); toast('已清空'); go('home');
}

/* ---------- 启动 ---------- */
if(location.search.indexOf('test=1')>=0){ window.confirm=function(){return true;}; window.alert=function(){}; }
window.App={
  go:go, setLevel:setLevel, startQuiz:startQuiz, resumeQuiz:resumeQuiz, restartQuiz:restartQuiz,
  speak:speak, toggleAccent:toggleAccent, placeAnswer:placeAnswer, answer:answer, checkSpell:checkSpell,
  nextWord:nextWord, undo:undo, markTooEasy:markTooEasy, undoTooEasy:undoTooEasy,
  setWrongRange:setWrongRange, setWrongBrowse:setWrongBrowse, browseMonthShift:browseMonthShift,
  reviewWrong:reviewWrong, toggleNote:toggleNote, finishOverview:finishOverview, finishQuiz:finishQuiz,
  resetPlacement:resetPlacement, exportData:exportData, importData:importData, clearAll:clearAll
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
  }else if(S.placeQueue && S.placeIdx<S.placeQueue.length && !S.placementDone){
    go('placement'); showPlace();
  }else{
    go('home');
    if(!S.placementDone){
      setTimeout(function(){ if(confirm('欢迎使用词频通！开始前需要进行一个 100 题的单词测试，用于精确判断你的词量并跳过已掌握的简单词。现在开始吗？')) startPlacement(); },400);
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
