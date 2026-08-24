"use client";

import { ArrowUpRight, Eye, Volume2, VolumeX } from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SubjectSnapshot, SubjectStep } from "@/lib/types";

async function sessionRequest(code: string, action?: string, payload?: Record<string,unknown>) {
  const response = action
    ? await fetch("/api/sessions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code,action,payload,view:"subject"})})
    : await fetch(`/api/sessions?code=${encodeURIComponent(code)}&view=subject`,{cache:"no-store"});
  const data = await response.json() as {session?:SubjectSnapshot;error?:string};
  if (!response.ok) throw new Error(data.error || "Unable to connect.");
  return data.session!;
}

async function participantSessionRequest(participantId: number) {
  const response = await fetch(`/api/sessions?participantId=${participantId}&view=subject`,{cache:"no-store"});
  const data = await response.json() as {session?:SubjectSnapshot;error?:string};
  if (!response.ok) throw new Error(data.error || "Unable to connect.");
  return data.session!;
}

export function SubjectPortal() {
  const [code,setCode] = useState("");
  const [draft,setDraft] = useState("");
  const [snapshot,setSnapshot] = useState<SubjectSnapshot|null>(null);
  const [error,setError] = useState("");
  const [connecting,setConnecting] = useState(false);
  const [audioEnabled,setAudioEnabled] = useState(true);
  const activeCode = useRef("");

  const acceptSnapshot = useCallback((next:SubjectSnapshot) => {
    if (next.code !== activeCode.current) return;
    setSnapshot(current => !current || current.code !== next.code || next.revision > current.revision ? next : current);
  },[]);

  const connectSnapshot = useCallback((next:SubjectSnapshot) => {
    activeCode.current=next.code;
    window.localStorage.setItem("meridian.subject.code",next.code);
    window.history.replaceState(null,"",`/subject?session=${encodeURIComponent(next.code)}`);
    setCode(next.code);
    setDraft(next.code);
    setSnapshot(next);
    setError("");
  },[]);

  const selectCode = useCallback((value:string) => {
    const normalized=value.trim().toUpperCase();
    activeCode.current=normalized;
    window.localStorage.setItem("meridian.subject.code",normalized);
    window.history.replaceState(null,"",`/subject?session=${encodeURIComponent(normalized)}`);
    setCode(normalized);
    setDraft(normalized);
    setSnapshot(null);
    setError("");
  },[]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get("session")?.toUpperCase();
    const saved = window.localStorage.getItem("meridian.subject.code")?.toUpperCase();
    const initial = query || saved || "";
    if (!initial) return;
    if (/^\d+$/.test(initial)) {
      participantSessionRequest(Number(initial)).then(connectSnapshot).catch(()=>window.setTimeout(()=>{setDraft(initial);setError("No active session for this participant.")},0));
    } else {
      window.setTimeout(()=>selectCode(initial),0);
    }
  },[connectSnapshot,selectCode]);

  const refresh = useCallback(async () => {
    if (!code) return;
    const requestedCode=code;
    try { const next=await sessionRequest(requestedCode); if(activeCode.current===requestedCode){acceptSnapshot(next);setError("");} }
    catch (err) {
      if(activeCode.current!==requestedCode)return;
      const message=err instanceof Error ? err.message : "Unable to connect.";
      setError(message === "Session not found." ? "Check the instructor code." : message);
      if(message === "Session not found.") {
        window.localStorage.removeItem("meridian.subject.code");
        activeCode.current="";
        setSnapshot(null);
        setDraft("");
        setCode("");
      }
    }
  },[acceptSnapshot,code]);

  useEffect(() => { if(!code)return; const first=window.setTimeout(refresh,0); const id=window.setInterval(refresh,850); return()=>{clearTimeout(first);clearInterval(id)}; },[code,refresh]);
  const act = useCallback(async (action:string,payload:Record<string,unknown>={}) => { if(!code)return;const requestedCode=code;const next=await sessionRequest(requestedCode,action,payload);if(activeCode.current===requestedCode)acceptSnapshot(next); },[acceptSnapshot,code]);
  useEffect(()=>{if(!code||snapshot?.status==="complete"||snapshot?.status==="aborted")return;const requestedCode=code;const beat=()=>sessionRequest(requestedCode,"subjectHeartbeat").then(next=>{if(activeCode.current===requestedCode)acceptSnapshot(next)}).catch(()=>undefined);const first=window.setTimeout(beat,0);const id=window.setInterval(beat,5000);return()=>{clearTimeout(first);clearInterval(id)}},[acceptSnapshot,code,snapshot?.status]);
  useEffect(()=>{
    if(!snapshot||!["complete","aborted"].includes(snapshot.status))return;
    let cancelled=false;
    const follow=()=>participantSessionRequest(snapshot.participantId).then(next=>{if(!cancelled&&next.code!==snapshot.code)connectSnapshot(next)}).catch(()=>undefined);
    const first=window.setTimeout(follow,0);const id=window.setInterval(follow,1200);
    return()=>{cancelled=true;clearTimeout(first);clearInterval(id)};
  },[connectSnapshot,snapshot]);
  const changeSession = useCallback(() => { window.localStorage.removeItem("meridian.subject.code");window.history.replaceState(null,"","/subject");activeCode.current="";setSnapshot(null);setDraft("");setError("");setCode(""); },[]);

  const submit = async () => {
    const value=draft.trim().toUpperCase();if(!value)return;
    setConnecting(true);setError("");
    try {
      if(/^\d+$/.test(value))connectSnapshot(await participantSessionRequest(Number(value)));
      else selectCode(value);
    } catch(err) { setError(err instanceof Error?err.message:"Unable to connect."); }
    finally { setConnecting(false); }
  };

  if (!code) return <SubjectConnect draft={draft} error={error} connecting={connecting} setDraft={setDraft} submit={submit} />;
  if (!snapshot) return <SubjectFrame code={code} progress={0} label="Session connection" title={<>Please wait.<br /><i>Connecting.</i></>} description={error || "The study will appear here when the connection is ready."} audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={changeSession}><QuietField /></SubjectFrame>;

  const step = snapshot.step;
  const progress = snapshot.stepCount ? Math.round(((snapshot.stepIndex + .35) / snapshot.stepCount) * 100) : 0;
  if (snapshot.status === "aborted") return <SubjectFrame code={snapshot.code} progress={progress} label="Session ended" title={<>Please wait.<br /><i>The session has ended.</i></>} description="The instructor will tell you what to do next." audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={changeSession}><QuietField /></SubjectFrame>;
  if (!step || snapshot.status === "complete" || step.type === "end") return <SubjectFrame code={snapshot.code} progress={100} label="Session complete" title={<>Thank you.<br /><i>Please wait.</i></>} description="Your responses have been recorded. The instructor will guide you from here." audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={changeSession}><QuietField complete /></SubjectFrame>;
  if (snapshot.status === "setup" || !snapshot.operatorConnected || !snapshot.acquisitionReady) return <SubjectFrame code={snapshot.code} progress={progress} label="Study preparation" title={<>Please wait.<br /><i>We will begin shortly.</i></>} description="There is nothing you need to do yet." audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={changeSession}><QuietField /></SubjectFrame>;

  const presentation = subjectPresentation(step);
  return <SubjectFrame code={snapshot.code} progress={progress} label={presentation.label} title={presentation.title} description={step.subjectPrompt || presentation.description} audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={changeSession}>
    {snapshot.status === "paused" ? <div className="subject-overlay"><p>{snapshot.announcement?.text || "Please wait a moment."}</p><button className="paper-button" onClick={changeSession}>Change session</button></div> : null}
    {snapshot.status !== "paused" && snapshot.announcement ? <div className="subject-overlay announcement" role="alert"><p>{snapshot.announcement.text}</p><button className="paper-button" onClick={()=>act("ack")}>Understood</button></div> : null}
    {step.safety && snapshot.status === "running" ? <button className="safety-stop" onClick={()=>act("pause",{reason:"Subject requested a stop",source:"subject"})}>I need to stop</button> : null}
    <div className={`live-subject-task task-${step.type}`}><StepView key={`${step.id}-${snapshot.attempt}`} step={step} snapshot={snapshot} act={act} audioEnabled={audioEnabled} /></div>
  </SubjectFrame>;
}

