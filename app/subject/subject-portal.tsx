"use client";

import {createPortal} from "react-dom";
import {SubjectCopySlot,SubjectFrame} from "./subject-frame";
import {ConsentForm, FeedbackForm} from "./participation-forms";
import {NBackTask} from "./nback-task";
import {StudyPlayer} from "./study-player";
import {SpeakingPrompt} from "./speaking-prompt";
import {COLOURS, makeStroopTrials} from "@/lib/stroop";
import {SubjectRecorder,useStation} from "./subject-station";
import { ArrowUpRight } from "lucide-react";
import {PortalHeader} from "../portal-header";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
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
  const [moving,setMoving] = useState(false);
  const movementPending = useRef(false);
  const activeCode = useRef("");
  const cueAudio=useRef<AudioContext|null>(null);
  const previousStep=useRef<SubjectStep|null>(null);
  useEffect(()=>{
    const unlock=()=>{try{cueAudio.current??=new AudioContext();void cueAudio.current.resume().catch(()=>{});}catch{/* Audio may be unavailable. */}};
    window.addEventListener("click",unlock,{once:true});
    return ()=>{window.removeEventListener("click",unlock);void cueAudio.current?.close().catch(()=>{});cueAudio.current=null;};
  },[]);
  useEffect(()=>{
    const current=snapshot?.step, last=previousStep.current;
    previousStep.current=current??null;
    if(!current || !last || current.id===last.id || snapshot?.status!=="running" || !audioEnabled ||
       !(last.type==="baseline"&&!last.fixation || last.type==="bodyscan"))return;
    const ctx=cueAudio.current;if(!ctx||ctx.state!=="running")return;
    const tone=ctx.createOscillator(),gain=ctx.createGain(),t=ctx.currentTime;
    tone.frequency.value=440;gain.gain.setValueAtTime(0,t);gain.gain.linearRampToValueAtTime(.06,t+.04);gain.gain.linearRampToValueAtTime(0,t+.32);
    tone.connect(gain);gain.connect(ctx.destination);tone.start(t);tone.stop(t+.33);
  },[snapshot?.step,snapshot?.status,audioEnabled]);

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

  const ignoredStation=useRef("");
  const knownStatus=useRef<SubjectSnapshot["status"]|null>(null);
  const awaitingFeedback=Boolean(snapshot?.feedbackStage && snapshot.feedbackStage!=="none");
  useEffect(()=>{knownStatus.current=awaitingFeedback?"running":snapshot?.status??null;},[snapshot?.status,awaitingFeedback]);
  const onAssignment=useCallback((assigned:string,enrolling:boolean)=>{
    if(assigned===activeCode.current || (!enrolling && ignoredStation.current===assigned))return;
    // Never move a participant out of a running activity to another session.
    if(!enrolling && activeCode.current && ["running","paused"].includes(knownStatus.current??""))return;
    selectCode(assigned);
  },[selectCode]);
  const station=useStation(onAssignment);
  useEffect(() => {
    if(new URLSearchParams(location.hash.slice(1)).has("invite"))return;
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
  const act = useCallback(async (action:string,payload:Record<string,unknown>={}) => {
    if(!code)return;
    const requestedCode=code;
    const next=await sessionRequest(requestedCode,action,payload);
    if(activeCode.current===requestedCode)acceptSnapshot(next);
    if(action==="subjectBeginTask" && next.awaitingTaskStart)throw new Error("Could not start the activity. Try again when recording is ready.");
    if(["rating","taskComplete","autoAdvance","advance"].includes(action)&&next.step?.id===payload.expectedStepId)throw new Error("The session paused or changed before saving. Retry when the instructor resumes.");
  },[acceptSnapshot,code]);
  useEffect(()=>{if(!code||snapshot?.status==="complete"||snapshot?.status==="aborted")return;const requestedCode=code;const beat=()=>sessionRequest(requestedCode,"subjectHeartbeat").then(next=>{if(activeCode.current===requestedCode)acceptSnapshot(next)}).catch(()=>undefined);const first=window.setTimeout(beat,0);const id=window.setInterval(beat,5000);return()=>{clearTimeout(first);clearInterval(id)}},[acceptSnapshot,code,snapshot?.status]);
  useEffect(()=>{
    if(!snapshot||awaitingFeedback||snapshot.selfGuided||!["complete","aborted"].includes(snapshot.status))return;
    let cancelled=false;
    const follow=()=>participantSessionRequest(snapshot.participantId).then(next=>{if(!cancelled&&next.code!==snapshot.code)connectSnapshot(next)}).catch(()=>undefined);
    const first=window.setTimeout(follow,0);const id=window.setInterval(follow,1200);
    return()=>{cancelled=true;clearTimeout(first);clearInterval(id)};
  },[connectSnapshot,snapshot,awaitingFeedback]);
  const changeSession = useCallback(() => { ignoredStation.current=activeCode.current;window.localStorage.removeItem("meridian.subject.code");window.history.replaceState(null,"","/subject");activeCode.current="";setSnapshot(null);setDraft("");setError("");setCode(""); },[]);

  const endSession=snapshot && ["setup","running","paused"].includes(snapshot.status)?()=>{
    const preparing=snapshot.status==="setup";
    if(window.confirm(preparing?"End this session before recording starts?":"End your session now? Recording will stop and saved responses will be kept."))
      void act("subjectEnd").catch(()=>window.alert("Could not end this session. Please try again."));
  }:undefined;
  const switchDisplay=()=>{
    if(snapshot && ["running","paused"].includes(snapshot.status) && !window.confirm("Leave this display to join another session? This does not end the current session."))return;
    changeSession();
  };
  const submit = async () => {
    const value=draft.trim().toUpperCase();if(!value)return;
    setConnecting(true);setError("");
    try {
      if(/^\d+$/.test(value))connectSnapshot(await participantSessionRequest(Number(value)));
      else connectSnapshot(await sessionRequest(value));
    } catch(err) { setError(err instanceof Error?err.message:"Unable to connect."); }
    finally { setConnecting(false); }
  };

  if (station.invite) return <main className="recorder-pair"><h1>Pair this subject computer?</h1><p>Use the lab computer connected to the sensors. This browser will remember the instructor station and join its next studies. Pairing does not start a recording.</p><button className="wizard-primary" disabled={station.busy} onClick={()=>void station.enroll()}>{station.busy?"Pairing…":"Pair this subject computer"}</button>{station.issue?<p role="alert">{station.issue}</p>:null}</main>;
  if (!code) return <SubjectConnect draft={draft} error={station.issue || error} connecting={connecting} setDraft={setDraft} submit={submit} />;
  if (!snapshot) return <SubjectFrame code={code} progress={0} label="Session connection" title={<>Please wait.<br /><i>Connecting.</i></>} description={error || "The study will appear here when the connection is ready."} audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={switchDisplay} endSession={endSession}><QuietField /></SubjectFrame>;

  const step = snapshot.step;
  const progress = snapshot.stepCount ? Math.round(((snapshot.stepIndex + .35) / snapshot.stepCount) * 100) : 0;
  if(snapshot.status==="setup" && !snapshot.consentGiven)return <SubjectFrame code={code} progress={0} label="Before recording" title={<>Your<br/><i>permission.</i></>} description="Taking part is voluntary. You can decline now or stop during the study." audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={switchDisplay} endSession={endSession}>
    <ConsentForm key={code+snapshot.consentSources.join(",")} sources={snapshot.consentSources} act={act}/></SubjectFrame>;
  if(snapshot.feedbackStage==="stopping")return <SubjectFrame code={code} progress={100} label="Finishing up" title={<>Stopping the<br/><i>recording.</i></>} description="Keep this page open while the recorder finishes." audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={switchDisplay} endSession={endSession}><QuietField/></SubjectFrame>;
  if(snapshot.feedbackStage==="open")return <SubjectFrame code={code} progress={100} label="Recording stopped" title={<>How did<br/><i>it go?</i></>} description="Your feedback is optional. You can answer either question or skip both." audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={switchDisplay} endSession={endSession}><FeedbackForm key={code} act={act}/></SubjectFrame>;
  if (snapshot.status === "aborted") return <SubjectFrame code={snapshot.code} progress={progress} label="Session ended" title="Session ended." description="There are no more activities." audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={switchDisplay} endSession={endSession}><QuietField /></SubjectFrame>;
  if (!step || snapshot.status === "complete" || step.type === "end") return <SubjectFrame code={snapshot.code} progress={100} label="Session complete" title="Thank you." description="You have finished the study. You can leave this screen." audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={switchDisplay} endSession={endSession}><QuietField complete /></SubjectFrame>;
  if(snapshot.status==="setup" && !snapshot.recorderOnline && !snapshot.canStartRecording){
    const trusted=station.assigned===code;
    return <SubjectFrame code={code} progress={0} label="Before you begin" title={trusted?"Connect this computer.":"Preparing this computer."} description={trusted?"The recorder connects the sensors on this computer to your study. Starting the study is a separate step.":"Open the subject invitation from Recording setup on the computer connected to the sensors."} audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={switchDisplay} endSession={endSession}>
      {trusted?<SubjectRecorder key={code} code={code}/>:<QuietField/>}</SubjectFrame>;
  }
  if (snapshot.selfGuided && snapshot.status === "setup") return <SubjectFrame code={code} progress={0} label="Before you begin" title={snapshot.canStartRecording?"Ready to begin.":"Getting ready."} description={snapshot.canStartRecording?"Starting will record this session. Follow one activity at a time. You can end your session at any point.":"Keep this page open while the recording equipment is prepared."} audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={switchDisplay} endSession={endSession}>{snapshot.canStartRecording?<ActionButton label="Start recording" run={()=>act("subjectStart")}/>:<QuietField/>}</SubjectFrame>;
  if (!snapshot.selfGuided && (snapshot.status === "setup" || !snapshot.operatorConnected || !snapshot.acquisitionReady)) return <SubjectFrame code={snapshot.code} progress={progress} label="Study preparation" title={<>Please wait.<br /><i>We will begin shortly.</i></>} description="There is nothing you need to do yet." audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={switchDisplay} endSession={endSession}><QuietField /></SubjectFrame>;

  const presentation = subjectPresentation(step);
  const blocked=snapshot.status!=="running" || Boolean(snapshot.announcement) || !snapshot.acquisitionReady;
  const move = async (direction:number) => {
    if (movementPending.current || !window.confirm("Go back? The previous task will restart. Saved responses remain in the study record; unfinished responses on this screen will be lost.")) return;
    movementPending.current=true;setMoving(true);
    try { await act("subjectNavigate",{direction,expectedStepId:step.id,expectedStepStartedAt:snapshot.stepStartedAt,expectedAttempt:snapshot.attempt});setError(""); }
    catch(reason){setError(reason instanceof Error ? reason.message : "Could not change tasks. Try again.");}
    finally {movementPending.current=false;setMoving(false);}
  };
  return <SubjectFrame code={snapshot.code} progress={progress} label={presentation.label} showLabel={false} title={presentation.title} description={step.type==="baseline" && !step.fixation ? (audioEnabled?"Close your eyes and breathe naturally. A tone marks the end.":"Close your eyes and breathe naturally for about 90 seconds, then open them.") :step.type==="sam"?"Rate how you felt during the last clip.":step.type === "nback" ? "Keep track of the positions, not the colour. Use Match only when the position repeats at the right distance." : step.subjectPrompt || presentation.description} audioEnabled={audioEnabled} setAudioEnabled={setAudioEnabled} changeSession={switchDisplay} endSession={endSession}>
    {error ? <p className="subject-request-error" role="alert">{error} Your task has not been discarded.</p> : null}
    {snapshot.status === "running" && !snapshot.acquisitionReady ? <div className="subject-overlay" role="status"><p>Waiting for the recording connection. Keep this page open.</p></div> : null}
    {snapshot.status === "paused" ? <div className="subject-overlay"><p>{step.safety?"Stop the movement and breathe normally. The activity is paused.":snapshot.announcement?.text || "Recording paused. Your activity will continue when the connection returns."}</p></div> : null}
    {snapshot.status !== "paused" && snapshot.announcement ? <div className="subject-overlay announcement" role="alert"><p>{snapshot.announcement.text}</p><button className="paper-button" onClick={()=>act("ack")}>Understood</button></div> : null}
    {!snapshot.selfGuided && step.safety && snapshot.status === "running" ? <button className="safety-stop" onClick={()=>act("pause",{reason:"Subject requested a stop",source:"subject"})}>I need to stop</button> : null}
    <div inert={blocked} className={`live-subject-task task-${step.type}`}><StepView key={`${step.id}-${snapshot.attempt}`} step={step} snapshot={snapshot} act={act} audioEnabled={audioEnabled} onAudioChange={setAudioEnabled} /></div>
    {!snapshot.selfGuided && <nav className="subject-task-navigation" aria-label="Task navigation">
      <button disabled={moving || !snapshot.canGoBack || Boolean(snapshot.announcement)} onClick={()=>void move(-1)}>Previous task</button>
      {step.type === "gate" || step.type === "setup" ? <small>The instructor will continue when checks are complete.</small> : null}
    </nav>}
  </SubjectFrame>;
}

function ActionButton({label,run,disabled=false}:{label:string;run:()=>Promise<void>;disabled?:boolean}) {
  const lock=useRef(false); const [busy,setBusy]=useState(false); const [failed,setFailed]=useState(false);
  return <div className="guided-action"><button className="paper-button" disabled={busy||disabled} onClick={async()=>{
    if(lock.current)return;lock.current=true;setBusy(true);setFailed(false);
    try{await run();}catch{setFailed(true);}finally{lock.current=false;setBusy(false);}
  }}>{busy?(label==="Start task"?"Starting…":"Saving…"):label}</button>{failed?<p role="alert">Could not continue. Check the connection and try again.</p>:null}</div>;
}

function TaskStart({run,active,label="Start task"}:{run:()=>Promise<void>;active:boolean;label?:string}) {
  const slot=useContext(SubjectCopySlot);
  return slot && createPortal(<div className="task-start-action"><ActionButton label={label} run={run} disabled={!active}/></div>,slot);
}

function SubjectConnect({draft,error,connecting,setDraft,submit}:{draft:string;error:string;connecting:boolean;setDraft:(value:string)=>void;submit:()=>Promise<void>}) {
  return <main className="live-entry">
    <PortalHeader role="Subject"/>
    <section className="portal-entry-form">
      <form onSubmit={event=>{event.preventDefault();void submit();}}>
        <h1>Join your session.</h1>
        <label htmlFor="session-code">Session code or participant ID</label>
        <input id="session-code" value={draft} onChange={event=>setDraft(event.target.value.toUpperCase())} autoComplete="off" autoCapitalize="characters" maxLength={12} placeholder="0009AB7K"/>
        {error && <p className="live-entry-error" role="alert">{error}</p>}
        <button type="submit" disabled={connecting || !draft.trim()}>{connecting?"CONNECTING":"CONNECT"}<ArrowUpRight size={16}/></button>
      </form>
      <details className="entry-lab-setup">
        <summary>First-time lab setup</summary>
        <p>Open the instructor’s private invitation on this computer to pair its browser. You can install the recorder before the study.</p>
        <a download href="/recorder-tools/MeridianRecorderSetup.exe">Install recorder for Windows (64-bit)</a>
      </details>
    </section>
  </main>;
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
  if(step.type==="setup") return {label:"Getting settled",title:"Before the first activity",description:step.subjectPrompt};
  if(step.type==="gate") return {label:"Quiet rest",title:"Rest a moment.",description:step.subjectPrompt};
  if(step.type==="baseline") return {label:"Quiet rest",title:"Rest your eyes.",description:step.subjectPrompt};
  if(step.type==="sweep" && !step.variant) return {label:"Movement",title:"Follow the instruction.",description:step.subjectPrompt};
  if(step.type==="sweep") return {label:"Breathing task",title:<>Breathe<br/><i>with the guide.</i></>,description:"Follow the guide at a comfortable pace."};
  return {label:"Current task",title:<>A moment<br/><i>of attention.</i></>,description:"Follow the instruction shown on the screen."};
}

function StepView({step,snapshot,act:request,audioEnabled,onAudioChange}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(action:string,payload?:Record<string,unknown>)=>Promise<void>;onAudioChange:(enabled:boolean)=>void;audioEnabled:boolean}) {
  const act = useCallback((action:string,payload:Record<string,unknown>={})=>request(action,{...payload,expectedStepId:step.id,expectedStepStartedAt:snapshot.stepStartedAt,expectedAttempt:snapshot.attempt}),[request,step.id,snapshot.stepStartedAt,snapshot.attempt]);
  const active=snapshot.status==="running" && snapshot.acquisitionReady && !snapshot.announcement;
  if(snapshot.awaitingTaskStart)return <section className="subject-center timed-screen">
    <TaskStart active={active} run={()=>act("subjectBeginTask")}/>
    <time aria-label="Task duration">{clock(step.durationSec??0)}</time>
    {step.safety && <p>Only begin if you feel comfortable.</p>}
  </section>;
  if (snapshot.selfGuided && step.type==="setup") return <ActionButton label="Begin first activity" run={()=>act("advance",{source:"subject"})}/>;
  if (step.type === "setup") return <CenteredInstruction text={step.subjectPrompt} />;
  if (step.type === "clip") return <ClipScreen active={snapshot.status==="running" && snapshot.acquisitionReady && !snapshot.announcement} step={step} src={snapshot.mediaSrc} act={act} audioEnabled={audioEnabled} onAudioChange={onAudioChange} />;
  if (step.type === "sam") return <RatingScreen step={step} act={act} />;
  if (step.type === "washout") return <WashoutScreen step={step} snapshot={snapshot} act={act} />;
  if (step.type === "stroop") return <StroopTask step={step} act={act} active={active} />;
  if (step.type === "nback") return <NBackTask step={step} level={snapshot.nbackLevel} active={snapshot.status === "running" && snapshot.acquisitionReady && !snapshot.announcement} act={act} />;
  if (step.type === "conversation") return <TimedScreen step={step} snapshot={snapshot} act={act} mode="conversation" src="" audioEnabled={audioEnabled} onAudioChange={onAudioChange} />;
  if (step.type === "gate") return <GateScreen step={step} snapshot={snapshot} proceed={()=>act("advance",{source:"subject"})} />;
  if (step.type === "sweep" && step.variant === "box_breathing") return <BreathingScreen step={step} snapshot={snapshot} act={act} src={snapshot.mediaSrc} audioEnabled={audioEnabled} onAudioChange={onAudioChange} />;
  if (step.type === "sweep" && step.variant === "breath_hold") return <BreathHoldScreen active={active} key={snapshot.status+(snapshot.announcement?.id??"")} step={step} act={act} />;
  if (step.type === "bodyscan") return <TimedScreen step={step} snapshot={snapshot} act={act} mode="bodyscan" src={snapshot.mediaSrc} audioEnabled={audioEnabled} onAudioChange={onAudioChange} />;
  if (step.durationSec) return <TimedScreen step={step} snapshot={snapshot} act={act} mode={step.fixation ? "fixation" : "timer"} src="" audioEnabled={audioEnabled} onAudioChange={onAudioChange} />;
  return <CenteredInstruction text={step.subjectPrompt || "Please wait."} />;
}

