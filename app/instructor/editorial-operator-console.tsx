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
  RefreshCw,
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
import { buildPlan, shortLabel } from "@/lib/protocol";
import type { DeviceConfig, ProtocolStep, SensorChannel, SessionSnapshot } from "@/lib/types";

type WorkspaceTab = "overview" | "protocol" | "review";
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

async function listSessions() {
  const response = await fetch("/api/sessions?list=1", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to check previous sessions.");
  return (data.sessions || []) as HistoryItem[];
}

export function EditorialOperatorConsole({ operatorName }: { operatorName: string }) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [navOpen, setNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [notice, setNotice] = useState("Workspace synchronized");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const activeCode = useRef("");

  const accept = useCallback((next: SessionSnapshot) => {
    if (next.code !== activeCode.current) return;
    setSnapshot((current) => !current || current.code !== next.code || next.revision > current.revision ? next : current);
  }, []);

  const openSession = useCallback((next: SessionSnapshot) => {
    activeCode.current = next.code;
    setSnapshot(next);
    setTab(["complete", "aborted"].includes(next.status) ? "review" : "overview");
  }, []);

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
      if (["complete", "abort"].includes(action)) setTab("review");
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update the session.");
      return null;
    }
  }, [accept, code]);

  const navigateTo = useCallback(async (target: number) => {
    if (!snapshot || snapshot.status === "setup") return;
    const direction = target < snapshot.stepIndex ? -1 : 1;
    let cursor = snapshot;
    for (let index = 0; index < Math.abs(target - snapshot.stepIndex); index += 1) {
      const next = await api({ code: cursor.code, action: "navigate", payload: { direction } });
      cursor = next;
      accept(next);
    }
    setNotice("Protocol position saved");
  }, [accept, snapshot]);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeLedger = useCallback(() => setLedgerOpen(false), []);

  if (!snapshot) return <EditorialSessionEntry operatorName={operatorName} onOpen={openSession} />;

  const plan = buildPlan(snapshot.assignment);
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
              <SidebarButton active={tab === "overview"} icon={Monitor} label="Study overview" onClick={() => changeTab("overview")} />
              <SidebarButton active={tab === "protocol"} icon={ClipboardList} label="Protocol workspace" onClick={() => changeTab("protocol")} />
              <SidebarButton active={tab === "review"} icon={ScanLine} label="Recording review" onClick={() => changeTab("review")} />
            </nav>
            <div className="live-sidebar-footer">
              <span className={running ? "is-live" : "is-paused"}><Circle size={8} fill="currentColor" /> {statusText(snapshot.status)}</span>
              <button onClick={() => setSettingsOpen(true)}><Settings2 size={15} /> WORKSPACE SETTINGS</button>
            </div>
          </aside>

          <section className="live-instructor-main" id="workspace-content" tabIndex={-1}>
            <span className="sr-only" role="status">{notice}</span>
            {error ? <div className="live-workspace-error" role="alert">{error}</div> : null}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={tab} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }}>
                {tab === "overview" ? <Overview snapshot={snapshot} step={step} plan={plan} running={running} health={health} readyCount={readyCount} required={required} agentOnline={agentOnline} subjectOnline={subjectOnline} now={now} act={act} onSettings={() => setSettingsOpen(true)} /> : null}
                {tab === "protocol" ? <Protocol snapshot={snapshot} step={step} plan={plan} running={running} subjectOnline={subjectOnline} act={act} navigateTo={navigateTo} /> : null}
                {tab === "review" ? <Review snapshot={snapshot} required={required} now={now} onLedger={() => setLedgerOpen(true)} /> : null}
              </motion.div>
            </AnimatePresence>
          </section>
        </div>

        <AnimatePresence>
          {ledgerOpen ? <LedgerDialog snapshot={snapshot} onClose={closeLedger} /> : null}
          {settingsOpen ? <SettingsDialog snapshot={snapshot} now={now} act={act} onClose={closeSettings} /> : null}
        </AnimatePresence>
      </main>
    </MotionConfig>
  );
}

