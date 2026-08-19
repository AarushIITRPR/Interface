/* ============================================================
   MEDIA LIBRARY
   ============================================================ */
const DEFAULT_MEDIA = {
  emotions:{ happy:"media/happy.mp4", sad:"media/sad.mp4", anger:"media/anger.mp4", fear:"media/fear.mp4", surprise:"media/surprise.mp4", disgust:"media/disgust.mp4" },
  washout:"", box_breathing:"", body_scan:"", fixation:""
};
const MEDIA_SLOTS = [
  ["emotions.happy","Clip · happy"],["emotions.sad","Clip · sad"],["emotions.anger","Clip · anger"],
  ["emotions.fear","Clip · fear"],["emotions.surprise","Clip · surprise"],["emotions.disgust","Clip · disgust"],
  ["washout","Neutral washout"],
  ["box_breathing","Box breathing"],
  ["body_scan","Body-scan audio (4 min)"],
  ["fixation","Fixation (opt.)"]
];
let MEDIA = loadMediaConfig();

function deepGet(o,p){ return p.split(".").reduce((a,k)=>a&&a[k],o); }
function deepSet(o,p,v){ const ks=p.split("."); let a=o; for(let i=0;i<ks.length-1;i++){a=a[ks[i]]=a[ks[i]]||{};} a[ks[ks.length-1]]=v; }
function mergeNonEmpty(dst,src){ Object.keys(src||{}).forEach(k=>{ const v=src[k]; if(v && typeof v==="object") mergeNonEmpty(dst[k]=dst[k]||{},v); else if(v!==undefined && v!==null) dst[k]=v; }); }
function loadMediaConfig(){ const base=JSON.parse(JSON.stringify(DEFAULT_MEDIA));
  try{ const s=localStorage.getItem("cvpr_media"); if(s){ const j=JSON.parse(s); mergeNonEmpty(base,j); } }catch(e){} return base; }
function saveMediaConfig(){
  try{ localStorage.setItem("cvpr_media",JSON.stringify(MEDIA)); }catch(e){}
  if(window.SessionAPI) window.SessionAPI.saveMediaConfig(MEDIA).catch(error=>console.warn("Media config was saved locally only.",error));
}
async function hydrateMediaConfig(){
  if(!window.SessionAPI)return;
  try{
    const serverConfig=await window.SessionAPI.loadMediaConfig();
    mergeNonEmpty(MEDIA,serverConfig);
    try{localStorage.setItem("cvpr_media",JSON.stringify(MEDIA));}catch(e){}
    renderMediaRows();
  }catch(error){ console.warn("Using local media configuration.",error); }
}
function renderMediaRows(){
  const rows=document.getElementById("mediaRows");
  if(!rows)return;
  rows.innerHTML=MEDIA_SLOTS.map(([path,name])=>{
    const v=deepGet(MEDIA,path)||"";
    return `<div class="medrow"><span class="name">${name}</span>
      <input type="text" value="${v.replace(/"/g,'&quot;')}" placeholder="media/…" data-path="${path}" oninput="onMediaInput(this)">
      <span class="stat ${v?'unk':'miss'}" id="stat_${path.replace(/\./g,'_')}">${v?'set':'empty'}</span></div>`;
  }).join("");
}
function onMediaInput(el){ deepSet(MEDIA,el.dataset.path,el.value.trim()); saveMediaConfig();
  const st=document.getElementById("stat_"+el.dataset.path.replace(/\./g,"_")); st.className="stat "+(el.value.trim()?"unk":"miss"); st.textContent=el.value.trim()?"set":"empty"; previewAssign(); }
function verifyAllMedia(){
  MEDIA_SLOTS.forEach(([path])=>{ const src=deepGet(MEDIA,path); const st=document.getElementById("stat_"+path.replace(/\./g,"_"));
    if(!src){ st.className="stat miss"; st.textContent="empty"; return; }
    st.className="stat unk"; st.textContent="…";
    const isAudio=/\.(mp3|wav|m4a|aac|ogg)$/i.test(src); const el=document.createElement(isAudio?"audio":"video");
    el.preload="metadata"; el.muted=true;
    el.onloadedmetadata=()=>{ st.className="stat ok"; st.textContent="OK"; };
    el.onerror=()=>{ st.className="stat miss"; st.textContent="fail"; }; el.src=src; });
}
function exportMediaConfig(){ download("media_config.json",JSON.stringify(MEDIA,null,2),"application/json"); }
function importMediaConfig(file){ if(!file)return; const r=new FileReader();
  r.onload=()=>{ try{ const j=JSON.parse(r.result); MEDIA=JSON.parse(JSON.stringify(DEFAULT_MEDIA)); Object.assign(MEDIA,j); if(j.emotions)Object.assign(MEDIA.emotions,j.emotions); saveMediaConfig(); renderMediaRows(); previewAssign(); }catch(e){ alert("Invalid config JSON."); } };
  r.readAsText(file); }
function clearMediaConfig(){ if(!confirm("Clear all media paths?"))return; MEDIA=JSON.parse(JSON.stringify(DEFAULT_MEDIA)); saveMediaConfig(); renderMediaRows(); previewAssign(); }

/* ============================================================
   COUNTERBALANCING
   ============================================================ */
const EMOTIONS=["happy","sad","anger","fear","surprise","disgust"];
const WILLIAMS6=[[1,2,6,3,5,4],[2,3,1,4,6,5],[3,4,2,5,1,6],[4,5,3,6,2,1],[5,6,4,1,3,2],[6,1,5,2,4,3]];

function assignFor(pid){
  const p=Math.max(1,parseInt(pid,10)||1);
  const row=((p-1)%6+6)%6;
  const seq=WILLIAMS6[row].map(c=>EMOTIONS[c-1]);

  // Guarantee Stroop, Nback, and Conv appear across the 3 blocks in varied order
  const bOrders = [
    ["Stroop Task", "N-Back Task", "Conversation"],
    ["Stroop Task", "Conversation", "N-Back Task"],
    ["N-Back Task", "Stroop Task", "Conversation"],
    ["N-Back Task", "Conversation", "Stroop Task"],
    ["Conversation", "Stroop Task", "N-Back Task"],
    ["Conversation", "N-Back Task", "Stroop Task"]
  ];
  const bo = bOrders[(p-1)%6];

  return {
    pid:p, row:row+1,
    buf1: bo[0], buf2: bo[1], buf3: bo[2],
    block1:[seq[0],seq[1]], block2:[seq[2],seq[3]], block3:[seq[4],seq[5]], fullOrder:seq
  };
}

/* ============================================================
   PLAN BUILDER
   ============================================================ */