function SubjectConnect({draft,error,connecting,setDraft,submit}:{draft:string;error:string;connecting:boolean;setDraft:(value:string)=>void;submit:()=>Promise<void>}) {
  return <main className="live-entry live-subject-connect"><header className="live-entry-topbar"><Link href="/">MERIDIAN</Link><span>THE MERIDIAN STUDY</span><span>SUBJECT DISPLAY</span></header><section className="live-entry-grid"><div className="live-entry-index"><i /><span>01</span><p>Guided<br />session</p></div><form onSubmit={(event)=>{event.preventDefault();void submit()}}><p className="live-workspace-label">Subject display</p><h1>Join your<br /><i>study session.</i></h1><label htmlFor="session-code">Code shown by instructor</label><input id="session-code" value={draft} onChange={(event)=>setDraft(event.target.value.toUpperCase())} autoComplete="off" autoCapitalize="characters" maxLength={12} placeholder="0009AB7K" />{error ? <p className="live-entry-error" role="alert">{error}</p> : <div className="live-entry-state">Enter the code or participant ID shown by the instructor.</div>}<button type="submit" disabled={connecting || !draft.trim()}>{connecting ? "CONNECTING" : "CONNECT"}<ArrowUpRight size={16} /></button></form><div className="live-entry-context"><span>GUIDED DISPLAY</span><strong>One task at a time.</strong><p>Only the current instruction will appear during the study.</p></div></section><footer className="live-entry-footer"><span><Eye size={14} /> SUBJECT EXPERIENCE</span><span>THE MERIDIAN STUDY</span></footer></main>;
}

