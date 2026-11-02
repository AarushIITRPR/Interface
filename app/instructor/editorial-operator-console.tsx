/* eslint-disable @next/next/no-img-element -- live MJPEG sensor previews require a native image element. */
"use client";
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronRight,
  Circle,
  ClipboardList,
  Download,
  HeartPulse,
  Menu,
  Monitor,
  Pause,
  Play,
  Radio,
  ScanLine,
  Send,
  Settings2,
  Video,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {stationRequest} from "@/lib/station-client";
import { buildPlan, shortLabel } from "@/lib/protocol";
import type { DeviceConfig, ProtocolStep, SensorChannel, SessionSnapshot } from "@/lib/types";

type WorkspaceTab = "setup" | "overview" | "protocol" | "review";
type Act = (action: string, payload?: Record<string, unknown>) => Promise<SessionSnapshot | null>;
type HistoryItem = {
  code: string;
  participant_id: number;
  operator: string;
  status: string;
  step_index: number;
  revision: number;
  created_at: string;
  updated_at: string;
};

const CANNED_MESSAGES = ["Please wait a moment.", "Keep still.", "You can continue.", "Please look at the screen."];
const SETUP_SENSORS = ["face", "audio", "oximeter", "csi", "emg", "gsr", "ecg", "thermal"];

async function api(body: Record<string, unknown>) {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to save the session.");
  return data.session as SessionSnapshot;
}

async function load(code: string) {
  const response = await fetch(`/api/sessions?code=${encodeURIComponent(code)}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Session not found.");
  return data.session as SessionSnapshot;
}

async function activeSessionFor(id:number) {
  const response = await fetch(`/api/sessions?participantId=${id}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to check previous sessions.");
  return data.active as Pick<HistoryItem,"code"> | null;
}

export function EditorialOperatorConsole({ operatorName }: { operatorName: string }) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [navOpen, setNavOpen] = useState(false);
  const lastAccepted = useRef<{revision:number;status:SessionSnapshot["status"]}|null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [notice, setNotice] = useState("Workspace synchronized");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const activeCode = useRef("");

  const accept = useCallback((next: SessionSnapshot) => {
    if (next.code !== activeCode.current) return;
    const prev=lastAccepted.current;
    if(prev && next.revision<=prev.revision)return;
    lastAccepted.current={revision:next.revision,status:next.status};
    setSnapshot(next);
    if(prev?.status==="setup" && ["running","paused"].includes(next.status))setTab("overview");
    if(["complete","aborted"].includes(next.status) && prev?.status!==next.status)setTab("review");
  }, []);

  const openSession = useCallback((next: SessionSnapshot) => {
    activeCode.current = next.code;
    setSnapshot(next);
    lastAccepted.current={revision:next.revision,status:next.status};
    window.history.replaceState(null,"","/instructor?session="+encodeURIComponent(next.code));
    setTab(next.status==="setup"?"setup":["complete", "aborted"].includes(next.status) ? "review" : "overview");
  }, []);

  useEffect(()=>{let cancelled=false;const saved=new URLSearchParams(location.search).get("session");
    if(saved)load(saved).then(s=>{if(!cancelled&&!activeCode.current)openSession(s);}).catch(()=>{if(!cancelled&&!activeCode.current)window.history.replaceState(null,"","/instructor");});
    return ()=>{cancelled=true;};
  },[openSession]);
  const code = snapshot?.code || "";
  const refresh = useCallback(async () => {
    if (!code) return;
    try { accept(await load(code)); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to refresh the workspace."); }
  }, [accept, code]);

  const heartbeat = useCallback(async () => {
    if (!code) return;
    try { accept(await api({ code, action: "heartbeat" })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The workspace lost synchronization."); }
  }, [accept, code]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!code) return;
    const first = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 1800);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [code, refresh]);

  useEffect(() => {
    if (!code) return;
    const first = window.setTimeout(heartbeat, 0);
    const timer = window.setInterval(heartbeat, 5000);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [code, heartbeat]);

  const act = useCallback<Act>(async (action, payload = {}) => {
    if (!code) return null;
    try {
      const next = await api({ code, action, payload });
      accept(next);
      setError("");
      setNotice(actionNotice(action));
      window.setTimeout(() => setNotice("Workspace synchronized"), 2200);
      if (["complete", "abort"].includes(action)) { setTab("review"); }
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update the session.");
      return null;
    }
  }, [accept, code]);

  const navigateTo = useCallback(async (target: number) => {
    if (!snapshot || !["running","paused"].includes(snapshot.status) || target===snapshot.stepIndex) return;
    if (!window.confirm("Move the participant to another stage? This interrupts the current activity.")) return;
    const direction = target < snapshot.stepIndex ? -1 : 1;
    let cursor = snapshot;
    for (let index = 0; index < Math.abs(target - snapshot.stepIndex); index += 1) {
      const next = await api({ code: cursor.code, action: "navigate", payload: { direction } });
      cursor = next;
      accept(next);
    }
    setNotice("Protocol position saved");
  }, [accept, snapshot]);

  const closeLedger = useCallback(() => setLedgerOpen(false), []);

  if (!snapshot) return <EditorialSessionEntry operatorName={operatorName} onOpen={openSession} />;

  const plan = buildPlan(snapshot.assignment,snapshot.protocolVersion);
  const step = plan[snapshot.stepIndex] ?? plan[0];
  const agentOnline = isAgentOnline(snapshot, now);
  const subjectOnline = Boolean(snapshot.subjectLastSeenAt && now - Date.parse(snapshot.subjectLastSeenAt) < 11000);
  const required = snapshot.requiredSensors.map((id) => snapshot.sensors.find((sensor) => sensor.id === id)).filter((sensor): sensor is SensorChannel => Boolean(sensor));
  const readyCount = required.filter((sensor) => sensorOperational(sensor, now, agentOnline)).length;
  const health = required.length ? Math.round((readyCount / required.length) * 100) : 100;
  const running = snapshot.status === "running";

  const changeTab = (next: WorkspaceTab) => { setTab(next); setNavOpen(false); };
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
      <main className="live-instructor">
        <a className="live-skip-link" href="#workspace-content">Skip to workspace</a>
        <header className="live-instructor-topbar">
          <div className="live-instructor-brand"><Link href="/">MERIDIAN</Link><i /><b>RESEARCH WORKSPACE</b></div>
          <div className="live-instructor-topmeta"><span>THE MERIDIAN STUDY</span><i /><span>SESSION {snapshot.code}</span></div>
          <button className="live-instructor-menu" onClick={() => setNavOpen((value) => !value)} aria-label="Toggle workspace navigation" aria-expanded={navOpen}><Menu size={19} /></button>
        </header>

        <div className={`live-instructor-layout ${navOpen ? "nav-open" : ""}`}>
          <aside className="live-instructor-sidebar">
            <div className="live-study-block"><WorkspaceLabel>Current study</WorkspaceLabel><h1>The Meridian<br />Study</h1><p>Multimodal research<br />Protocol {snapshot.protocolVersion}</p></div>
            <nav aria-label="Instructor workspace">
              <SidebarButton active={tab === "setup"} icon={Settings2} label="Recording setup" onClick={() => changeTab("setup")} />
              <SidebarButton active={tab === "overview"} icon={Monitor} label="Live study" onClick={() => changeTab("overview")} />
              <SidebarButton active={tab === "protocol"} icon={ClipboardList} label="Protocol" onClick={() => changeTab("protocol")} />
              <SidebarButton active={tab === "review"} icon={ScanLine} label="Recording review" onClick={() => changeTab("review")} />
            </nav>
            <div className="live-sidebar-footer">
              <span className={running ? "is-live" : "is-paused"}><Circle size={8} fill="currentColor" /> {statusText(snapshot.status)}</span>

            </div>
          </aside>

          <section className="live-instructor-main" id="workspace-content" tabIndex={-1}>
            <span className="sr-only" role="status">{notice}</span>
            {error ? <div className="live-workspace-error" role="alert">The workspace could not complete the request. Check the server connection, then retry your action. <details><summary>Error details</summary>{error}</details></div> : null}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={tab} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }}>
                {tab==="setup" && <RecordingSetup key={snapshot.code} snapshot={snapshot} now={now} act={act} onLive={()=>changeTab("overview")}/>}
                {tab === "overview" ? <Overview snapshot={snapshot} step={step} plan={plan} running={running} health={health} readyCount={readyCount} required={required} agentOnline={agentOnline} subjectOnline={subjectOnline} now={now} act={act} onSettings={() => changeTab("setup")} /> : null}
                {tab === "protocol" ? <Protocol snapshot={snapshot} step={step} plan={plan} running={running} subjectOnline={subjectOnline} act={act} navigateTo={navigateTo} /> : null}
                {tab === "review" ? <Review snapshot={snapshot} required={required} now={now} onLedger={() => setLedgerOpen(true)} /> : null}
              </motion.div>
            </AnimatePresence>
          </section>
        </div>

        <AnimatePresence>
          {ledgerOpen ? <LedgerDialog snapshot={snapshot} onClose={closeLedger} /> : null}

        </AnimatePresence>
      </main>
    </MotionConfig>
  );
}

