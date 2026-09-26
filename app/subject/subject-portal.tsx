"use client";

import { ArrowUpRight, Eye, Volume2, VolumeX } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BpStepper } from "@/app/bp-stepper";
import { QUESTIONNAIRES } from "@/lib/questionnaires";
import { BP_LIMITS } from "@/lib/rig";
import { startTicker } from "@/lib/ticker";
import { BOX_BREATHING_PHASE_SEC, BOX_BREATHING_ROUNDS, BREATH_HOLD_MAX_SEC, READING_EVENT, READING_MAX_SEC, READING_PASSAGE, READING_WORDS, DISCRETE_EMOTIONS, FAMILIARITY, INTENSITY_POINTS, NBACK, SAM_POINTS, STROOP, TASK_COLOURS, WORD_LIST, WORD_LIST_EVENT, nbackOutcome, nbackSequence, newSeed, seededRandom, stroopTrials, summarizeNBack, summarizeStroop, type NBackTrial, type StroopResponse } from "@/lib/tasks";
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

// Photodiode sync patch: a small screen corner that flashes white when a stimulus starts or ends and when a step
// appears. The flash is set directly on the element so it lands on the next frame without waiting for React.
let syncPatchElement: HTMLDivElement | null = null;
const SYNC_FLASH_MS = 200;
function flashSyncPatch() {
  const element = syncPatchElement;
  if (!element) return;
  element.style.background = "#fff";
  window.setTimeout(() => { element.style.background = "#000"; }, SYNC_FLASH_MS);
}
function SyncPatch() {
  return <div className="sync-patch" aria-hidden="true" ref={(element) => { syncPatchElement = element; }} />;
}
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

  useEffect(() => { if(!code)return; const first=window.setTimeout(refresh,0); const stop=startTicker(850,()=>void refresh()); return()=>{clearTimeout(first);stop()}; },[code,refresh]);
  const act = useCallback(async (action:string,payload:Record<string,unknown>={}) => { if(!code)return;const requestedCode=code;const next=await sessionRequest(requestedCode,action,payload);if(activeCode.current===requestedCode)acceptSnapshot(next); },[acceptSnapshot,code]);
  useEffect(()=>{if(!code||snapshot?.status==="complete"||snapshot?.status==="aborted")return;const requestedCode=code;const beat=()=>sessionRequest(requestedCode,"subjectHeartbeat",{media:mediaProgress.current}).then(next=>{if(activeCode.current===requestedCode)acceptSnapshot(next)}).catch(()=>undefined);const first=window.setTimeout(beat,0);const stop=startTicker(5000,()=>void beat());return()=>{clearTimeout(first);stop()}},[acceptSnapshot,code,snapshot?.status,mediaProgressVersion]);
  useMediaPreload(snapshot?.mediaManifest,onMediaProgress);
  const displayedStep = snapshot?.status === "running" && snapshot.step ? `${snapshot.step.id}|${snapshot.attempt}` : "";
  useEffect(()=>{
    if(!displayedStep||!code)return;
    const [stepId]=displayedStep.split("|");
    // Stamp when the step is actually on screen (next frame), for alignment and the photodiode check.
    // Browsers skip animation frames for hidden pages, so a short timer guarantees the event is still logged.
    let logged=false;
    const show=()=>{if(logged)return;logged=true;flashSyncPatch();void sessionRequest(code,"log",{expectedStepId:stepId,eventType:"step_displayed",metadata:{clientTime:serverIso()}}).catch(()=>undefined);};
    const frame=window.requestAnimationFrame(show);const fallback=window.setTimeout(show,100);
    return()=>{window.cancelAnimationFrame(frame);clearTimeout(fallback);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[displayedStep]);
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
  if (snapshot.status === "setup") return <SubjectFrame demo={snapshot.demo} code={snapshot.code} progress={progress} label="Study preparation" title={<>Please wait.<br /><i>We will begin shortly.</i></>} description="There is nothing you need to do yet." audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={changeSession}><QuietField /></SubjectFrame>;

  const presentation = subjectPresentation(step);
  return <SubjectFrame code={snapshot.code} progress={progress} label={presentation.label} title={presentation.title} description={step.subjectPrompt || presentation.description} audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={changeSession}>
    {snapshot.status === "paused" ? <div className="subject-overlay"><p>{snapshot.announcement?.text || "Please wait a moment."}</p><button className="paper-button" onClick={changeSession}>Change session</button></div> : null}
    {snapshot.status !== "paused" && snapshot.announcement ? <div className="subject-overlay announcement" role="alert"><p>{snapshot.announcement.text}</p><button className="paper-button" onClick={()=>act("ack")}>Understood</button></div> : null}
    {step.safety && snapshot.status === "running" ? <button className="safety-stop" onClick={()=>act("pause",{reason:"Subject requested a stop",source:"subject"})}>I need to stop</button> : null}
    {snapshot.syncPatch ? <SyncPatch /> : null}
    <div className={`live-subject-task task-${step.type}`}><StepView key={`${step.id}-${snapshot.attempt}`} step={step} snapshot={snapshot} act={act} audioEnabled={audioEnabled} /></div>
  </SubjectFrame>;
}

function SubjectConnect({draft,error,connecting,setDraft,submit}:{draft:string;error:string;connecting:boolean;setDraft:(value:string)=>void;submit:()=>Promise<void>}) {
  return <main className="live-entry live-subject-connect"><header className="live-entry-topbar"><Link href="/">MERIDIAN</Link><span>THE MERIDIAN STUDY</span><span>SUBJECT DISPLAY</span></header><section className="live-entry-grid"><div className="live-entry-index"><i /><span>01</span><p>Guided<br />session</p></div><form onSubmit={(event)=>{event.preventDefault();void submit()}}><p className="live-workspace-label">Subject display</p><h1>Join your<br /><i>study session.</i></h1><label htmlFor="session-code">Code shown by instructor</label><input id="session-code" value={draft} onChange={(event)=>setDraft(event.target.value.toUpperCase())} autoComplete="off" autoCapitalize="characters" maxLength={12} placeholder="0009AB7K" />{error ? <p className="live-entry-error" role="alert">{error}</p> : <div className="live-entry-state">Enter the code or participant ID shown by the instructor.</div>}<button type="submit" disabled={connecting || !draft.trim()}>{connecting ? "CONNECTING" : "CONNECT"}<ArrowUpRight size={16} /></button></form><div className="live-entry-context"><span>GUIDED DISPLAY</span><strong>One task at a time.</strong><p>Only the current instruction will appear during the study.</p></div></section><footer className="live-entry-footer"><span><Eye size={14} /> SUBJECT EXPERIENCE</span><span>THE MERIDIAN STUDY</span></footer></main>;
}

function SubjectFrame({code,progress,label,title,description,audioEnabled,setAudioEnabled,changeSession,demo=false,children}:{code:string;progress:number;label:string;title:ReactNode;description:string;audioEnabled:boolean;setAudioEnabled:(value:boolean)=>void;changeSession:()=>void;demo?:boolean;children:ReactNode}) {
  return <main className="live-subject"><header className="live-subject-topbar"><Link href="/" className="live-wordmark">MERIDIAN</Link><span>SUBJECT DISPLAY</span><span>{demo?"DEMO RUN / NOT RECORDED":"SESSION IN PROGRESS"}</span></header><div className="live-subject-progress" aria-hidden="true"><i style={{width:`${Math.max(0,Math.min(progress,100))}%`}} /></div><section className="live-subject-stage"><div className="live-subject-copy" key={`${code}-${label}`}><p className="live-subject-label">{label}</p><h1>{title}</h1><p className="live-subject-description">{description}</p><div className="live-subject-actions"><button className="live-subject-secondary" onClick={()=>setAudioEnabled(!audioEnabled)} aria-pressed={audioEnabled}>{audioEnabled?<Volume2 size={16}/>:<VolumeX size={16}/>} {audioEnabled?"AUDIO ON":"AUDIO OFF"}</button></div></div><div className="live-subject-field"><span className="live-subject-field-label top">BE PRESENT / NO RUSH</span>{children}<span className="live-subject-field-label bottom">ONE TASK AT A TIME</span></div></section><footer className="live-subject-footer"><span><Eye size={15}/> YOUR SESSION IS GUIDED</span><span>THE MERIDIAN STUDY / {code}</span><button onClick={changeSession}>CHANGE SESSION <ArrowUpRight size={14}/></button></footer><p className="sr-only" aria-live="polite">Audio is {audioEnabled?"on":"off"}.</p></main>;
}

function QuietField({complete=false}:{complete?:boolean}) { return <div className={`live-subject-cross ${complete?"complete":""}`} aria-hidden="true"><i/><i/></div>; }

function subjectPresentation(step:SubjectStep) {
  if(step.type==="clip") return {label:"Visual stimulus",title:<>Watch<br/><i>naturally.</i></>,description:"Watch the screen naturally."};
  if(step.type==="sam") return {label:"Short response",title:<>Choose what<br/><i>fits best.</i></>,description:"Choose the response that feels closest."};
  if(step.type==="stroop") return {label:"Attention task",title:<>Respond<br/><i>accurately.</i></>,description:"Follow the instruction shown on the screen."};
  if(step.type==="nback") return {label:"Memory task",title:<>Stay with<br/><i>the sequence.</i></>,description:"Follow the instruction shown on the screen."};
  if(step.type==="wordlist") return {label:"Memory task",title:<>Remember<br/><i>the words.</i></>,description:"Follow the instruction shown on the screen."};
  if(step.type==="reading") return {label:"Reading task",title:<>Read<br/><i>aloud.</i></>,description:"Read at your normal speaking pace."};
  if(step.type==="conversation") return {label:"Speaking task",title:<>Speak<br/><i>naturally.</i></>,description:"Speak at a comfortable pace."};
  if(step.type==="washout"||step.fixation) return {label:"Baseline task",title:<>Keep your eyes<br/><i>at the centre.</i></>,description:"Stay with the centre of the screen."};
  if(step.type==="bodyscan") return {label:"Relaxation",title:<>Close your eyes.<br/><i>Relax.</i></>,description:"Close your eyes, relax and follow the guided voice."};
  if(step.type==="sweep" && step.variant==="exertion") return {label:"Movement task",title:<>Move<br/><i>at your own pace.</i></>,description:"Stop at once if you feel dizzy or unwell."};
  if((step.type==="sweep" && !step.variant) || step.type==="recovery") return {label:"Rest",title:<>Sit<br/><i>still.</i></>,description:"Breathe normally."};
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
  if (step.type === "wordlist") return <WordListTask step={step} act={act} paused={snapshot.status !== "running"} />;
  if (step.type === "reading") return <ReadingScreen step={step} act={act} paused={snapshot.status !== "running"} />;
  if (step.type === "conversation") return <TimedScreen step={step} snapshot={snapshot} act={act} mode="conversation" src="" audioEnabled={audioEnabled} />;
  if (step.type === "gate") return <GateScreen step={step} snapshot={snapshot} act={act} />;
  if (step.type === "sweep" && step.variant === "box_breathing") return <BreathingScreen step={step} snapshot={snapshot} act={act} />;
  if (step.type === "sweep" && step.variant === "paced_breathing") return <PacedBreathingScreen step={step} snapshot={snapshot} act={act} />;
  if (step.type === "questionnaire") return <QuestionnaireScreen step={step} act={act} paused={snapshot.status !== "running"} />;
  if (step.type === "annotation") return <AnnotationScreen step={step} src={snapshot.mediaSrc} act={act} audioEnabled={audioEnabled} paused={snapshot.status !== "running"} />;
  if (step.type === "sweep" && step.variant === "breath_hold") return <BreathHoldScreen step={step} act={act} paused={snapshot.status !== "running"} />;
  if (step.type === "bodyscan") return <TimedScreen step={step} snapshot={snapshot} act={act} mode="bodyscan" src={snapshot.mediaSrc} audioEnabled={audioEnabled} />;
  if (step.durationSec) return <TimedScreen step={step} snapshot={snapshot} act={act} mode={step.fixation ? "fixation" : "timer"} src="" audioEnabled={audioEnabled} />;
  return <CenteredInstruction text={step.subjectPrompt || "Please wait."} />;
}

function CenteredInstruction({text}:{text:string}) { return <section className="subject-center subject-enter"><h1>{text}</h1></section>; }

function useRemaining(step:SubjectStep,snapshot:SubjectSnapshot,onDone?:()=>Promise<unknown>,started=true) {
  const [remaining,setRemaining] = useState(step.durationSec ?? 0);
  const lastAttempt = useRef(0);
  useEffect(()=>{
    // A step waiting for Start shows its Start screen instead of a countdown, and must not ask the server to move on.
    if(!started)return;
    const tick=()=>{
      if(snapshot.status !== "running")return;
      const elapsed=(serverNow()-Date.parse(snapshot.stepStartedAt))/1000;
      const value=Math.max(0,(step.durationSec ?? 0)-elapsed);
      setRemaining(value);
      // Keep asking until the server moves on; a dropped request must not leave the subject stuck on a finished timer.
      if(value<=0 && onDone && Date.now()-lastAttempt.current>=1000){lastAttempt.current=Date.now();onDone().catch(()=>undefined);}
    };
    tick(); return startTicker(100,tick);
  },[onDone,snapshot.status,snapshot.stepStartedAt,step.durationSec,started]);
  return remaining;
}

function TimedScreen({step,snapshot,act,mode,src,audioEnabled}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;mode:"timer"|"fixation"|"conversation"|"bodyscan";src:string;audioEnabled:boolean}) {
  const done=useCallback(()=>act("autoAdvance",{expectedStepId:step.id}),[act,step.id]);
  const remaining=useRemaining(step,snapshot,done);
  if(step.bp && !step.bpRecorded && remaining<=0 && snapshot.status==="running") return <BpEntryScreen step={step} act={act} />;
  // Plays once: looping restarted the recording's opening words in the last seconds of the step (2303V84Y).
  if(mode==="bodyscan") return <section className="body-scan">
    {src ? <ProtocolVideo className="body-scan-video" src={src} audioEnabled={audioEnabled} paused={snapshot.status !== "running"} /> : null}
    <div className="body-scan-content"><div className="body-scan-instruction"><h1>Close your eyes and relax.</h1><p>Listen to the guided voice and let your body settle. Keep your eyes closed until the instructor asks you to open them.</p></div><div className="breathing-orb"/><time>{clock(remaining)}</time></div>
  </section>;
  return <section className="subject-center timed-screen">
    {mode==="fixation" ? <div className="fixation" aria-label="Focus on the cross"/> : <h1>{step.subjectPrompt}</h1>}
    {mode==="conversation" || (mode==="timer" && (step.durationSec ?? 0) >= 60) ? <time>{clock(remaining)}</time> : mode!=="fixation" ? <time>{Math.ceil(remaining)}</time> : <small>{Math.ceil(remaining)}</small>}
  </section>;
}

