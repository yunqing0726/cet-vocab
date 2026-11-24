/* 词频通 — 核心逻辑 */
(function(){
'use strict';

var ALL = (window.VOCAB_DATA && window.VOCAB_DATA.words) || [];
var LS = 'cetcore_v1';

/* ---------- 状态 ---------- */
var S = {
  level: 'both',
  placementDone: false,
  skipThreshold: 0,      // freq rank below this = too easy, skip
  mastered: {},          // word -> {n: times-correct}
  tooEasy: {},           // word -> true
  wrong: {},             // word -> {n: error count, last: ts, first: ts, level: lv}
  daily: {},             // 'YYYY-MM-DD' -> {new:number, correct:number, total:number}
  streak: 0,
  lastActive: '',
  session: null,
  current: null,
  placeQueue: [],
  placeIdx: 0,
  placeCorrect: 0
};

function load(){
  try{
    var raw = localStorage.getItem(LS);
    if(raw){ var o = JSON.parse(raw); for(var k in S){ if(o[k]!==undefined) S[k]=o[k]; } }
  }catch(e){}
}
function save(){ try{ localStorage.setItem(LS, JSON.stringify(S)); }catch(e){} }
function today(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function ts(){ return Date.now(); }
function dayDiff(a,b){ return Math.round((new Date(b)-new Date(a))/86400000); }

/* ---------- 词池 ---------- */
function pool(){
  return ALL.filter(function(w){
    if(S.level==='4' && w.l!==4) return false;
    if(S.level==='6' && w.l!==6) return false;
    if(S.tooEasy[w.w]) return false;
    if(!S.placementDone && false) return false;
    return true;
  });
}
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

/* ---------- 视图 ---------- */
function go(v){
  document.querySelectorAll('.view').forEach(function(el){ el.classList.remove('active'); });
  var el=document.getElementById('view-'+v); if(el) el.classList.add('active');
  document.querySelectorAll('.bottom-nav button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-nav')===v); });
  if(v==='home') renderHome();
  if(v==='wrongbook') renderWrong();
  if(v==='dashboard') renderDash();
  if(v==='settings') renderSettings();
  window.scrollTo(0,0);
}
function toast(msg){
  var t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(t._tm); t._tm=setTimeout(function(){ t.classList.remove('show'); },2200);
}

/* ---------- 读音（Web Speech API + 在线音频兜底） ---------- */
var currentAudio=null;
function speak(){
  var w=S.current; if(!w) return;
  // 优先在线标准人声录音
  if(w.au && w.au.indexOf('http')===0){
    try{
      if(currentAudio){ currentAudio.pause(); }
      currentAudio=new Audio(w.au);
      var p=currentAudio.play();
      if(p && p.then){ p.then(function(){ return true; }).catch(function(){ tts(w.w); }); return; }
      return;
    }catch(e){}
  }
  tts(w.w);
}
function tts(word){
  if(!('speechSynthesis' in window)){ toast('当前浏览器不支持朗读'); return; }
  speechSynthesis.cancel();
  var u=new SpeechSynthesisUtterance(word); u.lang='en-US'; u.rate=.85;
  speechSynthesis.speak(u);
}

/* ---------- 首屏 ---------- */
function renderHome(){
  var wrongN=Object.keys(S.wrong).length;
  document.getElementById('wrongCount').textContent=wrongN?wrongN+' 个待强化':'遗忘曲线强化';
  var masteredN=Object.keys(S.mastered).length;
  document.getElementById('homeStats').innerHTML=
    '<div class="hstat"><b>'+masteredN+'</b><span>已掌握</span></div>'+
    '<div class="hstat"><b>'+wrongN+'</b><span>错题本</span></div>'+
    '<div class="hstat"><b>'+S.streak+'</b><span>连续打卡</span></div>';
  document.querySelectorAll('.level-chip').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-lv')===String(S.level)); });
}
function setLevel(lv){
  S.level=lv; save();
  document.querySelectorAll('.level-chip,.seg button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-lv')===String(lv)); });
  renderHome(); toast('已切换范围：'+(lv==='both'?'四级+六级':lv+'级'));
}