function buildPlan(a){
  const steps=[];
  const markPhase=(from,label)=>{ for(let k=from;k<steps.length;k++) steps[k].phase=label; };
  const clip=(emo)=>({type:"clip",emo,title:`Emotion clip — ${emo}`,tag:"var(--c-affect)",kick:"Affective",
      script:`You'll watch a short video clip now. Just watch it like you normally would and let yourself react however feels natural — there's no right or wrong way to feel.`,
      op:`Clip auto-loaded from the library. Play to log a photodiode-anchored onset; Stop at clip end.`,feature:"video"});
  const sam=(emo)=>({type:"sam",emo,title:`SAM rating — ${emo}`,tag:"var(--c-affect)",kick:"Self-report",
      script:`Think back to how that clip made you feel, and rate it using the sliders below. Go with your first instinct — there's no wrong answer.`,op:`Collect SAM (valence / arousal / dominance).`,feature:"sam"});

  const washout=()=>({type:"washout",title:"Neutral washout",tag:"var(--c-base)",kick:"Washout",
      script:`Take a moment to relax. You'll see a calm, neutral grey screen — just rest your eyes on the central cross and breathe normally.`,
      op:`Interactive grey washout screen with fixation cross and auto-countdown. Physiology settle before next clip.`,dur:20,feature:"washout_interactive"});

  const gate=(label,bp,bpLabel)=>({type:"gate",title:label||"Return-to-baseline gate",tag:"var(--c-base)",kick:"Baseline gate",
      script:`Let's pause for a short breather. Just sit quietly and breathe normally while we make sure you're comfortable before continuing.`,op:`Do not advance until tonic GSR and HR return toward the resting reference.`,dur:40,feature:"gate",bp:!!bp,bpLabel});

  const stroopTask=()=>({type:"stroop_interactive",title:"Cognitive — Stroop Color-Word Task",tag:"var(--c-cog)",kick:"Cognitive · Interactive",
      script:`Next is a colour attention task. You'll see a colour word — like the word RED — printed in a different colour ink. Your job is to click the button matching the INK COLOUR, not what the word says. Go as fast and as accurately as you can.`,
      op:`Interactive Stroop task — 30 trials. All RT and accuracy data logged automatically.`,feature:"stroop_interactive"});

  const nbackTask=()=>({type:"nback_interactive",title:"Cognitive — N-Back Working Memory",tag:"var(--c-cog)",kick:"Cognitive · Interactive",
      script:`Next is a memory task. You'll see squares light up one at a time on a 3-by-3 grid. Press the MATCH button whenever the current position matches the position from N steps ago. We'll start with 1-back.`,
      op:`Interactive N-Back — 20 trials. Hit/miss/false-alarm and d-prime logged automatically.`,feature:"nback_interactive"});

  const conv=()=>({ type:"buffer", kind:"conversational", title:"Conversational task", tag:"var(--c-conv)", kick:"Conversational buffer",
      script:`Let's take a short break and chat for a couple of minutes about anything easy-going — a recent trip, a hobby you enjoy, or how your day's been so far.`,
      op:`Semi-structured neutral conversation. Use the notes field below to log observations.`, dur:180, feature:"conversational_interactive" });

  const getBuffer = (bType) => {
    if (bType === "Stroop Task") return stroopTask();
    if (bType === "N-Back Task") return nbackTask();
    if (bType === "Conversation") return conv();
  };

  steps.push({type:"setup",title:"Sensor & sync check",tag:"var(--c-base)",kick:"Pre-flight",
    script:`We're just getting your sensors checked and ready — this will only take a moment. Try to stay fairly still and keep your face toward the camera.`,
    op:`Confirm all 11 modalities streaming and the photodiode is in frame. Fire a sync flash, then advance.`,feature:"none"});
  steps.push({type:"baseline",title:"Resting baseline — eyes open",tag:"var(--c-base)",kick:"Baseline",
    script:`Please look at the small cross on the screen and just breathe normally, the way you always would. No need to do anything special — just relax.`,op:`Eyes-open reference every gate returns to. Take the resting BP reading ~1 min in, once settled.`,dur:120,feature:"none",bp:true,bpLabel:"resting anchor",fixationCross:true});
  steps.push({type:"baseline",title:"Resting baseline — eyes closed",tag:"var(--c-base)",kick:"Baseline",
    script:`Now gently close your eyes and keep breathing the way you naturally would. Feel free to let your shoulders relax too.`,op:`Eyes-closed rest.`,dur:90,feature:"none"});
  markPhase(0,"Getting settled");

  let ps=steps.length;
  steps.push(clip(a.block1[0])); steps.push(sam(a.block1[0])); steps.push(washout());
  steps.push(clip(a.block1[1])); steps.push(sam(a.block1[1]));
  steps.push(getBuffer(a.buf1)); steps.push(gate(null,false,"washout point"));
  markPhase(ps,"Part 1"); ps=steps.length;

  steps.push(clip(a.block2[0])); steps.push(sam(a.block2[0])); steps.push(washout());
  steps.push(clip(a.block2[1])); steps.push(sam(a.block2[1]));
  steps.push(getBuffer(a.buf2)); steps.push(gate(null,false,"washout point"));
  markPhase(ps,"Part 2"); ps=steps.length;

  steps.push(clip(a.block3[0])); steps.push(sam(a.block3[0])); steps.push(washout());
  steps.push(clip(a.block3[1])); steps.push(sam(a.block3[1]));
  steps.push(getBuffer(a.buf3));
  markPhase(ps,"Part 3"); ps=steps.length;

  steps.push(gate("Settle before physiological sweep"));
  steps.push({type:"sweep",title:"Sweep — seated rest",tag:"var(--c-phys)",kick:"Physio sweep",
    script:`Just sit comfortably and try to stay still for a short moment, breathing as you normally would.`,op:`20 s still seated anchor.`,dur:20,feature:"none"});
  steps.push({type:"sweep",title:"Sweep — box breathing",tag:"var(--c-phys)",kick:"Physio sweep",
    script:`Let's do a short breathing exercise together. Breathe in as the circle grows, hold for a moment, breathe out as it shrinks, then hold again — just follow the rhythm.`,op:`Plays your box-breathing video if registered, else the on-screen pacer.`,dur:45,feature:"pacer"});
  steps.push({type:"sweep",sub:"breathhold",title:"Sweep — breath-hold",tag:"var(--c-phys)",kick:"Physio sweep · caution",
    script:`Whenever you're ready, take a normal breath in and hold it for as long as feels comfortable. There's no pressure at all — let it go whenever you need to.`,
    op:`Voluntary, comfort-limited. SKIP if any contraindication.`,feature:"breathhold"});
  steps.push({type:"sweep",title:"Sweep — head motion",tag:"var(--c-phys)",kick:"Physio sweep",
    script:`Let's do a little movement — slowly turn your head left, then right, then up, then down. After that, just talk out loud for a few seconds about anything at all.`,op:`PURE-style motion segment.`,dur:30,feature:"none"});
  steps.push({type:"sweep",sub:"standing",title:"Sweep — standing (orthostatic)",tag:"var(--c-phys)",kick:"Physio sweep · caution",
    script:`Now please stand up slowly and stay still, facing the camera. Let us know right away if you feel dizzy or lightheaded.`,op:`Orthostatic HR/BP shift. SKIP if contraindicated.`,dur:45,feature:"safety_stand",bp:true,bpLabel:"orthostatic (standing)"});
  steps.push({type:"sweep",sub:"exertion",title:"Sweep — brief exertion",tag:"var(--c-phys)",kick:"Physio sweep · caution",
    script:`Let's get your heart rate up a little with some gentle movement — sit-to-stands or marching in place, whatever's comfortable.`,op:`Elevates HR. SKIP if contraindicated.`,dur:20,feature:"safety_stand"});
  steps.push({type:"sweep",title:"Sweep — post-exertion recovery",tag:"var(--c-phys)",kick:"Physio sweep",
    script:`Great job — now sit back down and stay as much as you can while your breathing settles back to normal.`,op:`Elevated HR + still body → clean high-HR sample.`,dur:60,feature:"none",bp:true,bpLabel:"post-exertion peak"});
  markPhase(ps,"Movement & breathing"); ps=steps.length;

  steps.push({type:"bodyscan",title:"Body scan — guided relaxation",tag:"var(--c-relax)",kick:"Relaxation",
    script:`Get comfortable, sit up tall but relaxed, and close your eyes. We'll play a short guided audio that gently walks your attention through different parts of your body.`,
    op:`Press Start Audio to play the 4-min body-scan audio. Eyes closed, still, seated upright.`,dur:240,feature:"audio_bodyscan"});
  steps.push({type:"recovery",title:"Return to normal",tag:"var(--c-base)",kick:"Baseline",
    script:`Whenever you're ready, gently open your eyes. You've made it through the whole session — thank you so much.`,op:`Brief eyes-open return. Take the final BP reading, then export.`,dur:60,feature:"none",bp:true,bpLabel:"relaxed / final"});
  markPhase(ps,"Relaxation"); ps=steps.length;
  steps.push({type:"end",title:"Session complete",tag:"var(--go)",kick:"Done",
    script:`That's everything! Thank you so much for your time and for being such a great participant.`,op:`Export CSV + JSON. Confirm all recorders saved before releasing the participant.`,feature:"end"});
  markPhase(ps,"All done");
  return steps;
}

function shortLabel(s){
  if(s.type==="clip")return{t:`Clip · ${s.emo}`}; if(s.type==="sam")return{t:`SAM · ${s.emo}`};
  if(s.type==="washout")return{t:"Washout"}; if(s.type==="gate")return{t:s.title};
  if(s.type==="taskvid")return{t:s.name}; if(s.type==="buffer")return{t:s.title};
  if(s.type==="sweep")return{t:s.title.replace("Sweep — ","")}; if(s.type==="bodyscan")return{t:"Body scan"};
  if(s.type==="baseline")return{t:s.title.replace("Resting baseline — ","Baseline ")};
  if(s.type==="stroop_interactive")return{t:"Stroop Task"};
  if(s.type==="nback_interactive")return{t:"N-Back Task"};
  return{t:s.title};
}
function tagColor(s){
  if(s.type==="clip")return"var(--c-affect)"; if(s.type==="taskvid")return"var(--c-cog)";
  if(s.type==="stroop_interactive"||s.type==="nback_interactive")return"var(--c-cog)";
  if(s.type==="buffer")return"var(--c-conv)"; if(s.type==="sweep")return"var(--c-phys)";
  if(s.type==="bodyscan")return"var(--c-relax)"; if(s.type==="end")return"var(--go)"; return"var(--c-base)";
}
function resolveMedia(s){
  if(s.type==="clip") return {src:MEDIA.emotions[s.emo]||"", kind:"video", marked:true, mkind:"clip", name:s.emo};
  if(s.type==="taskvid") return {src:MEDIA[s.slot]||"", kind:"video", marked:true, mkind:"task", name:s.slot};
  if(s.type==="washout") return null;
  if(s.feature==="pacer") return {src:MEDIA.box_breathing||"", kind:"video", slot:"box_breathing"};
  if(s.type==="bodyscan" || s.feature==="audio_bodyscan") return {src:MEDIA.body_scan||"", kind:"audio", slot:"body_scan"};
  return null;
}

/* ============================================================
   CLOCK + LOG
   ============================================================ */
const state={ plan:[],i:0,assign:null,perfT0:null,wallT0:null,markers:[],timer:null,timerRemain:0,timerRunning:false,timerDur:0,pacerInt:null,holdInt:null,holdT0:null,bpInt:null,bpT0:null,showPlanDetail:false,lastPlan:[],lastCur:-1,
  stroopTrials:[],stroopIdx:0,stroopRunning:false,stroopRT0:null,
  nbackSeq:[],nbackIdx:0,nbackRunning:false,nbackN:1,nbackTrialT0:null,nbackInt:null,nbackResults:[],
  washoutInt:null,washoutRemain:0,washoutRunning:false,
  conversationTimer:null, conversationTimerRemain:0, conversationTimerRunning:false, conversationTimerDur:0,
};

function nowPerf(){ return performance.now(); }
function logEvent(label,detail,extra){
  const perf=nowPerf(); const tSession=state.perfT0==null?0:perf-state.perfT0;
  const m={ idx:state.markers.length+1, participant_id:state.assign?state.assign.pid:"", label, detail:detail||"",
    step:state.plan[state.i]?shortLabel(state.plan[state.i]).t:"—", step_type:state.plan[state.i]?state.plan[state.i].type:"",
    t_perf_ms:perf.toFixed(1), t_session_ms:tSession.toFixed(1), wall_iso:new Date().toISOString() };
  if(extra)Object.assign(m,extra); state.markers.push(m); renderLog();
  document.getElementById("clockBadge").textContent=`clock: ${(tSession/1000).toFixed(1)}s`; return m;
}
function renderLog(){
  document.getElementById("logBody").innerHTML=state.markers.slice().reverse().map(m=>`<tr>
    <td class="mono">${m.idx}</td><td class="mono">${(m.t_session_ms/1000).toFixed(2)}s</td>
    <td class="mono">${m.t_perf_ms}</td><td class="mono">${m.wall_iso.split("T")[1].replace("Z","")}</td>
    <td>${m.step}</td><td><b>${m.label}</b></td><td>${m.detail}</td></tr>`).join("");
  document.getElementById("logCount").textContent=`${state.markers.length} markers`;
}
function logNote(){ const el=document.getElementById("noteText"); if(!el.value.trim())return; logEvent("operator_note",el.value.trim()); el.value=""; }