function EditorialSessionEntry({ operatorName, onOpen }: { operatorName: string; onOpen: (snapshot: SessionSnapshot) => void }) {
  const [participant, setParticipant] = useState("");
  const [existing, setExisting] = useState<HistoryItem | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const id = Number(participant);
    if (!Number.isSafeInteger(id) || id < 1) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      listSessions().then((items) => {
        if (cancelled) return;
        setExisting(items.find((item) => item.participant_id === id && ["setup", "running", "paused"].includes(item.status)) ?? null);
      }).catch(() => !cancelled && setError("Previous sessions could not be checked.")).finally(() => !cancelled && setChecking(false));
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [participant]);

  const start = async () => {
    const id = Number(participant);
    if (!Number.isSafeInteger(id) || id < 1) { setError("Enter a valid participant ID."); return; }
    setBusy(true); setError("");
    try { onOpen(await api({ action: "create", participantId: id, operator: operatorName })); }
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
        <form onSubmit={(event) => { event.preventDefault(); void (existing ? resume() : start()); }}>
          <WorkspaceLabel>New study session</WorkspaceLabel>
          <h1>Prepare the<br /><i>next study.</i></h1>
          <label htmlFor="participant-id">Participant ID</label>
          <input id="participant-id" inputMode="numeric" value={participant} onChange={(event) => { const value = event.target.value.replace(/\D/g, ""); setParticipant(value); setExisting(null); setChecking(Boolean(value)); setError(""); }} placeholder="0001" />
          <div className="live-entry-state" role="status">{checking ? "Checking previous sessions" : existing ? `Existing session ${existing.code} found` : participant ? "Ready to prepare session" : "Enter the participant identifier"}</div>
          {error ? <p className="live-entry-error" role="alert">{error}</p> : null}
          <button type="submit" disabled={busy || !participant}>{busy ? "PREPARING" : existing ? "RESUME SESSION" : "CONTINUE"}<ArrowUpRight size={16} /></button>
          {existing ? <button type="button" className="live-entry-secondary" onClick={() => { setExisting(null); void start(); }}>START A NEW ACQUISITION</button> : null}
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
  const setupReady = agentOnline && readyCount === required.length && snapshot.preflightTest.status === "pass";
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
      <div className="live-content-heading"><div><WorkspaceLabel>Session overview</WorkspaceLabel><h2>{snapshot.status === "setup" ? <>The study<br /><i>in preparation.</i></> : <>The study<br /><i>in progress.</i></>}</h2></div><div><span>SESSION {snapshot.code}</span><p>Operational clarity for the participant, protocol, and recording in front of you.</p></div></div>

      <section className="live-session-banner">
        <div><span className={running ? "live-active" : "live-active paused"}><Circle size={8} fill="currentColor" /> {statusText(snapshot.status)}</span><strong>P{String(snapshot.participantId).padStart(3, "0")} <em>·</em> {shortLabel(step)}</strong><small>Stage {String(snapshot.stepIndex + 1).padStart(2, "0")} of {String(plan.length).padStart(2, "0")} · {snapshot.operator}</small></div>
        <div className="live-banner-actions">
          {!['complete','aborted'].includes(snapshot.status) ? <button onClick={primaryAction}>{snapshot.status === "running" ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}{snapshot.status === "setup" ? setupReady ? " START SESSION" : " PREPARE RECORDING" : snapshot.status === "running" ? " PAUSE SESSION" : " RESUME SESSION"}</button> : null}
          <button disabled={snapshot.status !== "running" || snapshot.stepIndex >= plan.length - 1} onClick={() => void act("advance")}>ADVANCE <ChevronRight size={14} /></button>
        </div>
      </section>

      <div className="live-overview-cards">
        <article><WorkspaceLabel>Protocol progress</WorkspaceLabel><div className="live-progress-number"><b>{String(snapshot.stepIndex + 1).padStart(2, "0")}</b><span>of {String(plan.length).padStart(2, "0")}<br />stages</span></div><div className="live-progress-line"><i style={{ width: `${progress}%` }} /></div><small>Current: {shortLabel(step)} · {durationLabel(step)}</small></article>
        <article className="live-subject-card"><div><WorkspaceLabel>Subject display</WorkspaceLabel><b>One quiet task<br />at a time.</b><p>{step.subjectPrompt || "The subject display is waiting for the next instruction."}</p></div><Link href={`/subject?session=${snapshot.code}`} target="_blank">OPEN SUBJECT VIEW <ArrowUpRight size={14} /></Link><small className={subjectOnline ? "connected" : "waiting"}>{subjectOnline ? "DISPLAY CONNECTED" : "DISPLAY WAITING"}</small></article>
        <article className="live-health-card"><WorkspaceLabel>Recording health</WorkspaceLabel><div><b>{health}</b><span>%<small>{health === 100 ? "stable" : "ready"}</small></span></div><p className={health === 100 ? "good" : "attention"}>{health === 100 ? <Check size={14} /> : <Circle size={9} fill="currentColor" />} {readyCount} of {required.length} required streams ready.</p></article>
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
        <div className="live-interventions"><header><div><WorkspaceLabel>Interventions</WorkspaceLabel><h3>Operator channel</h3></div><span>SESSION CONTROLS</span></header><div className="live-intervention-actions"><button onClick={() => void act("log", { eventType: "comfort_check", label: "Comfort check requested", source: "operator" })}><HeartPulse size={15} /> COMFORT CHECK</button><button onClick={() => void act("log", { eventType: "operator_marker", label: "Protocol marker inserted", source: "operator" })}><Circle size={12} fill="currentColor" /> INSERT MARKER</button><button className="review" onClick={() => void act("log", { eventType: "review_flag", label: "Operator review requested", severity: "warn", source: "operator" })}>FLAG REVIEW</button></div><div className="live-message"><input value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") sendMessage(); }} placeholder="Short instruction to subject" aria-label="Send a subject message" /><button onClick={sendMessage} aria-label="Send subject message"><Send size={16} /></button></div><div className="live-message-presets">{CANNED_MESSAGES.map((text) => <button key={text} onClick={() => void act("message", { text })}>{text}</button>)}</div></div>
      </section>
    </section>
  );
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
      <div className="live-content-heading"><div><WorkspaceLabel>Protocol workspace</WorkspaceLabel><h2>Make each<br /><i>stage matter.</i></h2></div><div><span>{snapshot.protocolVersion.toUpperCase()}</span><p>A composed operational view for the live research sequence.</p></div></div>
      <div className="live-protocol-layout">
        <section className="live-protocol-list"><header><WorkspaceLabel>Session sequence</WorkspaceLabel><span>{String(snapshot.stepIndex + 1).padStart(2, "0")} / {String(plan.length).padStart(2, "0")}</span></header><div>{plan.map((item, index) => <button key={item.id} className={index === snapshot.stepIndex ? "current" : index < snapshot.stepIndex ? "complete" : ""} disabled={snapshot.status === "setup"} onClick={() => void navigateTo(index)}><span>{index < snapshot.stepIndex ? <Check size={14} /> : String(index + 1).padStart(2, "0")}</span><strong>{shortLabel(item)}</strong><small>{index === snapshot.stepIndex ? "Live now" : index < snapshot.stepIndex ? "Recorded" : "Queued"}</small></button>)}</div></section>
        <section className="live-stage-detail"><div><span>STAGE {String(snapshot.stepIndex + 1).padStart(2, "0")}</span><span>EST. {durationLabel(step)}</span></div><h3>{shortLabel(step)}</h3><p>{step.operatorScript}</p><blockquote><span>SUBJECT CUE</span>“{step.subjectPrompt || "Please wait for the instructor."}”</blockquote>
          {step.type === "gate" ? <fieldset className="live-context-control"><legend>Return-to-baseline check</legend>{["GSR near resting reference", "Heart rate near resting reference", "Subject settled and breathing regularly"].map((label, index) => <label key={label}><input type="checkbox" checked={checks[index]} onChange={(event) => setChecks((current) => current.map((value, item) => item === index ? event.target.checked : value))} />{label}</label>)}</fieldset> : null}
          {step.type === "nback" ? <fieldset className="live-context-control inline"><legend>N-back difficulty</legend>{[1, 2, 3].map((level) => <button className={snapshot.nbackLevel === level ? "selected" : ""} key={level} onClick={() => void act("nbackLevel", { level })}>{level}-back</button>)}</fieldset> : null}
          {step.bp ? <fieldset className="live-context-control bp"><legend>Blood pressure · {step.bpLabel}</legend><label>Systolic<input inputMode="numeric" value={sys} onChange={(event) => setSys(event.target.value.replace(/\D/g, ""))} /></label><label>Diastolic<input inputMode="numeric" value={dia} onChange={(event) => setDia(event.target.value.replace(/\D/g, ""))} /></label><label>Pulse<input inputMode="numeric" value={pulse} onChange={(event) => setPulse(event.target.value.replace(/\D/g, ""))} /></label><button disabled={!sys || !dia} onClick={() => { void act("bp", { label: step.bpLabel, systolic: Number(sys), diastolic: Number(dia), pulse: pulse ? Number(pulse) : null }); setSys(""); setDia(""); setPulse(""); }}>SAVE READING</button></fieldset> : null}
          <footer><button onClick={() => void act(running ? "pause" : "resume", running ? { reason: "Paused by operator" } : {})}>{running ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}{running ? " PAUSE SESSION" : " RESUME SESSION"}</button><button disabled={!canAdvance} onClick={() => void act("advance")}>ADVANCE <ChevronRight size={14} /></button></footer>
          <div className="live-stage-lower"><button disabled={snapshot.stepIndex === 0 || snapshot.status === "setup"} onClick={() => void act("navigate", { direction: -1 })}>PREVIOUS STAGE</button><span className={subjectOnline ? "connected" : "waiting"}>{subjectOnline ? "SUBJECT DISPLAY CONNECTED" : "SUBJECT DISPLAY WAITING"}</span></div>
        </section>
      </div>
    </section>
  );
}