/* ---------- 入学测试 ---------- */
// 用词频分层抽样 100 题：从最常用到最冷僻分 10 段，每段 10 题，
// 依据"在哪一段开始大量答错"判断真实词量边界，跳词阈值更准确。
var PLACE_TOTAL = 100, PLACE_BANDS = 10, PLACE_PER_BAND = 10;
function startPlacement(){
  var p=trainedPool().slice().sort(function(a,b){ return (a.f||99999)-(b.f||99999); });
  var sample=[];
  if(p.length >= PLACE_TOTAL){
    for(var band=0; band<PLACE_BANDS; band++){
      var lo=Math.floor(band*p.length/PLACE_BANDS), hi=Math.floor((band+1)*p.length/PLACE_BANDS);
      var seg=p.slice(lo,hi); shuffle(seg);
      sample=sample.concat(seg.slice(0,PLACE_PER_BAND));
    }
  }else{ sample=p.slice(); }
  shuffle(sample);
  S.placeQueue=sample; S.placeIdx=0; S.placeCorrect=0; S.placeAnswers=[];
  S.session={type:'placement'};
  go('placement'); showPlace();
}
function showPlace(){
  var w=S.placeQueue[S.placeIdx];
  if(!w){ finishPlacement(); return; }
  S.current=w;
  document.getElementById('placeProgress').textContent=(S.placeIdx+1)+' / '+S.placeQueue.length;
  document.getElementById('placeWord').textContent=w.w;
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
  // 找出"连续答对到哪一段"：按词频排序后，累计正确率首次跌破 70% 的位置
  // 作为词量边界；阈值取该边界词频，跳过比它更常用的词。
  var ans=(S.placeAnswers||[]).slice().sort(function(a,b){ return a.f-b.f; });
  var boundary=0;
  if(ans.length){
    var cum=0, n=0;
    for(var i=0;i<ans.length;i++){
      n++; if(ans[i].ok) cum++;
      if(cum/n < 0.7){ boundary=ans[i].f; break; }
      boundary=ans[i].f;
    }
  }
  S.skipThreshold=Math.max(0, Math.round(boundary||0));
  // 保底：无论答得多好，至少保留 50% 的词可供学习，避免全被跳过
  var sorted=trainedPool().slice().sort(function(a,b){ return (a.f||99999)-(b.f||99999); });
  var capIndex=Math.floor(sorted.length*0.5);
  if(capIndex<sorted.length && S.skipThreshold>sorted[capIndex].f){
    S.skipThreshold=sorted[capIndex].f;
  }
  var rate=Math.round(S.placeCorrect/Math.max(1,S.placeQueue.length)*100);
  save();
  toast('测试完成！正确率 '+rate+'%，将跳过词频前 '+S.skipThreshold+' 的已掌握词');
  go('home');
}