function GateScreen({step,snapshot,act}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const remaining=useRemaining(step,snapshot);
  const [continued,setContinued]=useState(false);
  if(step.bp && !step.bpRecorded && remaining<=0 && snapshot.status==="running") return <BpEntryScreen step={step} act={act} />;
  // After the timer and the reading, the participant moves on themselves rather than waiting for the operator.
  if(remaining<=0) return <section className="subject-center subject-enter"><h1>Thank you.</h1><p className="task-note">When you are ready, press Continue.</p><button className="paper-button" disabled={continued || snapshot.status !== "running"} onClick={()=>{setContinued(true);sendUntilAccepted(()=>act("advance",{expectedStepId:step.id,source:"subject"}));}}>Continue</button></section>;
  return <section className="subject-center timed-screen"><h1>{step.subjectPrompt}</h1><time>{Math.ceil(remaining)}</time></section>;
}

/** The participant reads the cuff monitor and sets the numbers with the mouse; the step moves on once it is saved. */
function BpEntryScreen({step,act}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  // Blank until set: pre-filled 120/80/70 was saved untouched twice in 2303V84Y. The first +/- press starts from those values.
  const [systolic,setSystolic]=useState<number|null>(null);
  const [diastolic,setDiastolic]=useState<number|null>(null);
  const [pulse,setPulse]=useState<number|null>(null);
  const [saved,setSaved]=useState(false);
  const valid=systolic!==null && diastolic!==null && systolic>diastolic;
  const save=()=>{
    if(!valid||saved)return;
    setSaved(true);
    sendUntilAccepted(()=>act("bp",{expectedStepId:step.id,systolic,diastolic,pulse}));
  };
  if(saved) return <section className="subject-center subject-enter"><h1>Saved. Thank you.</h1></section>;
  return <section className="bp-entry subject-enter">
    <p className="rating-count">{step.bpLabel ?? "Blood pressure"}</p>
    <h1>Enter your blood pressure</h1>
    <p className="task-note">Copy the three numbers from the cuff monitor. Use the buttons to change each one.</p>
    <div className="bp-entry-fields">
      <BpStepper label="Systolic (top)" unit="mmHg" value={systolic} onChange={setSystolic} {...BP_LIMITS.systolic} />
      <BpStepper label="Diastolic (bottom)" unit="mmHg" value={diastolic} onChange={setDiastolic} {...BP_LIMITS.diastolic} />
      <BpStepper label="Pulse" unit="per min" value={pulse} onChange={setPulse} {...BP_LIMITS.pulse} />
    </div>
    {systolic===null || diastolic===null ? <p className="bp-entry-warning">Set the top and bottom numbers from the cuff.</p> : !valid ? <p className="bp-entry-warning">The top number must be higher than the bottom number.</p> : null}
    <button className="paper-button bp-entry-save" disabled={!valid} onClick={save}>Save reading</button>
  </section>;
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
  const finish=()=>{if(ended)return;setEnded(true);flashSyncPatch();void log("media_offset",{mediaTimeSec:video.current?.currentTime,durationSec:video.current?.duration});};
  const begin=()=>{beganAt.current=performance.now();setPlaying(true);if(!src){onsetLogged.current=true;void log("media_onset");}};
  // Onset is the first frame actually playing, not the button press.
  const onPlaying=()=>{if(onsetLogged.current)return;onsetLogged.current=true;flashSyncPatch();void log("media_onset",{loadDelayMs:performance.now()-beganAt.current,mediaTimeSec:video.current?.currentTime});};
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

const SAM_DIMENSIONS = [
  {key:"valence",prompt:"Valence (pleasure)",lo:"Unpleasant",hi:"Pleasant"},
  {key:"arousal",prompt:"Arousal (activation)",lo:"Calm",hi:"Excited"},
  {key:"dominance",prompt:"Dominance (control)",lo:"Controlled",hi:"In control"},
] as const;
const sendUntilAccepted=(send:()=>Promise<void>)=>{const attempt=():Promise<void>=>send().catch(()=>{window.setTimeout(()=>void attempt(),1500)});void attempt();};

/** Nine-point SAM, then the main emotion felt with its intensity, then whether the clip was familiar. */
function RatingScreen({step,act}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [stage,setStage]=useState(0); const [emotion,setEmotion]=useState(""); const answers=useRef<Record<string,string|number|null>>({}); const sent=useRef(false);
  const next=(key:string,value:string|number)=>{
    answers.current[key]=value;
    if(key==="discreteEmotion")setEmotion(String(value));
    let following=stage+1;
    if(key==="discreteEmotion"&&value==="Neutral"){answers.current.intensity=null;following+=1;}
    if(following<6){window.setTimeout(()=>setStage(following),180);return;}
    if(sent.current)return;sent.current=true;
    sendUntilAccepted(()=>act("rating",{expectedStepId:step.id,...answers.current}));
  };
  const scale=stage<3||stage===4;
  useEffect(()=>{if(!scale)return;const key=(event:KeyboardEvent)=>{const value=Number(event.key);if(value>=1&&value<=SAM_POINTS)next(stage<3?SAM_DIMENSIONS[stage].key:"intensity",value)};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key)});
  const points=(count:number)=>Array.from({length:count},(_,index)=>index+1);
  if(stage<3){const dim=SAM_DIMENSIONS[stage];return <RatingFrame count={stage+1} prompt={dim.prompt} lo={dim.lo} hi={dim.hi} options={points(SAM_POINTS).map(value=>({label:String(value),value}))} onChoose={value=>next(dim.key,value)} columns={SAM_POINTS} />;}
  if(stage===3)return <RatingFrame count={4} prompt="Which emotion did you mainly feel?" options={DISCRETE_EMOTIONS.map(label=>({label,value:label}))} onChoose={value=>next("discreteEmotion",value)} columns={4} />;
  if(stage===4)return <RatingFrame count={5} prompt={`How strong was that ${emotion.toLowerCase()}?`} lo="Very weak" hi="Very strong" options={points(INTENSITY_POINTS).map(value=>({label:String(value),value}))} onChoose={value=>next("intensity",value)} columns={INTENSITY_POINTS} />;
  return <RatingFrame count={6} prompt="Have you seen this video before?" options={FAMILIARITY.map(label=>({label,value:label}))} onChoose={value=>next("familiarity",value)} columns={3} />;
}