function Review({ snapshot, required, now, onLedger }: { snapshot: SessionSnapshot; required: SensorChannel[]; now: number; onLedger: () => void }) {
  const artifacts = snapshot.recordings;
  const duration = artifacts.length ? Math.max(...artifacts.map((item) => item.durationSec)) : snapshot.recordingStartedAt ? Math.max(0, (now - Date.parse(snapshot.recordingStartedAt)) / 1000) : 0;
  const totalBytes = artifacts.reduce((sum, item) => sum + item.bytes, 0);
  const manifestReady = artifacts.length > 0 && artifacts.every((item) => item.quality !== "pending");
  const exportManifest = () => download(`${snapshot.code.toLowerCase()}-manifest.json`, JSON.stringify({ exportedAt: new Date().toISOString(), session: safeSnapshot(snapshot), recordings: artifacts }, null, 2), "application/json");
  return (
    <section className="live-workspace-content">
      <div className="live-content-heading"><div><WorkspaceLabel>Recording review</WorkspaceLabel><h2>Evidence,<br /><i>held clearly.</i></h2></div><div><span>CAPTURE {snapshot.code}</span><p>Review recording completeness and the operational ledger without leaving the study context.</p></div></div>
      <section className="live-review-summary"><article><WorkspaceLabel>Capture coverage</WorkspaceLabel><b>{clock(duration)}</b><small>{snapshot.status === "complete" ? "finalized duration" : "recorded so far"}</small></article><article><WorkspaceLabel>Storage</WorkspaceLabel><b>{formatBytes(totalBytes)} </b><small>{artifacts.length ? `${artifacts.length} finalized files` : "local acquisition volume"}</small></article><article><WorkspaceLabel>Manifest</WorkspaceLabel><b>{manifestReady ? "Ready" : "Pending"}</b><small className={manifestReady ? "good" : "attention"}>{manifestReady ? <Check size={13} /> : <Circle size={8} fill="currentColor" />} {manifestReady ? "recordings verified" : "awaiting final evidence"}</small></article></section>
      <section className="live-stream-register"><header><div><WorkspaceLabel>Collected streams</WorkspaceLabel><h3>Recording register</h3></div><button onClick={exportManifest}><Download size={14} /> EXPORT MANIFEST</button></header>{required.map((sensor) => { const artifact = artifacts.find((item) => item.sensorId === sensor.id); const quality = artifact?.quality || sensor.quality; return <article key={sensor.id}><i className={quality === "pass" || quality === "good" ? "good" : quality === "fail" || quality === "bad" ? "bad" : "attention"} />{sensorIcon(sensor)}<strong>{sensor.label}</strong><span>{artifact ? `${formatRate(artifact.averageRateHz)} Hz · ${artifact.availabilityPct.toFixed(1)}% available` : sensor.latestValue || sensor.detail}</span><small>{quality === "pass" || quality === "good" ? "COMPLETE" : String(quality).toUpperCase()}</small></article>; })}</section>
      <section className="live-review-ledger"><header><div><WorkspaceLabel>Operational record</WorkspaceLabel><h3>Session ledger</h3></div><button onClick={onLedger}>OPEN LEDGER <ArrowUpRight size={14} /></button></header>{snapshot.events.slice(-3).reverse().map((event) => <article key={event.id}><time>{timeLabel(event.createdAt)}</time><p>{event.label}</p><span>{event.eventType.replaceAll("_", " ").toUpperCase()}</span></article>)}</section>
    </section>
  );
}