function CenteredInstruction({text}:{text:string}) { return <section className="subject-center subject-enter"><h1>{text}</h1></section>; }

function useRemaining(step:SubjectStep,snapshot:SubjectSnapshot,onDone?:()=>Promise<void>) {
  const [remaining,setRemaining] = useState(step.durationSec ?? 0);
  const fired = useRef(false);
  useEffect(()=>{
    const tick=()=>{
      if(snapshot.status !== "running" || snapshot.announcement || !snapshot.acquisitionReady)return;
      const elapsed=(Date.now()-Date.parse(snapshot.stepStartedAt))/1000;
      const value=Math.max(0,(step.durationSec ?? 0)-elapsed);
      setRemaining(value);
      if(value<=0 && !fired.current && onDone){fired.current=true;void onDone().catch(()=>{window.setTimeout(()=>{fired.current=false;},1200);});}
    };
    tick(); const id=window.setInterval(tick,100); return()=>clearInterval(id);
  },[onDone,snapshot.status,snapshot.stepStartedAt,snapshot.announcement,snapshot.acquisitionReady,step.durationSec]);
  return remaining;
}

function TimedScreen({step,snapshot,act,mode,src,audioEnabled,onAudioChange}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;mode:"timer"|"fixation"|"conversation"|"bodyscan";src:string;onAudioChange:(enabled:boolean)=>void;audioEnabled:boolean}) {
  const done=useCallback(()=>act("autoAdvance",{expectedStepId:step.id}),[act,step.id]);
  const remaining=useRemaining(step,snapshot,done);
  if(mode==="conversation") return <SpeakingPrompt elapsedSeconds={(step.durationSec ?? 0)-remaining}/>;
  if(mode==="bodyscan") {
    const guide=<div className="body-scan-content"><div className="breathing-orb"/><time>{clock(remaining)}</time></div>;
    return <section className="body-scan">{src?<StudyPlayer className="body-scan-video" src={src} aria-label="Guided body scan video"
      active={snapshot.status==="running" && snapshot.acquisitionReady && !snapshot.announcement} onAudioChange={onAudioChange} autoPlay muted={!audioEnabled} loop>{guide}</StudyPlayer>:guide}</section>;
  }
  return <section className={`subject-center timed-screen ${mode==="fixation"?"fixation-screen":""}`}>
    {mode==="fixation" && <div className="fixation" aria-label="Focus on the cross"/>}
    <time className={mode==="fixation"?"task-countdown":undefined} aria-label="Time remaining">{clock(remaining)}</time>
  </section>;
}