/* ---------- 测验 ---------- */
function startQuiz(type){
  if(type==='placement'){ startPlacement(); return; }
  var queue=[];
  if(type==='wrong'){
    var wrongWords=wrongSorted();
    if(!wrongWords.length){ toast('错题本还是空的，先做几道题吧'); go('wrongbook'); return; }
    queue=wrongWords.slice(0,20);
  }else{
    var p=trainedPool();
    // 优先复习到期错题
    var due=wrongDue();
    queue=due.slice(0,5);
    var rest=p.filter(function(w){ return !S.wrong[w.w]; });
    shuffle(rest);
    queue=queue.concat(rest.slice(0, 20-queue.length));
    shuffle(queue);
  }
  if(!queue.length){ toast('没有可测验的单词'); return; }
  S.session={type:type, queue:queue, idx:0, correct:0};
  go('quiz'); showQuiz();
}
function shuffle(a){ for(var i=a.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=a[i];a[i]=a[j];a[j]=t; } return a; }
function wrongDue(){
  var now=ts();
  return trainedPool().filter(function(w){
    var x=S.wrong[w.w]; if(!x) return false;
    var d=(now-(x.last||x.first))/86400000;
    var interval=Math.pow(2, Math.min(5, Math.max(0,x.rep||0))); // 1,2,4,8,16,32天
    return d>=interval;
  });
}
function wrongSorted(){
  var now=ts();
  return trainedPool().filter(function(w){ return !!S.wrong[w.w]; }).sort(function(a,b){
    var x=S.wrong[a.w],y=S.wrong[b.w];
    var da=(now-(x.last||x.first))/86400000, db=(now-(y.last||y.first))/86400000;
    var ia=Math.pow(2,Math.min(5,Math.max(0,x.rep||0))), ib=Math.pow(2,Math.min(5,Math.max(0,y.rep||0)));
    // 逾期越久越优先；同等逾期下错误次数越多越优先
    return (db-ib)-(da-ia) || (y.n-x.n);
  });
}
function showQuiz(){
  var ss=S.session, w=ss.queue[ss.idx];
  if(!w){ finishQuiz(); return; }
  S.current=w;
  var isSpell=ss.type==='spell';
  document.getElementById('quizTag').textContent=ss.type==='wrong'?'强化复习':(isSpell?'拼写测试':'认识测验');
  document.getElementById('quizProgress').textContent=(ss.idx+1)+' / '+ss.queue.length;
  document.getElementById('quizWord').textContent=isSpell?'—':w.w;
  document.getElementById('quizIpa').textContent=isSpell?((w.m[0]&&w.m[0].t)||''):(w.ipa||'');
  document.getElementById('quizHint').textContent=isSpell?'根据释义拼写单词':(ss.type==='wrong'?'这个单词你记住了吗？':'这个单词你认识吗？');
  document.getElementById('answerReveal').style.display='none';
  document.getElementById('quizActions').style.display=isSpell?'none':'flex';
  document.getElementById('revealActions').style.display='none';
  document.getElementById('spellBox').style.display=isSpell?'flex':'none';
  document.getElementById('spellInput').value='';
  document.getElementById('quizTip').textContent='';
  if(isSpell) setTimeout(function(){ document.getElementById('spellInput').focus(); },100);
}
function checkSpell(){
  var w=S.current, val=(document.getElementById('spellInput').value||'').trim().toLowerCase();
  var ok=val===w.w.toLowerCase();
  reveal(ok);
}
function answer(known){ reveal(known); }
function reveal(known){
  var w=S.current, ss=S.session;
  if(known) ss.correct++;
  // 错题记录 + 遗忘曲线：答错重置间隔为 1 天并累计错误次数；
  // 答对则在错题本内累计连续答对次数 rep，间隔按 1,2,4,8,16,32 天递增。
  if(!known){
    var x=S.wrong[w.w]||{n:0,rep:0,first:ts()};
    x.n++; x.rep=0; x.last=ts(); x.level=w.l; S.wrong[w.w]=x;
  }else{
    if(S.wrong[w.w]){
      var wx=S.wrong[w.w]; wx.rep=(wx.rep||0)+1; wx.last=ts();
    }
    var m=S.mastered[w.w]||{n:0}; m.n++; S.mastered[w.w]=m;
  }
  // 打卡统计
  var d=today(), day=S.daily[d]||{new:0,correct:0,total:0};
  day.total++; if(known) day.correct++;
  if(!S.mastered[w.w]||S.mastered[w.w].n===1) day.new++;
  S.daily[d]=day; updateStreak(); save();

  // 显示答案
  var mean=(w.m||[]).map(function(x){ return (x.p?'<span class="pos">'+esc(x.p)+'.</span>':'')+esc(x.t); }).join('；');
  document.getElementById('answerMean').innerHTML='<span class="pos" style="font-family:Times New Roman,serif">'+esc(w.w)+' '+esc(w.ipa||'')+'</span><br>'+(mean||'—');
  // 常见短语（用法）
  var pb=document.getElementById('answerPhrases');
  if(w.ph && w.ph.length){
    pb.innerHTML='<div class="phrase-title">常用短语</div>'+w.ph.slice(0,5).map(function(p){
      return '<div class="phrase-item"><b>'+esc(p.p)+'</b><span>'+esc(p.t)+'</span></div>';
    }).join('');
    pb.style.display='block';
  }else{ pb.style.display='none'; }
  // 例句（双语优先）
  var ex=document.getElementById('answerEx');
  var parts=[];
  if(w.sen && w.sen.length){
    w.sen.slice(0,2).forEach(function(s){ parts.push('• '+s.e+'\n  '+s.c); });
  }else if(w.df && w.df.length){ parts.push('用法：'+w.df.join('；')); }
  else if(w.ex){ parts.push('例：'+w.ex); }
  ex.textContent=parts.length?parts.join('\n'):'提示：'+w.w+' 的常见搭配请结合释义记忆';
  ex.style.display='block';
  document.getElementById('answerFreq').textContent=w.f>0&&w.f<90000?('词频排名 #'+w.f+' · '+(w.l===4?'四级':'六级')+'词'):((w.l===4?'四级':'六级')+'词汇');
  document.getElementById('answerReveal').style.display='block';
  document.getElementById('quizActions').style.display='none';
  document.getElementById('revealActions').style.display='flex';
  document.getElementById('quizTip').textContent=known?'✅ 回答正确':'❌ 已收入错题本，将按遗忘曲线安排复习';
  // TTS 自动朗读一次
  if(w.au || 'speechSynthesis' in window) setTimeout(speak,150);
}
function nextWord(){
  var ss=S.session; ss.idx++; showQuiz();
}
function markTooEasy(){
  var w=S.current;
  if(!confirm('确定将「'+w.w+'」标记为太简单？以后不再出现。')) return;
  S.tooEasy[w.w]=true;
  delete S.wrong[w.w]; save(); toast('已标记，以后不再出现');
  nextWord();
}
function finishQuiz(){
  var ss=S.session;
  var rate=Math.round(ss.correct/Math.max(1,ss.queue.length)*100);
  toast('测验完成！正确率 '+rate+'%（'+ss.correct+'/'+ss.queue.length+'）');
  go('home');
}
function updateStreak(){
  var t=today();
  if(S.lastActive===t) return;
  if(S.lastActive && dayDiff(S.lastActive,t)===1) S.streak++;
  else if(S.lastActive && dayDiff(S.lastActive,t)>1) S.streak=1;
  else S.streak=Math.max(1,S.streak);
  S.lastActive=t;
}