function RatingFrame({count,prompt,lo,hi,options,onChoose,columns}:{count:number;prompt:string;lo?:string;hi?:string;options:Array<{label:string;value:string|number}>;onChoose:(value:string|number)=>void;columns:number}) {
  return <section className="rating-screen subject-enter"><p className="rating-count">{count} / 6</p><h1>{prompt}</h1><div className="rating-options" style={{gridTemplateColumns:`repeat(${columns},1fr)`}} role="radiogroup" aria-label={lo&&hi?`${prompt}, ${lo} to ${hi}`:prompt}>{options.map((option,index)=><button key={option.label} role="radio" aria-checked="false" aria-label={lo&&hi?`${option.label} of ${options.length}${index===0?`, ${lo}`:index===options.length-1?`, ${hi}`:""}`:option.label} onClick={()=>onChoose(option.value)}>{option.label}</button>)}</div>{lo&&hi?<div className="rating-anchors"><span>{lo}</span><span>{hi}</span></div>:null}</section>;
}

/** Balanced Stroop: fixation, word until response or deadline, per-trial logging. Pauses restart the trial clock. */
function StroopTask({step,act,paused}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;paused:boolean}) {
  const [seed]=useState(newSeed); const trials=useMemo(()=>stroopTrials(seededRandom(seed)),[seed]);
  const [started,setStarted]=useState(false); const [index,setIndex]=useState(0); const [showing,setShowing]=useState(false);
  const onset=useRef(0); const responses=useRef<StroopResponse[]>([]); const done=useRef(false);
  const record=(response:string|null,eventTime:number|null)=>{
    if(done.current)return;
    const trial=trials[index];
    const rtMs=response!==null&&eventTime!==null?Math.round(eventTime-onset.current):null;
    responses.current.push({...trial,response,rtMs,correct:response===trial.ink,timedOut:response===null});
    setShowing(false);
    if(index+1<trials.length){setIndex(index+1);return;}
    done.current=true;
    const metadata={seed,...summarizeStroop(responses.current),trialData:responses.current.map(({index:i,word,ink,congruent,response:r,rtMs:rt,correct,timedOut})=>({i,word,ink,congruent,response:r,rtMs:rt,correct,timedOut}))};
    sendUntilAccepted(()=>act("taskComplete",{expectedStepId:step.id,eventType:"stroop_complete",label:"Stroop completed",metadata}));
  };
  useEffect(()=>{
    if(!started||paused||done.current)return;
    if(!showing){const id=window.setTimeout(()=>{onset.current=performance.now();setShowing(true);},STROOP.fixationMs);return()=>clearTimeout(id);}
    // Resuming from a pause restarts the response clock for the visible word.
    onset.current=Math.max(onset.current,performance.now()-1);
    const id=window.setTimeout(()=>record(null,null),STROOP.deadlineMs);
    return()=>clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[started,paused,showing,index]);
  // The deadline is the part participants get wrong on the first trials, so the intro states it before they start.
  if(!started)return <section className="subject-center"><h1>{step.subjectPrompt}</h1><p className="wordlist-intro">{trials.length} words, one at a time. Each one disappears after about {Math.round(STROOP.deadlineMs/1000)} seconds, so answer as quickly as you can and go with your first instinct.</p><button className="paper-button" onClick={()=>setStarted(true)}>Begin</button></section>;
  const trial=trials[index];
  return <section className="task-screen"><div className="stroop-word" style={{color:showing?trial.hex:undefined}}>{showing?trial.word.toUpperCase():"+"}</div><div className="colour-buttons">{TASK_COLOURS.map(colour=><button key={colour.name} style={{background:colour.hex}} disabled={!showing||paused} onClick={event=>record(colour.name,event.timeStamp)}>{colour.name}</button>)}</div></section>;
}

type RecognitionAnswer={word:string;answer:"yes"|"no";rtMs:number|null};

/**
 * Word list: study all ten words for a fixed time, then a yes/no recognition test, one word at a time. The test mixes
 * the studied words with look-alikes and the display is never told which is which; the server scores the answers.
 */
function WordListTask({step,act,paused}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;paused:boolean}) {
  const words=step.words??[]; const testWords=useMemo(()=>step.testWords??[],[step.testWords]);
  const [stage,setStage]=useState<"intro"|"study"|"instructions"|"test"|"sent">("intro");
  const [remainingMs,setRemainingMs]=useState<number>(WORD_LIST.studySec*1000);
  const [index,setIndex]=useState(0); const [showing,setShowing]=useState(false);
  const shownMs=useRef(0); const onset=useRef(0); const answers=useRef<RecognitionAnswer[]>([]); const done=useRef(false);
  useEffect(()=>{
    // Study time only runs while the words are visible: a pause hides them and stops the clock.
    if(stage!=="study"||paused)return;
    let last=performance.now();
    const id=window.setInterval(()=>{
      const now=performance.now(); shownMs.current+=now-last; last=now;
      const left=WORD_LIST.studySec*1000-shownMs.current;
      if(left<=0){window.clearInterval(id);setRemainingMs(0);setStage("instructions");return;}
      setRemainingMs(left);
    },100);
    return()=>window.clearInterval(id);
  },[stage,paused]);
  useEffect(()=>{
    // A short blank between words, then the next word and its response clock.
    if(stage!=="test"||paused||showing)return;
    const id=window.setTimeout(()=>{onset.current=performance.now();setShowing(true);},WORD_LIST.gapMs);
    return()=>window.clearTimeout(id);
  },[stage,paused,showing,index]);
  // Resuming from a pause restarts the response clock for the visible word.
  useEffect(()=>{if(!paused&&showing)onset.current=performance.now();},[paused,showing]);
  const answer=useCallback((value:"yes"|"no",eventTime:number)=>{
    if(stage!=="test"||!showing||paused||done.current)return;
    answers.current.push({word:testWords[index],answer:value,rtMs:Math.round(eventTime-onset.current)});
    setShowing(false);
    if(index+1<testWords.length){setIndex(index+1);return;}
    done.current=true; setStage("sent");
    const metadata={answers:answers.current,studyMs:Math.round(shownMs.current)};
    sendUntilAccepted(()=>act("taskComplete",{expectedStepId:step.id,eventType:WORD_LIST_EVENT,label:"Word list recognition completed",metadata}));
  },[act,index,paused,showing,stage,step.id,testWords]);
  useEffect(()=>{
    if(stage!=="test")return;
    const key=(event:KeyboardEvent)=>{const k=event.key.toLowerCase();if(k==="y")answer("yes",performance.now());if(k==="n")answer("no",performance.now());};
    window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);
  },[answer,stage]);
  if(!words.length||!testWords.length)return <CenteredInstruction text="Please wait." />;
  if(stage==="intro")return <section className="subject-center"><h1>{step.subjectPrompt}</h1><p className="wordlist-intro">You will see {words.length} words for {WORD_LIST.studySec} seconds. Try to remember them.</p><button className="paper-button" onClick={()=>setStage("study")}>Begin</button></section>;
  if(stage==="study")return <section className="task-screen wordlist-study"><ol className="wordlist-words" aria-label="Words to remember">{paused?null:words.map(word=><li key={word}>{word}</li>)}</ol><time className={!paused&&remainingMs<=5000?"low":""}>{paused?"Paused":<>{Math.ceil(remainingMs/1000)}<span>seconds left</span></>}</time></section>;
  if(stage==="instructions")return <section className="subject-center"><h1>Was the word on the list?</h1><p className="wordlist-intro">Words will appear one at a time. Some are from the list and some only look or mean nearly the same. Answer <strong>Yes</strong> only if it is exactly a word you saw. You can also press Y or N.</p><button className="paper-button" onClick={()=>setStage("test")}>Start</button></section>;
  if(stage==="sent")return <section className="subject-center"><h1>Thank you.</h1></section>;
  const visible=showing&&!paused;
  return <section className="task-screen wordlist-test">
    <p className="wordlist-progress">{index+1} of {testWords.length}</p>
    <div className={`wordlist-probe ${visible?"":"blank"}`} aria-live="polite">{visible?testWords[index]:"+"}</div>
    {/* The labels are one word so they can be read at a glance; the full meaning stays on the accessible name. */}
    <div className="wordlist-answers">
      <button className="paper-button wordlist-answer" aria-label="Yes, it was on the list" disabled={!visible} onClick={event=>answer("yes",event.timeStamp)}>YES</button>
      <button className="paper-button wordlist-answer" aria-label="No, it was not on the list" disabled={!visible} onClick={event=>answer("no",event.timeStamp)}>NO</button>
    </div>
  </section>;
}