function EditorialSessionEntry({ operatorName, onOpen }: { operatorName: string; onOpen: (snapshot: SessionSnapshot) => void }) {
  const [supervised,setSupervised]=useState(false);
  const [participant, setParticipant] = useState("");
  const [existing, setExisting] = useState<Pick<HistoryItem,"code"> | null>(null);
  const [lookupAttempt,retryLookup]=useState(0),[lookupFailed,setLookupFailed]=useState(false);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const id = Number(participant);
    if (!Number.isSafeInteger(id) || id < 1) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      activeSessionFor(id).then((item) => {
        if (cancelled) return;
        setExisting(item); setLookupFailed(false);
      }).catch(() => {if(!cancelled){setLookupFailed(true);setError("Could not check this participant’s previous sessions.");}}).finally(() => !cancelled && setChecking(false));
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [participant,lookupAttempt]);

  const start = async () => {
    const id = Number(participant);
    if (!Number.isSafeInteger(id) || id < 1) { setError("Enter a valid participant ID."); return; }
    setBusy(true); setError("");
    try { onOpen(await api({ action: "create", participantId: id, operator: operatorName, protocolVersion:supervised?"v7":"v8" })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to prepare the study."); }
    finally { setBusy(false); }
  };

  const resume = async () => {
    if (!existing) return;
    setBusy(true); setError("");
    try { onOpen(await load(existing.code)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to open the session."); }
    finally { setBusy(false); }
  };

  return (
    <main className="live-entry">
      <header className="live-entry-topbar"><Link href="/">MERIDIAN</Link><span>THE MERIDIAN STUDY</span><span>RESEARCH OPERATIONS</span></header>
      <section className="live-entry-grid">
        <div className="live-entry-index"><i /><span>01</span><p>Acquisition<br />workspace</p></div>
        <form onSubmit={(event) => { event.preventDefault(); if(!busy && !checking && !lookupFailed)void (existing ? resume() : start()); }}>
          <h1>Prepare a session.</h1>
          <label htmlFor="participant-id">Participant ID</label>
          <input id="participant-id" inputMode="numeric" value={participant} onChange={(event) => { const value = event.target.value.replace(/\D/g, ""); setParticipant(value); setLookupFailed(false); setExisting(null); setChecking(Number(value)>0); setError(""); }} placeholder="0001" />
          <div className="live-entry-state" role="status">{checking ? "Checking previous sessions" : existing ? `Existing session ${existing.code} found` : participant ? "Ready to prepare session" : "Enter the participant identifier"}</div>
          {!existing?<details className="run-mode"><summary>Session mode: {supervised?"Instructor-guided":"Self-guided"}</summary><label><input type="checkbox" checked={supervised} onChange={e=>setSupervised(e.target.checked)}/> Require instructor clearance at recovery checks (v7)</label></details>:null}
          {error ? <p className="live-entry-error" role="alert">{error}</p> : null}
          <button type="submit" disabled={busy || checking || lookupFailed || Number(participant)<1 || !participant}>{busy ? "PREPARING" : existing ? "RESUME SESSION" : "CONTINUE"}<ArrowUpRight size={16} /></button>
          {lookupFailed?<button type="button" onClick={()=>{setChecking(true);setError("");retryLookup(n=>n+1);}}>Retry session check</button>:null}
          {existing ? <button type="button" disabled={busy} className="live-entry-secondary" onClick={() => { if(window.confirm("Create another session for this participant instead of resuming?"))void start(); }}>START A NEW ACQUISITION</button> : null}
        </form>
        <div className="live-entry-context"><span>OPERATOR</span><strong>{operatorName}</strong><p>Enter the participant identifier. Meridian will restore an active session when one exists.</p></div>
      </section>
      <footer className="live-entry-footer"><span><ScanLine size={14} /> SESSION ORCHESTRATION</span><span>CVPR LAB / IIT ROPAR</span></footer>
    </main>
  );
}

function Overview({ snapshot, step, plan, running, health, readyCount, required, agentOnline, subjectOnline, now, act, onSettings }: {
  snapshot: SessionSnapshot; step: ProtocolStep; plan: ProtocolStep[]; running: boolean; health: number; readyCount: number; required: SensorChannel[]; agentOnline: boolean; subjectOnline: boolean; now: number; act: Act; onSettings: () => void;
}) {
  const [message, setMessage] = useState("");
  const progress = Math.round(((snapshot.stepIndex + 0.35) / plan.length) * 100);
  const capturing=agentOnline && snapshot.sensors.some(s=>s.status==="recording" && sensorOperational(s,now,agentOnline)) && required.every(s=>s.status==="recording" && sensorOperational(s,now,agentOnline));
  const supervisedAction=running && capturing && snapshot.protocolVersion!=="v8" && step.advance==="operator";
  const setupReady = agentOnline && subjectOnline && readyCount === required.length && snapshot.preflightTest.status === "pass";
  const requiredIds = new Set(required.map((sensor) => sensor.id));
  const optionalActive = snapshot.sensors.filter((sensor) => !requiredIds.has(sensor.id) && (sensor.hardwareDetected || sensor.dataDetected || Boolean(sensor.device && sensor.device !== "none") || Boolean(snapshot.acquisition.previewUrls[sensor.id])));
  const monitored = [...required, ...optionalActive];
  const sendMessage = () => { const text = message.trim(); if (!text) return; void act("message", { text }); setMessage(""); };
  const primaryAction = () => {
    if (snapshot.status === "setup") return setupReady ? void act("startSession") : onSettings();
    if (snapshot.status === "running") return void act("pause", { reason: "Paused by operator" });
    if (snapshot.status === "paused") return void act("resume");
  };

  return (
    <section className="live-workspace-content">
      <div className="live-content-heading"><div><WorkspaceLabel>Session overview</WorkspaceLabel><h2>Live study</h2></div><div><span>SESSION {snapshot.code}</span><p>{snapshot.protocolVersion==="v8"?"Self-guided recording. Intervene only if needed.":"Instructor-guided recording."}</p></div></div>

      <section className="live-session-banner">
        <div><span className={running ? "live-active" : "live-active paused"}><Circle size={8} fill="currentColor" /> {statusText(snapshot.status)}</span><strong>P{String(snapshot.participantId).padStart(3, "0")} <em>·</em> {shortLabel(step)}</strong><small>{snapshot.operator}</small></div>
        <div className="live-banner-actions">
          {!['complete','aborted'].includes(snapshot.status) ? <button onClick={primaryAction}>{snapshot.status === "running" ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}{snapshot.status === "setup" ? setupReady ? " START SESSION" : " PREPARE RECORDING" : snapshot.status === "running" ? " PAUSE SESSION" : " RESUME SESSION"}</button> : null}
          {snapshot.protocolVersion!=="v8" && step.advance!=="gate" && step.type!=="setup" && <button disabled={snapshot.status !== "running" || snapshot.stepIndex >= plan.length - 1} onClick={() => {if(window.confirm("Advance now instead of waiting for the current activity to finish?"))void act("advance");}}>ADVANCE <ChevronRight size={14} /></button>}
          {["running","paused"].includes(snapshot.status)?<button onClick={()=>{if(window.confirm("End recording and finalize files? Cancel to keep the session running."))void act("complete");}}>END SESSION</button>:null}
        </div>
      </section>

      {running && <section className="recording-handoff" aria-live="polite"><strong>{!capturing?(step.type==="setup"?"Starting the recorder":"Recording needs attention"):!subjectOnline?"Participant display disconnected":step.type==="setup"?(snapshot.protocolVersion==="v8"?"Recording is on. The participant begins on their screen.":"Recording is on. Confirm setup and begin the baseline."):step.advance==="gate"?"Instructor clearance needed":shortLabel(step)}</strong><p>{!capturing?"Waiting for the acquisition computer to report recording on all required streams.":!subjectOnline?"Reopen the subject display before continuing.":step.type==="setup"&&snapshot.protocolVersion==="v8"?"Waiting for “Begin first activity”. No instructor action needed.":step.advance==="timer"?"This activity advances automatically.":step.advance==="gate"?"Review the recovery checks before continuing.":snapshot.protocolVersion==="v8"?"The participant controls this activity.":step.operatorNote}</p>
      {supervisedAction && subjectOnline && <button onClick={()=>void act("advance",{expectedStepId:step.id,expectedStepStartedAt:snapshot.stepStartedAt,expectedAttempt:snapshot.attempt})}>Confirm setup and begin baseline</button>}
      {step.advance==="gate" && <GateClearance key={step.id+snapshot.stepStartedAt} step={step} snapshot={snapshot} act={act} disabled={!subjectOnline||!capturing}/>}
      </section>}
      <div className="live-overview-cards">
        <article><WorkspaceLabel>Protocol progress</WorkspaceLabel><div className="live-progress-number"><b>{String(snapshot.stepIndex + 1).padStart(2, "0")}</b><span>of {String(plan.length).padStart(2, "0")}<br />stages</span></div><div className="live-progress-line"><i style={{ width: `${progress}%` }} /></div><small>Current: {shortLabel(step)} · {durationLabel(step)}</small></article>
        <article className="live-subject-card"><div><WorkspaceLabel>Subject display</WorkspaceLabel><b>{subjectOnline?"Connected":"Not connected"}</b><p>{step.subjectPrompt || "The subject display is waiting for the next instruction."}</p></div><button onClick={onSettings}>View recording setup <ArrowUpRight size={14} /></button><small className={subjectOnline ? "connected" : "waiting"}>{subjectOnline ? "DISPLAY CONNECTED" : "DISPLAY WAITING"}</small></article>
        <article className="live-health-card"><WorkspaceLabel>Required streams ready</WorkspaceLabel><div><b>{readyCount} / {required.length}</b></div><p className={health === 100 ? "good" : "attention"}>{health === 100 ? <Check size={14} /> : <Circle size={9} fill="currentColor" />} {agentOnline ? "Incoming samples checked." : "Acquisition computer offline."}</p><small>Not a saved-file quality score. Verify files in Recording review.</small></article>
      </div>

      <section className="live-operations-grid">
        <section className="live-streams live-sensor-monitor" aria-labelledby="live-sensor-monitor-title">
          <header>
            <div><WorkspaceLabel>Live acquisition</WorkspaceLabel><h3 id="live-sensor-monitor-title">Sensor input</h3></div>
            <span className={agentOnline && readyCount === required.length ? "good" : "attention"}>{agentOnline ? `${readyCount} / ${required.length} REQUIRED READY` : "ACQUISITION OFFLINE"}</span>
          </header>
          {monitored.length ? <div className="live-sensor-grid">{monitored.map((sensor) => <SensorVisual key={sensor.id} sensor={sensor} required={requiredIds.has(sensor.id)} ready={sensorOperational(sensor, now, agentOnline)} agentOnline={agentOnline} now={now} previewUrl={snapshot.acquisition.previewUrls[sensor.id]} />)}</div> : <p className="live-empty-row">No sensors are configured for this session.</p>}
          <footer className="live-sensor-monitor-footer"><span>{monitored.length} {monitored.length === 1 ? "channel" : "channels"} monitored</span><span>{optionalActive.length ? `${optionalActive.length} optional active` : "Required channels prioritized"}</span></footer>
        </section>
        <div className="live-interventions"><header><div><WorkspaceLabel>Interventions</WorkspaceLabel><h3>Operator channel</h3></div><span>SESSION CONTROLS</span></header><details className="operator-tools"><summary>Markers and review flags</summary><div className="live-intervention-actions"><button onClick={() => void act("log", { eventType: "comfort_check", label: "Comfort check requested", source: "operator" })}><HeartPulse size={15} /> COMFORT CHECK</button><button onClick={() => void act("log", { eventType: "operator_marker", label: "Protocol marker inserted", source: "operator" })}><Circle size={12} fill="currentColor" /> INSERT MARKER</button><button className="review" onClick={() => void act("log", { eventType: "review_flag", label: "Operator review requested", severity: "warn", source: "operator" })}>FLAG REVIEW</button></div></details><div className="live-message"><input value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") sendMessage(); }} placeholder="Short instruction to subject" aria-label="Send a subject message" /><button onClick={sendMessage} aria-label="Send subject message"><Send size={16} /></button></div><div className="live-message-presets">{CANNED_MESSAGES.map((text) => <button key={text} onClick={() => void act("message", { text })}>{text}</button>)}</div></div>
      </section>
    </section>
  );
}

function GateClearance({step,snapshot,act,disabled}:{step:ProtocolStep;snapshot:SessionSnapshot;act:Act;disabled:boolean}){
  const [checks,setChecks]=useState([false,false,false]);
  return <fieldset><legend>Confirm recovery checks</legend>{["GSR near resting reference","Heart rate near resting reference","Participant settled"].map((label,i)=><label key={label}><input type="checkbox" checked={checks[i]} onChange={e=>setChecks(items=>items.map((v,j)=>i===j?e.target.checked:v))}/>{label}</label>)}<button disabled={disabled||!checks.every(Boolean)} onClick={()=>void act("advance",{expectedStepId:step.id,expectedStepStartedAt:snapshot.stepStartedAt,expectedAttempt:snapshot.attempt})}>Continue after checks</button></fieldset>;
}
function Protocol({ snapshot, step, plan, running, subjectOnline, act, navigateTo }: { snapshot: SessionSnapshot; step: ProtocolStep; plan: ProtocolStep[]; running: boolean; subjectOnline: boolean; act: Act; navigateTo: (index: number) => Promise<void> }) {
  const [checks, setChecks] = useState([false, false, false]);
  const [sys, setSys] = useState("");
  const [dia, setDia] = useState("");
  const [pulse, setPulse] = useState("");
  const gateReady = step.type !== "gate" || checks.every(Boolean);
  const canAdvance = running && ["operator", "gate"].includes(step.advance) && gateReady;

  return (
    <section className="live-workspace-content">
      <div className="live-content-heading"><div><WorkspaceLabel>Protocol workspace</WorkspaceLabel><h2>Session sequence</h2></div><div><span>{snapshot.protocolVersion.toUpperCase()}</span><p>{snapshot.protocolVersion==="v8"?"Activities advance from the subject display. Select a stage only to intervene.":"Select a stage to guide the participant."}</p></div></div>
      <div className="live-protocol-layout">
        <section className="live-protocol-list"><header><WorkspaceLabel>Session sequence</WorkspaceLabel><span>{String(snapshot.stepIndex + 1).padStart(2, "0")} / {String(plan.length).padStart(2, "0")}</span></header><div>{plan.map((item, index) => <button key={item.id} className={index === snapshot.stepIndex ? "current" : index < snapshot.stepIndex ? "complete" : ""} disabled={!["running","paused"].includes(snapshot.status)} aria-current={index===snapshot.stepIndex?"step":undefined} onClick={() => void navigateTo(index)}><span>{index < snapshot.stepIndex ? <Check size={14} /> : String(index + 1).padStart(2, "0")}</span><strong>{shortLabel(item)}</strong><small>{index === snapshot.stepIndex ? "Live now" : index < snapshot.stepIndex ? "Earlier" : "Queued"}</small></button>)}</div></section>
        <section className="live-stage-detail"><div><span>STAGE {String(snapshot.stepIndex + 1).padStart(2, "0")}</span><span>EST. {durationLabel(step)}</span></div><h3>{shortLabel(step)}</h3><p>{step.operatorScript}</p><blockquote><span>SUBJECT CUE</span>“{step.subjectPrompt || "Please wait for the instructor."}”</blockquote>
          {step.type === "gate" && step.advance==="gate" ? <fieldset className="live-context-control"><legend>Return-to-baseline check</legend>{["GSR near resting reference", "Heart rate near resting reference", "Subject settled and breathing regularly"].map((label, index) => <label key={label}><input type="checkbox" checked={checks[index]} onChange={(event) => setChecks((current) => current.map((value, item) => item === index ? event.target.checked : value))} />{label}</label>)}</fieldset> : null}
          {step.type === "nback" ? <fieldset className="live-context-control inline"><legend>N-back difficulty</legend>{[1, 2, 3].map((level) => <button className={snapshot.nbackLevel === level ? "selected" : ""} key={level} onClick={() => void act("nbackLevel", { level })}>{level}-back</button>)}</fieldset> : null}
          {step.bp ? <fieldset className="live-context-control bp"><legend>Blood pressure · {step.bpLabel}</legend><label>Systolic<input inputMode="numeric" value={sys} onChange={(event) => setSys(event.target.value.replace(/\D/g, ""))} /></label><label>Diastolic<input inputMode="numeric" value={dia} onChange={(event) => setDia(event.target.value.replace(/\D/g, ""))} /></label><label>Pulse<input inputMode="numeric" value={pulse} onChange={(event) => setPulse(event.target.value.replace(/\D/g, ""))} /></label><button disabled={!sys || !dia} onClick={() => { void act("bp", { label: step.bpLabel, systolic: Number(sys), diastolic: Number(dia), pulse: pulse ? Number(pulse) : null }); setSys(""); setDia(""); setPulse(""); }}>SAVE READING</button></fieldset> : null}
          <footer><button disabled={!["running","paused"].includes(snapshot.status)} onClick={() => void act(running ? "pause" : "resume", running ? { reason: "Paused by operator" } : {})}>{running ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}{running ? " PAUSE SESSION" : " RESUME SESSION"}</button><button disabled={!canAdvance} onClick={() => {if(window.confirm("Advance now instead of waiting for the current activity to finish?"))void act("advance");}}>ADVANCE <ChevronRight size={14} /></button></footer>
          <div className="live-stage-lower"><button disabled={snapshot.stepIndex === 0 || !["running","paused"].includes(snapshot.status)} onClick={() => void navigateTo(snapshot.stepIndex-1)}>PREVIOUS STAGE</button><span className={subjectOnline ? "connected" : "waiting"}>{subjectOnline ? "SUBJECT DISPLAY CONNECTED" : "SUBJECT DISPLAY WAITING"}</span></div>
        </section>
      </div>
    </section>
  );
}

function Review({ snapshot, required, now, onLedger }: { snapshot: SessionSnapshot; required: SensorChannel[]; now: number; onLedger: () => void }) {
  const artifacts = snapshot.recordings;
  const streams = snapshot.sensors.filter(s=>required.some(r=>r.id===s.id)||artifacts.some(a=>a.sensorId===s.id));
  const duration = artifacts.length ? Math.max(...artifacts.map((item) => item.durationSec)) : snapshot.recordingStartedAt ? Math.max(0, ((["complete","aborted"].includes(snapshot.status) ? Date.parse(snapshot.stepStartedAt) : now) - Date.parse(snapshot.recordingStartedAt)) / 1000) : 0;
  const totalBytes = artifacts.reduce((sum, item) => sum + item.bytes, 0);
  const manifestReady = artifacts.length > 0 && artifacts.every((item) => item.quality !== "pending");
  const exportManifest = () => download(`${snapshot.code.toLowerCase()}-manifest.json`, JSON.stringify({ exportedAt: new Date().toISOString(), session: safeSnapshot(snapshot), recordings: artifacts }, null, 2), "application/json");
  return (
    <section className="live-workspace-content">
      <div className="live-content-heading"><div><WorkspaceLabel>Recording review</WorkspaceLabel><h2>Recording review</h2></div><div><span>CAPTURE {snapshot.code}</span><p>Check the reported files before exporting the session record.</p></div></div>
      <section className="live-review-summary"><article><WorkspaceLabel>Capture coverage</WorkspaceLabel><b>{clock(duration)}</b><small>{artifacts.length ? "reported file duration" : "session elapsed, no file confirmation"}</small></article><article><WorkspaceLabel>Storage</WorkspaceLabel><b>{formatBytes(totalBytes)} </b><small>{artifacts.length ? `${artifacts.length} reported files` : "local acquisition volume"}</small></article><article><WorkspaceLabel>Manifest</WorkspaceLabel><b>{manifestReady ? "Ready" : "Pending"}</b><small className={manifestReady ? "good" : "attention"}>{manifestReady ? <Check size={13} /> : <Circle size={8} fill="currentColor" />} {manifestReady ? "manifest received; check stream results" : "awaiting final evidence"}</small></article></section>
      <section className="live-stream-register"><header><div><WorkspaceLabel>Collected streams</WorkspaceLabel><h3>Recording register</h3></div><button onClick={exportManifest}><Download size={14} /> {artifacts.length?"EXPORT MANIFEST":"EXPORT SESSION RECORD"}</button></header>{streams.map((sensor) => { const artifact = artifacts.find((item) => item.sensorId === sensor.id); const quality = artifact?.quality || sensor.quality; return <article key={sensor.id}><i className={quality === "pass" || quality === "good" ? "good" : quality === "fail" || quality === "bad" ? "bad" : "attention"} />{sensorIcon(sensor)}<strong>{sensor.label}</strong><span>{artifact ? `${formatRate(artifact.averageRateHz)} Hz · ${artifact.availabilityPct.toFixed(1)}% available` : sensor.latestValue || sensor.detail}</span><small>{!artifact ? "NO FILE REPORT" : quality === "pass" ? "CHECKED" : String(quality).toUpperCase()}</small></article>; })}</section>
      <section className="live-review-ledger"><header><div><WorkspaceLabel>Operational record</WorkspaceLabel><h3>Session ledger</h3></div><button onClick={onLedger}>OPEN LEDGER <ArrowUpRight size={14} /></button></header>{snapshot.events.slice(-3).reverse().map((event) => <article key={event.id}><time>{timeLabel(event.createdAt)}</time><p>{event.label}</p><span>{event.eventType.replaceAll("_", " ").toUpperCase()}</span></article>)}</section>
    </section>
  );
}

function useDialogFocus(closeRef: {current: HTMLButtonElement | null}, onClose: () => void) {
  useEffect(() => {
    const opener=document.activeElement as HTMLElement|null;
    const dialog=closeRef.current?.closest<HTMLElement>('[role="dialog"]');
    if(!dialog)return;
    const background=Array.from(document.querySelectorAll<HTMLElement>(".live-instructor-topbar,.live-instructor-layout"));
    const prior=background.map(el=>el.inert);
    background.forEach(el=>{el.inert=true;});
    closeRef.current?.focus();
    const focusables=()=>Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')).filter(el=>el.getClientRects().length>0);
    const keyboard=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){event.preventDefault();onClose();}
      if(event.key==="Tab"){
        const items=focusables(),first=items[0],last=items.at(-1);
        if(!first){event.preventDefault();return;}
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    };
    const contain=(event:FocusEvent)=>{if(event.target instanceof Node&&!dialog.contains(event.target))closeRef.current?.focus();};
    document.addEventListener("keydown",keyboard);document.addEventListener("focusin",contain);
    return()=>{document.removeEventListener("keydown",keyboard);document.removeEventListener("focusin",contain);background.forEach((el,i)=>{el.inert=prior[i];});if(opener?.isConnected)opener.focus();};
  },[closeRef,onClose]);
}

function RecordingSetup({ snapshot, now, act, onLive }: { snapshot: SessionSnapshot; now: number; act: Act; onLive: () => void }) {
  const [revisit,setRevisit]=useState<number|null>(null);
  const [station,setStation]=useState<{paired?:boolean;displayOnline?:boolean}|null>(null);
  const [stationError,setStationError]=useState(""),[invitation,setInvitation]=useState(""),[inviting,setInviting]=useState(false);
  useEffect(()=>{
    if(snapshot.status!=="setup")return;
    let stopped=false,pending=false;
    const sync=async()=>{if(stopped||pending)return;pending=true;
      try{const data=await stationRequest({action:"assign",code:snapshot.code});if(!stopped){setStation(data);setStationError("");}}
      catch(e){if(!stopped)setStationError(e instanceof Error?e.message:"Could not assign the subject computer.");}
      finally{pending=false;}
    };
    const first=setTimeout(sync,0),timer=setInterval(sync,4000);
    return()=>{stopped=true;clearTimeout(first);clearInterval(timer);};
  },[snapshot.code,snapshot.status]);
  const [devices,setDevices]=useState<DeviceConfig>(snapshot.deviceConfig);
  const [required,setRequired]=useState(snapshot.requiredSensors);
  const [platform,setPlatform]=useState("windows");
  const [origin,setOrigin]=useState("");
  const [feedback,setFeedback]=useState("");
  const [busy,setBusy]=useState(false);const pending=useRef(false);
  useEffect(()=>{const timer=window.setTimeout(()=>setOrigin(window.location.origin),0);return()=>clearTimeout(timer);},[]);
  const online=isAgentOnline(snapshot,now);
  const subjectOnline=Boolean(snapshot.subjectLastSeenAt&&now-Date.parse(snapshot.subjectLastSeenAt)<11000);
  const dirty=JSON.stringify(devices)!==JSON.stringify(snapshot.deviceConfig)||JSON.stringify(required)!==JSON.stringify(snapshot.requiredSensors);
  const selectedReady=required.every(id=>sensorOperational(snapshot.sensors.find(s=>s.id===id),now,online));
  const canStart=online&&subjectOnline&&selectedReady&&!dirty&&snapshot.preflightTest.status==="pass";
  const checkRunning=snapshot.preflightTest.status==="running";
  const command=(platform==="windows"?".\\venv\\Scripts\\python.exe":".venv/bin/python")+" -m meridian_agent --server "+origin+" --code "+snapshot.code+" --token "+snapshot.acquisitionToken;
  // Use the same .venv directory for installation and launch, without shell activation.
  const launch=command.replace(".\\venv\\",".\\.venv\\");
  const joined=subjectOnline && (station?.paired?station.displayOnline:online);
  const next=!joined?1:!online?2:!selectedReady||dirty||snapshot.preflightTest.status!=="pass" || snapshot.configRevision!==snapshot.acquisition.configRevision?3:4;
  const page=revisit!==null && revisit<next?revisit:next;
  const heading=useRef<HTMLHeadingElement>(null);
  const lastPage=useRef(page);
  useEffect(()=>{if(lastPage.current!==page){lastPage.current=page;heading.current?.focus();}},[page]);
  const perform=async(action:string,payload:Record<string,unknown>={})=>{
    if(pending.current)return;pending.current=true;setBusy(true);setFeedback("");
    try{const result=await act(action,payload);setFeedback(result?(action==="startSession"?"Recording requested.":"Saved."): "Could not complete this action. Check the connection and try again.");}
    finally{pending.current=false;setBusy(false);}
  };
  const save=async()=>{
    if(pending.current)return;pending.current=true;setBusy(true);setFeedback("");
    try{
      const saved=await act("deviceConfig",{devices,required});
      setFeedback(saved?"Device choices saved. Checking the updated configuration.":"Device choices were not saved. Try again.");
    }finally{pending.current=false;setBusy(false);}
  };
  async function invite(){
    setInviting(true);setFeedback("");
    try{
      const result=await stationRequest({action:"invite",code:snapshot.code});
      if(result.invite)setInvitation(location.origin+"/subject#invite="+result.invite);
      else setStation(result);
    }catch(e){setFeedback(e instanceof Error?e.message:"Could not prepare an invitation.");}finally{setInviting(false);}
  }
  const local=Boolean(origin && ["localhost","127.0.0.1","[::1]"].includes(new URL(origin).hostname));
  const titles=["Connect the subject computer","Wait for the subject recorder","Check recording devices","Start recording"];
  if(snapshot.status!=="setup")return <section className="setup-workflow"><h2>Recording setup</h2><p>Device choices are locked for this session.</p><details><summary>Recording devices and diagnostics</summary><p>{snapshot.acquisition.host || "Acquisition computer offline"} · {snapshot.preflightTest.detail}</p><ul>{snapshot.sensors.filter(s=>snapshot.requiredSensors.includes(s.id)||snapshot.deviceConfig[s.id] && snapshot.deviceConfig[s.id]!=="none").map(s=><li key={s.id}>{s.label}: {s.detail || s.status}</li>)}</ul></details><button className="wizard-primary" onClick={onLive}>View live study</button>{["complete","aborted"].includes(snapshot.status) && <details><summary>Subject computer</summary><button onClick={async()=>{if(!window.confirm("Forget the trusted subject computer? The next study will require a new invitation."))return;try{await stationRequest({action:"forget",code:snapshot.code});setFeedback("Subject computer forgotten.");}catch(e){setFeedback(e instanceof Error?e.message:"Could not forget this computer.");}}}>Forget subject computer</button><p role="status">{feedback}</p></details>}</section>;
  return <section className="setup-workflow" aria-label="Recording setup"><p>Recording setup · Step {page} of 4</p><h2 ref={heading} tabIndex={-1}>{titles[page-1]}</h2>
    {page===1 && <>{station?.paired?<><p>This instructor station remembers its subject computer. Open the subject portal there, or leave it open between sessions. The browser will join this study automatically.</p><p role="status">{joined?"Subject display connected.":"Waiting for the trusted subject display…"}</p></>:<>
      <p>Open a private invitation in the browser on the subject’s Windows computer, where the sensors are connected. This is needed once per pair of browsers, not once per participant.</p>
      {local?<p role="status">This is a localhost address. For two different computers, use the same reachable HTTPS Meridian address on both. A localhost link will not reach this server from the other PC.</p>:null}
      {!stationError && (local?<details><summary>Test both portals on this computer instead</summary><button disabled={!station||inviting} onClick={()=>void invite()}>Create local test invitation</button></details>:<button className="wizard-primary" disabled={!station||inviting} onClick={()=>void invite()}>{invitation?"Replace invitation":"Create subject invitation"}</button>)}
      {invitation?<><label>Private subject invitation<input readOnly value={invitation} onFocus={e=>e.target.select()}/></label><button onClick={async()=>{try{await navigator.clipboard.writeText(invitation);setFeedback("Copied. Open it on the subject computer within 30 minutes.");}catch{setFeedback("Select and copy the invitation above.");}}}>Copy invitation</button><p>The first browser to use this invitation becomes the subject station. Do not open it on the instructor PC.</p></>:null}
      </>}{stationError && <p role="alert">{stationError}</p>}</>}
    {page===2 && <><p>The subject display handles installation and connects the recorder to this session. No pairing code or link is needed here.</p><p role="status">{online?"Recorder connected.":"Waiting for a heartbeat from the recorder on the subject computer."}</p>
      <details><summary>Manual connection (advanced)</summary><label>Operating system <select value={platform} onChange={e=>setPlatform(e.target.value)}><option value="windows">Windows</option><option value="linux">Linux / macOS</option></select></label><p>From the acquisition_agent folder, install once:</p><pre>{platform==="windows"?"python -m venv .venv\n.\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt":"python3 -m venv .venv\n.venv/bin/python -m pip install -r requirements.txt"}</pre><p>Then run this private session command:</p><pre>{launch}</pre><button onClick={async()=>{try{await navigator.clipboard.writeText(launch);setFeedback("Command copied.");}catch{setFeedback("Select and copy the command above.");}}}>Copy command</button></details>
    </>}
    {page===3 && <><p>{dirty?"Save your device choices before checking readiness.":checkRunning?"Checking incoming data and storage. This takes about 10 seconds.":snapshot.preflightTest.status==="fail"?snapshot.preflightTest.detail:"Required devices must send usable samples before recording."}</p>
      <ul className="setup-streams">{snapshot.sensors.filter(s=>required.includes(s.id)).map(s=><li key={s.id}><strong>{s.label}</strong><span>{sensorOperational(s,now,online)?"Receiving data":sensorAction(s,sensorDisplayState(s,now,online).key)}</span></li>)}</ul>
      <details><summary>Change devices</summary><div className="live-device-settings">{snapshot.sensors.filter(s=>SETUP_SENSORS.includes(s.id)).map(sensor=>{
            const kind=sensor.group==="video"?"video":sensor.group==="audio"?"audio":"serial";
            const selected=devices[sensor.id]||"none";
            const ready=sensorOperational(sensor,now,online);
            return <article key={sensor.id}>
              <label className="live-required-toggle"><input type="checkbox" aria-label={'Require '+sensor.label} checked={required.includes(sensor.id)} disabled={busy||snapshot.configurationLocked} onChange={e=>setRequired(items=>e.target.checked?[...new Set([...items,sensor.id])]:items.filter(id=>id!==sensor.id))}/><span><strong>{sensor.label}</strong><small>{selected==="none"?"Not assigned":ready?"Receiving data":!online?"Connect acquisition computer":"Check device connection and assignment"}</small></span></label>
              {sensor.id==="ecg"?<label className="live-api-device"><span>Frontier X live link</span><input value={selected==="none"||selected==="auto"?"":selected} disabled={busy||snapshot.configurationLocked} onChange={e=>setDevices(d=>({...d,ecg:e.target.value||"none"}))} placeholder="Paste live ECG share link or user ID"/></label>:<select aria-label={sensor.label+' device'} value={selected} disabled={busy||snapshot.configurationLocked} onChange={e=>setDevices(d=>({...d,[sensor.id]:e.target.value}))}><option value="none">Not assigned</option><option value="auto">Auto-detect</option>{snapshot.acquisition.inventory[kind].map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select>}
              <details className="device-diagnostic"><summary>{sensor.label} details</summary><p>{sensor.detail}</p><p>{sensor.latestValue}</p></details>
            </article>;
          })}</div>
          <button className="live-save-settings" disabled={busy||snapshot.configurationLocked||!dirty} onClick={()=>void save()}>{busy?"SAVING…":"SAVE DEVICE CHOICES"}</button>
          {dirty?<p role="status">Unsaved choices. Save before running the readiness check.</p>:null}
      </details>
      <button disabled={busy||!online||dirty||checkRunning} onClick={()=>void perform("startPreflight")}>{checkRunning?"Checking…":"Run readiness check"}</button>
      <details><summary>Diagnostics</summary><p>{snapshot.preflightTest.detail}</p><p>Free space: {snapshot.acquisition.diskFreeGb??"Unknown"} GiB</p><button disabled={busy||!online||dirty} onClick={()=>void perform("refreshDevices")}>Refresh devices</button></details>
    </>}
    {page===4 && <><p>Devices ready. Participant connected.</p><p>{snapshot.protocolVersion==="v8"?"After you start recording, the participant begins the first activity on their screen.":"After recording begins, Live study will show the instructor’s next action."}</p><button className="wizard-primary" disabled={busy||!canStart} onClick={()=>void perform("startSession")}>Start recording</button></>}
    <p role="status">{feedback}</p><footer>{page>1 && <button onClick={()=>{setRevisit(page-1);setFeedback("");}}>Back</button>}{page<next && <button onClick={()=>{setRevisit(page+1===next?null:page+1);setFeedback("");}}>Continue</button>}
    <details><summary>Session options</summary><button onClick={()=>{if(window.confirm("Discard this prepared session?"))void perform("abort");}}>Discard session</button></details></footer>
  </section>;
}

function LedgerDialog({ snapshot, onClose }: { snapshot: SessionSnapshot; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(closeRef,onClose);
  const exportLedger = () => download(`${snapshot.code.toLowerCase()}-events.json`, JSON.stringify(snapshot.events, null, 2), "application/json");
  return <motion.div className="live-modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><section className="live-ledger" role="dialog" aria-modal="true" aria-labelledby="ledger-title"><header><div><WorkspaceLabel>Session ledger</WorkspaceLabel><h2 id="ledger-title">Operational record</h2></div><button ref={closeRef} onClick={onClose} aria-label="Close session ledger"><X size={18} /></button></header><div className="live-ledger-meta"><span>{snapshot.code}</span><span>P{String(snapshot.participantId).padStart(3, "0")}</span><span>{snapshot.protocolVersion}</span></div><div className="live-ledger-events">{snapshot.events.length ? [...snapshot.events].reverse().map((event) => <article key={event.id}><time>{timeLabel(event.createdAt)}</time><span>{event.source.toUpperCase()}</span><p><strong>{event.label}</strong>{event.detail ? <small>{event.detail}</small> : null}</p></article>) : <p>No events have been recorded yet.</p>}</div><footer><span>Entries are stored with this session.</span><button onClick={exportLedger}><Download size={14} /> EXPORT JSON</button></footer></section></motion.div>;
}

function WorkspaceLabel({ children }: { children: ReactNode }) { return <p className="live-workspace-label">{children}</p>; }
function SidebarButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: LucideIcon; label: string; onClick: () => void }) { return <button aria-current={active?"page":undefined} className={active ? "active" : ""} onClick={onClick}><Icon size={17} /><span>{label}</span><ChevronRight size={15} /></button>; }

function SensorVisual({ sensor, required, ready, agentOnline, now, previewUrl }: { sensor: SensorChannel; required: boolean; ready: boolean; agentOnline: boolean; now: number; previewUrl?: string }) {
  const state = sensorDisplayState(sensor, now, agentOnline);
  const readings = sensorReadings(sensor);
  const freshness = sampleAgeLabel(sensor, now);
  const rate = sensor.rateHz == null ? "No rate" : `${formatRate(sensor.rateHz)} Hz`;
  const connection = agentOnline && sensor.hardwareDetected ? "Connected" : agentOnline ? "Not connected" : "Agent offline";
  const transmission = !agentOnline || !sensor.hardwareDetected ? "No stream" : !sensor.dataDetected ? "Waiting" : state.key === "stalled" ? "Stalled" : "Live";
  const showPreview = sensor.group === "video" && Boolean(previewUrl);

  return (
    <article className={`live-sensor-channel ${sensor.group === "video" ? "video" : ""} ${state.tone}`} aria-label={`${sensor.label}. ${state.label}. ${rate}. ${freshness}.`}>
      <div className="live-sensor-channel-head">
        <div>{sensorIcon(sensor)}<span><strong>{sensor.label}</strong><small>{required ? "Required channel" : "Optional channel"}</small></span></div>
        <span className={`live-sensor-state ${state.tone}`}><i />{state.label}</span>
      </div>

      <div className={`live-signal-visual ${sensor.group === "video" ? "video" : ""}`}>
        {showPreview ? <SensorPreview label={sensor.label} url={previewUrl!} /> : sensor.id === "csi" ? <CsiSpectrum values={sensor.series} /> : <SignalTrace label={sensor.label} values={sensor.series} tone={state.tone} />}
      </div>

      <dl className="live-sensor-readings">
        {readings.map((reading) => <div key={reading.label}><dt>{reading.label}</dt><dd>{reading.value}</dd></div>)}
      </dl>

      <div className="live-sensor-transmission">
        <span><b>Connection</b>{connection}</span>
        <span><b>Transmission</b>{transmission} · {freshness}</span>
        <span><b>Quality</b>{qualityText(sensor)} · {rate} · {sensor.dropoutPct.toFixed(2)}% loss</span>
      </div>
      {!ready && required ? <p className="live-sensor-action">{sensorAction(sensor, state.key)}</p> : null}
    </article>
  );
}

function SensorPreview({ label, url }: { label: string; url: string }) {
  const [failedUrl, setFailedUrl] = useState("");
  if (failedUrl === url) return <div className="live-signal-empty"><strong>Preview unavailable</strong><span>The channel may still be recording.</span></div>;
  return <img src={url} alt={`${label} live preview`} onError={() => setFailedUrl(url)} />;
}

function SignalTrace({ label, values, tone }: { label: string; values: number[]; tone: string }) {
  const data = values.slice(-160).filter(Number.isFinite);
  if (data.length < 2) return <div className="live-signal-empty"><strong>Waiting for samples</strong><span>The trace will appear when real data arrives.</span></div>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((value, index) => `${(index / Math.max(1, data.length - 1) * 320).toFixed(2)},${(74 - ((value - min) / range) * 64).toFixed(2)}`).join(" ");
  return <div className="live-trace" role="img" aria-label={`${label} rolling signal with ${data.length} real samples`}><svg viewBox="0 0 320 84" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="42" x2="320" y2="42" /><polyline className={tone} points={points} /></svg></div>;
}

function CsiSpectrum({ values }: { values: number[] }) {
  const data = values.slice(0, 52).filter(Number.isFinite);
  if (!data.length) return <div className="live-signal-empty"><strong>Waiting for CSI packets</strong><span>Subcarriers will appear when packets arrive.</span></div>;
  const max = Math.max(1, ...data.map(Math.abs));
  return <div className="live-csi-spectrum" role="img" aria-label={`${data.length} live CSI subcarrier amplitudes`}><div aria-hidden="true">{data.map((value, index) => <i key={index} style={{ height: `${Math.max(4, Math.abs(value) / max * 100)}%` }} />)}</div></div>;
}

function sensorReadings(sensor: SensorChannel) {
  const rate = sensor.rateHz == null ? "Waiting" : `${formatRate(sensor.rateHz)} Hz`;
  if (sensor.id === "oximeter") return [
    { label: "Heart rate", value: metricValue(sensor, "heartRate", " bpm") },
    { label: "SpO2", value: metricValue(sensor, "spo2", "%") },
    { label: "Signal", value: metricValue(sensor, "signalStrength", "%") },
  ];
  if (sensor.id === "audio") return [
    { label: "Input level", value: metricValue(sensor, "levelPct", "%") },
    { label: "Capture rate", value: metricRate(sensor, "sampleRate") },
    { label: "Samples", value: formatCount(sensor.sampleCount) },
  ];
  if (sensor.id === "csi") return [
    { label: "RSSI", value: metricValue(sensor, "rssi", " dBm") },
    { label: "Subcarriers", value: metricValue(sensor, "subcarriers") },
    { label: "Packet rate", value: rate },
  ];
  if (sensor.id === "gsr") return [
    { label: "Conductance", value: metricValue(sensor, "conductance", " uS") },
    { label: "Baseline", value: metricValue(sensor, "baseline", " uS") },
    { label: "Z-score", value: metricValue(sensor, "zscore") },
  ];
  if (sensor.id === "ecg") return [
    { label: "Heart rate", value: metricValue(sensor, "heartRate", " bpm") },
    { label: "Packet loss", value: metricValue(sensor, "packetLossPct", "%") },
    { label: "Sample rate", value: rate },
  ];
  if (sensor.id === "emg" && ["raw", "rms", "clippingPct"].some((key) => metricNumber(sensor, key) != null)) return [
    { label: "Raw", value: metricValue(sensor, "raw") },
    { label: "RMS", value: metricValue(sensor, "rms") },
    { label: "Clipping", value: metricValue(sensor, "clippingPct", "%") },
  ];
  if (sensor.group === "video") {
    const width = metricNumber(sensor, "width");
    const height = metricNumber(sensor, "height");
    return [
      { label: "Frame size", value: width != null && height != null ? `${width} × ${height}` : "Waiting" },
      { label: "Frame rate", value: metricValue(sensor, "fps", " fps") },
      { label: "Dropped", value: metricValue(sensor, "droppedFrames", " frames") },
    ];
  }
  return [
    { label: "Latest", value: sensor.latestValue || "Waiting" },
    { label: "Sample rate", value: rate },
    { label: "Samples", value: formatCount(sensor.sampleCount) },
  ];
}

function sensorDisplayState(sensor: SensorChannel, now: number, online: boolean) {
  const age = sampleAgeMs(sensor, now);
  if (!online) return { key: "offline", label: "Agent offline", tone: "bad" };
  if (!sensor.hardwareDetected) return { key: "disconnected", label: "Not connected", tone: "bad" };
  if (!sensor.dataDetected) return { key: "waiting", label: "Waiting for data", tone: "attention" };
  if (age > 10000) return { key: "stalled", label: "Stream stalled", tone: "bad" };
  if (sensor.quality === "bad") return { key: "error", label: "Signal error", tone: "bad" };
  if (sensor.quality === "degraded") return { key: "degraded", label: "Signal degraded", tone: "attention" };
  return { key: "live", label: "Live", tone: "good" };
}

function sensorAction(sensor: SensorChannel, state: string) {
  if (state === "offline") return "Start or reconnect the acquisition agent.";
  if (state === "stalled") return "Check the device connection. No fresh samples are arriving.";
  if (state === "waiting") return sensor.id === "oximeter" ? "Confirm finger placement and wait for a valid pulse signal." : "Confirm the device is producing samples.";
  if (state === "disconnected") return "Connect the device or check its assignment in Recording setup.";
  return sensor.group === "video" || sensor.group === "audio" ? "Check OS camera or microphone permissions and close other capture apps. Open Recording setup for device details." : "Check the cable, driver and selected device. Open Recording setup for signal details, then run the readiness check again.";
}

function qualityText(sensor: SensorChannel) { if (sensor.quality === "good") return "Good"; if (sensor.quality === "degraded") return "Degraded"; if (sensor.quality === "bad") return "Poor"; if (sensor.quality === "disabled") return "Disabled"; return "Validating"; }
function sampleAgeMs(sensor: SensorChannel, now: number) { const updated = Date.parse(sensor.updatedAt); return Number.isFinite(updated) ? Math.max(0, now - updated) : Number.POSITIVE_INFINITY; }
function sampleAgeLabel(sensor: SensorChannel, now: number) { const age = sampleAgeMs(sensor, now); if (!sensor.dataDetected || !Number.isFinite(age)) return "No samples"; if (age < 1000) return "Now"; if (age < 60000) return `${Math.floor(age / 1000)} sec ago`; return `${Math.floor(age / 60000)} min ago`; }
function metricNumber(sensor: SensorChannel, key: string) { const value = sensor.metrics[key]; return typeof value === "number" && Number.isFinite(value) ? value : null; }
function metricValue(sensor: SensorChannel, key: string, suffix = "") { const value = sensor.metrics[key]; if (typeof value === "number" && Number.isFinite(value)) return `${Number.isInteger(value) ? value : value.toFixed(2)}${suffix}`; if (typeof value === "string" && value) return `${value}${suffix}`; return "Waiting"; }
function metricRate(sensor: SensorChannel, key: string) { const value = metricNumber(sensor, key); return value == null ? "Waiting" : value >= 1000 ? `${(value / 1000).toFixed(value % 1000 ? 1 : 0)} kHz` : `${formatRate(value)} Hz`; }
function formatCount(value: number) { return new Intl.NumberFormat(undefined, { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function sensorIcon(sensor: SensorChannel) { if (sensor.group === "video") return <Video size={17} />; if (sensor.group === "audio") return <Radio size={17} />; if (sensor.id === "oximeter") return <HeartPulse size={17} />; return <Activity size={17} />; }
function actionNotice(action: string) { if (action === "message") return "Instruction sent to subject"; if (action === "advance") return "Protocol advanced"; if (action === "pause") return "Session paused"; if (action === "resume") return "Session resumed"; if (action === "startSession") return "Recording started"; return "Session state saved"; }
function statusText(status: SessionSnapshot["status"]) { if (status === "setup") return "SESSION IN PREPARATION"; if (status === "running") return "LIVE SESSION"; if (status === "paused") return "SESSION PAUSED"; if (status === "complete") return "SESSION COMPLETE"; return "SESSION ENDED"; }
function durationLabel(step: ProtocolStep) { return step.durationSec ? clock(step.durationSec) : step.estimatedSec ? clock(step.estimatedSec) : "operator paced"; }
function isAgentOnline(snapshot: SessionSnapshot, now: number) { return Boolean(snapshot.acquisition.lastSeenAt && now - Date.parse(snapshot.acquisition.lastSeenAt) <= 10000); }
function sensorOperational(sensor: SensorChannel | undefined, now: number, online: boolean) { return Boolean(online && sensor?.dataDetected && sensor.quality === "good" && now - Date.parse(sensor.updatedAt) <= 10000); }
function timeLabel(value: string) { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function clock(seconds: number) { const value = Math.max(0, Math.round(seconds)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`; }
function formatRate(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(value < 100 ? 1 : 0); }
function formatBytes(value: number) { if (!value) return "0 MB"; if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`; if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`; return `${(value / 1073741824).toFixed(2)} GB`; }
function safeSnapshot(snapshot: SessionSnapshot) { const { acquisitionToken: omitted, ...safe } = snapshot; void omitted; return safe; }
function download(name: string, content: string, type: string) { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