function SettingsDialog({ snapshot, now, act, onClose }: { snapshot: SessionSnapshot; now: number; act: Act; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [devices, setDevices] = useState<DeviceConfig>(snapshot.deviceConfig);
  const [required, setRequired] = useState(snapshot.requiredSensors);
  useEffect(() => { closeRef.current?.focus(); const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); }, [onClose]);
  const online = isAgentOnline(snapshot, now);
  const setupSensors = snapshot.sensors.filter((sensor) => SETUP_SENSORS.includes(sensor.id));
  const save = async () => { await act("deviceConfig", { devices }); await act("requiredSensors", { ids: required }); };
  return <motion.div className="live-modal-overlay" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><section className="live-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><div><WorkspaceLabel>Workspace settings</WorkspaceLabel><h2 id="settings-title">Recording setup</h2></div><button ref={closeRef} onClick={onClose} aria-label="Close workspace settings"><X size={19} /></button></header><div className="live-settings-body"><section><h3>Acquisition computer</h3><div className="live-setting-status"><i className={online ? "good" : "bad"} /><span><strong>{online ? "Connected" : "Not connected"}</strong><small>{online ? snapshot.acquisition.host : "Start the local acquisition agent"}</small></span></div><dl><div><dt>Subject code</dt><dd>{snapshot.code}</dd></div><div><dt>Preflight</dt><dd>{snapshot.preflightTest.status}</dd></div><div><dt>Disk</dt><dd>{snapshot.acquisition.diskFreeGb == null ? "Not measured" : `${snapshot.acquisition.diskFreeGb.toFixed(1)} GB free`}</dd></div></dl><div className="live-settings-actions"><button disabled={!online || snapshot.configurationLocked} onClick={() => void act("refreshDevices")}><RefreshCw size={14} /> REFRESH DEVICES</button><button disabled={!online || snapshot.configurationLocked} onClick={() => void act("startPreflight")}>RUN PREFLIGHT</button>{snapshot.status === "setup" ? <button className="primary" disabled={snapshot.preflightTest.status !== "pass"} onClick={() => void act("startSession")}>START SESSION</button> : null}</div><details><summary>Technical connection</summary><code>python -m meridian_agent --server http://localhost:3000 --code {snapshot.code} --token {snapshot.acquisitionToken}</code></details></section><section><h3>Recording devices</h3><div className="live-device-settings">{setupSensors.map((sensor) => { const kind = sensor.group === "video" ? "video" : sensor.group === "audio" ? "audio" : "serial"; const options = snapshot.acquisition.inventory[kind]; const isRequired = required.includes(sensor.id); const selected = devices[sensor.id] || "none"; return <article key={sensor.id}><label className="live-required-toggle"><input aria-label={`Require ${sensor.label}`} type="checkbox" checked={isRequired} disabled={snapshot.configurationLocked} onChange={(event) => setRequired((items) => event.target.checked ? [...new Set([...items, sensor.id])] : items.filter((id) => id !== sensor.id))} /><span><strong>{sensor.label}</strong><small>{sensor.latestValue || sensor.detail}</small></span></label>{sensor.id === "ecg" ? <label className="live-api-device"><span>Frontier X live link</span><input aria-label="Frontier X live ECG link" value={selected === "none" || selected === "auto" ? "" : selected} disabled={snapshot.configurationLocked} onChange={(event) => setDevices((current) => ({ ...current, ecg: event.target.value || "none" }))} placeholder="Paste live ECG share link or user ID" /></label> : <select aria-label={`${sensor.label} device`} value={selected} disabled={snapshot.configurationLocked} onChange={(event) => setDevices((current) => ({ ...current, [sensor.id]: event.target.value }))}><option value="none">Not assigned</option><option value="auto">Auto-detect</option>{options.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}</article>; })}</div><button className="live-save-settings" disabled={snapshot.configurationLocked} onClick={() => void save()}>SAVE RECORDING SETUP</button></section></div><footer><button className="danger" onClick={() => { if (window.confirm(snapshot.status === "setup" ? "Discard this session?" : "End and finalize this session?")) void act(snapshot.status === "setup" ? "abort" : "complete"); }}>{snapshot.status === "setup" ? "DISCARD SESSION" : "END SESSION"}</button><span>Settings stay outside the normal operator workflow.</span></footer></section></motion.div>;
}