function GateScreen({step,snapshot,proceed}:{step:SubjectStep;snapshot:SubjectSnapshot;proceed:()=>Promise<void>}) {
  const remaining=useRemaining(step,snapshot);
  if(snapshot.selfGuided)return <section className="subject-center timed-screen">{remaining>0?<time aria-label="Rest time remaining">{clock(remaining)}</time>:<ActionButton label="I’m ready to continue" run={proceed}/>}</section>;
  return <section className="subject-center timed-screen"><h1>{remaining>0 ? step.subjectPrompt : "Please wait."}</h1>{remaining>0 ? <time>{Math.ceil(remaining)}</time> : null}</section>;
}

function WashoutScreen({step,snapshot,act}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const done=useCallback(()=>act("autoAdvance",{expectedStepId:step.id}),[act,step.id]);
  const remaining=useRemaining(step,snapshot,done);
  return <section className="washout-screen"><div className="washout-cross"/><time className="task-countdown" aria-label="Time remaining">{clock(remaining)}</time></section>;
}

function ClipScreen({step,src,act,audioEnabled,active,onAudioChange}:{step:SubjectStep;src:string;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;onAudioChange:(enabled:boolean)=>void;audioEnabled:boolean;active:boolean}) {
  const video=useRef<HTMLVideoElement>(null), onset=useRef(false), saving=useRef(false);
  const [state,setState]=useState<"ready"|"playing"|"ended"|"error">("ready");
  const [failure,setFailure]=useState("");
  const finish=async()=>{
    if(saving.current)return;saving.current=true;setFailure("");setState("ended");
    try{await act("advance",{source:"subject",expectedStepId:step.id});}
    catch{setFailure("The clip has finished. Retry to save and continue.");}
    finally{saving.current=false;}
  };
  const play=async()=>{
    try{
      if(!video.current || !src)throw new Error();
      if(state==="error")video.current.load();
      await video.current.play();
    }catch{setState("error");}
  };
  return <section className="subject-center clip-ready">
    <StudyPlayer videoRef={video} className="stimulus-video" aria-label="Study clip" hidden={state!=="playing"}
      src={src||undefined} active={active} muted={!audioEnabled} onAudioChange={onAudioChange}
      onPlaying={()=>{setState("playing");if(!onset.current){onset.current=true;void act("log",{eventType:"media_onset"}).catch(()=>{});}}}
      onSeeked={e=>{if(onset.current)void act("log",{eventType:"media_seek",positionSec:e.currentTarget.currentTime}).catch(()=>{});}}
      onEnded={()=>void finish()}
      onError={()=>{setState("error");void act("log",{eventType:"media_error"}).catch(()=>{});}}/>
    {state==="ready"||state==="error"?<>{state==="error"?<p role="alert">The clip could not play. Check the connection and retry.</p>:null}<TaskStart active={active} run={play} label={state==="error"?"Retry clip":onset.current?"Resume clip":"Start task"}/></>:null}
    {state==="ended" && (failure?<><p role="alert">{failure}</p><button className="light-button" onClick={()=>void finish()}>Retry saving</button></>:<p role="status">Saving…</p>)}
  </section>;
}