function SubjectFrame({code,progress,label,title,description,audioEnabled,setAudioEnabled,changeSession,children}:{code:string;progress:number;label:string;title:ReactNode;description:string;audioEnabled:boolean;setAudioEnabled:(value:boolean)=>void;changeSession:()=>void;children:ReactNode}) {
  return <MotionConfig reducedMotion="user"><main className="live-subject"><header className="live-subject-topbar"><Link href="/" className="live-wordmark">MERIDIAN</Link><span>SUBJECT DISPLAY</span><span>SESSION IN PROGRESS</span></header><div className="live-subject-progress" aria-hidden="true"><motion.i initial={false} animate={{width:`${Math.max(0,Math.min(progress,100))}%`}} /></div><section className="live-subject-stage"><motion.div className="live-subject-copy" key={`${code}-${label}`} initial={{opacity:0,y:7}} animate={{opacity:1,y:0}}><p className="live-subject-label">{label}</p><h1>{title}</h1><p className="live-subject-description">{description}</p><div className="live-subject-actions"><button className="live-subject-secondary" onClick={()=>setAudioEnabled(!audioEnabled)} aria-pressed={audioEnabled}>{audioEnabled?<Volume2 size={16}/>:<VolumeX size={16}/>} {audioEnabled?"AUDIO ON":"AUDIO OFF"}</button></div></motion.div><div className="live-subject-field"><span className="live-subject-field-label top">BE PRESENT / NO RUSH</span>{children}<span className="live-subject-field-label bottom">ONE TASK AT A TIME</span></div></section><footer className="live-subject-footer"><span><Eye size={15}/> YOUR SESSION IS GUIDED</span><span>THE MERIDIAN STUDY / {code}</span><button onClick={changeSession}>CHANGE SESSION <ArrowUpRight size={14}/></button></footer><p className="sr-only" aria-live="polite">Audio is {audioEnabled?"on":"off"}.</p></main></MotionConfig>;
}

function QuietField({complete=false}:{complete?:boolean}) { return <div className={`live-subject-cross ${complete?"complete":""}`} aria-hidden="true"><i/><i/></div>; }