/** N-back with a short practice block (with feedback) and a pre-generated scored block. */
function NBackTask({step,level,act,paused}:{step:SubjectStep;level:number;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;paused:boolean}) {
  const [stage,setStage]=useState<"intro"|"practice"|"ready"|"main">("intro");
  const [seed]=useState(newSeed); const [lockedLevel,setLockedLevel]=useState(level);
  const [lit,setLit]=useState<number|null>(null); const [feedback,setFeedback]=useState<"good"|"bad"|null>(null);
  const index=useRef(0); const open=useRef<{responded:boolean;rtMs:number|null;onset:number}|null>(null); const records=useRef<NBackTrial[]>([]); const practiceRecords=useRef<NBackTrial[]>([]); const ended=useRef(false);
  const sequences=useMemo(()=>{const random=seededRandom(seed);return {practice:nbackSequence(random,lockedLevel,NBACK.practiceTrials),main:nbackSequence(random,lockedLevel)};},[lockedLevel,seed]);
  useEffect(()=>{
    if((stage!=="practice"&&stage!=="main")||paused)return;
    const practice=stage==="practice"; const sequence=practice?sequences.practice:sequences.main; const target=practice?practiceRecords:records;
    let hideId=0; let feedbackId=0;
    const closeTrial=()=>{
      const trial=open.current; if(!trial)return; open.current=null;
      const at=index.current-1; const isTarget=sequence.targets[at];
      const outcome=nbackOutcome(isTarget,trial.responded,at>=sequence.scoredFrom);
      target.current.push({index:at,position:sequence.positions[at],target:isTarget,responded:trial.responded,rtMs:trial.rtMs,outcome});
      if(practice&&outcome==="miss"){setFeedback("bad");feedbackId=window.setTimeout(()=>setFeedback(null),300);}
    };
    const next=()=>{
      closeTrial();
      if(index.current>=sequence.positions.length){
        index.current=0;
        if(practice){setStage("ready");return;}
        if(!ended.current){ended.current=true;const metadata={seed,...summarizeNBack(lockedLevel,records.current),practice:summarizeNBack(lockedLevel,practiceRecords.current),trialData:records.current};sendUntilAccepted(()=>act("taskComplete",{expectedStepId:step.id,eventType:"nback_complete",label:"N-back completed",metadata}));}
        return;
      }
      open.current={responded:false,rtMs:null,onset:performance.now()};
      setLit(sequence.positions[index.current]);hideId=window.setTimeout(()=>setLit(null),NBACK.stimulusMs);index.current+=1;
    };
    next();const id=window.setInterval(next,NBACK.soaMs);
    return()=>{
      clearInterval(id);clearTimeout(hideId);clearTimeout(feedbackId);setLit(null);
      // A pause discards the trial on screen; it is shown again on resume.
      if(open.current){open.current=null;index.current=Math.max(0,index.current-1);}
    };
  },[act,lockedLevel,paused,seed,sequences,stage,step.id]);
  const press=(eventTime:number)=>{
    const trial=open.current; if(paused||!trial||trial.responded)return;
    trial.responded=true; trial.rtMs=Math.round(eventTime-trial.onset);
    if(stage==="practice"){const good=(stage==="practice"?sequences.practice:sequences.main).targets[index.current-1];setFeedback(good?"good":"bad");window.setTimeout(()=>setFeedback(null),300);}
  };
  if(stage==="intro")return <section className="subject-center"><h1>{step.subjectPrompt}</h1><p className="task-note">N = {level}. First a short practice with feedback.</p><button className="paper-button" onClick={()=>{setLockedLevel(level);setStage("practice");}}>Start practice</button></section>;
  if(stage==="ready")return <section className="subject-center"><h1>Practice complete.</h1><p className="task-note">The task itself has no feedback.</p><button className="paper-button" onClick={()=>setStage("main")}>Begin task</button></section>;
  return <section className={`task-screen ${feedback?`nback-feedback-${feedback}`:""}`}><div className="nback-grid">{Array.from({length:NBACK.positions},(_,i)=><div key={i} className={lit===i?"lit":""}/>)}</div><button className="match-button" onClick={event=>press(event.timeStamp)}>Match</button></section>;
}