const DIMS = [
  {key:"valence",prompt:"How pleasant did you feel?",help:"Think about how you felt during the activity you just finished.",lo:"Very unpleasant",hi:"Very pleasant"},
  {key:"arousal",prompt:"How calm or energized did you feel?",help:"Rate your energy, whether the feeling was pleasant or unpleasant.",lo:"Very calm",hi:"Very energized"},
  {key:"dominance",prompt:"How in control did you feel?",help:"Choose how much you felt in control of your experience, rather than overwhelmed by it.",lo:"Not in control",hi:"Fully in control"},
] as const;
function RatingScreen({step,act}:{step:SubjectStep;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [stage,setStage]=useState(0);
  const [values,setValues]=useState<Array<number|null>>([null,null,null]);
  const [saving,setSaving]=useState(false);const [error,setError]=useState("");const pending=useRef(false);
  const heading=useRef<HTMLHeadingElement>(null);const dim=DIMS[stage];
  const choose=(value:number)=>{if(!pending.current)setValues(old=>old.map((v,i)=>i===stage?value:v));};
  useEffect(()=>{heading.current?.focus();},[stage]);
  const submit=async()=>{
    if(pending.current || values[stage] == null)return;
    if(stage<2){setStage(stage+1);return;}
    pending.current=true;setSaving(true);setError("");
    try{await act("rating",{expectedStepId:step.id,valence:values[0],arousal:values[1],dominance:values[2]});}
    catch{setError("Your answers are still here. Check the connection and select Submit responses again.");}
    finally{pending.current=false;setSaving(false);}
  };
  return <section className="rating-screen subject-enter"><p className="rating-count">Question {stage+1} of 3</p><h1 ref={heading} tabIndex={-1} id="rating-title">{dim.prompt}</h1><p>{dim.help}</p><div className="rating-options" role="radiogroup" tabIndex={-1} aria-labelledby="rating-title" onKeyDown={event=>{
    if(saving)return;
    const numeric=event.key==="0"?10:Number(event.key);
    let value=Number.isInteger(numeric)&&numeric>=1&&numeric<=10?numeric:null;
    if(["ArrowRight","ArrowDown"].includes(event.key))value=(values[stage]??0)%10+1;
    if(["ArrowLeft","ArrowUp"].includes(event.key))value=((values[stage]??2)+8)%10+1;
    if(event.key==="Home")value=1;if(event.key==="End")value=10;
    if(value!==null){event.preventDefault();choose(value);event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[value-1]?.focus();}
  }}>{Array.from({length:10},(_,index)=>index+1).map(value=><button key={value} role="radio" disabled={saving} tabIndex={(values[stage]??1)===value?0:-1} aria-checked={values[stage]===value} aria-label={`${value} of 10${value===1?`, ${dim.lo}`:value===10?`, ${dim.hi}`:""}`} onClick={()=>choose(value)}>{value}</button>)}</div><div className="rating-anchors"><span>1 · {dim.lo}</span><span>10 · {dim.hi}</span></div><details className="rating-keyboard-help"><summary>Keyboard shortcuts</summary>Use arrow keys or 1–9. Press 0 for 10.</details><div className="subject-response-actions">{stage>0?<button className="paper-button" data-tone="secondary" disabled={saving} onClick={()=>setStage(stage-1)}>Back</button>:null}<button className="paper-button" disabled={values[stage]===null||saving} onClick={()=>void submit()}>{saving?"Saving…":stage===2?"Submit responses":"Continue"}</button></div>{error?<p role="alert">{error}</p>:null}</section>;
}

function StroopTask({step,act,active}:{step:SubjectStep;active:boolean;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [started,setStarted]=useState(false),[trial,setTrial]=useState(0);
  const [trials]=useState(()=>makeStroopTrials());
  const stimulus=trials[trial];
  const [saving,setSaving]=useState(false),[failed,setFailed]=useState(false);
  const startedAt=useRef(0),locked=useRef(false),results=useRef<Array<{correct:boolean;rt:number}>>([]);
  useEffect(()=>{if(started){startedAt.current=performance.now();locked.current=false;}},[started,trial]);
  const save=async()=>{
    setSaving(true);setFailed(false);
    const rows=results.current;
    try{await act("taskComplete",{expectedStepId:step.id,eventType:"stroop_complete",label:"Stroop completed",metadata:{trials:rows.length,accuracyPct:Math.round(rows.filter(r=>r.correct).length/rows.length*100),averageRtMs:Math.round(rows.reduce((sum,r)=>sum+r.rt,0)/rows.length)}});}
    catch{setFailed(true);}finally{setSaving(false);}
  };
  const answer=(name:string,eventTime:number)=>{
    if(locked.current)return;locked.current=true;
    results.current.push({correct:name===stimulus.ink,rt:Math.max(0,eventTime-startedAt.current)});
    if(trial===trials.length-1){void save();return;}
    setTrial(trial+1);
  };
  if(!started)return <section className="subject-center"><p>For example, if the word “blue” is printed in red, choose Red.</p><TaskStart active={active} run={async()=>setStarted(true)}/></section>;
  if(saving||failed)return <section className="subject-center">{failed?<><p role="alert">Your answers are still here.</p><button className="paper-button" onClick={()=>void save()}>Retry saving</button></>:<p role="status">Saving…</p>}</section>;
  return <section className="task-screen"><p>Word {trial+1} of 30</p><div className="stroop-word" style={{color:stimulus.hex}}>{stimulus.word}</div><div className="colour-buttons">{COLOURS.map(colour=><button key={colour.name} style={{background:colour.hex,color:["Yellow","Orange"].includes(colour.name)?"#161616":"#fff"}} onClick={e=>answer(colour.name,e.timeStamp)}>{colour.name}</button>)}</div></section>;
}

function BreathingScreen({step,snapshot,act,src,audioEnabled,onAudioChange}:{step:SubjectStep;snapshot:SubjectSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>;src:string;onAudioChange:(enabled:boolean)=>void;audioEnabled:boolean}) {
  const done=useCallback(()=>act("autoAdvance",{expectedStepId:step.id}),[act,step.id]);const remaining=useRemaining(step,snapshot,done);const phase=Math.floor((((step.durationSec??0)-remaining)/4)%4);const label=["In","Hold","Out","Hold"][phase];
  const guide=<div className="breathing-content"><h1>{step.subjectPrompt}</h1><div className={`breathing-circle phase-${phase}`}><span>{label}</span></div><time className="task-countdown" aria-label="Time remaining">{clock(remaining)}</time></div>;
  return <section className={`subject-center breathing-screen ${src?"with-media":""}`}>
    {src?<StudyPlayer className="breathing-video" src={src} aria-label="Breathing guide video" active={snapshot.status==="running" && snapshot.acquisitionReady && !snapshot.announcement} onAudioChange={onAudioChange} autoPlay muted={!audioEnabled} loop>{guide}</StudyPlayer>:guide}
  </section>;
}

function BreathHoldScreen({step,act,active}:{step:SubjectStep;active:boolean;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [state,setState]=useState<"ready"|"holding"|"released">("ready");
  const [elapsed,setElapsed]=useState(0),[failed,setFailed]=useState(false);
  const start=useRef(0),duration=useRef<number|null>(null),busy=useRef(false);
  useEffect(()=>{if(state!=="holding")return;const id=window.setInterval(()=>setElapsed((performance.now()-start.current)/1000),100);return()=>clearInterval(id);},[state]);
  const release=async()=>{
    if(busy.current)return;busy.current=true;duration.current??=Math.round((performance.now()-start.current)/100)/10;
    setState("released");setFailed(false);
    try{await act("taskComplete",{expectedStepId:step.id,eventType:"breath_hold_complete",label:"Breath hold completed",metadata:{durationSec:duration.current}});}
    catch{setFailed(true);}finally{busy.current=false;}
  };
  return <section className="subject-center breath-hold">{state==="holding"?<><time>{elapsed.toFixed(1)}</time><button className="paper-button" data-tone="caution" onClick={()=>void release()}>Release and breathe normally</button></>:state==="ready"?<TaskStart active={active} run={async()=>{start.current=performance.now();setState("holding");}}/>:<><p>Breathe normally.</p>{failed?<button className="paper-button" data-tone="caution" onClick={()=>void release()}>Retry saving</button>:<p role="status">Saving…</p>}</>}</section>;
}

function clock(value:number){const n=Math.max(0,Math.ceil(value));return`${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`}