/* ============================================================
   SETUP / PREVIEW
   ============================================================ */
function previewAssign(){
  const pidEl=document.getElementById("pid");
  if(!pidEl.value || !pidEl.checkValidity()){ renderRail([],-1); checkStartReady(); return; }
  renderRail(buildPlan(assignFor(pidEl.value)),-1);
  checkStartReady();
}
function checkStartReady(){
  const pidEl=document.getElementById("pid");
  const checks=["rdyConsent","rdyPhys","rdySensors"].map(id=>document.getElementById(id));
  const pidOK=!!pidEl.value && pidEl.checkValidity();
  const remaining=checks.filter(el=>!el.checked).length;
  const ok=pidOK && remaining===0;
  document.getElementById("startBtn").disabled=!ok;
  const status=document.getElementById("startStatus");
  if(status){
    status.classList.toggle("ready",ok);
    const title=status.querySelector("strong"), note=status.querySelector("small");
    if(!pidOK){ title.textContent="Add a valid participant ID"; note.textContent="Use an ID from 1 to 100."; }
    else if(remaining){ title.textContent=`${remaining} readiness check${remaining===1?"":"s"} remaining`; note.textContent="Confirm every item before starting."; }
    else { title.textContent="Ready to begin"; note.textContent="The session plan and recorders are prepared."; }
  }
}
function renderRail(plan,cur){
  state.lastPlan=plan; state.lastCur=cur;
  const miniFill=document.getElementById("railProgressMiniFill");
  if(miniFill){ const total=plan.length, done=Math.max(0,cur+1); miniFill.style.width=(total?Math.round(100*done/total):0)+"%"; }
  const detailed=state.showPlanDetail;
  const btn=document.getElementById("planToggle"); if(btn) btn.textContent=detailed?"Hide plan detail":"Show plan detail";
  if(!detailed){
    const total=plan.length, done=Math.max(0,cur+1), pct=total?Math.round(100*done/total):0;
    const phaseLabel=(cur>=0 && plan[cur] && plan[cur].phase)?plan[cur].phase:"Getting settled";
    document.getElementById("railSteps").innerHTML=cur<0
      ?`<div class="muted" style="padding:0 6px">Ready to begin.</div>`
      :`<div style="padding:0 6px">
          <div style="margin-bottom:8px;font-weight:600">${phaseLabel}</div>
          <div style="background:var(--line);border-radius:20px;height:10px;overflow:hidden">
            <div style="background:var(--go);height:100%;width:${pct}%;transition:width .3s"></div>
          </div>
        </div>`;
    return;
  }
  document.getElementById("railSteps").innerHTML=plan.map((s,idx)=>{ const sl=shortLabel(s); const cls=idx<cur?"done":(idx===cur?"current":"");
    return `<div class="step-row ${cls}"><div class="dot" style="background:${tagColor(s)}"></div>
      <div class="lbl">${sl.t}${s.bp?`<span class="bpbadge">BP</span>`:""}${s.dur?`<small>${s.dur}s</small>`:""}</div></div>`; }).join("");
}
function togglePlanDetail(){ state.showPlanDetail=!state.showPlanDetail; renderRail(state.lastPlan||[],state.lastCur??-1); }
function startSession(){
  const pid=document.getElementById("pid").value; state.assign=assignFor(pid); state.plan=buildPlan(state.assign);
  document.body.classList.add("session-running");
  state.perfT0=nowPerf(); state.wallT0=new Date().toISOString(); state.markers=[];
  logEvent("session_start",`participant ${state.assign.pid} · operator ${document.getElementById("operator").value||"—"} · williams_row ${state.assign.row}`);
  document.getElementById("setupCard").classList.add("hide");
  document.getElementById("runnerCard").classList.remove("hide");
  document.getElementById("logCard").classList.add("hide");
  state.i=0; renderStep();
}

/* ============================================================
   RUNNER
   ============================================================ */
function gotoStep(i){ if(i<0||i>=state.plan.length)return; state.i=i; renderStep(); }
function advance(){
  logEvent("step_end",shortLabel(state.plan[state.i]).t);
  if(state.i<state.plan.length-1){
    state.i++;
    renderStep();
  }
}
function renderStep(){
  clearTimer(); stopWashout(); stopStroop(); stopNback(); stopConversationTimer(); stopBodyScanAudio();
  const logDetails=document.getElementById("logDetails"); if(logDetails) logDetails.open=false;
  const s=state.plan[state.i]; renderRail(state.plan,state.i);
  document.getElementById("stepTag").style.background=tagColor(s);
  document.getElementById("stepKicker").textContent=s.kick;
  document.getElementById("stepTitle").textContent=s.title;
  let html=""; if(s.script)html+=`<div class="script"><div class="who">Say to participant <button class="speakBtn" id="speakBtn" onclick="speakScript()" title="Play / replay aloud">🔊</button></div><span id="scriptText">${s.script}</span></div>`;
  if(s.op)html+=`<div class="opnote"><b>Operator:</b> ${s.op}</div>`;
  document.getElementById("stepBody").innerHTML=html;
  document.getElementById("prevBtn").disabled=state.i===0;
  state.currentScript=s.script||"";
  if(s.script) speakScript(); else if("speechSynthesis" in window) window.speechSynthesis.cancel();

  renderMedia(s);

  const tr=document.getElementById("timerRow");
  const hideBuiltinTimer=["washout_interactive","stroop_interactive","nback_interactive","conversational_interactive", "audio_bodyscan"].includes(s.feature);
  if(s.dur && !hideBuiltinTimer){ tr.classList.remove("hide"); setupTimer(s.dur); } else { tr.classList.add("hide"); setFixationOverlay(false); }

  const slot=document.getElementById("featureSlot"); slot.innerHTML="";
  const f=s.feature; const m=resolveMedia(s);

  if(f==="washout_interactive") renderWashoutInteractive(slot,s);
  else if(f==="stroop_interactive") renderStroopInteractive(slot);
  else if(f==="nback_interactive") renderNbackInteractive(slot);
  else if(f==="conversational_interactive") renderConversationalInteractive(slot,s);
  else if(f==="sam") renderSAM(slot,s);
  else if(f==="pacer" && !(m&&m.src)) renderPacer(slot);
  else if(f==="breathhold") renderBreathHold(slot);
  else if(f==="gate") renderGate(slot);
  else if(f==="safety_stand") renderSafetyStand(slot,s);
  else if(f==="audio_bodyscan"){
    slot.innerHTML=`
      <div class="mediabox" style="text-align:center; padding: 24px;">
        <h3 style="color:var(--c-relax);margin-bottom:10px">🎧 Guided Relaxation Audio</h3>
        <p class="muted">Ensure participant has eyes closed and is seated comfortably.</p>
        <div class="path" style="margin-bottom:14px; word-break:break-all;">File: ${m.src || 'No file set'}</div>
        <audio id="stepMedia" preload="auto" src="${m.src}" onended="stopBodyScanAudio(true)"></audio>
        ${!m.src ? '<div class="safety" style="margin-top:10px">No body-scan audio registered. Please set it in the Setup tab.</div>' : ''}
        <div class="controls" style="justify-content:center; margin-top:20px;">
          <button class="btn-go" id="bsPlayBtn" onclick="playBodyScanAudio()" ${!m.src ? 'disabled' : ''} style="padding:12px 28px; font-size:1.1rem; font-weight:bold;">▶ Start Audio</button>
          <button class="btn-stop" id="bsStopBtn" onclick="stopBodyScanAudio()" disabled style="padding:12px 28px; font-size:1.1rem; font-weight:bold;">■ Stop Audio</button>
        </div>
      </div>`;
  }
  else if(f==="end") slot.innerHTML=`<div class="script" style="border-left-color:var(--go)">Session complete. Export both files below and verify recorders saved.</div>`;

  if(s.bp) renderBP(slot,s);
  document.getElementById("logCard").classList.remove("hide");
  logEvent("step_start",shortLabel(s).t+(s.emo?` (${s.emo})`:""));
}

/* Explicit Audio controls for Body Scan */
function playBodyScanAudio() {
  const au = document.getElementById("stepMedia");
  if(au) {
    au.play();
    logEvent("bodyscan_onset", "Audio started");
    document.getElementById("bsPlayBtn").disabled = true;
    document.getElementById("bsStopBtn").disabled = false;
  }
}
function stopBodyScanAudio(autoCompleted) {
  const au = document.getElementById("stepMedia");
  // Ensure we only affect this if we are currently on the body scan step
  if(au && state.plan[state.i] && state.plan[state.i].feature === "audio_bodyscan") {
    au.pause();
    logEvent("bodyscan_offset", autoCompleted === true ? "Audio finished naturally" : "Stopped manually");
    const playBtn = document.getElementById("bsPlayBtn");
    if(playBtn) { playBtn.disabled = false; playBtn.textContent = "▶ Resume Audio"; }
    const stopBtn = document.getElementById("bsStopBtn");
    if(stopBtn) stopBtn.disabled = true;
    if(autoCompleted) beep();
  }
}