function LedgerDialog({ snapshot, onClose }: { snapshot: SessionSnapshot; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); }, [onClose]);
  const exportLedger = () => download(`${snapshot.code.toLowerCase()}-events.json`, JSON.stringify(snapshot.events, null, 2), "application/json");
  return <motion.div className="live-modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><section className="live-ledger" role="dialog" aria-modal="true" aria-labelledby="ledger-title"><header><div><WorkspaceLabel>Session ledger</WorkspaceLabel><h2 id="ledger-title">Operational record</h2></div><button ref={closeRef} onClick={onClose} aria-label="Close session ledger"><X size={18} /></button></header><div className="live-ledger-meta"><span>{snapshot.code}</span><span>P{String(snapshot.participantId).padStart(3, "0")}</span><span>{snapshot.protocolVersion}</span></div><div className="live-ledger-events">{snapshot.events.length ? [...snapshot.events].reverse().map((event) => <article key={event.id}><time>{timeLabel(event.createdAt)}</time><span>{event.source.toUpperCase()}</span><p><strong>{event.label}</strong>{event.detail ? <small>{event.detail}</small> : null}</p></article>) : <p>No events have been recorded yet.</p>}</div><footer><span>Entries are stored with this session.</span><button onClick={exportLedger}><Download size={14} /> EXPORT JSON</button></footer></section></motion.div>;
}

function WorkspaceLabel({ children }: { children: ReactNode }) { return <p className="live-workspace-label">{children}</p>; }
function SidebarButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: LucideIcon; label: string; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}><Icon size={17} /><span>{label}</span><ChevronRight size={15} /></button>; }

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
  if (state === "disconnected") return "Connect the device or check its assignment in Workspace settings.";
  return sensor.detail || "Inspect this channel before continuing.";
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