/**
 * Box breathing on the same bar the paced-breathing step uses: the marker rises for four seconds, waits at the top
 * for the hold, falls, then waits at the bottom. A hold is a level that stops changing, so the pause is the cue.
 */
/** The screen a breathing step shows until Start is pressed: nothing moves and no time passes until then. */
function BreathingStart({step,snapshot,act,detail}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;detail:string}) {
  const [sending,setSending]=useState(false);
  const start=()=>{setSending(true);act("startTimer",{expectedStepId:step.id}).finally(()=>setSending(false));};
  return <section className="subject-center"><h1>{step.subjectPrompt}</h1><p className="wordlist-intro">{detail} Press Start when you are ready.</p><button className="paper-button" disabled={sending || snapshot.status !== "running"} onClick={start}>Start</button></section>;
}

function BreathingScreen({step,snapshot,act}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const done=useCallback(()=>act("autoAdvance",{expectedStepId:step.id}),[act,step.id]);
  const remaining=useRemaining(step,snapshot,done,step.timerStarted);
  if(!step.timerStarted) return <BreathingStart step={step} snapshot={snapshot} act={act} detail={`Box breathing, ${BOX_BREATHING_ROUNDS} rounds: in, hold, out, hold.`} />;
  const elapsed=(step.durationSec??0)-remaining;
  const phase=Math.floor((elapsed/BOX_BREATHING_PHASE_SEC)%4); const within=(elapsed%BOX_BREATHING_PHASE_SEC)/BOX_BREATHING_PHASE_SEC;
  const label=["Breathe in","Hold","Breathe out","Hold"][phase];
  const level=phase===0?within:phase===1?1:phase===2?1-within:0;
  const round=Math.min(BOX_BREATHING_ROUNDS,Math.floor(elapsed/(BOX_BREATHING_PHASE_SEC*4))+1);
  return <section className="subject-center paced-breathing">
    <h1>{label}</h1>
    <div className="paced-bar" aria-hidden="true"><i style={{height:`${Math.round(8+level*92)}%`}} /></div>
    <small>Round {round} of {BOX_BREATHING_ROUNDS} &middot; {Math.ceil(BOX_BREATHING_PHASE_SEC-(elapsed%BOX_BREATHING_PHASE_SEC))} &middot; {Math.ceil(remaining)}</small>
  </section>;
}