/* media */
function renderMedia(s){
  const slot=document.getElementById("mediaSlot"); slot.innerHTML="";
  const m=resolveMedia(s);
  if(!m || s.feature==="audio_bodyscan") return;

  if(!m.src){
    if(m.marked) slot.innerHTML=`<div class="safety">No file registered for <b>${m.name}</b>. Set it in the media library, or use manual markers.</div>
      <div class="controls"><button class="btn-go" onclick="videoStart('${m.mkind}','${m.name}')">▶ Mark onset (manual)</button>
      <button class="btn-stop" onclick="videoStop('${m.mkind}','${m.name}')">■ Mark offset</button></div>`;
    return;
  }
  if(m.kind==="audio"){
    slot.innerHTML=`<div class="mediabox"><div class="path">${m.src}</div><audio id="stepMedia" controls preload="auto" src="${m.src}"></audio></div>`; return;
  }
  if(m.marked){
    slot.innerHTML=`<div class="mediabox"><div class="path">${m.src}</div>
      <div class="videoWrap"><video id="stepMedia" playsinline preload="auto" src="${m.src}" onclick="fullscreenVideo(this)"></video><span class="expandHint">⤢ click to expand</span></div>
      <div class="controls"><button class="btn-go" onclick="videoStart('${m.mkind}','${m.name}')">▶ Play &amp; mark onset</button>
      <button class="btn-stop" onclick="videoStop('${m.mkind}','${m.name}')">■ Stop &amp; mark offset</button></div>
      <p class="muted">Onset logged on first rendered frame via requestVideoFrameCallback for photodiode alignment.</p></div>`;
  } else {
    slot.innerHTML=`<div class="mediabox"><div class="path">${m.src} · ${m.slot}</div>
      <div class="videoWrap"><video id="stepMedia" playsinline preload="auto" src="${m.src}" controls ${m.slot==='box_breathing'?'loop':''} onclick="fullscreenVideo(this)"></video><span class="expandHint">⤢ click to expand</span></div></div>`;
  }
}
function fullscreenVideo(v){
  if(document.fullscreenElement){ document.exitFullscreen(); return; }
  (v.requestFullscreen||v.webkitRequestFullscreen||v.msRequestFullscreen||function(){}).call(v);
}
function videoStart(mkind,name){
  const v=document.getElementById("stepMedia"); const label=mkind+"_onset";
  if(v && v.tagName==="VIDEO" && v.getAttribute("src")){
    if("requestVideoFrameCallback" in HTMLVideoElement.prototype) v.requestVideoFrameCallback((now,meta)=>logEvent(label,name,{media_time:meta.mediaTime,frame:meta.presentedFrames}));
    else logEvent(label,name,{note:"rVFC unsupported"});
    v.play();
  } else logEvent(label,name,{note:"manual (no media)"});
}
function videoStop(mkind,name){ const v=document.getElementById("stepMedia"); if(v&&v.pause)v.pause(); logEvent(mkind+"_offset",name); }

/* timer */
function setupTimer(dur){ state.timerDur=dur; state.timerRemain=dur; state.timerRunning=false; paintTimer(); document.getElementById("timerStart").textContent="Start"; setFixationOverlay(false); }
function paintTimer(){
  const d=document.getElementById("timerDisplay"), dot=document.getElementById("timerDot"), txt=document.getElementById("timerStatusText");
  d.classList.remove("running","completed");
  if(state.timerRemain<=0){ dot.textContent="✔"; txt.textContent="Completed"; d.classList.add("completed"); }
  else if(state.timerRunning){ dot.textContent="🟢"; txt.textContent="Running"; d.classList.add("running"); }
  else{ dot.textContent="🟡"; txt.textContent="Preparing"; }
}
function currentStepHasFixation(){ const s=state.plan[state.i]; return !!(s && s.fixationCross); }
function setFixationOverlay(show){ const ov=document.getElementById("fixationOverlay"); if(!ov)return; ov.classList.toggle("show", show && currentStepHasFixation()); }
function timerStartStop(){
  if(state.timerRunning){ clearInterval(state.timer); state.timerRunning=false; document.getElementById("timerStart").textContent="Resume"; logEvent("timer_pause",""); paintTimer(); setFixationOverlay(false); return; }
  state.timerRunning=true; document.getElementById("timerStart").textContent="Pause"; logEvent("timer_start",`${state.timerDur}s`); paintTimer(); setFixationOverlay(true);
  const t0=nowPerf(),start=state.timerRemain;
  state.timer=setInterval(()=>{ state.timerRemain=start-(nowPerf()-t0)/1000;
    if(state.timerRemain<=0){ state.timerRemain=0; paintTimer(); clearInterval(state.timer); state.timerRunning=false;
      document.getElementById("timerStart").textContent="Done"; beep(); logEvent("timer_elapsed",`${state.timerDur}s`); setFixationOverlay(false); return; } paintTimer(); },100);
}
function timerReset(){ clearTimer(); setupTimer(state.timerDur); }
function clearTimer(){ if(state.timer){clearInterval(state.timer);state.timer=null;} state.timerRunning=false; if(state.pacerInt){clearInterval(state.pacerInt);state.pacerInt=null;} if(state.bpInt){clearInterval(state.bpInt);state.bpInt=null;} }
function beep(){ try{const c=new(window.AudioContext||window.webkitAudioContext)();const o=c.createOscillator();const g=c.createGain();o.connect(g);g.connect(c.destination);o.frequency.value=660;g.gain.value=.08;o.start();setTimeout(()=>{o.stop();c.close();},180);}catch(e){} }
function speakScript(text){
  if(!("speechSynthesis" in window)) return;
  const t=(text||state.currentScript||"").trim(); if(!t) return;
  const btn=document.getElementById("speakBtn");
  window.speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(t);
  u.rate=0.97; u.pitch=1; u.lang="en-US";
  if(btn){ u.onstart=()=>btn.classList.add("speaking"); u.onend=()=>btn.classList.remove("speaking"); u.onerror=()=>btn.classList.remove("speaking"); }
  window.speechSynthesis.speak(u);
}

/* ============================================================
   WASHOUT INTERACTIVE
   ============================================================ */
function renderWashoutInteractive(slot, s){
  const dur = s.dur||20;
  slot.innerHTML=`
    <div style="text-align:center">
      <div class="washout-screen" id="washoutScreen">
        <div class="fix-cross" id="washoutCross"></div>
        <div class="washout-timer-ring" id="washoutRing">
          <svg viewBox="0 0 52 52"><circle class="ring-bg" cx="26" cy="26" r="22"/><circle class="ring-fg" id="washoutRingFg" cx="26" cy="26" r="22"/></svg>
          <div class="ring-label" id="washoutRingLabel">${dur}</div>
        </div>
      </div>
      <div class="washout-stats">
        <div class="washout-stat"><div class="wval" id="washoutElapsed">0s</div><div class="wlbl">Elapsed</div></div>
        <div class="washout-stat"><div class="wval" id="washoutRemainDisp">${dur}s</div><div class="wlbl">Remaining</div></div>
        <div class="washout-stat"><div class="wval" id="washoutSessionCount">—</div><div class="wlbl">Washout #</div></div>
      </div>
      <div class="controls" style="justify-content:center">
        <button class="btn-go" id="washoutStartBtn" onclick="startWashoutInteractive(${dur})">▶ Start washout</button>
        <button id="washoutStopBtn" onclick="stopWashout()" disabled>■ Stop</button>
      </div>
      <p class="muted" style="margin-top:8px">Participant stares at the grey field + fixation cross. Screen logs onset/offset automatically.</p>
    </div>`;
  const n = state.markers.filter(m=>m.label==="washout_onset").length+1;
  const el=document.getElementById("washoutSessionCount"); if(el) el.textContent=n;
}
function startWashoutInteractive(dur){
  const CIRCUMFERENCE=2*Math.PI*22;
  state.washoutRunning=true; state.washoutRemain=dur;
  const t0=nowPerf();
  const cross=document.getElementById("washoutCross");
  const ringFg=document.getElementById("washoutRingFg");
  const ringLbl=document.getElementById("washoutRingLabel");
  const elapsedEl=document.getElementById("washoutElapsed");
  const remainEl=document.getElementById("washoutRemainDisp");
  const startBtn=document.getElementById("washoutStartBtn");
  const stopBtn=document.getElementById("washoutStopBtn");
  if(cross) cross.classList.add("show");
  if(startBtn) startBtn.disabled=true;
  if(stopBtn) stopBtn.disabled=false;
  logEvent("washout_onset",`${dur}s washout start`);
  state.washoutInt=setInterval(()=>{
    const elapsed=(nowPerf()-t0)/1000;
    const remain=Math.max(0,dur-elapsed);
    state.washoutRemain=remain;
    if(ringFg) ringFg.style.strokeDashoffset=String(CIRCUMFERENCE*(1-(remain/dur)));
    if(ringLbl) ringLbl.textContent=Math.ceil(remain)+"s";
    if(elapsedEl) elapsedEl.textContent=elapsed.toFixed(1)+"s";
    if(remainEl) remainEl.textContent=Math.ceil(remain)+"s";
    if(remain<=0){ stopWashout(true); }
  },100);
}
function stopWashout(completed){
  if(state.washoutInt){ clearInterval(state.washoutInt); state.washoutInt=null; }
  if(!state.washoutRunning) return;
  state.washoutRunning=false;
  const cross=document.getElementById("washoutCross"); if(cross) cross.classList.remove("show");
  const startBtn=document.getElementById("washoutStartBtn"); if(startBtn){ startBtn.disabled=false; startBtn.textContent="▶ Restart"; }
  const stopBtn=document.getElementById("washoutStopBtn"); if(stopBtn) stopBtn.disabled=true;
  logEvent("washout_offset",completed?"auto-completed":"operator stopped",{completed:!!completed});
  if(completed) beep();
}

/* ============================================================
   STROOP INTERACTIVE
   ============================================================ */
const STROOP_COLORS=["red","blue","green","yellow","purple","orange"];
const STROOP_COLOR_CSS={ red:"#D32F2F",blue:"#1565C0",green:"#2E7D32",yellow:"#F57F17",purple:"#6A1B9A",orange:"#E65100" };
const STROOP_NEUTRAL_WORDS=["TABLE","CHAIR","HOUSE","CLOUD","RIVER","STONE"];

function buildStroopTrials(n){
  const trials=[]; const third=Math.floor(n/3);
  for(let i=0;i<third;i++){
    const c=STROOP_COLORS[i%STROOP_COLORS.length];
    trials.push({word:c.toUpperCase(),ink:c,type:"congruent",correct:c});
  }
  for(let i=0;i<third;i++){
    const w=STROOP_COLORS[i%STROOP_COLORS.length];
    const ink=STROOP_COLORS[(i+1+Math.floor(Math.random()*4))%STROOP_COLORS.length];
    trials.push({word:w.toUpperCase(),ink,type:"incongruent",correct:ink});
  }
  for(let i=0;i<n-2*third;i++){
    const ink=STROOP_COLORS[i%STROOP_COLORS.length];
    trials.push({word:STROOP_NEUTRAL_WORDS[i%STROOP_NEUTRAL_WORDS.length],ink,type:"neutral",correct:ink});
  }
  for(let i=trials.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[trials[i],trials[j]]=[trials[j],trials[i]];}
  return trials;
}