/* ---------- 错题本 ---------- */
function renderWrong(){
  var list=wrongSorted(), box=document.getElementById('wrongList');
  if(!list.length){
    box.innerHTML='<div class="empty"><div class="empty-icon">🎉</div><p>错题本还是空的</p><p style="font-size:13px;margin-top:6px">答错的单词会自动收进来</p></div>';
    document.getElementById('reviewBtn').style.display='none'; return;
  }
  document.getElementById('reviewBtn').style.display='block';
  var now=ts();
  box.innerHTML=list.map(function(w){
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
  // 7 天柱状图
  var days=[],max=1;
  for(var i=6;i>=0;i--){
    var d=new Date(); d.setDate(d.getDate()-i);
    var key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    var n=(S.daily[key]&&S.daily[key].total)||0; if(n>max)max=n;
    days.push({label:['日','一','二','三','四','五','六'][d.getDay()],n:n,key:key});
  }
  document.getElementById('dashChart').innerHTML=days.map(function(x){
    var h=Math.max(2,Math.round(x.n/max*90));
    return '<div class="chart-col"><div class="chart-bar" style="height:'+h+'px"></div><div class="chart-label">'+x.label+'</div></div>';
  }).join('');
  // 日历（本月）
  var now=new Date(), y=now.getFullYear(), m=now.getMonth();
  var first=new Date(y,m,1).getDay(), len=new Date(y,m+1,0).getDate();
  var html=['日','一','二','三','四','五','六'].map(function(x){return '<div class="cal-day" style="background:transparent;font-size:11px">'+x+'</div>';}).join('');
  for(var i=0;i<first;i++) html+='<div></div>';
  for(var d=1;d<=len;d++){
    var key=y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    var on=S.daily[key]&&S.daily[key].total>0;
    var isToday=d===now.getDate();
    html+='<div class="cal-day'+(on?' on':'')+(isToday?' today':'')+'">'+d+'</div>';
  }
  document.getElementById('dashCalendar').innerHTML=html;
}

/* ---------- 设置 ---------- */
function renderSettings(){
  document.querySelectorAll('.seg button').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-lv')===String(S.level)); });
}
function resetPlacement(){ if(confirm('重新进行入学测试？')){ S.placementDone=false; S.skipThreshold=0; save(); startPlacement(); } }
function exportData(){
  var blob=new Blob([JSON.stringify(S,null,2)],{type:'application/json'});
  var a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='cet-vocab-backup-'+today()+'.json'; a.click();
  toast('已导出备份文件');
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
  S={level:'both',placementDone:false,skipThreshold:0,mastered:{},tooEasy:{},wrong:{},daily:{},streak:0,lastActive:'',session:null,current:null,placeQueue:[],placeIdx:0,placeCorrect:0};
  save(); toast('已清空'); go('home');
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

/* ---------- 启动 ---------- */
// 测试模式：?test=1 时自动确认弹窗，便于自动化验证
if(location.search.indexOf('test=1')>=0){
  window.confirm=function(){ return true; };
  window.alert=function(){};
}
window.App={go:go,setLevel:setLevel,startQuiz:startQuiz,speak:speak,placeAnswer:placeAnswer,
  answer:answer,checkSpell:checkSpell,nextWord:nextWord,markTooEasy:markTooEasy,
  resetPlacement:resetPlacement,exportData:exportData,importData:importData,clearAll:clearAll};
if(location.search.indexOf('test=1')>=0){ window.App._setCurrent=function(w){ S.current=w; }; }

document.addEventListener('DOMContentLoaded',function(){
  load();
  if(!ALL.length){
    document.getElementById('view-loading').innerHTML='<div class="empty"><p>词库加载失败，请刷新重试</p></div>';
    return;
  }
  go('home');
  if(!S.placementDone){
    setTimeout(function(){ if(confirm('欢迎使用词频通！开始前需要进行一个 100 题的单词测试，用于精确判断你的词量并跳过已掌握的简单词。现在开始吗？')) startPlacement(); },400);
  }
});
})();