/**
 * Read aloud: one fixed passage, the same for every participant, on one static screen. Nothing scrolls, because
 * this recording is also a camera measurement and head movement is what breaks it. The subject ends the step.
 */
function ReadingScreen({step,act,paused}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;paused:boolean}) {
  const [started,setStarted]=useState(false); const [sent,setSent]=useState(false);
  const start=useRef(0); const doneRef=useRef(false);
  const finish=useCallback((capped:boolean)=>{
    if(doneRef.current)return; doneRef.current=true; setSent(true);
    const readingMs=Math.round(performance.now()-start.current);
    sendUntilAccepted(()=>act("taskComplete",{expectedStepId:step.id,eventType:READING_EVENT,label:capped?"Reading stopped at the time limit":"Passage read aloud",metadata:{readingMs,words:READING_WORDS,capped,maxSec:READING_MAX_SEC}}));
  },[act,step.id]);
  useEffect(()=>{
    if(!started||paused||doneRef.current)return;
    start.current=performance.now();
    const id=window.setTimeout(()=>finish(true),READING_MAX_SEC*1000);
    return()=>window.clearTimeout(id);
  },[started,paused,finish]);
  if(sent)return <section className="subject-center"><h1>Thank you.</h1></section>;
  if(!started)return <section className="subject-center"><h1>{step.subjectPrompt}</h1><p className="wordlist-intro">The passage stays on the screen while you read. Read it once, aloud, at your normal speaking pace, then press Done.</p><button className="paper-button" disabled={paused} onClick={()=>setStarted(true)}>Begin</button></section>;
  return <section className="task-screen reading-screen">
    <p className="reading-passage">{READING_PASSAGE}</p>
    <button className="paper-button" disabled={paused} onClick={()=>finish(false)}>Done</button>
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
function BreathHoldScreen({step,act,paused}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;paused:boolean}) {
  const [holding,setHolding]=useState(false);const [elapsed,setElapsed]=useState(0);const start=useRef(0);const releasedRef=useRef(false);const [released,setReleased]=useState(false);
  const release=useCallback((durationSec:number,capped:boolean)=>{
    if(releasedRef.current)return;releasedRef.current=true;setReleased(true);
    const metadata={durationSec:Number(durationSec.toFixed(1)),capped,maxSec:BREATH_HOLD_MAX_SEC};
    sendUntilAccepted(()=>act("taskComplete",{expectedStepId:step.id,eventType:"breath_hold_complete",label:capped?"Breath hold stopped at the time limit":"Breath hold completed",metadata}));
  },[act,step.id]);
  useEffect(()=>{if(!holding)return;start.current=performance.now();const id=window.setInterval(()=>{const value=(performance.now()-start.current)/1000;setElapsed(Math.min(value,BREATH_HOLD_MAX_SEC));if(value>=BREATH_HOLD_MAX_SEC)release(BREATH_HOLD_MAX_SEC,true);},100);return()=>clearInterval(id)},[holding,release]);
  // A pause (including "I need to stop") ends the hold immediately.
  useEffect(()=>{if(paused&&holding)release((performance.now()-start.current)/1000,false);},[paused,holding,release]);
  if(released)return <section className="subject-center breath-hold"><h1>Breathe normally.</h1></section>;
  return <section className="subject-center breath-hold"><h1>{step.subjectPrompt}</h1>{holding?<><time>{elapsed.toFixed(1)}</time><button className="paper-button" onClick={()=>release((performance.now()-start.current)/1000,false)}>Release</button></>:<button className="paper-button" disabled={paused} onClick={()=>setHolding(true)}>I am ready</button>}</section>;
}

