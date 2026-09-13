"use client";

import { ArrowUpRight, Eye, Volume2, VolumeX } from "lucide-react";
import { MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SubjectSnapshot, SubjectStep } from "@/lib/types";

// Step timers use the server clock so a subject computer with a skewed clock cannot shorten or stretch timed steps.
let serverOffsetMs = 0;
const clockSamples: Array<{ roundTrip: number; offset: number }> = [];
const serverNow = () => Date.now() + serverOffsetMs;
const serverIso = () => new Date(serverNow()).toISOString();

// Stimuli are downloaded in full before the protocol starts and played from memory, so playback never waits on the
// network and onset timing does not depend on buffering.
const preloadedMedia = new Map<string,string>();
const mediaUrl = (src: string) => preloadedMedia.get(src) ?? src;
type MediaProgress = { loaded: number; total: number; failed: number };

function useMediaPreload(manifest: string[] | undefined, onProgress: (progress: MediaProgress) => void) {
  const key = (manifest ?? []).join("|");
  useEffect(() => {
    const urls = key ? key.split("|") : [];
    if (!urls.length) return;
    let cancelled = false;
    let retryId = 0;
    const failed = new Set<string>();
    const report = () => { if (!cancelled) onProgress({ loaded: urls.filter((url) => preloadedMedia.has(url)).length, total: urls.length, failed: failed.size }); };
    const load = async () => {
      failed.clear();
      await Promise.all(urls.filter((url) => !preloadedMedia.has(url)).map(async (url) => {
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(String(response.status));
          const blob = await response.blob();
          if (!preloadedMedia.has(url)) preloadedMedia.set(url, URL.createObjectURL(blob));
        } catch {
          failed.add(url);
        } finally {
          report();
        }
      }));
      report();
      if (failed.size && !cancelled) retryId = window.setTimeout(() => void load(), 10_000);
    };
    void load();
    return () => { cancelled = true; clearTimeout(retryId); };
  }, [key, onProgress]);
}

function trackServerClock(stamps: { serverReceivedAt?: string; serverRepliedAt?: string }, sentAt: number, receivedAt: number) {
  const serverReceived = Date.parse(stamps.serverReceivedAt ?? "");
  const serverReplied = Date.parse(stamps.serverRepliedAt ?? "");
  if (!Number.isFinite(serverReceived) || !Number.isFinite(serverReplied)) return;
  // NTP-style estimate; the sample with the shortest network round trip among recent ones is the most trustworthy.
  const roundTrip = (receivedAt - sentAt) - (serverReplied - serverReceived);
  clockSamples.push({ roundTrip, offset: ((serverReceived - sentAt) + (serverReplied - receivedAt)) / 2 });
  if (clockSamples.length > 12) clockSamples.shift();
  serverOffsetMs = clockSamples.reduce((best, sample) => sample.roundTrip < best.roundTrip ? sample : best).offset;
}