function renderStroopInteractive(slot){
  state.stroopTrials=buildStroopTrials(30);
  state.stroopIdx=0; state.stroopRunning=false;
  slot.innerHTML=`
    <div class="stroop-arena" id="stroopArena">
      <div id="stroopPhase">
        <h3 style="margin-bottom:8px;color:var(--c-cog)">🎨 Stroop Color-Word Task</h3>
        <p style="color:var(--ink2);font-size:14px;margin-bottom:12px">
          A colour <b>word</b> will appear. Click the button for the <b>INK COLOUR</b> — ignore what the word says.<br>
          30 trials · congruent / incongruent / neutral · keyboard shortcuts: R B G Y P O
        </p>
        <div style="display:flex;gap:14px;flex-wrap:wrap;justify-content:center;margin-bottom:14px">
          <span style="font-size:13px;color:var(--ink3)">Trials: <b>30</b></span>
          <span style="font-size:13px;padding:2px 10px;border-radius:20px;background:var(--go-bg);color:var(--go)">Congruent: 10</span>
          <span style="font-size:13px;padding:2px 10px;border-radius:20px;background:var(--stop-bg);color:var(--stop)">Incongruent: 10</span>
          <span style="font-size:13px;padding:2px 10px;border-radius:20px;background:var(--amber-bg);color:var(--amber)">Neutral: 10</span>
        </div>
        <button class="btn-go" style="font-size:1rem;padding:12px 32px" onclick="startStroop()">▶ Begin Stroop Task</button>
      </div>
      <div id="stroopTask" class="hide">
        <div class="stroop-progress"><div class="stroop-progress-fill" id="stroopFill" style="width:0%"></div></div>
        <div class="stroop-meta" id="stroopMeta">Trial 1 of 30</div>
        <div class="stroop-word-display" id="stroopWordDisplay">+</div>
        <div class="stroop-feedback-bar" id="stroopFeedback"></div>
        <div class="stroop-btns" id="stroopBtns">
          ${STROOP_COLORS.map(c=>`<button class="stroop-color-btn" data-color="${c}" style="background:${STROOP_COLOR_CSS[c]};color:#fff" onclick="stroopAnswer('${c}')">${c.toUpperCase()}</button>`).join("")}
        </div>
        <div class="stroop-meta" id="stroopScore">Correct: 0 | Errors: 0 | Avg RT: —</div>
      </div>
      <div id="stroopResults" class="hide">
        <h3 style="color:var(--c-cog);margin-bottom:10px">✅ Stroop Complete</h3>
        <div class="stroop-summary" id="stroopSummary"></div>
        <details style="margin-top:10px"><summary style="cursor:pointer;font-size:13px;color:var(--ink3)">Show trial-by-trial data</summary>
        <div class="logscroll" style="margin-top:8px"><table class="stroop-results-table">
          <thead><tr><th>#</th><th>Type</th><th>Word</th><th>Ink</th><th>Response</th><th>Correct?</th><th>RT (ms)</th></tr></thead>
          <tbody id="stroopResultsBody"></tbody></table></div></details>
        <div class="controls" style="margin-top:12px"><button onclick="restartStroop()">↺ Repeat task</button></div>
      </div>
    </div>`;
  document.addEventListener("keydown", stroopKeyHandler);
}

function startStroop(){
  state.stroopIdx=0; state.stroopRunning=true;
  logEvent("stroop_start","30 trials (10 congruent / 10 incongruent / 10 neutral)");
  document.getElementById("stroopPhase").classList.add("hide");
  document.getElementById("stroopTask").classList.remove("hide");
  showStroopTrial();
}
function showStroopTrial(){
  const t=state.stroopTrials[state.stroopIdx];
  document.getElementById("stroopWordDisplay").style.opacity="0";
  document.getElementById("stroopFeedback").textContent="";
  document.getElementById("stroopFeedback").style.color="";
  document.getElementById("stroopMeta").textContent=`Trial ${state.stroopIdx+1} of ${state.stroopTrials.length}`;
  document.getElementById("stroopFill").style.width=`${Math.round(100*state.stroopIdx/state.stroopTrials.length)}%`;
  setTimeout(()=>{
    const disp=document.getElementById("stroopWordDisplay");
    if(!disp)return;
    disp.textContent=t.word;
    disp.style.color=STROOP_COLOR_CSS[t.ink];
    disp.style.opacity="1";
    state.stroopRT0=nowPerf();
    document.querySelectorAll(".stroop-color-btn").forEach(b=>b.disabled=false);
  },350);
}
function stroopAnswer(color){
  if(!state.stroopRunning)return;
  const rt=(nowPerf()-state.stroopRT0).toFixed(1);
  const t=state.stroopTrials[state.stroopIdx];
  const correct=color===t.correct;
  document.querySelectorAll(".stroop-color-btn").forEach(b=>b.disabled=true);
  logEvent("stroop_trial",`${t.type} · word=${t.word} ink=${t.ink} resp=${color} correct=${correct}`,
    {trial:state.stroopIdx+1,trial_type:t.type,word:t.word,ink_color:t.ink,response:color,correct:correct,rt_ms:rt});
  const fb=document.getElementById("stroopFeedback");
  fb.textContent=correct?"✓ Correct":"✗ Wrong — ink was "+t.ink.toUpperCase();
  fb.style.color=correct?"var(--go)":"var(--stop)";

  const done=state.markers.filter(m=>m.label==="stroop_trial");
  const corr=done.filter(m=>m.correct).length;
  const rts=done.filter(m=>m.rt_ms).map(m=>+m.rt_ms);
  const avgRT=rts.length?Math.round(rts.reduce((a,b)=>a+b,0)/rts.length):0;
  document.getElementById("stroopScore").textContent=`Correct: ${corr} | Errors: ${done.length-corr} | Avg RT: ${avgRT}ms`;
  state.stroopIdx++;
  if(state.stroopIdx>=state.stroopTrials.length){ setTimeout(finishStroop,700); }
  else setTimeout(showStroopTrial,500);
}
function stroopKeyHandler(e){
  if(!state.stroopRunning)return;
  const map={r:"red",b:"blue",g:"green",y:"yellow",p:"purple",o:"orange"};
  const c=map[e.key.toLowerCase()]; if(c) stroopAnswer(c);
}
function finishStroop(){
  state.stroopRunning=false;
  document.removeEventListener("keydown",stroopKeyHandler);
  const trials=state.markers.filter(m=>m.label==="stroop_trial");
  const total=trials.length, corr=trials.filter(m=>m.correct).length;
  const rts=trials.filter(m=>m.rt_ms).map(m=>+m.rt_ms);
  const avgRT=rts.length?Math.round(rts.reduce((a,b)=>a+b,0)/rts.length):0;
  const byType=(type)=>{ const sub=trials.filter(m=>m.trial_type===type); const srt=sub.filter(m=>m.rt_ms).map(m=>+m.rt_ms); return {n:sub.length,corr:sub.filter(m=>m.correct).length,rt:srt.length?Math.round(srt.reduce((a,b)=>a+b,0)/srt.length):0}; };
  const cong=byType("congruent"),incong=byType("incongruent"),neut=byType("neutral");
  const stroopEffect=(incong.rt&&cong.rt)?(incong.rt-cong.rt):0;
  logEvent("stroop_complete",`total=${total} correct=${corr} accuracy=${Math.round(100*corr/total)}% avgRT=${avgRT}ms stroopEffect=${stroopEffect}ms`,
    {total,correct:corr,accuracy_pct:Math.round(100*corr/total),avg_rt_ms:avgRT,stroop_effect_ms:stroopEffect});
  document.getElementById("stroopTask").classList.add("hide");
  document.getElementById("stroopResults").classList.remove("hide");
  document.getElementById("stroopSummary").innerHTML=`
    <div class="stroop-sum-card"><div class="sval">${Math.round(100*corr/total)}%</div><div class="slbl">Accuracy</div></div>
    <div class="stroop-sum-card"><div class="sval">${avgRT}ms</div><div class="slbl">Avg RT</div></div>
    <div class="stroop-sum-card" style="border-color:var(--go)"><div class="sval" style="color:var(--go)">${cong.rt}ms</div><div class="slbl">Congruent RT</div></div>
    <div class="stroop-sum-card" style="border-color:var(--stop)"><div class="sval" style="color:var(--stop)">${incong.rt}ms</div><div class="slbl">Incongruent RT</div></div>
    <div class="stroop-sum-card"><div class="sval" style="color:var(--amber)">${stroopEffect}ms</div><div class="slbl">Stroop Effect</div></div>`;
  document.getElementById("stroopResultsBody").innerHTML=trials.map(m=>`<tr>
    <td>${m.trial}</td>
    <td class="${m.trial_type==='congruent'?'tag-congruent':m.trial_type==='incongruent'?'tag-incongruent':'tag-neutral'}">${m.trial_type}</td>
    <td><b>${m.word}</b></td>
    <td style="color:${STROOP_COLOR_CSS[m.ink_color]||'inherit'};font-weight:700">${m.ink_color}</td>
    <td style="color:${STROOP_COLOR_CSS[m.response]||'inherit'}">${m.response}</td>
    <td style="color:${m.correct?'var(--go)':'var(--stop)'}">${m.correct?"✓":"✗"}</td>
    <td class="mono">${m.rt_ms}</td></tr>`).join("");
  beep();
}
function restartStroop(){
  state.stroopTrials=buildStroopTrials(30); state.stroopIdx=0; state.stroopRunning=false;
  document.getElementById("stroopResults").classList.add("hide");
  document.getElementById("stroopPhase").classList.remove("hide");
}
function stopStroop(){ state.stroopRunning=false; document.removeEventListener("keydown",stroopKeyHandler); }