function subjectPresentation(step:SubjectStep) {
  if(step.type==="clip") return {label:"Visual stimulus",title:<>Watch<br/><i>naturally.</i></>,description:"Watch the screen naturally."};
  if(step.type==="sam") return {label:"Short response",title:<>Choose what<br/><i>fits best.</i></>,description:"Choose the response that feels closest."};
  if(step.type==="stroop") return {label:"Attention task",title:<>Respond<br/><i>accurately.</i></>,description:"Follow the instruction shown on the screen."};
  if(step.type==="nback") return {label:"Memory task",title:<>Stay with<br/><i>the sequence.</i></>,description:"Follow the instruction shown on the screen."};
  if(step.type==="conversation") return {label:"Speaking task",title:<>Speak<br/><i>naturally.</i></>,description:"Speak at a comfortable pace."};
  if(step.type==="washout"||step.fixation) return {label:"Baseline task",title:<>Keep your eyes<br/><i>at the centre.</i></>,description:"Stay with the centre of the screen."};
  if(step.type==="bodyscan") return {label:"Rest task",title:<>Settle<br/><i>into stillness.</i></>,description:"Stay still and follow the instruction."};
  if(step.type==="sweep") return {label:"Breathing task",title:<>Breathe<br/><i>with the guide.</i></>,description:"Follow the guide at a comfortable pace."};
  return {label:"Current task",title:<>A moment<br/><i>of attention.</i></>,description:"Follow the instruction shown on the screen."};
}

function StepView({step,snapshot,act,audioEnabled}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(action:string,payload?:Record<string,unknown>)=>Promise<void>;audioEnabled:boolean}) {
  if (step.type === "setup") return <CenteredInstruction text={step.subjectPrompt} />;
  if (step.type === "clip") return <ClipScreen step={step} src={snapshot.mediaSrc} act={act} audioEnabled={audioEnabled} />;
  if (step.type === "sam") return <RatingScreen step={step} act={act} />;
  if (step.type === "washout") return <WashoutScreen step={step} snapshot={snapshot} act={act} />;
  if (step.type === "stroop") return <StroopTask step={step} act={act} />;
  if (step.type === "nback") return <NBackTask step={step} level={snapshot.nbackLevel} act={act} />;
  if (step.type === "conversation") return <TimedScreen step={step} snapshot={snapshot} act={act} mode="conversation" />;
  if (step.type === "gate") return <GateScreen step={step} snapshot={snapshot} />;
  if (step.type === "sweep" && step.variant === "box_breathing") return <BreathingScreen step={step} snapshot={snapshot} act={act} />;
  if (step.type === "sweep" && step.variant === "breath_hold") return <BreathHoldScreen step={step} act={act} />;
  if (step.type === "bodyscan") return <TimedScreen step={step} snapshot={snapshot} act={act} mode="bodyscan" />;
  if (step.durationSec) return <TimedScreen step={step} snapshot={snapshot} act={act} mode={step.fixation ? "fixation" : "timer"} />;
  return <CenteredInstruction text={step.subjectPrompt || "Please wait."} />;
}

function CenteredInstruction({text}:{text:string}) { return <section className="subject-center subject-enter"><h1>{text}</h1></section>; }

function useRemaining(step:SubjectStep,snapshot:SubjectSnapshot,onDone?:()=>void) {
  const [remaining,setRemaining] = useState(step.durationSec ?? 0);
  const fired = useRef(false);
  useEffect(()=>{
    const tick=()=>{
      if(snapshot.status !== "running")return;
      const elapsed=(Date.now()-Date.parse(snapshot.stepStartedAt))/1000;
      const value=Math.max(0,(step.durationSec ?? 0)-elapsed);
      setRemaining(value);
      if(value<=0 && !fired.current){fired.current=true;onDone?.();}
    };
    tick(); const id=window.setInterval(tick,100); return()=>clearInterval(id);
  },[onDone,snapshot.status,snapshot.stepStartedAt,step.durationSec]);
  return remaining;
}

function TimedScreen({step,snapshot,act,mode}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;mode:"timer"|"fixation"|"conversation"|"bodyscan"}) {
  const done=useCallback(()=>act("autoAdvance",{expectedStepId:step.id}),[act,step.id]);
  const remaining=useRemaining(step,snapshot,done);
  if(mode==="bodyscan") return <section className="body-scan"><div className="breathing-orb"/><time>{clock(remaining)}</time></section>;
  return <section className="subject-center timed-screen">
    {mode==="fixation" ? <div className="fixation" aria-label="Focus on the cross"/> : <h1>{step.subjectPrompt}</h1>}
    {mode==="conversation" ? <time>{clock(remaining)}</time> : mode!=="fixation" ? <time>{Math.ceil(remaining)}</time> : <small>{Math.ceil(remaining)}</small>}
  </section>;
}