async function sessionRequest(code: string, action?: string, payload?: Record<string,unknown>) {
  const sentAt = Date.now();
  const response = action
    ? await fetch("/api/sessions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code,action,payload,view:"subject"})})
    : await fetch(`/api/sessions?code=${encodeURIComponent(code)}&view=subject`,{cache:"no-store"});
  const data = await response.json() as {session?:SubjectSnapshot;error?:string;serverReceivedAt?:string;serverRepliedAt?:string};
  if (!response.ok) throw new Error(data.error || "Unable to connect.");
  trackServerClock(data,sentAt,Date.now());
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
  const mediaProgress = useRef<MediaProgress|null>(null);
  const [mediaProgressVersion,setMediaProgressVersion] = useState(0);
  const onMediaProgress = useCallback((progress:MediaProgress) => { mediaProgress.current = progress; setMediaProgressVersion((value) => value + 1); },[]);

  const acceptSnapshot = useCallback((next:SubjectSnapshot) => {
    if (next.code !== activeCode.current) return;
    setSnapshot(current => !current || current.code !== next.code || next.revision > current.revision || (next.revision === current.revision && Date.parse(next.serverTime) >= Date.parse(current.serverTime)) ? next : current);
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
      participantSessionRequest(Number(initial)).then(connectSnapshot).catch(()=>window.setTimeout(()=>{setDraft(initial);setError("No session is waiting for this participant. Use the session code.")},0));
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
  useEffect(()=>{if(!code||snapshot?.status==="complete"||snapshot?.status==="aborted")return;const requestedCode=code;const beat=()=>sessionRequest(requestedCode,"subjectHeartbeat",{media:mediaProgress.current}).then(next=>{if(activeCode.current===requestedCode)acceptSnapshot(next)}).catch(()=>undefined);const first=window.setTimeout(beat,0);const id=window.setInterval(beat,5000);return()=>{clearTimeout(first);clearInterval(id)}},[acceptSnapshot,code,snapshot?.status,mediaProgressVersion]);
  useMediaPreload(snapshot?.mediaManifest,onMediaProgress);
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
  // Operator or recording loss while running is handled by a server-side pause, shown as an overlay below, so the
  // current stimulus stays mounted and resumes where it stopped.
  if (snapshot.status === "setup") return <SubjectFrame code={snapshot.code} progress={progress} label="Study preparation" title={<>Please wait.<br /><i>We will begin shortly.</i></>} description="There is nothing you need to do yet." audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={changeSession}><QuietField /></SubjectFrame>;

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
  if (step.type === "clip") return <ClipScreen step={step} src={snapshot.mediaSrc} act={act} audioEnabled={audioEnabled} paused={snapshot.status !== "running"} />;
  if (step.type === "sam") return <RatingScreen step={step} act={act} />;
  if (step.type === "washout") return <WashoutScreen step={step} snapshot={snapshot} act={act} />;
  if (step.type === "stroop") return <StroopTask step={step} act={act} paused={snapshot.status !== "running"} />;
  if (step.type === "nback") return <NBackTask step={step} level={snapshot.nbackLevel} act={act} paused={snapshot.status !== "running"} />;
  if (step.type === "conversation") return <TimedScreen step={step} snapshot={snapshot} act={act} mode="conversation" src="" audioEnabled={audioEnabled} />;
  if (step.type === "gate") return <GateScreen step={step} snapshot={snapshot} />;
  if (step.type === "sweep" && step.variant === "box_breathing") return <BreathingScreen step={step} snapshot={snapshot} act={act} src={snapshot.mediaSrc} audioEnabled={audioEnabled} />;
  if (step.type === "sweep" && step.variant === "breath_hold") return <BreathHoldScreen step={step} act={act} />;
  if (step.type === "bodyscan") return <TimedScreen step={step} snapshot={snapshot} act={act} mode="bodyscan" src={snapshot.mediaSrc} audioEnabled={audioEnabled} />;
  if (step.durationSec) return <TimedScreen step={step} snapshot={snapshot} act={act} mode={step.fixation ? "fixation" : "timer"} src="" audioEnabled={audioEnabled} />;
  return <CenteredInstruction text={step.subjectPrompt || "Please wait."} />;
}

function CenteredInstruction({text}:{text:string}) { return <section className="subject-center subject-enter"><h1>{text}</h1></section>; }

function useRemaining(step:SubjectStep,snapshot:SubjectSnapshot,onDone?:()=>Promise<unknown>) {
  const [remaining,setRemaining] = useState(step.durationSec ?? 0);
  const lastAttempt = useRef(0);
  useEffect(()=>{
    const tick=()=>{
      if(snapshot.status !== "running")return;
      const elapsed=(serverNow()-Date.parse(snapshot.stepStartedAt))/1000;
      const value=Math.max(0,(step.durationSec ?? 0)-elapsed);
      setRemaining(value);
      // Keep asking until the server moves on; a dropped request must not leave the subject stuck on a finished timer.
      if(value<=0 && onDone && Date.now()-lastAttempt.current>=1000){lastAttempt.current=Date.now();onDone().catch(()=>undefined);}
    };
    tick(); const id=window.setInterval(tick,100); return()=>clearInterval(id);
  },[onDone,snapshot.status,snapshot.stepStartedAt,step.durationSec]);
  return remaining;
}

function TimedScreen({step,snapshot,act,mode,src,audioEnabled}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;mode:"timer"|"fixation"|"conversation"|"bodyscan";src:string;audioEnabled:boolean}) {
  const done=useCallback(()=>act("autoAdvance",{expectedStepId:step.id}),[act,step.id]);
  const remaining=useRemaining(step,snapshot,done);
  if(mode==="bodyscan") return <section className="body-scan">
    {src ? <ProtocolVideo className="body-scan-video" src={src} audioEnabled={audioEnabled} loop paused={snapshot.status !== "running"} /> : null}
    <div className="body-scan-content"><div className="breathing-orb"/><time>{clock(remaining)}</time></div>
  </section>;
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

function ClipScreen({step,src,act,audioEnabled,paused}:{step:SubjectStep;src:string;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;audioEnabled:boolean;paused:boolean}) {
  const [playing,setPlaying]=useState(false); const [ended,setEnded]=useState(false); const errorLogged=useRef(false);
  const video=useRef<HTMLVideoElement>(null); const beganAt=useRef(0); const onsetLogged=useRef(false);
  const log=(eventType:string,metadata:Record<string,unknown>={})=>act("log",{expectedStepId:step.id,eventType,metadata:{clientTime:serverIso(),...metadata}}).catch(()=>undefined);
  const finish=()=>{if(ended)return;setEnded(true);void log("media_offset",{mediaTimeSec:video.current?.currentTime,durationSec:video.current?.duration});};
  const begin=()=>{beganAt.current=performance.now();setPlaying(true);if(!src){onsetLogged.current=true;void log("media_onset");}};
  // Onset is the first frame actually playing, not the button press.
  const onPlaying=()=>{if(onsetLogged.current)return;onsetLogged.current=true;void log("media_onset",{loadDelayMs:performance.now()-beganAt.current,mediaTimeSec:video.current?.currentTime});};
  useEffect(()=>{if(!playing||src||ended||paused)return;const id=window.setTimeout(finish,12000);return()=>clearTimeout(id);});
  useEffect(()=>{if(!ended)return;const send=()=>act("advance",{expectedStepId:step.id,source:"subject"}).catch(()=>undefined);send();const id=window.setInterval(send,1500);return()=>clearInterval(id);},[act,ended,step.id]);
  const wasPaused=useRef(paused);
  useEffect(()=>{
    // Act only on real session pause transitions, not on re-renders or remounts.
    if(wasPaused.current===paused)return;
    wasPaused.current=paused;
    const element=video.current;
    if(!element||!onsetLogged.current||ended)return;
    if(paused){element.pause();void log("media_paused",{mediaTimeSec:element.currentTime});}
    else{void element.play().catch(()=>undefined);void log("media_resumed",{mediaTimeSec:element.currentTime});}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[paused]);
  const mediaError=()=>{if(errorLogged.current)return;errorLogged.current=true;act("log",{expectedStepId:step.id,eventType:"media_error",metadata:{clientTime:serverIso()}}).catch(()=>undefined);};
  if(!playing) return <section className="subject-center clip-ready"><h1>{step.subjectPrompt}</h1><button className="light-button" disabled={paused} onClick={begin}>Begin</button></section>;
  if(src) return (
    // Captions are intentionally not injected because they would alter the registered research stimulus.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video ref={video} className="stimulus-video" src={mediaUrl(src)} autoPlay playsInline muted={!audioEnabled} onPlaying={onPlaying} onEnded={finish} onError={mediaError}/>
  );
  return <section className="placeholder-film" aria-label="Video stimulus"><div/><div/><div/></section>;
}

const DIMS = [
  {key:"valence",prompt:"Valence (pleasure)",lo:"Unpleasant",hi:"Pleasant"},
  {key:"arousal",prompt:"Arousal (activation)",lo:"Calm",hi:"Excited"},
  {key:"dominance",prompt:"Dominance (control)",lo:"Controlled",hi:"In control"},
] as const;
function RatingScreen({step,act}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [stage,setStage]=useState(0); const values=useRef([5,5,5]); const dim=DIMS[stage];
  const choose=(value:number)=>{values.current[stage]=value;if(stage<2)window.setTimeout(()=>setStage(stage+1),180);else act("rating",{expectedStepId:step.id,valence:values.current[0],arousal:values.current[1],dominance:value});};
  useEffect(()=>{const key=(event:KeyboardEvent)=>{const value=event.key==="0"?10:Number(event.key);if(value>=1&&value<=10)choose(value)};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key)});
  return <section className="rating-screen subject-enter"><p className="rating-count">{stage+1} / 3</p><h1>{dim.prompt}</h1><div className="rating-options" role="radiogroup" aria-label={`${dim.prompt}, ${dim.lo} to ${dim.hi}`}>{Array.from({length:10},(_,index)=>index+1).map(value=><button key={value} role="radio" aria-checked="false" aria-label={`${value} of 10${value===1?`, ${dim.lo}`:value===10?`, ${dim.hi}`:""}`} onClick={()=>choose(value)}>{value}</button>)}</div><div className="rating-anchors"><span>{dim.lo}</span><span>{dim.hi}</span></div></section>;
}

const COLOURS = [{name:"Red",hex:"#b83232"},{name:"Blue",hex:"#245fa9"},{name:"Green",hex:"#34743b"},{name:"Yellow",hex:"#d3a522"},{name:"Purple",hex:"#76509a"},{name:"Orange",hex:"#c66728"}];
function StroopTask({step,act,paused}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;paused:boolean}) {
  const [started,setStarted]=useState(false); const [trial,setTrial]=useState(0); const [stimulus,setStimulus]=useState(()=>makeStimulus()); const startedAt=useRef(0); const results=useRef<Array<{correct:boolean;rt:number}>>([]); const done=useRef(false);
  // Restarting the trial clock on resume keeps pause time out of the reaction time.
  useEffect(()=>{if(started&&!paused)startedAt.current=performance.now()},[started,trial,paused]);
  const answer=(name:string,eventTime:number)=>{if(paused||done.current)return;const correct=name===stimulus.ink;results.current.push({correct,rt:eventTime-startedAt.current});if(trial>=29){done.current=true;const accuracy=Math.round(results.current.filter(r=>r.correct).length/results.current.length*100);const avgRt=Math.round(results.current.reduce((s,r)=>s+r.rt,0)/results.current.length);const metadata={trials:30,accuracyPct:accuracy,averageRtMs:avgRt};const send=():Promise<void>=>act("taskComplete",{expectedStepId:step.id,eventType:"stroop_complete",label:"Stroop completed",metadata}).catch(()=>{window.setTimeout(send,1500)});void send()}else{setTrial(trial+1);setStimulus(makeStimulus())}};
  if(!started)return <section className="subject-center"><h1>{step.subjectPrompt}</h1><button className="paper-button" onClick={()=>setStarted(true)}>Begin</button></section>;
  return <section className="task-screen"><div className="stroop-word" style={{color:stimulus.hex}}>{stimulus.word}</div><div className="colour-buttons">{COLOURS.map(colour=><button key={colour.name} style={{background:colour.hex}} onClick={event=>answer(colour.name,event.timeStamp)}>{colour.name}</button>)}</div></section>;
}
function makeStimulus(){const word=COLOURS[Math.floor(Math.random()*COLOURS.length)];let ink=COLOURS[Math.floor(Math.random()*COLOURS.length)];if(Math.random()>.35)while(ink.name===word.name)ink=COLOURS[Math.floor(Math.random()*COLOURS.length)];return{word:word.name.toUpperCase(),ink:ink.name,hex:ink.hex}}

const NBACK_TRIALS = 20;
function NBackTask({step,level,act,paused}:{step:SubjectStep;level:number;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;paused:boolean}) {
  const [started,setStarted]=useState(false);const [lit,setLit]=useState<number|null>(null);const sequence=useRef<number[]>([]);const index=useRef(0);const ended=useRef(false);
  const trial=useRef({target:false,responded:false,onset:0});const score=useRef({hits:0,misses:0,falseAlarms:0,correctRejections:0,hitRtMs:[] as number[]});
  useEffect(()=>{
    if(!started||paused)return;
    let hideId=0;
    const closeTrial=()=>{const current=trial.current;if(index.current===0)return;if(current.target&&!current.responded)score.current.misses+=1;if(!current.target&&!current.responded)score.current.correctRejections+=1;};
    const next=()=>{
      if(index.current>=NBACK_TRIALS){
        if(!ended.current){closeTrial();ended.current=true;const {hits,misses,falseAlarms,correctRejections,hitRtMs}=score.current;const averageHitRtMs=hitRtMs.length?Math.round(hitRtMs.reduce((sum,value)=>sum+value,0)/hitRtMs.length):null;const metadata={level,trials:NBACK_TRIALS,hits,misses,falseAlarms,correctRejections,averageHitRtMs};const send=():Promise<void>=>act("taskComplete",{expectedStepId:step.id,eventType:"nback_complete",label:"N-back completed",metadata}).catch(()=>{window.setTimeout(send,1500)});void send();}
        return;
      }
      closeTrial();
      let pos=Math.floor(Math.random()*9);
      if(index.current>=level&&Math.random()<.3)pos=sequence.current[index.current-level];
      sequence.current.push(pos);
      trial.current={target:index.current>=level&&pos===sequence.current[index.current-level],responded:false,onset:performance.now()};
      setLit(pos);hideId=window.setTimeout(()=>setLit(null),800);index.current+=1;
    };
    next();const id=window.setInterval(next,1100);
    return()=>{clearInterval(id);clearTimeout(hideId);};
  },[act,level,paused,started,step.id]);
  const press=(eventTime:number)=>{const current=trial.current;if(paused||lit===null||current.responded)return;current.responded=true;if(current.target){score.current.hits+=1;score.current.hitRtMs.push(Math.round(eventTime-current.onset));}else score.current.falseAlarms+=1;};
  if(!started)return <section className="subject-center"><h1>{step.subjectPrompt}</h1><button className="paper-button" onClick={()=>setStarted(true)}>Begin</button></section>;
  return <section className="task-screen"><div className="nback-grid">{Array.from({length:9},(_,i)=><div key={i} className={lit===i?"lit":""}/>)}</div><button className="match-button" onClick={event=>press(event.timeStamp)}>Match</button></section>;
}

function BreathingScreen({step,snapshot,act,src,audioEnabled}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;src:string;audioEnabled:boolean}) {
  const done=useCallback(()=>act("autoAdvance",{expectedStepId:step.id}),[act,step.id]);const remaining=useRemaining(step,snapshot,done);const phase=Math.floor((((step.durationSec??0)-remaining)/4)%4);const label=["In","Hold","Out","Hold"][phase];
  return <section className={`subject-center breathing-screen ${src?"with-media":""}`}>
    {src ? <ProtocolVideo className="breathing-video" src={src} audioEnabled={audioEnabled} loop paused={snapshot.status !== "running"} /> : null}
    <div className="breathing-content"><h1>{step.subjectPrompt}</h1><div className={`breathing-circle phase-${phase}`}><span>{label}</span></div><small>{Math.ceil(remaining)}</small></div>
  </section>;
}

function ProtocolVideo({src,audioEnabled,className,loop=false,paused=false}:{src:string;audioEnabled:boolean;className:string;loop?:boolean;paused?:boolean}) {
  const video=useRef<HTMLVideoElement>(null);
  useEffect(()=>{const element=video.current;if(!element)return;if(paused)element.pause();else void element.play().catch(()=>undefined);},[paused]);
  return (
    // These registered protocol stimuli intentionally omit injected captions because captions would alter the research material.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video ref={video} className={className} src={mediaUrl(src)} autoPlay playsInline loop={loop} muted={!audioEnabled} preload="auto" />
  );
}
function BreathHoldScreen({step,act}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [holding,setHolding]=useState(false);const [elapsed,setElapsed]=useState(0);const start=useRef(0);
  useEffect(()=>{if(!holding)return;start.current=performance.now();const id=window.setInterval(()=>setElapsed((performance.now()-start.current)/1000),100);return()=>clearInterval(id)},[holding]);
  return <section className="subject-center breath-hold"><h1>{step.subjectPrompt}</h1>{holding?<><time>{elapsed.toFixed(1)}</time><button className="paper-button" onClick={()=>{const metadata={durationSec:Number(elapsed.toFixed(1))};const send=():Promise<void>=>act("taskComplete",{expectedStepId:step.id,eventType:"breath_hold_complete",label:"Breath hold completed",metadata}).catch(()=>{window.setTimeout(send,1500)});void send();}}>Release</button></>:<button className="paper-button" onClick={()=>setHolding(true)}>I am ready</button>}</section>;
}
function clock(value:number){const n=Math.max(0,Math.ceil(value));return`${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`}