/* ============================================================
   N-BACK INTERACTIVE
   ============================================================ */
function buildNbackSeq(n, trials, matchProb){
  const seq=[]; const positions=Array.from({length:9},(_,i)=>i);
  for(let i=0;i<trials+n;i++){
    if(i<n){ seq.push({pos:positions[Math.floor(Math.random()*9)],isTarget:false,responded:false}); }
    else{
      const isTarget=Math.random()<matchProb;
      const pos=isTarget?seq[i-n].pos:positions.filter(p=>p!==seq[i-n].pos)[Math.floor(Math.random()*8)];
      seq.push({pos,isTarget,responded:false});
    }
  }
  return seq;
}
function renderNbackInteractive(slot){
  state.nbackN=1; state.nbackSeq=buildNbackSeq(1,20,0.3);
  state.nbackIdx=0; state.nbackRunning=false; state.nbackResults=[];
  slot.innerHTML=`
    <div class="nback-arena" id="nbackArena">
      <div id="nbackPhase">
        <h3 style="color:var(--c-phys);margin-bottom:8px">🧠 N-Back Working Memory Task</h3>
        <p style="color:var(--ink2);font-size:14px;margin-bottom:12px">
          A square will light up in the grid. Press <b>MATCH</b> (or <kbd style="font-family:var(--mono);background:#eee;padding:1px 6px;border-radius:4px">Space</kbd>) when the current position matches the position from N steps back.
        </p>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:center;margin-bottom:14px">
          <label style="font-size:13px;color:var(--ink2)">N-level:</label>
          <button onclick="setNbackN(1)" id="nBtn1" style="background:var(--c-phys);color:#fff;border-color:var(--c-phys)">1-Back</button>
          <button onclick="setNbackN(2)" id="nBtn2">2-Back</button>
          <button onclick="setNbackN(3)" id="nBtn3">3-Back</button>
        </div>
        <p style="font-size:12px;color:var(--ink3);margin-bottom:14px">20 trials · ~30% targets · stimulus on 800ms · ISI 200ms</p>
        <button class="btn-go" style="font-size:1rem;padding:12px 32px" onclick="startNback()">▶ Begin N-Back Task</button>
      </div>
      <div id="nbackTask" class="hide">
        <div class="nback-hud">
          <div class="nback-hud-item"><div class="hval" id="nhTrial">—</div><div class="hlbl">Trial</div></div>
          <div class="nback-hud-item"><div class="hval" id="nhHits" style="color:var(--go)">0</div><div class="hlbl">Hits</div></div>
          <div class="nback-hud-item"><div class="hval" id="nhMisses" style="color:var(--stop)">0</div><div class="hlbl">Misses</div></div>
          <div class="nback-hud-item"><div class="hval" id="nhFA" style="color:var(--amber)">0</div><div class="hlbl">False Alarms</div></div>
          <div class="nback-hud-item"><div class="hval" id="nhRT">—</div><div class="hlbl">Last RT</div></div>
        </div>
        <div class="nback-progress"><div class="nback-progress-fill" id="nbackFill" style="width:0%"></div></div>
        <div class="nback-grid-wrap">
          <div class="nback-grid" id="nbackGrid">
            ${Array.from({length:9}).map((_,i)=>`<div class="nback-cell" id="nc${i}"></div>`).join("")}
          </div>
        </div>
        <div class="nback-feedback" id="nbackFeedback"></div>
        <button class="nback-match-btn" id="nbackMatchBtn" onclick="nbackMatch()">MATCH</button>
        <div class="nback-kbd">Keyboard: <kbd style="font-family:var(--mono);background:#eee;padding:1px 6px;border-radius:4px">Space</kbd> = Match</div>
      </div>
      <div id="nbackResults" class="hide">
        <h3 style="color:var(--c-phys);margin-bottom:10px">✅ N-Back Complete</h3>
        <div class="nback-sum" id="nbackSummary"></div>
        <div id="nbackDprime"></div>
        <details style="margin-top:10px"><summary style="cursor:pointer;font-size:13px;color:var(--ink3)">Show trial-by-trial data</summary>
        <div class="logscroll" style="margin-top:8px"><table class="stroop-results-table">
          <thead><tr><th>#</th><th>Target?</th><th>Response</th><th>Outcome</th><th>RT (ms)</th></tr></thead>
          <tbody id="nbackResultsBody"></tbody></table></div></details>
        <div class="controls" style="margin-top:12px">
          <button onclick="restartNback()">↺ Repeat task</button>
          <button onclick="setNbackN(state.nbackN+1<=3?state.nbackN+1:1);restartNback()">↑ Next N-level</button>
        </div>
      </div>
    </div>`;
  document.addEventListener("keydown",nbackKeyHandler);
}
function setNbackN(n){
  state.nbackN=n;
  [1,2,3].forEach(i=>{ const b=document.getElementById("nBtn"+i); if(b){ b.style.background=i===n?"var(--c-phys)":""; b.style.color=i===n?"#fff":""; b.style.borderColor=i===n?"var(--c-phys)":"var(--line2)"; } });
  state.nbackSeq=buildNbackSeq(n,20,0.3);
}
function startNback(){
  state.nbackIdx=0; state.nbackRunning=true; state.nbackResults=[];
  logEvent("nback_start",`${state.nbackN}-back · 20 trials`);
  document.getElementById("nbackPhase").classList.add("hide");
  document.getElementById("nbackTask").classList.remove("hide");
  runNbackTrial();
}
function runNbackTrial(){
  if(state.nbackIdx>=state.nbackSeq.length){ finishNback(); return; }
  const trial=state.nbackSeq[state.nbackIdx];
  const isScored=state.nbackIdx>=state.nbackN;
  document.querySelectorAll(".nback-cell").forEach(c=>c.classList.remove("lit","match-flash","error-flash"));
  const cell=document.getElementById("nc"+trial.pos); if(cell) cell.classList.add("lit");
  state.nbackTrialT0=nowPerf(); trial.responded=false;
  const matchBtn=document.getElementById("nbackMatchBtn");
  if(matchBtn) matchBtn.disabled=!isScored;
  document.getElementById("nbackFill").style.width=`${Math.round(100*Math.max(0,state.nbackIdx-state.nbackN)/20)}%`;
  if(isScored) document.getElementById("nhTrial").textContent=`${state.nbackIdx-state.nbackN+1}/20`;

  state.nbackInt=setTimeout(()=>{
    if(cell) cell.classList.remove("lit");
    if(isScored && trial.isTarget && !trial.responded){
      nbackRecord(trial,"miss",null);
    }
    state.nbackInt=setTimeout(()=>{ state.nbackIdx++; runNbackTrial(); },200);
  },800);
}
function nbackMatch(){
  if(!state.nbackRunning)return;
  const trial=state.nbackSeq[state.nbackIdx];
  const isScored=state.nbackIdx>=state.nbackN;
  if(!isScored||trial.responded)return;
  const rt=(nowPerf()-state.nbackTrialT0).toFixed(1);
  trial.responded=true;
  const outcome=trial.isTarget?"hit":"false_alarm";
  nbackRecord(trial,outcome,rt);
  const cell=document.getElementById("nc"+trial.pos);
  if(cell){ cell.classList.remove("lit"); cell.classList.add(trial.isTarget?"match-flash":"error-flash"); }
  const fb=document.getElementById("nbackFeedback");
  fb.textContent=trial.isTarget?"✓ Hit!":"✗ False alarm";
  fb.style.color=trial.isTarget?"var(--go)":"var(--stop)";
  if(!trial.isTarget) document.getElementById("nhFA").textContent=parseInt(document.getElementById("nhFA").textContent||0)+1;
  document.getElementById("nhRT").textContent=rt+"ms";
}
function nbackRecord(trial,outcome,rt){
  state.nbackResults.push({trial:state.nbackIdx-state.nbackN+1,target:trial.isTarget,outcome,rt_ms:rt});
  logEvent("nback_trial",`${state.nbackN}-back · target=${trial.isTarget} outcome=${outcome}${rt?` rt=${rt}ms`:""}`,
    {nback_level:state.nbackN,trial_no:state.nbackIdx-state.nbackN+1,target:trial.isTarget,outcome,rt_ms:rt||""});
  const hits=state.nbackResults.filter(r=>r.outcome==="hit").length;
  const misses=state.nbackResults.filter(r=>r.outcome==="miss").length;
  const fa=state.nbackResults.filter(r=>r.outcome==="false_alarm").length;
  const hEl=document.getElementById("nhHits"); if(hEl) hEl.textContent=hits;
  const mEl=document.getElementById("nhMisses"); if(mEl) mEl.textContent=misses;
  const fEl=document.getElementById("nhFA"); if(fEl) fEl.textContent=fa;
}
function nbackKeyHandler(e){
  if(!state.nbackRunning)return;
  if(e.code==="Space"||e.key===" "){ e.preventDefault(); nbackMatch(); }
}
function finishNback(){
  state.nbackRunning=false;
  clearTimeout(state.nbackInt);
  document.removeEventListener("keydown",nbackKeyHandler);
  const res = state.nbackResults;
  const targets = res.filter(r => r.target);
  const nonTargets = res.filter(r => !r.target);

  const hits = res.filter(r => r.target && r.outcome === "hit").length;
  const misses = res.filter(r => r.target && r.outcome === "miss").length;
  const fa = res.filter(r => !r.target && r.outcome === "false_alarm").length;

  const hitRate = targets.length ? hits / targets.length : 0;
  const faRate = nonTargets.length ? fa / nonTargets.length : 0;

  const zScore=(p)=>{ const pc=Math.max(0.01,Math.min(0.99,p)); return Math.sqrt(2)*erfinv(2*pc-1); };
  const erfinv=(x)=>{ const a=0.147; const ln=Math.log(1-x*x); const t=2/(Math.PI*a)+ln/2; const r=Math.sign(x)*Math.sqrt(Math.sqrt(t*t-ln/a)-t); return isNaN(r)?0:r; };
  const dprime=(zScore(hitRate)-zScore(faRate)).toFixed(2);

  const rts = res.filter(r => r.rt_ms).map(r => +r.rt_ms);
  const avgRT = rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : 0;

  logEvent("nback_complete",`${state.nbackN}-back · hits=${hits} misses=${misses} FA=${fa} d'=${dprime} avgRT=${avgRT}ms`,
    {nback_level:state.nbackN,hits,misses,false_alarms:fa,hit_rate:hitRate.toFixed(3),fa_rate:faRate.toFixed(3),dprime,avg_rt_ms:avgRT});

  document.getElementById("nbackTask").classList.add("hide");
  document.getElementById("nbackResults").classList.remove("hide");
  document.getElementById("nbackSummary").innerHTML=`
    <div class="nback-sum-card"><div class="nsval">${hits}</div><div class="nslbl">Hits</div></div>
    <div class="nback-sum-card"><div class="nsval" style="color:var(--stop)">${misses}</div><div class="nslbl">Misses</div></div>
    <div class="nback-sum-card"><div class="nsval" style="color:var(--amber)">${fa}</div><div class="nslbl">False Alarms</div></div>
    <div class="nback-sum-card"><div class="nsval">${avgRT}ms</div><div class="nslbl">Avg RT</div></div>
    <div class="nback-sum-card"><div class="nsval">${(hitRate*100).toFixed(0)}%</div><div class="nslbl">Hit Rate</div></div>`;
  document.getElementById("nbackDprime").innerHTML=`<div class="dprime-badge">d′ (sensitivity) = ${dprime} &nbsp;·&nbsp; ${state.nbackN}-Back</div>`;
  document.getElementById("nbackResultsBody").innerHTML=res.map(r=>`<tr>
    <td>${r.trial}</td>
    <td style="color:${r.target?'var(--c-cog)':'var(--ink3)'}">${r.target?"🎯 Yes":"No"}</td>
    <td>${r.outcome==="hit"||r.outcome==="false_alarm"?"Pressed":"—"}</td>
    <td style="color:${r.outcome==="hit"?'var(--go)':r.outcome==="miss"?'var(--stop)':r.outcome==="false_alarm"?'var(--amber)':'var(--ink3)'};font-weight:600">${r.outcome.replace("_"," ")}</td>
    <td class="mono">${r.rt_ms||"—"}</td></tr>`).join("");
  beep();
}
function restartNback(){
  state.nbackSeq=buildNbackSeq(state.nbackN,20,0.3);
  state.nbackIdx=0; state.nbackRunning=false; state.nbackResults=[];
  document.getElementById("nbackResults").classList.add("hide");
  document.getElementById("nbackPhase").classList.remove("hide");
}
function stopNback(){
  state.nbackRunning=false;
  clearTimeout(state.nbackInt);
  document.removeEventListener("keydown",nbackKeyHandler);
}