function clock(value:number){const n=Math.max(0,Math.ceil(value));return`${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`}

/** One item at a time; the subject can go back before submitting. */
function QuestionnaireScreen({step,act,paused}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;paused:boolean}) {
  const questionnaire=QUESTIONNAIRES[step.questionnaireId ?? ""];
  const [index,setIndex]=useState(0); const [answers,setAnswers]=useState<Record<string,number>>({}); const [sent,setSent]=useState(false);
  if(!questionnaire) return <CenteredInstruction text="Please wait." />;
  if(sent) return <CenteredInstruction text="Thank you." />;
  const item=questionnaire.items[index]; const {scale}=questionnaire;
  const values=Array.from({length:scale.points},(_,point)=>scale.min+point*scale.step);
  const choose=(value:number)=>{
    if(paused)return;
    const next={...answers,[item.id]:value}; setAnswers(next);
    if(index+1<questionnaire.items.length){window.setTimeout(()=>setIndex(index+1),150);return;}
    setSent(true);
    sendUntilAccepted(()=>act("questionnaire",{expectedStepId:step.id,answers:next}));
  };
  const low=item.lowLabel ?? scale.lowLabel; const high=item.highLabel ?? scale.highLabel; const dense=scale.points>10;
  return <section className="rating-screen questionnaire-screen subject-enter"><p className="rating-count">{index+1} / {questionnaire.items.length}</p><p className="task-note">{index===0?questionnaire.instructions:questionnaire.title}</p><h1>{item.text}</h1><div className={`rating-options ${dense?"dense":""}`} style={{gridTemplateColumns:`repeat(${scale.points},1fr)`}} role="radiogroup" aria-label={`${item.text}, ${low} to ${high}`}>{values.map((value,point)=><button key={value} role="radio" aria-checked={answers[item.id]===value} className={answers[item.id]===value?"chosen":""} disabled={paused} aria-label={scale.labels?.[point] ?? `${value} of ${scale.min+(scale.points-1)*scale.step}`} title={scale.labels?.[point]} onClick={()=>choose(value)}>{dense?"":scale.labels?point+1:value}</button>)}</div><div className="rating-anchors"><span>{low}</span><span>{high}</span></div>{index>0?<button className="paper-button questionnaire-back" disabled={paused} onClick={()=>setIndex(index-1)}>Back</button>:null}</section>;
}

