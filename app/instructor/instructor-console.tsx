"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { buildPlan, estimateRemaining, shortLabel } from "@/lib/protocol";
import type { MediaConfig, SensorStatus, SessionSnapshot } from "@/lib/types";

type HistoryItem = {code:string;participant_id:number;operator:string;status:string;step_index:number;revision:number;created_at:string;updated_at:string};
async function api(body:Record<string,unknown>) { const response=await fetch("/api/sessions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error||"Unable to save.");return data.session as SessionSnapshot; }
async function load(code:string) { const response=await fetch(`/api/sessions?code=${encodeURIComponent(code)}`,{cache:"no-store"});const data=await response.json();if(!response.ok)throw new Error(data.error||"Session not found.");return data.session as SessionSnapshot; }

export function InstructorConsole({operatorName}:{operatorName:string}) {
  const [snapshot,setSnapshot]=useState<SessionSnapshot|null>(null);
  const [tab,setTab]=useState<"live"|"data"|"config"|"history">("live");
  const [error,setError]=useState("");
  const [clockNow,setClockNow]=useState(()=>Date.now());
  const code=snapshot?.code ?? "";
  const refresh=useCallback(async()=>{if(!code)return;try{setSnapshot(await load(code));setError("")}catch(err){setError(err instanceof Error?err.message:"Unable to refresh.")}},[code]);
  const heartbeat=useCallback(async()=>{if(!code)return;try{setSnapshot(await api({code,action:"heartbeat"}));setError("")}catch(err){setError(err instanceof Error?err.message:"Unable to keep the session connected.")}},[code]);
  useEffect(()=>{if(!code)return;const id=window.setInterval(refresh,900);return()=>clearInterval(id)},[code,refresh]);
  useEffect(()=>{if(!code)return;const first=window.setTimeout(heartbeat,0);const id=window.setInterval(heartbeat,4000);return()=>{clearTimeout(first);clearInterval(id)}},[code,heartbeat]);
  useEffect(()=>{const id=window.setInterval(()=>setClockNow(Date.now()),1000);return()=>clearInterval(id)},[]);
  const act=useCallback(async(action:string,payload:Record<string,unknown>={})=>{if(!code)return;try{setSnapshot(await api({code,action,payload}));setError("")}catch(err){setError(err instanceof Error?err.message:"Unable to save.")}},[code]);

  if(!snapshot) return <Preflight defaultOperator={operatorName} onStarted={(session)=>setSnapshot(session)} onRestore={async(value)=>setSnapshot(await load(value))} />;
  const plan=buildPlan(snapshot.assignment); const step=plan[snapshot.stepIndex]; const elapsed=Math.max(0,(clockNow-Date.parse(snapshot.createdAt))/1000);
  const warningCount=snapshot.sensors.filter(sensor=>["delayed","missing","error"].includes(sensor.status)).length;

  return <main className="console-shell">
    <header className="console-header">
      <div><span className="console-wordmark">Meridian</span><span className="live-dot"/> <span className="session-state">{snapshot.status}</span></div>
      <div className="session-identity"><span>Participant P{snapshot.participantId}</span><span>v{snapshot.revision}</span><span>{formatClock(elapsed)}</span></div>
      <div className="header-actions">{snapshot.status==="paused"?<button onClick={()=>act("resume")}>Resume</button>:<button onClick={()=>act("pause",{reason:"Operator pause"})}>Pause</button>}<button className="danger-text" onClick={()=>act("abort")}>End</button></div>
    </header>
    <nav className="console-tabs" aria-label="Console sections">
      {(["live","data","config","history"] as const).map(value=><button key={value} className={tab===value?"active":""} onClick={()=>setTab(value)}>{value}</button>)}
      {warningCount>0?<span className="health-warning">{warningCount} warnings</span>:<span className="health-ok">Recording healthy</span>}
    </nav>
    <section className="session-connect-strip" aria-label="Subject connection">
      <span>Subject connection code</span><strong>{snapshot.code}</strong><button onClick={()=>void navigator.clipboard?.writeText(snapshot.code)}>Copy code</button><a href={`/subject?session=${snapshot.code}`} target="_blank" rel="noreferrer">Open subject display</a>
    </section>
    {error?<div className="console-error" role="alert">{error}</div>:null}
    {tab==="live"?<LiveWorkspace snapshot={snapshot} act={act}/>:null}
    {tab==="data"?<DataPanel snapshot={snapshot}/>:null}
    {tab==="config"?<ConfigPanel snapshot={snapshot} act={act}/>:null}
    {tab==="history"?<HistoryPanel onRestore={(session)=>{setSnapshot(session);setTab("live")}}/>:null}
    {step ? <footer className="console-footer"><span>{step.phase}</span><span>Step {step.index+1} of {plan.length}</span><span>About {formatClock(estimateRemaining(plan,snapshot.stepIndex))} remaining</span></footer>:null}
  </main>;
}

function Preflight({defaultOperator,onStarted,onRestore}:{defaultOperator:string;onStarted:(s:SessionSnapshot)=>void;onRestore:(code:string)=>Promise<void>}) {
  const [participant,setParticipant]=useState("");const [operator,setOperator]=useState(defaultOperator);const [restore,setRestore]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");
  const checks=["Participant ID","Protocol assignment","Recording services","Sensor connectivity","Synchronization","Protocol version"];
  const start=async()=>{setBusy(true);setError("");try{const session=await api({action:"create",participantId:Number(participant),operator});window.localStorage.setItem("meridian.operator.code",session.code);onStarted(session)}catch(err){setError(err instanceof Error?err.message:"Unable to start.")}finally{setBusy(false)}};
  return <main className="preflight-shell"><header><span className="console-wordmark">Meridian</span><span>Instructor console</span></header><section className="preflight-card"><div className="preflight-intro"><p className="eyebrow">New session</p><h1>Ready the room.</h1><p>Confirm the assignment and recording chain before the subject begins.</p></div><div className="preflight-form"><label>Participant ID<input inputMode="numeric" value={participant} onChange={event=>setParticipant(event.target.value.replace(/\D/g,""))} placeholder="0001"/></label><label>Operator<input value={operator} onChange={event=>setOperator(event.target.value)} placeholder="Name"/></label><div className="readiness"><div><strong>{participant?"Ready":"Action required"}</strong><span>{participant?"Deterministic assignment prepared":"Enter a participant ID"}</span></div>{checks.map((check,index)=><p key={check}><span className={participant||index>0?"check-dot ok":"check-dot"}/>{check}<b>{participant||index>0?"Ready":"Required"}</b></p>)}</div>{error?<p className="form-error">{error}</p>:null}<button className="primary-action" disabled={!participant||busy} onClick={start}>{busy?"Preparing":"Start session"}</button></div></section><section className="restore-row"><label>Resume session<input value={restore} onChange={event=>setRestore(event.target.value.toUpperCase())} placeholder="Session code"/></label><button disabled={!restore} onClick={()=>onRestore(restore)}>Restore</button></section></main>;
}

function LiveWorkspace({snapshot,act}:{snapshot:SessionSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const plan=useMemo(()=>buildPlan(snapshot.assignment),[snapshot.assignment]);const step=plan[snapshot.stepIndex];
  return <div className="live-grid"><ProtocolRail snapshot={snapshot} plan={plan} act={act}/><CurrentStep snapshot={snapshot} step={step} next={plan[snapshot.stepIndex+1]} act={act}/><aside className="ops-rail"><SensorPanel snapshot={snapshot} act={act}/><Interventions snapshot={snapshot} act={act}/><EventLog snapshot={snapshot}/></aside></div>;
}

function ProtocolRail({snapshot,plan,act}:{snapshot:SessionSnapshot;plan:ReturnType<typeof buildPlan>;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  return <aside className="protocol-rail"><p className="rail-title">Protocol</p><ol>{plan.map((item,index)=>{const showPhase=index===0||plan[index-1].phase!==item.phase;const state=item.index<snapshot.stepIndex?"done":item.index===snapshot.stepIndex?"now":"todo";return <li key={item.id}>{showPhase?<span className="phase-label">{item.phase}</span>:null}<button className={state} onClick={()=>item.index===snapshot.stepIndex?act("repeat",{reason:"Repeated from protocol rail"}):undefined}><i/>{shortLabel(item)}{item.durationSec?<small>{item.durationSec}s</small>:null}</button></li>})}</ol></aside>;
}

function CurrentStep({snapshot,step,next,act}:{snapshot:SessionSnapshot;step:ReturnType<typeof buildPlan>[number];next?:ReturnType<typeof buildPlan>[number];act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [reason,setReason]=useState("");const [checks,setChecks]=useState([false,false,false]);const [sys,setSys]=useState("");const [dia,setDia]=useState("");const [pulse,setPulse]=useState("");
  return <section className="current-step"><p className="eyebrow">{step.phase}</p><h1>{step.title}</h1><p className="step-meta">Step {step.index+1} · Attempt {snapshot.attempt}{next?` · Next: ${shortLabel(next)}`:""}</p><div className="operator-script"><span>Say to subject</span><p>{step.operatorScript}</p><small>{step.operatorNote}</small></div>
  <nav className="task-navigation" aria-label="Task navigation"><button disabled={snapshot.stepIndex===0||snapshot.status==="aborted"} onClick={()=>act("navigate",{direction:-1})}>Previous task</button><span>Step {snapshot.stepIndex+1} of {buildPlan(snapshot.assignment).length}</span><button disabled={snapshot.stepIndex>=buildPlan(snapshot.assignment).length-1||snapshot.status==="aborted"} onClick={()=>act("navigate",{direction:1})}>Next task</button></nav>
  {step.type==="gate"?<div className="gate-check"><strong>Return-to-baseline check</strong>{["Tonic GSR near resting reference","Heart rate near resting reference","Subject settled and breathing regularly"].map((label,index)=><label key={label}><input type="checkbox" checked={checks[index]} onChange={event=>setChecks(values=>values.map((value,i)=>i===index?event.target.checked:value))}/>{label}</label>)}<button disabled={!checks.every(Boolean)} onClick={()=>act("advance",{reason:"Baseline gate cleared"})}>Confirm and continue</button></div>:null}
  {step.type==="nback"?<div className="inline-control"><span>N level</span>{[1,2,3].map(level=><button className={snapshot.nbackLevel===level?"selected":""} key={level} onClick={()=>act("nbackLevel",{level})}>{level}-back</button>)}</div>:null}
  {step.safety?<div className="safety-panel"><span>Remain within reach. Stop if the subject reports discomfort.</span><button onClick={()=>act("advance",{reason:"Safety step skipped"})}>Skip and log</button></div>:null}
  {step.bp?<div className="bp-panel"><strong>Blood pressure <small>{step.bpLabel}</small></strong><div><input placeholder="SYS" inputMode="numeric" value={sys} onChange={e=>setSys(e.target.value)}/><input placeholder="DIA" inputMode="numeric" value={dia} onChange={e=>setDia(e.target.value)}/><input placeholder="Pulse" inputMode="numeric" value={pulse} onChange={e=>setPulse(e.target.value)}/><button disabled={!sys||!dia} onClick={()=>{act("bp",{label:step.bpLabel,systolic:Number(sys),diastolic:Number(dia),pulse:pulse?Number(pulse):null});setSys("");setDia("");setPulse("")}}>Save</button></div></div>:null}
  <div className="step-controls">{["operator","gate"].includes(step.advance)?<button className="primary-action" disabled={step.advance==="gate"&&!checks.every(Boolean)} onClick={()=>act("advance",{reason:"Operator continued"})}>Continue</button>:<span>{step.advance==="timer"?"Advances when the timer completes.":step.advance==="media"?"Advances when the clip ends.":"Advances when the subject finishes."}</span>}<input value={reason} onChange={event=>setReason(event.target.value)} placeholder="Repeat reason"/><button onClick={()=>act("repeat",{reason:reason||"Operator repeat"})}>Repeat step</button></div>
  <div className="subject-preview"><header><span>Subject display preview</span><a href={`/subject?session=${snapshot.code}`} target="_blank" rel="noreferrer">Open full screen</a></header><iframe title="Subject display" src={`/subject?session=${snapshot.code}`}/></div></section>;
}

function SensorPanel({snapshot,act}:{snapshot:SessionSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const statuses:SensorStatus[]=["recording","connected","delayed","missing","error","unknown"];
  return <section className="sensor-panel"><header><span>Recording health</span><b>{snapshot.sensors.filter(s=>s.status==="recording").length}/{snapshot.sensors.length}</b></header><ul>{snapshot.sensors.map(sensor=><li key={sensor.id}><i className={`sensor-dot ${sensor.status}`}/><span>{sensor.label}</span><select value={sensor.status} aria-label={`${sensor.label} status`} onChange={event=>act("sensor",{id:sensor.id,status:event.target.value})}>{statuses.map(status=><option key={status}>{status}</option>)}</select><small>{sensor.latencyMs??""}{sensor.latencyMs?" ms":""}</small></li>)}</ul></section>;
}

const CANNED=["Please wait a moment.","Keep still.","You can continue.","Please look at the screen."];
function Interventions({snapshot,act}:{snapshot:SessionSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [message,setMessage]=useState("");const [note,setNote]=useState("");const [category,setCategory]=useState("general");
  return <section className="interventions"><span className="rail-title">Message to subject</span><div className="message-chips">{CANNED.map(text=><button key={text} onClick={()=>act("message",{text})}>{text}</button>)}</div><div className="compose"><input value={message} onChange={event=>setMessage(event.target.value)} maxLength={180} placeholder="Short announcement"/><button disabled={!message.trim()} onClick={()=>{act("message",{text:message});setMessage("")}}>Send</button></div><span className="rail-title note-title">Operator note</span><select value={category} onChange={event=>setCategory(event.target.value)}><option>general</option><option>sensor</option><option>participant</option><option>safety</option><option>protocol</option></select><div className="compose"><input value={note} onChange={event=>setNote(event.target.value)} placeholder="Timestamped note"/><button disabled={!note.trim()} onClick={()=>{act("note",{body:note,category});setNote("")}}>Log</button></div><ul className="notes-list">{snapshot.notes.slice(-4).reverse().map(item=><li key={item.id}><b>{item.category}</b>{item.body}</li>)}</ul></section>;
}

function EventLog({snapshot}:{snapshot:SessionSnapshot}) { return <section className="event-log"><header><span>Live event log</span><b>{snapshot.events.length}</b></header><ul>{snapshot.events.slice(-14).reverse().map(event=><li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString([],{hour12:false})}</time><i className={event.severity}/><span><b>{event.label}</b>{event.detail}</span></li>)}</ul></section>; }

function DataPanel({snapshot}:{snapshot:SessionSnapshot}) {
  const exports=[
    ["Session JSON",()=>download(`meridian_${snapshot.participantId}_${snapshot.code}.json`,JSON.stringify(snapshot,null,2),"application/json")],
    ["Event CSV",()=>download(`meridian_${snapshot.participantId}_${snapshot.code}_events.csv`,eventsCsv(snapshot),"text/csv")],
    ["Event JSONL",()=>download(`meridian_${snapshot.participantId}_${snapshot.code}_events.jsonl`,snapshot.events.map(event=>JSON.stringify(event)).join("\n"),"application/x-ndjson")],
    ["Session report",()=>download(`meridian_${snapshot.participantId}_${snapshot.code}_report.txt`,report(snapshot),"text/plain")],
    ["Assignment",()=>download(`meridian_${snapshot.participantId}_${snapshot.code}_assignment.json`,JSON.stringify(snapshot.assignment,null,2),"application/json")],
    ["Configuration",()=>download(`meridian_${snapshot.code}_config.json`,JSON.stringify({protocolVersion:snapshot.protocolVersion,media:snapshot.media,nbackLevel:snapshot.nbackLevel},null,2),"application/json")],
  ] as const;
  return <section className="data-panel"><div><p className="eyebrow">Automatic persistence</p><h1>Session data</h1><p>Every response, task event, operator action, and timing marker is saved continuously.</p></div><div className="data-summary"><article><span>Events</span><b>{snapshot.events.length}</b></article><article><span>Responses</span><b>{snapshot.ratings.length}</b></article><article><span>Notes</span><b>{snapshot.notes.length}</b></article><article><span>BP readings</span><b>{snapshot.bpReadings.length}</b></article></div><div className="export-grid">{exports.map(([label,run])=><button key={label} onClick={run}><strong>{label}</strong><span>Download</span></button>)}</div><div className="data-table"><header><span>Recent events</span><span>Source</span><span>Time</span></header>{snapshot.events.slice(-20).reverse().map(event=><div key={event.id}><span>{event.label}<small>{event.stepLabel}</small></span><span>{event.source}</span><time>{new Date(event.createdAt).toLocaleTimeString([],{hour12:false})}</time></div>)}</div></section>;
}

function ConfigPanel({snapshot,act}:{snapshot:SessionSnapshot;act:(a:string,p?:Record<string,unknown>)=>Promise<void>}) {
  const [media,setMedia]=useState<MediaConfig>(snapshot.media);const [uploading,setUploading]=useState("");
  const rows:[string,string,string][]=[["emotions.happy","Clip 1",media.emotions.happy],["emotions.sad","Clip 2",media.emotions.sad],["emotions.anger","Clip 3",media.emotions.anger],["emotions.fear","Clip 4",media.emotions.fear],["emotions.surprise","Clip 5",media.emotions.surprise],["emotions.disgust","Clip 6",media.emotions.disgust],["washout","Washout media",media.washout],["boxBreathing","Breathing media",media.boxBreathing],["bodyScan","Body scan audio",media.bodyScan],["fixation","Fixation media",media.fixation]];
  const update=(key:string,value:string)=>setMedia(current=>key.startsWith("emotions.")?{...current,emotions:{...current.emotions,[key.split(".")[1]]:value}}:{...current,[key]:value});
  const upload=async(key:string,file:File)=>{setUploading(key);const form=new FormData();form.append("file",file);const response=await fetch("/api/media",{method:"POST",body:form});const data=await response.json();if(response.ok)update(key,data.asset.url);setUploading("")};
  return <section className="config-panel"><div><p className="eyebrow">Protocol v6</p><h1>Media configuration</h1><p>Uploaded media is stored separately from session records and can be assigned without changing the subject interface.</p></div><div className="config-list">{rows.map(([key,label,value])=><div key={key}><label>{label}<input value={value} placeholder="No media assigned" onChange={event=>update(key,event.target.value)}/></label><label className="upload-button">{uploading===key?"Uploading":"Upload"}<input type="file" accept="video/*,audio/*,image/*" onChange={event=>event.target.files?.[0]&&upload(key,event.target.files[0])}/></label></div>)}</div><button className="primary-action" onClick={()=>act("media",{media})}>Save configuration</button></section>;
}

function HistoryPanel({onRestore}:{onRestore:(s:SessionSnapshot)=>void}) {
  const [items,setItems]=useState<HistoryItem[]>([]);const [error,setError]=useState("");
  useEffect(()=>{fetch("/api/sessions?list=1",{cache:"no-store"}).then(r=>r.json()).then(data=>setItems(data.sessions||[])).catch(()=>setError("Unable to load session history."))},[]);
  return <section className="history-panel"><div><p className="eyebrow">Recovery</p><h1>Session history</h1><p>Restore a saved session without restarting the protocol.</p></div>{error?<p>{error}</p>:null}<div className="history-table"><header><span>Participant</span><span>Session</span><span>Status</span><span>Updated</span><span/></header>{items.map(item=><div key={item.code}><b>P{item.participant_id}</b><code>{item.code}</code><span>{item.status}</span><time>{new Date(item.updated_at).toLocaleString()}</time><button onClick={async()=>onRestore(await load(item.code))}>Restore</button></div>)}</div></section>;
}

function eventsCsv(snapshot:SessionSnapshot){const quote=(value:unknown)=>`"${String(value??"").replaceAll('"','""')}"`;return[["sequence","timestamp","participant","session","step","event","severity","source","detail"].join(","),...snapshot.events.map(event=>[event.sequence,event.createdAt,snapshot.participantId,snapshot.code,event.stepLabel,event.eventType,event.severity,event.source,event.detail].map(quote).join(","))].join("\n")}
function report(snapshot:SessionSnapshot){return[`Meridian session report`,`Participant: ${snapshot.participantId}`,`Session: ${snapshot.code}`,`Operator: ${snapshot.operator}`,`Protocol: ${snapshot.protocolVersion}`,`Status: ${snapshot.status}`,`Started: ${snapshot.createdAt}`,`Updated: ${snapshot.updatedAt}`,`Williams row: ${snapshot.assignment.row}`,`Stimulus order: ${snapshot.assignment.fullOrder.join(", ")}`,`Task order: ${snapshot.assignment.buf1}, ${snapshot.assignment.buf2}, ${snapshot.assignment.buf3}`,`Events: ${snapshot.events.length}`,`Ratings: ${snapshot.ratings.length}`,`Notes: ${snapshot.notes.length}`,`BP readings: ${snapshot.bpReadings.length}`].join("\n")}
function download(name:string,content:string,type:string){const url=URL.createObjectURL(new Blob([content],{type}));const link=document.createElement("a");link.href=url;link.download=name;link.click();URL.revokeObjectURL(url)}
function formatClock(seconds:number){const n=Math.max(0,Math.round(seconds));return`${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`}