/* ============================================================
   CONVERSATIONAL INTERACTIVE
   ============================================================ */
function renderConversationalInteractive(slot, s) {
  const dur = s.dur || 180;
  slot.innerHTML = `
    <div class="conv-interactive">
      <h3>💬 Conversational Task</h3>
      <p style="color:var(--ink2);font-size:14px;margin-bottom:12px">
        Engage in neutral conversation with the participant.
      </p>
      <div class="timer-display" id="conversationTimerDisplay">
        ${formatTime(dur)}
      </div>
      <div class="controls" style="justify-content:center; margin-bottom:15px;">
        <button class="btn-go" id="convStartBtn" onclick="startConversationTimer(${dur})">▶ Start Conversation</button>
        <button id="convPauseBtn" onclick="pauseConversationTimer()" disabled>⏸ Pause</button>
        <button id="convStopBtn" onclick="stopConversationTimer(false)" disabled>■ End Conversation</button>
      </div>
      <div class="note-input">
        <input type="text" id="conversationNoteText" placeholder="Log a timestamped observation about the conversation…" onkeydown="if(event.key==='Enter')logConversationNote()">
        <button onclick="logConversationNote()">Mark Note</button>
      </div>
      <p class="muted" style="margin-top:10px;">Operator notes are logged with timestamps.</p>
    </div>
  `;
  state.conversationTimerRemain = dur;
  paintConversationTimer();
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function paintConversationTimer() {
  const display = document.getElementById("conversationTimerDisplay");
  if (display) {
    display.textContent = formatTime(state.conversationTimerRemain);
  }
  const startBtn = document.getElementById("convStartBtn");
  const pauseBtn = document.getElementById("convPauseBtn");
  const stopBtn = document.getElementById("convStopBtn");

  if (state.conversationTimerRunning) {
    if (startBtn) { startBtn.disabled = true; startBtn.textContent = "Running..."; }
    if (pauseBtn) pauseBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = false;
  } else {
    if (state.conversationTimerRemain <= 0) {
      if (startBtn) { startBtn.disabled = true; startBtn.textContent = "Completed"; }
      if (pauseBtn) pauseBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = true;
    } else {
      if (startBtn) { startBtn.disabled = false; startBtn.textContent = "▶ Start Conversation"; }
      if (pauseBtn) pauseBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
    }
  }
}

function startConversationTimer(dur) {
  if (state.conversationTimerRunning) return;
  state.conversationTimerRunning = true;
  state.conversationTimerDur = dur;
  const t0 = nowPerf();
  const startRemain = state.conversationTimerRemain;
  logEvent("conversation_start", `Conversation timer started for ${dur}s.`);
  paintConversationTimer();

  state.conversationTimer = setInterval(() => {
    state.conversationTimerRemain = startRemain - (nowPerf() - t0) / 1000;
    if (state.conversationTimerRemain <= 0) {
      state.conversationTimerRemain = 0;
      stopConversationTimer(true);
    }
    paintConversationTimer();
  }, 1000);
}

function pauseConversationTimer() {
  if (!state.conversationTimerRunning) return;
  clearInterval(state.conversationTimer);
  state.conversationTimer = null;
  state.conversationTimerRunning = false;
  logEvent("conversation_pause", `Conversation timer paused. Remaining: ${state.conversationTimerRemain.toFixed(0)}s`);
  paintConversationTimer();
}

function stopConversationTimer(completed) {
  if (state.conversationTimer) {
    clearInterval(state.conversationTimer);
    state.conversationTimer = null;
  }
  if (state.conversationTimerRunning) {
    state.conversationTimerRunning = false;
    const status = completed ? "auto-completed" : "operator stopped";
    logEvent("conversation_end", `Conversation timer ${status}. Duration: ${(state.conversationTimerDur - state.conversationTimerRemain).toFixed(0)}s`,
      { completed: !!completed, duration_s: (state.conversationTimerDur - state.conversationTimerRemain).toFixed(0) });
    if(completed) beep();
  }

  // Safety checks before touching the DOM, in case we moved to another step
  const startBtn = document.getElementById("convStartBtn");
  const pauseBtn = document.getElementById("convPauseBtn");
  const stopBtn = document.getElementById("convStopBtn");
  const display = document.getElementById("conversationTimerDisplay");

  if (startBtn) { startBtn.disabled = false; startBtn.textContent = "▶ Start Conversation"; }
  if (pauseBtn) pauseBtn.disabled = true;
  if (stopBtn) stopBtn.disabled = true;
  if (display) display.textContent = formatTime(state.conversationTimerDur || 180);
}

function logConversationNote() {
  const el = document.getElementById("conversationNoteText");
  if (!el || !el.value.trim()) return;
  logEvent("conversation_note", el.value.trim());
  el.value = "";
}

/* ============================================================
   SAM
   ============================================================ */
function renderSAM(slot,s){
  const dim=(id,label,lo,hi)=>`<div class="dim"><div class="top"><span><b>${label}</b></span><span class="val" id="${id}v">5</span></div>
    <input type="range" id="${id}" min="1" max="9" value="5" oninput="document.getElementById('${id}v').textContent=this.value">
    <div class="top muted"><span>${lo}</span><span>${hi}</span></div></div>`;
  slot.innerHTML=`<div class="sam">${dim("valence","Valence (pleasure)","unpleasant","pleasant")}
    ${dim("arousal","Arousal (activation)","calm","excited")}${dim("dominance","Dominance (control)","controlled","in control")}
    <button class="btn-go" onclick="submitSAM('${s.emo}')">Save rating</button><span class="pill go hide" id="samSaved">saved</span></div>`;
}
function submitSAM(emo){ logEvent("sam_rating",emo,{valence:+document.getElementById("valence").value,arousal:+document.getElementById("arousal").value,dominance:+document.getElementById("dominance").value});
  document.getElementById("samSaved").classList.remove("hide"); }

/* pacer fallback */
function renderPacer(slot){ slot.innerHTML=`<div class="pacer-wrap"><div class="pacer" id="pacer"><span class="ph" id="pacerPh">ready</span></div>
  <button class="btn-go" onclick="startPacer()">Start pacer</button></div>`; }
function startPacer(){
  const phases=[["in",4,1.0],["hold",4,1.0],["out",4,.55],["hold",4,.55]]; let pi=0,remain=phases[0][1];
  const el=document.getElementById("pacer"),ph=document.getElementById("pacerPh");
  const apply=()=>{ el.style.transform=`scale(${phases[pi][2]})`; ph.textContent=`${phases[pi][0]} ${remain}`; };
  logEvent("pacer_start","box 4-4-4-4"); apply();
  state.pacerInt=setInterval(()=>{ remain--; if(remain<=0){pi=(pi+1)%phases.length;remain=phases[pi][1];} apply(); },1000);
}

/* breath-hold */
function renderBreathHold(slot){
  slot.innerHTML=`<div class="safety"><b>Safety:</b> voluntary and comfort-limited. Participant releases at will. Skip if any respiratory/cardiac condition, pregnancy, or discomfort.</div>
    <div class="flex"><button class="btn-go" onclick="holdStart()">Start hold (onset)</button>
    <button class="btn-stop" onclick="holdStop()">Release (offset)</button><span class="mono" id="holdClock" style="font-size:22px">0.0s</span></div>`;
  state.holdT0=null;
}
function holdStart(){ state.holdT0=nowPerf(); logEvent("breathhold_onset",""); if(state.holdInt)clearInterval(state.holdInt);
  state.holdInt=setInterval(()=>{const el=document.getElementById("holdClock");if(el)el.textContent=((nowPerf()-state.holdT0)/1000).toFixed(1)+"s";},100); }
function holdStop(){ if(state.holdInt){clearInterval(state.holdInt);state.holdInt=null;} const d=state.holdT0?((nowPerf()-state.holdT0)/1000).toFixed(1):"?"; logEvent("breathhold_offset",`${d}s held`,{duration_s:d}); }

/* gate */
function renderGate(slot){
  slot.innerHTML=`<div class="gate"><div class="muted" style="margin-bottom:6px">Confirm return-to-baseline before advancing:</div>
    <label><input type="checkbox" class="gk"> Tonic GSR back near resting level</label>
    <label><input type="checkbox" class="gk"> HR within ~5% of resting reference</label>
    <label><input type="checkbox" class="gk"> Participant settled, breathing regular</label>
    <button class="btn-amber" style="margin-top:8px" onclick="confirmGate()">Confirm baseline &amp; log</button>
    <span class="pill amber hide" id="gateOK" style="margin-left:8px">gate cleared</span></div>
    <p class="muted">The timer is a suggested minimum settle window, not a substitute for the physiology check.</p>`;
}
function confirmGate(){ if(![...document.querySelectorAll(".gk")].every(c=>c.checked)){alert("Confirm all three physiology checks first.");return;}
  logEvent("baseline_gate_cleared",`settle ${(state.timerDur-state.timerRemain).toFixed(0)}s`); document.getElementById("gateOK").classList.remove("hide"); }

/* standing/exertion safety */
function renderSafetyStand(slot,s){
  slot.innerHTML=`<div class="safety"><b>Supervise:</b> stay within reach for light-headedness. If a contraindication was flagged at intake, skip and log.</div>
    <div class="flex"><button onclick="logEvent('sweep_skipped','${s.title}')">Skip (logs reason)</button></div>`;
}

/* blood pressure */
function renderBP(slot,s){
  const bpSteps=state.plan.filter(x=>x.bp); const n=bpSteps.indexOf(s)+1, tot=bpSteps.length;
  const html=`<div class="bp">
    <div class="bp-head">Blood pressure — reading ${n} of ${tot}<span class="bp-lbl">${s.bpLabel||""}</span></div>
    <div class="muted" style="margin:4px 0 8px">Non-dominant arm, supported, feet flat. No talking during inflation.</div>
    <div class="flex" style="margin-bottom:8px"><button class="btn-go" id="bpInflate" onclick="bpInflate()">Inflate &amp; mark onset</button>
      <span class="mono" id="bpClock" style="font-size:16px;color:var(--ink3)">—</span></div>
    <div class="flex" style="gap:8px">
      <input type="number" id="bpSys" placeholder="SYS" min="50" max="260" style="width:80px">
      <span class="mono">/</span>
      <input type="number" id="bpDia" placeholder="DIA" min="30" max="160" style="width:80px">
      <input type="number" id="bpPul" placeholder="pulse" min="30" max="220" style="width:90px">
      <button class="btn-go" onclick="bpSave()">Save reading &amp; mark offset</button>
      <span class="pill go hide" id="bpSaved">saved</span>
    </div></div>`;
  slot.insertAdjacentHTML("beforeend",html); state.bpT0=null;
}
function bpInflate(){ state.bpT0=nowPerf(); logEvent("bp_onset",""); const b=document.getElementById("bpInflate"); if(b)b.textContent="Inflating…";
  if(state.bpInt)clearInterval(state.bpInt); state.bpInt=setInterval(()=>{const c=document.getElementById("bpClock"); if(c)c.textContent=((nowPerf()-state.bpT0)/1000).toFixed(0)+"s";},250); }
function bpSave(){
  const sys=+document.getElementById("bpSys").value, dia=+document.getElementById("bpDia").value, pul=+document.getElementById("bpPul").value;
  if(!sys||!dia){ alert("Enter at least systolic and diastolic."); return; }
  if(state.bpInt){clearInterval(state.bpInt);state.bpInt=null;}
  logEvent("bp_reading",`${sys}/${dia}${pul?` · ${pul} bpm`:""}`,{systolic:sys,diastolic:dia,pulse:pul||""});
  logEvent("bp_offset","");
  document.getElementById("bpSaved").classList.remove("hide");
}

/* exports */
function csvEscape(v){ v=String(v==null?"":v); return /[",\n]/.test(v)?`"${v.replace(/"/g,'""')}"`:v; }
function exportCSV(){
  const cols=["idx","participant_id","step_type","step","label","detail","t_session_ms","t_perf_ms","wall_iso"];
  const extra=["valence","arousal","dominance","systolic","diastolic","pulse","duration_s","media_time","frame","note",
    "trial","trial_type","word","ink_color","response","correct","rt_ms","nback_level","trial_no","target","outcome","hit_rate","fa_rate","dprime",
    "completed", "duration_elapsed_s"];
  const head=[...cols,...extra].join(",");
  const rows=state.markers.map(m=>[...cols,...extra].map(k=>csvEscape(m[k])).join(","));
  download(`markers_P${state.assign?state.assign.pid:"x"}.csv`,[head,...rows].join("\n"),"text/csv");
}
function exportJSON(){
  const payload={
    participant:state.assign, session_start_wall:state.wallT0, exported:new Date().toISOString(),
    clip_order:state.assign?state.assign.fullOrder:null, media:MEDIA, markers:state.markers };
  download(`session_P${state.assign?state.assign.pid:"x"}.json`,JSON.stringify(payload,null,2),"application/json");
  if(window.SessionAPI) window.SessionAPI.saveSession(payload).catch(error=>console.warn("Session was downloaded but not saved by the server.",error));
}
function exportCohortSheet(){
  const cols=["participant_id","williams_row","buf1","buf2","buf3","block1_a","block1_b","block2_a","block2_b","block3_a","block3_b","full_order"];
  const rows=[]; for(let p=1;p<=100;p++){ const a=assignFor(p);
    rows.push([p,a.row,a.buf1,a.buf2,a.buf3,...a.block1,...a.block2,...a.block3,a.fullOrder.join("|")].map(csvEscape).join(",")); }
  download("cohort_assignment_100.csv",[cols.join(","),...rows].join("\n"),"text/csv");
}
function download(name,text,mime){ const b=new Blob([text],{type:mime}),u=URL.createObjectURL(b);
  const a=document.createElement("a"); a.href=u; a.download=name; a.click(); URL.revokeObjectURL(u); }
function abortSession(){ logEvent("session_aborted",""); exportCSV(); exportJSON(); }

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener("DOMContentLoaded",()=>{
  renderMediaRows();
  hydrateMediaConfig();
  ["rdyConsent","rdyPhys","rdySensors"].forEach(id=>{const e=document.getElementById(id); if(e)e.addEventListener("change",checkStartReady);});
  checkStartReady();
  initRailDrawer();
  initDetailsAccordion();
});

function initDetailsAccordion(){
  const panels=Array.from(document.querySelectorAll("details"));
  panels.forEach(d=>{
    d.addEventListener("toggle",()=>{
      if(d.open){ panels.forEach(other=>{ if(other!==d && other.open) other.open=false; }); }
    });
  });
}

function initRailDrawer(){
  const rail=document.getElementById("rail"), handle=document.getElementById("railHandle"), backdrop=document.getElementById("railBackdrop");
  const W=()=>Math.min(280,window.innerWidth*0.82);
  let dragging=false, startX=0, startTranslate=0, current=0, open=false;
  function setOpen(v,animate=true){
    open=v;
    rail.classList.toggle("dragging",!animate); handle.classList.toggle("dragging",!animate);
    rail.style.transform=""; rail.classList.toggle("open",open); handle.classList.toggle("open",open);
    handle.style.left=open?W()+"px":"0px"; backdrop.classList.toggle("show",open);
    handle.setAttribute("aria-expanded",open?"true":"false");
  }
  window.openRail=()=>setOpen(true); window.closeRail=()=>setOpen(false); window.toggleRail=()=>setOpen(!open);
  function clientX(e){ return e.touches?e.touches[0].clientX:e.clientX; }
  function dragStart(e){
    dragging=true; startX=clientX(e); startTranslate=open?0:-W(); current=startTranslate;
    rail.classList.add("dragging"); handle.classList.add("dragging");
    document.addEventListener("pointermove",dragMove); document.addEventListener("pointerup",dragEnd);
    document.addEventListener("touchmove",dragMove,{passive:false}); document.addEventListener("touchend",dragEnd);
  }
  function dragMove(e){
    if(!dragging)return; if(e.cancelable)e.preventDefault();
    const dx=clientX(e)-startX; current=Math.max(-W(),Math.min(0,startTranslate+dx));
    rail.style.transform=`translateX(${current}px)`; handle.style.left=(W()+current)+"px";
    backdrop.classList.add("show"); backdrop.style.opacity=String(Math.max(0,Math.min(1,1+current/W())));
  }
  function dragEnd(){
    if(!dragging)return; dragging=false;
    document.removeEventListener("pointermove",dragMove); document.removeEventListener("pointerup",dragEnd);
    document.removeEventListener("touchmove",dragMove); document.removeEventListener("touchend",dragEnd);
    backdrop.style.opacity=""; setOpen(current>-W()*0.6,true);
  }
  handle.addEventListener("pointerdown",dragStart); handle.addEventListener("touchstart",dragStart,{passive:true});
  handle.addEventListener("click",()=>{ if(!dragging)toggleRail(); });
  rail.addEventListener("pointerdown",(e)=>{ if(e.target.closest("input,button,textarea,select,a"))return; dragStart(e); });
  backdrop.addEventListener("click",closeRail);
  document.addEventListener("keydown",(e)=>{ if(e.key==="Escape"&&open)closeRail(); });
  setOpen(false,false);
}