/** Breathing guide at a fixed rate with equal inhale and exhale, driven by the server-corrected step clock. */
function PacedBreathingScreen({step,snapshot,act}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const done=useCallback(()=>act("autoAdvance",{expectedStepId:step.id}),[act,step.id]);
  const remaining=useRemaining(step,snapshot,done,step.timerStarted);
  if(!step.timerStarted) return <BreathingStart step={step} snapshot={snapshot} act={act} detail={`${step.breathsPerMin} breaths per minute for ${clock(step.durationSec ?? 0)}.`} />;
  const cycle=60/(step.breathsPerMin ?? 10); const elapsed=(step.durationSec ?? 0)-remaining; const phase=(elapsed%cycle)/cycle;
  const level=phase<0.5?phase*2:(1-phase)*2; const inhaling=phase<0.5;
  return <section className="subject-center paced-breathing"><h1>{inhaling?"Breathe in":"Breathe out"}</h1><div className="paced-bar" aria-hidden="true"><i style={{height:`${Math.round(8+level*92)}%`}} /></div><small>{step.breathsPerMin} breaths per minute · {Math.ceil(remaining)}</small></section>;
}

/**
 * Continuous valence (left to right) and arousal (bottom to top) while the clip replays. The marker position is
 * sampled every 50 ms with the server-corrected clock and sent in 2 s chunks that are retried until stored.
 */
function AnnotationScreen({step,src,act,audioEnabled,paused}:{step:SubjectStep;src:string;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;audioEnabled:boolean;paused:boolean}) {
  const [playing,setPlaying]=useState(false); const [ended,setEnded]=useState(false); const [marker,setMarker]=useState({valence:0,arousal:0});
  const markerRef=useRef(marker); const onsetLogged=useRef(false); const video=useRef<HTMLVideoElement>(null); const grid=useRef<HTMLDivElement>(null);
  const buffer=useRef<number[][]>([]); const chunk=useRef(0); const outbox=useRef<Array<{chunk:number;samples:number[][]}>>([]);
  const move=(valence:number,arousal:number)=>{const next={valence:Math.max(-1,Math.min(1,valence)),arousal:Math.max(-1,Math.min(1,arousal))};markerRef.current=next;setMarker(next);};
  const fromPointer=(event:React.PointerEvent<HTMLDivElement>)=>{const box=grid.current?.getBoundingClientRect();if(!box||event.buttons===0&&event.type!=="pointerdown")return;move(((event.clientX-box.left)/box.width)*2-1,1-((event.clientY-box.top)/box.height)*2);};
  const flush=useCallback(()=>{
    if(buffer.current.length){outbox.current.push({chunk:chunk.current,samples:buffer.current});chunk.current+=1;buffer.current=[];}
    const pending=[...outbox.current];
    return Promise.all(pending.map((item)=>act("annotationChunk",{expectedStepId:step.id,...item}).then(()=>{outbox.current=outbox.current.filter((entry)=>entry!==item);}).catch(()=>undefined)));
  },[act,step.id]);
  useEffect(()=>{if(!playing||ended||paused)return;const sample=window.setInterval(()=>{if(onsetLogged.current)buffer.current.push([Math.round(serverNow()),markerRef.current.valence,markerRef.current.arousal]);},50);const send=window.setInterval(()=>void flush(),2000);return()=>{clearInterval(sample);clearInterval(send);};},[ended,flush,paused,playing]);
  useEffect(()=>{if(!ended)return;let stopped=false;const finish=async()=>{await flush();if(outbox.current.length&&!stopped){window.setTimeout(()=>void finish(),1500);return;}sendUntilAccepted(()=>act("advance",{expectedStepId:step.id,source:"subject"}));};void finish();return()=>{stopped=true;};},[act,ended,flush,step.id]);
  useEffect(()=>{const element=video.current;if(!element||!onsetLogged.current||ended)return;if(paused)element.pause();else void element.play().catch(()=>undefined);},[ended,paused]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{const delta=0.1;const {valence,arousal}=markerRef.current;if(event.key==="ArrowLeft")move(valence-delta,arousal);if(event.key==="ArrowRight")move(valence+delta,arousal);if(event.key==="ArrowUp")move(valence,arousal+delta);if(event.key==="ArrowDown")move(valence,arousal-delta);};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[]);
  const onPlaying=()=>{if(onsetLogged.current)return;onsetLogged.current=true;flashSyncPatch();void act("log",{expectedStepId:step.id,eventType:"media_onset",metadata:{clientTime:serverIso(),mediaTimeSec:video.current?.currentTime}}).catch(()=>undefined);};
  const onEnded=()=>{if(ended)return;flashSyncPatch();void act("log",{expectedStepId:step.id,eventType:"media_offset",metadata:{clientTime:serverIso(),mediaTimeSec:video.current?.currentTime}}).catch(()=>undefined);setEnded(true);};
  if(!playing) return <section className="subject-center clip-ready"><h1>{step.subjectPrompt}</h1><p className="task-note">Left to right: unpleasant to pleasant. Bottom to top: calm to excited. Drag the marker, or use the arrow keys.</p><button className="light-button" disabled={paused} onClick={()=>setPlaying(true)}>Begin</button></section>;
  return <section className="annotation-screen">
    {/* Registered protocol stimuli intentionally omit captions, which would alter the research material. */}
    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
    <video ref={video} className="annotation-video" src={mediaUrl(src)} autoPlay playsInline muted={!audioEnabled} onPlaying={onPlaying} onEnded={onEnded} />
    <div ref={grid} className="annotation-grid" role="slider" tabIndex={0} aria-label="Valence and arousal" aria-valuemin={-1} aria-valuemax={1} aria-valuenow={Number(marker.valence.toFixed(2))} aria-valuetext={`valence ${marker.valence.toFixed(1)}, arousal ${marker.arousal.toFixed(1)}`} onPointerDown={fromPointer} onPointerMove={fromPointer}>
      <span className="axis top">Excited</span><span className="axis bottom">Calm</span><span className="axis left">Unpleasant</span><span className="axis right">Pleasant</span>
      <i style={{left:`${(marker.valence+1)*50}%`,top:`${(1-marker.arousal)*50}%`}} />
    </div>
  </section>;
}