function GateScreen({step,snapshot}:{step:SubjectStep;snapshot:SubjectSnapshot}) {
  const remaining=useRemaining(step,snapshot);
  return <section className="subject-center timed-screen"><h1>{remaining>0 ? step.subjectPrompt : "Please wait."}</h1>{remaining>0 ? <time>{Math.ceil(remaining)}</time> : null}</section>;
}

function WashoutScreen({step,snapshot,act}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const done=useCallback(()=>act("autoAdvance",{expectedStepId:step.id}),[act,step.id]);
  const remaining=useRemaining(step,snapshot,done);
  return <section className="washout-screen"><div className="washout-cross"/><time>{Math.ceil(remaining)}</time></section>;
}

function ClipScreen({step,src,act,audioEnabled}:{step:SubjectStep;src:string;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;audioEnabled:boolean}) {
  const [playing,setPlaying]=useState(false); const fired=useRef(false);
  const finish=()=>{if(fired.current)return;fired.current=true;act("log",{eventType:"media_offset"}).then(()=>act("advance",{expectedStepId:step.id,source:"subject"}));};
  useEffect(()=>{if(!playing||src)return;const id=window.setTimeout(finish,12000);return()=>clearTimeout(id);});
  if(!playing) return <section className="subject-center clip-ready"><h1>{step.subjectPrompt}</h1><button className="light-button" onClick={()=>{setPlaying(true);act("log",{eventType:"media_onset"})}}>Begin</button></section>;
  if(src) return (
    // Captions are intentionally not injected because they would alter the registered research stimulus.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video className="stimulus-video" src={src} autoPlay playsInline muted={!audioEnabled} onEnded={finish} onError={()=>act("log",{eventType:"media_error",label:"Media failed to load",severity:"error",source:"system"})}/>
  );
  return <section className="placeholder-film" aria-label="Video stimulus"><div/><div/><div/></section>;
}

const DIMS = [
  {key:"valence",prompt:"How did the experience feel?",lo:"Unpleasant",hi:"Pleasant"},
  {key:"arousal",prompt:"How active did you feel?",lo:"Calm",hi:"Energized"},
  {key:"dominance",prompt:"How in control did you feel?",lo:"Less",hi:"More"},
] as const;
function RatingScreen({step,act}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [stage,setStage]=useState(0); const values=useRef([5,5,5]); const dim=DIMS[stage];
  const choose=(value:number)=>{values.current[stage]=value;if(stage<2)window.setTimeout(()=>setStage(stage+1),180);else act("rating",{expectedStepId:step.id,valence:values.current[0],arousal:values.current[1],dominance:value});};
  useEffect(()=>{const key=(event:KeyboardEvent)=>{const value=Number(event.key);if(value>=1&&value<=9)choose(value)};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key)});
  return <section className="rating-screen subject-enter"><p className="rating-count">{stage+1} / 3</p><h1>{dim.prompt}</h1><div className="rating-options" role="radiogroup" aria-label={dim.prompt}>{Array.from({length:9},(_,index)=>index+1).map(value=><button key={value} role="radio" aria-checked="false" aria-label={`Option ${value}`} onClick={()=>choose(value)}><span style={{transform:`scale(${0.72+value*0.04})`}}/></button>)}</div><div className="rating-anchors"><span>{dim.lo}</span><span>{dim.hi}</span></div></section>;
}

const COLOURS = [{name:"Red",hex:"#b83232"},{name:"Blue",hex:"#245fa9"},{name:"Green",hex:"#34743b"},{name:"Yellow",hex:"#d3a522"},{name:"Purple",hex:"#76509a"},{name:"Orange",hex:"#c66728"}];
function StroopTask({step,act}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [started,setStarted]=useState(false); const [trial,setTrial]=useState(0); const [stimulus,setStimulus]=useState(()=>makeStimulus()); const startedAt=useRef(0); const results=useRef<Array<{correct:boolean;rt:number}>>([]);
  useEffect(()=>{if(started)startedAt.current=performance.now()},[started,trial]);
  const answer=(name:string,eventTime:number)=>{const correct=name===stimulus.ink;results.current.push({correct,rt:eventTime-startedAt.current});if(trial>=29){const accuracy=Math.round(results.current.filter(r=>r.correct).length/results.current.length*100);const avgRt=Math.round(results.current.reduce((s,r)=>s+r.rt,0)/results.current.length);act("taskComplete",{expectedStepId:step.id,eventType:"stroop_complete",label:"Stroop completed",metadata:{trials:30,accuracyPct:accuracy,averageRtMs:avgRt}})}else{setTrial(trial+1);setStimulus(makeStimulus())}};
  if(!started)return <section className="subject-center"><h1>{step.subjectPrompt}</h1><button className="paper-button" onClick={()=>setStarted(true)}>Begin</button></section>;
  return <section className="task-screen"><div className="stroop-word" style={{color:stimulus.hex}}>{stimulus.word}</div><div className="colour-buttons">{COLOURS.map(colour=><button key={colour.name} style={{background:colour.hex}} onClick={event=>answer(colour.name,event.timeStamp)}>{colour.name}</button>)}</div></section>;
}
function makeStimulus(){const word=COLOURS[Math.floor(Math.random()*COLOURS.length)];let ink=COLOURS[Math.floor(Math.random()*COLOURS.length)];if(Math.random()>.35)while(ink.name===word.name)ink=COLOURS[Math.floor(Math.random()*COLOURS.length)];return{word:word.name.toUpperCase(),ink:ink.name,hex:ink.hex}}

function NBackTask({step,level,act}:{step:SubjectStep;level:number;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [started,setStarted]=useState(false);const [lit,setLit]=useState<number|null>(null);const sequence=useRef<number[]>([]);const index=useRef(0);const matches=useRef(0);const presses=useRef(0);const target=useRef(false);const ended=useRef(false);
  useEffect(()=>{if(!started)return;const next=()=>{if(index.current>=20){if(!ended.current){ended.current=true;act("taskComplete",{expectedStepId:step.id,eventType:"nback_complete",label:"N-back completed",metadata:{level,trials:20,matches:matches.current,responses:presses.current}})}return}let pos=Math.floor(Math.random()*9);if(index.current>=level&&Math.random()<.3)pos=sequence.current[index.current-level];sequence.current.push(pos);target.current=index.current>=level&&pos===sequence.current[index.current-level];setLit(pos);window.setTimeout(()=>setLit(null),800);index.current+=1};next();const id=window.setInterval(next,1100);return()=>clearInterval(id)},[act,level,started,step.id]);
  const press=()=>{if(lit===null)return;presses.current+=1;if(target.current)matches.current+=1};
  if(!started)return <section className="subject-center"><h1>{step.subjectPrompt}</h1><button className="paper-button" onClick={()=>setStarted(true)}>Begin</button></section>;
  return <section className="task-screen"><div className="nback-grid">{Array.from({length:9},(_,i)=><div key={i} className={lit===i?"lit":""}/>)}</div><button className="match-button" onClick={press}>Match</button></section>;
}

function BreathingScreen({step,snapshot,act}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const done=useCallback(()=>act("autoAdvance",{expectedStepId:step.id}),[act,step.id]);const remaining=useRemaining(step,snapshot,done);const phase=Math.floor((((step.durationSec??0)-remaining)/4)%4);const label=["In","Hold","Out","Hold"][phase];
  return <section className="subject-center breathing-screen"><h1>{step.subjectPrompt}</h1><div className={`breathing-circle phase-${phase}`}><span>{label}</span></div><small>{Math.ceil(remaining)}</small></section>;
}
function BreathHoldScreen({step,act}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [holding,setHolding]=useState(false);const [elapsed,setElapsed]=useState(0);const start=useRef(0);
  useEffect(()=>{if(!holding)return;start.current=performance.now();const id=window.setInterval(()=>setElapsed((performance.now()-start.current)/1000),100);return()=>clearInterval(id)},[holding]);
  return <section className="subject-center breath-hold"><h1>{step.subjectPrompt}</h1>{holding?<><time>{elapsed.toFixed(1)}</time><button className="paper-button" onClick={()=>act("taskComplete",{expectedStepId:step.id,eventType:"breath_hold_complete",label:"Breath hold completed",metadata:{durationSec:Number(elapsed.toFixed(1))}})}>Release</button></>:<button className="paper-button" onClick={()=>setHolding(true)}>I am ready</button>}</section>;
}
function clock(value:number){const n=Math.max(0,Math.ceil(value));return`${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`}
