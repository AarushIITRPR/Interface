/* eslint-disable @next/next/no-img-element -- live MJPEG sensor previews require a native image element. */
"use client";
import {
  Activity,
  ArrowDown,
  ArrowUp,
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
  SlidersHorizontal,
  Upload,
  Video,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { DEFAULT_PROTOCOL_OPTIONS, assignFor, buildPlan, defaultProtocolTemplate, estimateRemaining, shortLabel, timerStarted, waitsForStart, wordListIndexFor } from "@/lib/protocol";
import { WORD_LIST_EVENT } from "@/lib/tasks";
import { applyReply, latestSequence, type PartialSnapshot } from "@/lib/event-sync";
import { resolveBufferSlot, resolveClipSlot } from "@/lib/protocol-template";
import { EMOTIONS as CLIP_KINDS_EDITABLE } from "@/lib/types";
import { ARTIFACT_TYPES, BP_CUFF_ARTIFACT, BP_LIMITS, bpRecorded, CONSENT_FIELDS, CSI_CALIBRATION_SEC, consentReady, CSI_SETUP_FIELDS, PARTICIPANT_DEFAULTS, PARTICIPANT_FIELDS, missingParticipantFields, openArtifactSpans, startChecks, withConsentDefaults, type MetadataField, type StartCheck } from "@/lib/rig";
import { BpStepper } from "@/app/bp-stepper";
import { startTicker } from "@/lib/ticker";
import { SCREENING_QUESTIONS, screeningComplete, skippedSafetySteps } from "@/lib/safety";
import type { CohortOverview } from "@/lib/cohort";
import type { Assignment, DeviceConfig, ProtocolOptions, ProtocolSlot, ProtocolStep, ProtocolTemplate, SensorChannel, SessionSnapshot } from "@/lib/types";

type WorkspaceTab = "overview" | "protocol" | "builder" | "review" | "cohort";
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
const SETUP_SENSORS = ["face", "face2", "audio", "oximeter", "csi", "csi2", "emg", "gsr", "resp", "ecg", "thermal", "photodiode", "environment"];

async function api(body: Record<string, unknown>) {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to save the session.");
  return data.session as PartialSnapshot;
}

async function load(code: string, since?: number) {
  const query = since === undefined ? "" : `&since=${since}`;
  const response = await fetch(`/api/sessions?code=${encodeURIComponent(code)}${query}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Session not found.");
  return data.session as PartialSnapshot;
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
  const snapshotStatus = useRef<string | null>(null);
  useEffect(() => { snapshotStatus.current = snapshot?.status ?? null; }, [snapshot?.status]);

  // The snapshot on screen, readable synchronously. Replies are merged against it rather than inside a state updater,
  // which React may run later, and it tells each request which events are already held.
  const shownRef = useRef<SessionSnapshot | null>(null);
  const sinceFor = useCallback((sessionCode: string) => shownRef.current?.code === sessionCode ? latestSequence(shownRef.current) : undefined, []);

  /** Apply a reply if it is newer, and return the full snapshot the console now shows. */
  const accept = useCallback((next: PartialSnapshot): SessionSnapshot | null => {
    if (next.code !== activeCode.current) return null;
    const current = shownRef.current;
    const shown = applyReply(current, next);
    if (shown && shown !== current) {
      shownRef.current = shown;
      setSnapshot(shown);
    }
    return shown;
  }, []);

  const openSession = useCallback((next: SessionSnapshot) => {
    activeCode.current = next.code;
    shownRef.current = next;
    setSnapshot(next);
    setTab(["complete", "aborted"].includes(next.status) ? "review" : "overview");
  }, []);

  const code = snapshot?.code || "";
  const refresh = useCallback(async () => {
    if (!code) return;
    try { accept(await load(code, sinceFor(code))); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to refresh the workspace."); }
  }, [accept, code, sinceFor]);

  const heartbeat = useCallback(async () => {
    if (!code) return;
    try { accept(await api({ code, action: "heartbeat", since: sinceFor(code) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The workspace lost synchronization."); }
  }, [accept, code, sinceFor]);

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
    // Browsers throttle main-thread timers in background tabs, which would auto-pause the protocol. Worker timers are
    // not throttled the same way, so presence keeps flowing while the operator looks at another window.
    const stop = startTicker(5000, () => void heartbeat());
    return () => { window.clearTimeout(first); stop(); };
  }, [code, heartbeat]);

  const hiddenSince = useRef<number | null>(null);
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) { hiddenSince.current = Date.now(); return; }
      const away = hiddenSince.current ? Date.now() - hiddenSince.current : 0;
      hiddenSince.current = null;
      if (away > 10_000 && snapshotStatus.current && ["running", "paused"].includes(snapshotStatus.current)) {
        setNotice(`This tab was in the background for ${Math.round(away / 1000)} s. Keep the instructor console visible during the protocol.`);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const actRef = useRef<Act | null>(null);
  useEffect(() => {
    // Artifact hotkeys work in every workspace tab while the protocol runs, but never while typing in a field.
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (!snapshotStatus.current || !["running", "paused"].includes(snapshotStatus.current)) return;
      const type = ARTIFACT_TYPES.find((item) => item.key === event.key.toLowerCase());
      if (!type || !actRef.current) return;
      event.preventDefault();
      void actRef.current("artifact", { type: type.id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const act = useCallback<Act>(async (action, payload = {}) => {
    if (!code) return null;
    try {
      const reply = await api({ code, action, payload, since: sinceFor(code) });
      // Callers get the full, merged snapshot, never the partial reply.
      const next = accept(reply) ?? (reply.eventsSince === undefined ? reply : null);
      setError("");
      setNotice(actionNotice(action));
      window.setTimeout(() => setNotice("Workspace synchronized"), 2200);
      if (["complete", "abort"].includes(action)) setTab("review");
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update the session.");
      return null;
    }
  }, [accept, code, sinceFor]);
  useEffect(() => { actRef.current = act; }, [act]);

  const navigateTo = useCallback(async (target: number) => {
    if (!snapshot || snapshot.status === "setup") return;
    const direction = target < snapshot.stepIndex ? -1 : 1;
    let cursor = snapshot;
    for (let index = 0; index < Math.abs(target - snapshot.stepIndex); index += 1) {
      const next = accept(await api({ code: cursor.code, action: "navigate", payload: { direction }, since: sinceFor(cursor.code) }));
      if (next) cursor = next;
    }
    setNotice("Protocol position saved");
  }, [accept, sinceFor, snapshot]);

  // Open a session named in the URL, the convention the subject display already uses (subject-portal.tsx:138).
  // This is the only way into a specific session once the console is past its launcher, and it is what makes the
  // builder's demo links work without anything being typed.
  const [linkError, setLinkError] = useState("");
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("session")?.trim().toUpperCase();
    if (!requested || activeCode.current) return;
    let cancelled = false;
    load(requested)
      .then((next) => { if (!cancelled) openSession(next); })
      .catch(() => { if (!cancelled) setLinkError(`No session ${requested} could be opened.`); });
    return () => { cancelled = true; };
  }, [openSession]);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeLedger = useCallback(() => setLedgerOpen(false), []);

  if (!snapshot) return <EditorialSessionEntry operatorName={operatorName} onOpen={openSession} linkError={linkError} />;

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
            <SidebarButton active={tab === "builder"} icon={SlidersHorizontal} label="Protocol builder" onClick={() => changeTab("builder")} />
            <SidebarButton active={tab === "review"} icon={ScanLine} label="Recording review" onClick={() => changeTab("review")} />
            <SidebarButton active={tab === "cohort"} icon={Activity} label="Cohort" onClick={() => changeTab("cohort")} />
          </nav>
          <div className="live-sidebar-footer">
            <span className={snapshot.demo ? "is-demo" : running ? "is-live" : "is-paused"}><Circle size={8} fill="currentColor" /> {snapshot.demo ? `DEMO / ${statusText(snapshot.status)}` : statusText(snapshot.status)}</span>
            <button onClick={() => setSettingsOpen(true)}><Settings2 size={15} /> WORKSPACE SETTINGS</button>
          </div>
        </aside>

        <section className="live-instructor-main" id="workspace-content" tabIndex={-1}>
          <span className="sr-only" role="status">{notice}</span>
          {snapshot.demo ? <div className="live-demo-banner">DEMO RUN. No sensors, no consent, no screening. Nothing here counts toward the cohort.</div> : null}
          {error ? <div className="live-workspace-error" role="alert">{error}</div> : null}
          {/* The new tab renders at once and fades in; waiting for the old one to animate out made every switch lag. */}
          <div className="live-tab-panel" key={tab}>
            {tab === "overview" ? <Overview snapshot={snapshot} step={step} plan={plan} running={running} health={health} readyCount={readyCount} required={required} agentOnline={agentOnline} subjectOnline={subjectOnline} now={now} act={act} onSettings={() => setSettingsOpen(true)} /> : null}
            {tab === "protocol" ? <Protocol snapshot={snapshot} step={step} plan={plan} running={running} subjectOnline={subjectOnline} act={act} navigateTo={navigateTo} now={now} /> : null}
            {tab === "builder" ? <ProtocolBuilder assignment={snapshot.assignment} /> : null}
            {tab === "review" ? <Review snapshot={snapshot} required={required} now={now} onLedger={() => setLedgerOpen(true)} /> : null}
            {tab === "cohort" ? <CohortDashboard /> : null}
          </div>
        </section>
      </div>

      {ledgerOpen ? <LedgerDialog snapshot={snapshot} onClose={closeLedger} /> : null}
      {settingsOpen ? <SettingsDialog snapshot={snapshot} now={now} act={act} onClose={closeSettings} /> : null}
    </main>
  );
}

function EditorialSessionEntry({ operatorName, onOpen, linkError = "" }: { operatorName: string; onOpen: (snapshot: SessionSnapshot) => void; linkError?: string }) {
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
          {error || linkError ? <p className="live-entry-error" role="alert">{error || linkError}</p> : null}
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
  snapshot: SessionSnapshot; step: ProtocolStep; plan: readonly ProtocolStep[]; running: boolean; health: number; readyCount: number; required: SensorChannel[]; agentOnline: boolean; subjectOnline: boolean; now: number; act: Act; onSettings: () => void;
}) {
  const [message, setMessage] = useState("");
  const progress = Math.round(((snapshot.stepIndex + 0.35) / plan.length) * 100);
  const checks = startChecks(snapshot, now);
  const setupReady = checks.every((check) => check.ok);
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
      {snapshot.status === "setup" ? <StartChecklist checks={checks} onSettings={onSettings} /> : null}

      <div className="live-overview-cards">
        <article><WorkspaceLabel>Protocol progress</WorkspaceLabel><div className="live-progress-number"><b>{String(snapshot.stepIndex + 1).padStart(2, "0")}</b><span>of {String(plan.length).padStart(2, "0")}<br />stages</span></div><div className="live-progress-line"><i style={{ width: `${progress}%` }} /></div><small>Current: {shortLabel(step)} · {durationLabel(step)}</small></article>
        <article className="live-subject-card"><div><WorkspaceLabel>Subject display</WorkspaceLabel><b>One quiet task<br />at a time.</b><p>{step.subjectPrompt || "The subject display is waiting for the next instruction."}</p></div><Link href={`/subject?session=${snapshot.code}`} target="_blank">OPEN SUBJECT VIEW <ArrowUpRight size={14} /></Link><small className={subjectOnline ? "connected" : "waiting"}>{subjectOnline ? "DISPLAY CONNECTED" : "DISPLAY WAITING"}</small></article>
        <HeartRateAgreementCard snapshot={snapshot} />
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
        <ArtifactPanel snapshot={snapshot} act={act} />
      </section>
    </section>
  );
}

function Protocol({ snapshot, step, plan, running, subjectOnline, act, navigateTo, now }: { snapshot: SessionSnapshot; step: ProtocolStep; plan: readonly ProtocolStep[]; running: boolean; subjectOnline: boolean; act: Act; navigateTo: (index: number) => Promise<void>; now: number }) {
  const [settled, setSettled] = useState(false);
  const [note, setNote] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const gate = step.type === "gate" ? snapshot.gate : null;
  const needsOverride = gate?.status === "not_ready";
  const gateReady = step.type !== "gate" || (settled && (!needsOverride || overrideReason.trim().length > 0));
  const canAdvance = running && ["operator", "gate"].includes(step.advance) && gateReady;
  const skipped = skippedSafetySteps(snapshot.screening?.answers);
  const advanceStage = () => void act("advance", needsOverride ? { override: true, reason: overrideReason.trim() } : {}).then((next) => { if (next) { setSettled(false); setOverrideReason(""); } });
  // A repeat keeps the take that came before it: the export closes the current window as "repeated" and
  // opens the next one at attempt + 1, so both are kept apart. Cancelling the prompt repeats nothing.
  // Breathing steps hold their pacer until Start is pressed on the subject screen; the operator can start it too.
  const awaitingStart = running && waitsForStart(step) && !timerStarted(snapshot.events, step.id, snapshot.attempt);
  const repeatStage = () => { const reason = window.prompt("Why repeat this stage? The previous attempt is kept."); if (reason !== null) void act("repeat", { reason: reason.trim() }); };

  return (
    <section className="live-workspace-content">
      <div className="live-content-heading"><div><WorkspaceLabel>Protocol workspace</WorkspaceLabel><h2>Make each<br /><i>stage matter.</i></h2></div><div><span>{snapshot.protocolVersion.toUpperCase()}</span><p>A composed operational view for the live research sequence.</p></div></div>
      <div className="live-protocol-layout">
        <section className="live-protocol-list"><header><WorkspaceLabel>Session sequence</WorkspaceLabel><span>{String(snapshot.stepIndex + 1).padStart(2, "0")} / {String(plan.length).padStart(2, "0")}</span></header><div>{plan.map((item, index) => <button key={item.id} className={index === snapshot.stepIndex ? "current" : index < snapshot.stepIndex ? "complete" : ""} disabled={snapshot.status === "setup"} onClick={() => void navigateTo(index)}><span>{index < snapshot.stepIndex ? <Check size={14} /> : String(index + 1).padStart(2, "0")}</span><strong>{shortLabel(item)}</strong><small>{item.safetyKey && skipped[item.safetyKey] ? "Skipped by screening" : index === snapshot.stepIndex ? "Live now" : index < snapshot.stepIndex ? "Recorded" : "Queued"}</small></button>)}</div></section>
        <section className="live-stage-detail"><div><span>STAGE {String(snapshot.stepIndex + 1).padStart(2, "0")}</span><span>EST. {durationLabel(step)}</span></div><h3>{shortLabel(step)}</h3><p>{step.operatorScript}</p><blockquote><span>SUBJECT CUE</span>“{step.subjectPrompt || "Please wait for the instructor."}”</blockquote>
          {step.type === "gate" ? <fieldset className="live-context-control"><legend>Return-to-baseline check</legend><GatePhysiology gate={gate ?? null} /><label><input type="checkbox" checked={settled} onChange={(event) => setSettled(event.target.checked)} />Subject settled and breathing regularly</label>{needsOverride ? <label className="live-gate-override">Override reason<input value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} placeholder="Why continue before physiology has recovered?" /></label> : null}</fieldset> : null}
          {step.type === "nback" ? <fieldset className="live-context-control inline"><legend>N-back difficulty</legend>{[1, 2, 3].map((level) => <button className={snapshot.nbackLevel === level ? "selected" : ""} key={level} onClick={() => void act("nbackLevel", { level })}>{level}-back</button>)}</fieldset> : null}
          {step.bp ? <BloodPressurePanel snapshot={snapshot} step={step} plan={plan} act={act} now={now} /> : null}
          {step.type === "wordlist" ? <WordListPanel snapshot={snapshot} step={step} /> : null}
          <fieldset className="live-context-control notes">
            <legend>Observation</legend>
            <form onSubmit={(event) => { event.preventDefault(); const body = note.trim(); if (!body) return; void act("note", { body, category: "observation" }).then((next) => { if (next) setNote(""); }); }}>
              <input aria-label="Observation about this stage" value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="What did you notice? Saved with this stage and the time." />
              <button type="submit" disabled={!note.trim() || !["running", "paused"].includes(snapshot.status)}>ADD NOTE</button>
            </form>
            {snapshot.notes.filter((item) => item.stepId === step.id).slice(-4).map((item) => <p key={item.id}><time>{new Date(item.createdAt).toLocaleTimeString()}</time> {item.body}</p>)}
          </fieldset>
          <footer><button onClick={() => void act(running ? "pause" : "resume", running ? { reason: "Paused by operator" } : {})}>{running ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}{running ? " PAUSE SESSION" : " RESUME SESSION"}</button><button disabled={!canAdvance} onClick={advanceStage}>{needsOverride ? "ADVANCE WITH OVERRIDE" : "ADVANCE"} <ChevronRight size={14} /></button></footer>
          <div className="live-stage-lower"><button disabled={snapshot.stepIndex === 0 || snapshot.status === "setup"} onClick={() => void act("navigate", { direction: -1 })}>PREVIOUS STAGE</button><button disabled={!running} onClick={repeatStage}>REPEAT STAGE</button>{awaitingStart ? <button onClick={() => void act("startTimer", { expectedStepId: step.id })}>START BREATHING</button> : null}<span className={subjectOnline ? "connected" : "waiting"}>{awaitingStart ? "WAITING FOR SUBJECT TO PRESS START" : subjectOnline ? "SUBJECT DISPLAY CONNECTED" : "SUBJECT DISPLAY WAITING"}</span></div>
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
  const [devices, setDevices, clearDevices] = useDraft<DeviceConfig>(`${snapshot.code}:devices`, snapshot.deviceConfig);
  const [required, setRequired, clearRequired] = useDraft<string[]>(`${snapshot.code}:required`, snapshot.requiredSensors);
  const checks = startChecks(snapshot, now);
  useEffect(() => { closeRef.current?.focus(); const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); }, [onClose]);
  const online = isAgentOnline(snapshot, now);
  const setupSensors = snapshot.sensors.filter((sensor) => SETUP_SENSORS.includes(sensor.id));
  const save = async () => { if (await act("deviceConfig", { devices })) clearDevices(); if (await act("requiredSensors", { ids: required })) clearRequired(); };
  return <div className="live-modal-overlay" role="presentation"><section className="live-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><div><WorkspaceLabel>Workspace settings</WorkspaceLabel><h2 id="settings-title">Recording setup</h2></div><button ref={closeRef} onClick={onClose} aria-label="Close workspace settings"><X size={19} /></button></header><div className="live-settings-body"><section><h3>Acquisition computer</h3><div className="live-setting-status"><i className={online ? "good" : "bad"} /><span><strong>{online ? "Connected" : "Not connected"}</strong><small>{online ? snapshot.acquisition.host : "Start the local acquisition agent"}</small></span></div><dl><div><dt>Subject code</dt><dd>{snapshot.code}</dd></div><div><dt>Preflight</dt><dd>{snapshot.preflightTest.status}</dd></div><div><dt>Subject media</dt><dd>{subjectMediaLabel(snapshot)}</dd></div><div><dt>Disk</dt><dd>{snapshot.acquisition.diskFreeGb == null ? "Not measured" : `${snapshot.acquisition.diskFreeGb.toFixed(1)} GB free`}</dd></div></dl><div className="live-settings-actions"><button disabled={!online || snapshot.configurationLocked} onClick={() => void act("refreshDevices")}><RefreshCw size={14} /> REFRESH DEVICES</button><button disabled={!online || snapshot.configurationLocked} onClick={() => void act("startPreflight")}>RUN PREFLIGHT</button>{snapshot.status === "setup" ? <button className="primary" disabled={!checks.every((check) => check.ok)} onClick={() => void act("startSession")}>START SESSION</button> : null}</div>{snapshot.status === "setup" ? <StartChecklist checks={checks} /> : null}<details><summary>Technical connection</summary><p>Run once, from acquisition_agent. The agent refuses to start if another one is already recording this session.</p><code>MERIDIAN_URL={window.location.origin} ./start-linux.sh {snapshot.code} {snapshot.acquisitionToken}</code></details></section><ProtocolOptionsSection snapshot={snapshot} act={act} /><ConsentSection snapshot={snapshot} act={act} /><ParticipantSection snapshot={snapshot} act={act} /><ScreeningSection snapshot={snapshot} act={act} /><CsiSection snapshot={snapshot} act={act} /><section><h3>Recording devices</h3><div className="live-device-settings">{setupSensors.map((sensor) => { const kind = sensor.group === "video" ? "video" : sensor.group === "audio" ? "audio" : "serial"; const options = snapshot.acquisition.inventory[kind]; const isRequired = required.includes(sensor.id); const selected = devices[sensor.id] || "none"; return <article key={sensor.id}><label className="live-required-toggle"><input aria-label={`Require ${sensor.label}`} type="checkbox" checked={isRequired} disabled={snapshot.configurationLocked} onChange={(event) => setRequired((items) => event.target.checked ? [...new Set([...items, sensor.id])] : items.filter((id) => id !== sensor.id))} /><span><strong>{sensor.label}</strong><small>{sensor.latestValue || sensor.detail}</small></span></label>{sensor.id === "ecg" ? <label className="live-api-device"><span>Frontier X live link</span><input aria-label="Frontier X live ECG link" value={selected === "none" || selected === "auto" ? "" : selected} disabled={snapshot.configurationLocked} onChange={(event) => setDevices((current) => ({ ...current, ecg: event.target.value || "none" }))} placeholder="Paste live ECG share link or user ID" /></label> : <select aria-label={`${sensor.label} device`} value={selected} disabled={snapshot.configurationLocked} onChange={(event) => setDevices((current) => ({ ...current, [sensor.id]: event.target.value }))}><option value="none">Not assigned</option><option value="auto">Auto-detect</option>{selected !== "none" && selected !== "auto" && !options.some((item) => item.id === selected) ? <option value={selected}>Current: {selected}</option> : null}{options.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}</article>; })}</div><button className="live-save-settings" disabled={snapshot.configurationLocked} onClick={() => void save()}>SAVE RECORDING SETUP</button></section></div><footer><button className="danger" onClick={() => { if (window.confirm(snapshot.status === "setup" ? "Discard this session?" : "End and finalize this session?")) void act(snapshot.status === "setup" ? "abort" : "complete"); }}>{snapshot.status === "setup" ? "DISCARD SESSION" : "END SESSION"}</button><span>Settings stay outside the normal operator workflow.</span></footer></section></div>;
}

function LedgerDialog({ snapshot, onClose }: { snapshot: SessionSnapshot; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); }, [onClose]);
  const exportLedger = () => download(`${snapshot.code.toLowerCase()}-events.json`, JSON.stringify(snapshot.events, null, 2), "application/json");
  return <div className="live-modal-overlay"><section className="live-ledger" role="dialog" aria-modal="true" aria-labelledby="ledger-title"><header><div><WorkspaceLabel>Session ledger</WorkspaceLabel><h2 id="ledger-title">Operational record</h2></div><button ref={closeRef} onClick={onClose} aria-label="Close session ledger"><X size={18} /></button></header><div className="live-ledger-meta"><span>{snapshot.code}</span><span>P{String(snapshot.participantId).padStart(3, "0")}</span><span>{snapshot.protocolVersion}</span></div><div className="live-ledger-events">{snapshot.events.length ? [...snapshot.events].reverse().map((event) => <article key={event.id}><time>{timeLabel(event.createdAt)}</time><span>{event.source.toUpperCase()}</span><p><strong>{event.label}</strong>{event.detail ? <small>{event.detail}</small> : null}</p></article>) : <p>No events have been recorded yet.</p>}</div><footer><span>Entries are stored with this session.</span><button onClick={exportLedger}><Download size={14} /> EXPORT JSON</button></footer></section></div>;
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
/** Newer protocol revision wins; within one revision, the later server read carries fresher telemetry. */
function subjectMediaLabel(snapshot: SessionSnapshot) {
  const media = snapshot.subjectMedia;
  if (!media) return "Subject display not connected";
  if (media.ready) return `Loaded ${media.total} of ${media.total}`;
  return `Loading ${media.loaded} of ${media.total}${media.failed ? `, ${media.failed} failed` : ""}`;
}

function GatePhysiology({ gate }: { gate: SessionSnapshot["gate"] }) {
  if (!gate) return <p className="live-gate-status">Waiting for physiology.</p>;
  if (gate.status === "unavailable") return <p className="live-gate-status">No heart rate or skin conductance baseline was recorded, so recovery cannot be measured. Advancing will be logged as unverified.</p>;
  return <div className="live-gate-status">{gate.signals.map((signal) => <p key={signal.id} className={signal.within ? "good" : "attention"}><strong>{signal.label}</strong> {signal.current == null ? "no recent samples" : `${signal.current} ${signal.unit}`} · baseline {signal.baselineMean} ± {signal.tolerance} · {signal.within ? `within for ${Math.floor(Math.min(signal.heldSec, gate.holdSec))} of ${gate.holdSec} s` : "outside range"}</p>)}<p className={gate.status === "ready" ? "good" : "attention"}>{gate.status === "ready" ? "Returned to baseline." : "Not yet at baseline."}</p></div>;
}

/** Form entries survive closing the dialog or reloading the page until the server has them. */
function useDraft<T>(key: string, saved: T) {
  const storageKey = `meridian-draft:${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = typeof window === "undefined" ? null : window.localStorage.getItem(storageKey);
      if (raw) return JSON.parse(raw) as T;
    } catch { /* storage unavailable: fall back to the saved copy */ }
    return saved;
  });
  const update = useCallback((next: T | ((current: T) => T)) => {
    setValue((current) => {
      const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
      try { window.localStorage.setItem(storageKey, JSON.stringify(resolved)); } catch { /* storage unavailable */ }
      return resolved;
    });
  }, [storageKey]);
  const clear = useCallback(() => { try { window.localStorage.removeItem(storageKey); } catch { /* storage unavailable */ } }, [storageKey]);
  return [value, update, clear] as const;
}

function useAutoSave(enabled: boolean, save: () => Promise<SessionSnapshot | null>, onSaved: () => void, watch: unknown) {
  const saveRef = useRef(save);
  const savedRef = useRef(onSaved);
  useEffect(() => { saveRef.current = save; savedRef.current = onSaved; });
  const signature = JSON.stringify(watch);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => { void saveRef.current().then((next) => { if (next) savedRef.current(); }); }, 800);
    return () => window.clearTimeout(timer);
  }, [enabled, signature]);
}

function savedMatches(saved: Record<string, unknown> | undefined, draft: Record<string, unknown>) {
  if (!saved) return false;
  const keys = new Set([...Object.keys(saved), ...Object.keys(draft)].filter((key) => draft[key] !== "" && draft[key] !== undefined));
  return [...keys].every((key) => String(saved[key] ?? "") === String(draft[key] ?? ""));
}

function SaveState({ saved, pending }: { saved: boolean; pending: boolean }) {
  return <span className={`live-save-state ${saved ? "good" : "attention"}`}>{saved ? " Saved." : pending ? " Saving..." : " Not saved yet."}</span>;
}

function StartChecklist({ checks, onSettings }: { checks: StartCheck[]; onSettings?: () => void }) {
  const blocked = checks.filter((check) => !check.ok);
  return <div className="live-start-checklist" role="status"><p><strong>{blocked.length ? `Before START SESSION: ${blocked.length} item${blocked.length === 1 ? "" : "s"} left` : "Ready to start"}</strong>{blocked.length && onSettings ? <button onClick={onSettings}>OPEN RECORDING SETUP</button> : null}</p><ul>{checks.map((check) => <li key={check.id} className={check.ok ? "good" : "attention"}><span aria-hidden="true">{check.ok ? "✓" : "✗"}</span><b>{check.label}</b> {check.detail}</li>)}</ul></div>;
}

function ScreeningSection({ snapshot, act }: { snapshot: SessionSnapshot; act: Act }) {
  const [answers, setAnswers, clearDraft] = useDraft<Record<string, boolean>>(`${snapshot.code}:screening`, snapshot.screening?.answers ?? {});
  const locked = snapshot.status !== "setup";
  const complete = screeningComplete(answers);
  const saved = savedMatches(snapshot.screening?.answers, answers);
  // Saves by itself once every question has an answer, so nothing is lost if the dialog closes.
  const pending = complete && !locked && !saved;
  useAutoSave(pending, () => act("screening", { answers }), clearDraft, answers);
  const skipped = Object.keys(skippedSafetySteps(answers)).map((key) => key.replace("_", " "));
  return <section className="live-screening"><h3>Participant screening</h3><p>Ask each question aloud before recording. A yes skips the related physical steps for this participant. All No only saves the clicks.</p><button disabled={locked} onClick={() => setAnswers(() => Object.fromEntries(SCREENING_QUESTIONS.map((item) => [item.id, false])))}>ALL NO</button>{SCREENING_QUESTIONS.map((item) => <fieldset key={item.id} disabled={locked}><legend>{item.question} *</legend>{[true, false].map((value) => <label key={String(value)}><input type="radio" name={`screening-${item.id}`} checked={answers[item.id] === value} onChange={() => setAnswers((current) => ({ ...current, [item.id]: value }))} />{value ? "Yes" : "No"}</label>)}</fieldset>)}<p className={complete ? "good" : "attention"}>{!complete ? "Answer every question." : skipped.length ? `Will skip: ${skipped.join(", ")}.` : "No steps will be skipped."}<SaveState saved={saved} pending={pending} /></p><button disabled={locked || !complete} onClick={() => void act("screening", { answers })}>SAVE SCREENING</button></section>;
}

function ArtifactPanel({ snapshot, act }: { snapshot: SessionSnapshot; act: Act }) {
  const active = ["running", "paused"].includes(snapshot.status);
  const open = openArtifactSpans(snapshot.events);
  const recent = snapshot.events.filter((event) => event.eventType === "artifact").slice(-3).reverse();
  return <div className="live-artifacts"><header><div><WorkspaceLabel>Signal artifacts</WorkspaceLabel><h3>Label what you see</h3></div><span>KEYBOARD SHORTCUTS</span></header><div className="live-artifact-buttons">{ARTIFACT_TYPES.map((type) => <button key={type.id} disabled={!active} className={open.has(type.id) ? "open" : ""} onClick={() => void act("artifact", { type: type.id })} title={type.kind === "span" ? "Press to start, press again to end" : "Marks the last 3 s"}><kbd>{type.key.toUpperCase()}</kbd>{type.label}{type.kind === "span" ? (open.has(type.id) ? " · ON" : " · span") : ""}</button>)}</div>{recent.length ? <p>{recent.map((event) => `${timeLabel(event.createdAt)} ${event.label.replace("Artifact: ", "")}`).join("  ·  ")}</p> : <p>No artifacts labelled yet.</p>}</div>;
}

function FieldInputs({ fields, values, setValues, disabled, prefix }: { fields: readonly MetadataField[]; values: Record<string, string | number>; setValues: (update: (current: Record<string, string | number>) => Record<string, string | number>) => void; disabled: boolean; prefix: string }) {
  return <div className="live-field-grid">{fields.map((field) => <label key={field.id}><span>{field.label}{field.kind === "choice" && field.required ? " *" : ""}</span>{field.kind === "choice"
    ? <select aria-label={field.label} value={String(values[field.id] ?? "")} disabled={disabled} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}><option value="">Not set</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>
    : <span className="live-number-field"><input id={`${prefix}-${field.id}`} aria-label={field.label} inputMode="numeric" value={String(values[field.id] ?? "")} disabled={disabled} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value.replace(/[^0-9]/g, "") }))} />{field.unit ? <small>{field.unit}</small> : null}</span>}</label>)}</div>;
}

// The rig does not move between participants, so the last camera distances are the best default for the next one.
const DISTANCES_KEY = "meridian:lastDistances";
function lastDistances(): Record<string, string | number> {
  try { const saved = JSON.parse(window.localStorage.getItem(DISTANCES_KEY) ?? "{}"); return saved && typeof saved === "object" ? saved : {}; } catch { return {}; }
}
function rememberDistances(values: Record<string, string | number>) {
  const distances = Object.fromEntries(["cameraDistanceCm", "thermalDistanceCm"].filter((id) => values[id]).map((id) => [id, values[id]]));
  if (!Object.keys(distances).length) return;
  try { window.localStorage.setItem(DISTANCES_KEY, JSON.stringify(distances)); } catch { /* storage blocked: next session starts without them */ }
}

function ParticipantSection({ snapshot, act }: { snapshot: SessionSnapshot; act: Act }) {
  const [values, setValues, clearDraft] = useDraft<Record<string, string | number>>(`${snapshot.code}:participant`, snapshot.participantMetadata?.values ?? { ...PARTICIPANT_DEFAULTS, ...lastDistances() });
  const locked = ["complete", "aborted"].includes(snapshot.status);
  const missing = missingParticipantFields(values);
  const saved = savedMatches(snapshot.participantMetadata?.values, values);
  // The pre-filled answers are not saved on their own: autosave waits for skin type, age band and sex, which have no default.
  const pending = !locked && !saved && missing.length === 0;
  const save = () => { rememberDistances(values); return act("participantMetadata", { values }); };
  useAutoSave(pending, save, clearDraft, values);
  return <section className="live-rig-section"><h3>Participant details</h3><p>Categories only, no names or dates. Skin type and eyewear strongly affect camera and thermal signals.</p><FieldInputs fields={PARTICIPANT_FIELDS} values={values} setValues={setValues} disabled={locked} prefix="participant" /><p className={missing.length ? "attention" : "good"}>{missing.length ? `${missing.length} required fields (*) not set.` : "All required fields set."}<SaveState saved={saved} pending={pending} /></p><button disabled={locked} onClick={() => void save().then((next) => next && clearDraft())}>SAVE PARTICIPANT DETAILS</button></section>;
}

function CsiSection({ snapshot, act }: { snapshot: SessionSnapshot; act: Act }) {
  const [values, setValues, clearDraft] = useDraft<Record<string, string | number>>(`${snapshot.code}:csi`, snapshot.csiSetup?.values ?? {});
  const locked = ["complete", "aborted"].includes(snapshot.status);
  const saved = savedMatches(snapshot.csiSetup?.values, values);
  const pending = !locked && !saved && Object.keys(values).length > 0;
  useAutoSave(pending, () => act("csiSetup", { values }), clearDraft, values);
  const calibration = snapshot.csiCalibration;
  const csiAssigned = ["csi", "csi2"].some((id) => snapshot.deviceConfig[id] && snapshot.deviceConfig[id] !== "none");
  const status = !calibration ? "Not recorded" : calibration.status === "running" ? `Recording (${CSI_CALIBRATION_SEC} s)...` : calibration.status === "done" ? `Recorded ${calibration.rows} packets` : `Failed: ${calibration.detail}`;
  return <section className="live-rig-section"><h3>WiFi CSI setup</h3><p>Radio settings and geometry are needed to reproduce CSI results. Record the empty room before the participant sits down.</p><FieldInputs fields={CSI_SETUP_FIELDS} values={values} setValues={setValues} disabled={locked} prefix="csi" /><button disabled={locked} onClick={() => void act("csiSetup", { values }).then((next) => next && clearDraft())}>SAVE CSI SETUP</button><SaveState saved={saved} pending={pending} /><div className="live-calibration"><span className={calibration?.status === "done" ? "good" : calibration?.status === "failed" ? "attention" : ""}>Empty-room baseline: {status}</span><button disabled={snapshot.status !== "setup" || !csiAssigned || calibration?.status === "running"} onClick={() => void act("csiCalibration")}>RECORD EMPTY ROOM</button></div></section>;
}

function HeartRateAgreementCard({ snapshot }: { snapshot: SessionSnapshot }) {
  const agreement = snapshot.heartRateAgreement;
  const status = agreement?.status ?? "insufficient";
  const headline = status === "agree" ? `Within ${agreement?.spreadBpm} bpm` : status === "disagree" ? `${agreement?.spreadBpm} bpm apart` : "Need two sources";
  const advice = status === "disagree" ? "Check the finger clip, ECG strap contact, and that the face is lit and in view." : status === "agree" ? "Contact and contactless heart rate agree." : "Connect at least two of ECG, oximeter, or a visible face.";
  return <article className={`live-hr-card ${status}`}><WorkspaceLabel>Heart rate agreement</WorkspaceLabel><b>{headline}</b><ul>{(agreement?.sources ?? []).map((source) => <li key={source.id}><span>{source.label}</span><strong>{Math.round(source.bpm)} bpm</strong></li>)}</ul><p>{advice}</p></article>;
}

const PROTOCOL_OPTION_LABELS: Array<{ key: keyof ProtocolOptions; label: string; help: string }> = [
  { key: "questionnaires", label: "Questionnaires", help: "PANAS at start and end, TIPI at start, NASA-TLX after Stroop and N-back" },
  { key: "pacedBreathing", label: "Paced breathing", help: "60 s each at 6, 10, 15, and 20 breaths per minute" },
  { key: "extendedExertion", label: "Longer exertion", help: "60 s instead of 20 s, for a wider heart-rate range" },
  { key: "neutralClip", label: "Neutral control clip", help: "Clip, rating, and washout before Part 1, if a neutral clip is registered" },
  { key: "annotationReplay", label: "Continuous rating replay", help: "Replays every clip at the end with a valence-arousal marker (adds the clip durations)" },
  { key: "wordList", label: "Word list recall", help: "Study 10 words and recall them after Part 3, then recall again after the body scan (about 2.5 minutes)" },
];

function ProtocolOptionsSection({ snapshot, act }: { snapshot: SessionSnapshot; act: Act }) {
  const saved = snapshot.assignment.options;
  const [options, setOptions] = useState<ProtocolOptions>(saved ?? DEFAULT_PROTOCOL_OPTIONS);
  const editable = snapshot.status === "setup" && snapshot.stepIndex === 0 && Boolean(saved);
  const preview = buildPlan({ ...snapshot.assignment, options });
  const neutralMissing = options.neutralClip && !snapshot.assignment.stimuli?.neutral;
  return <section className="live-rig-section"><h3>Protocol options</h3><p>{saved ? "Choose the optional blocks for this session. They are fixed once recording starts." : "This session uses the earlier protocol without optional blocks."}</p>{PROTOCOL_OPTION_LABELS.map((item) => <label key={item.key} className="live-option"><input type="checkbox" aria-label={item.label} checked={Boolean(options[item.key])} disabled={!editable} onChange={(event) => setOptions((current) => ({ ...current, [item.key]: event.target.checked }))} /><span><strong>{item.label}</strong><small>{item.help}</small></span></label>)}{neutralMissing ? <p className="attention">No neutral clip is registered in lib/stimuli.ts, so the neutral block will be left out.</p> : null}<p className={editable ? "" : "attention"}>{preview.length} steps, about {Math.round(estimateRemaining(preview, 0) / 60)} minutes.</p><button disabled={!editable} onClick={() => void act("protocolOptions", { options })}>SAVE PROTOCOL OPTIONS</button></section>;
}

function ConsentSection({ snapshot, act }: { snapshot: SessionSnapshot; act: Act }) {
  const [values, setValues, clearDraft] = useDraft<Record<string, string | number>>(`${snapshot.code}:consent`, withConsentDefaults(snapshot.consent?.values));
  const ready = consentReady(values);
  const saved = savedMatches(snapshot.consent?.values, withConsentDefaults(values));
  // Sharing answers left unset are saved as "No"; saving starts as soon as participation is chosen.
  const pending = Boolean(values.participation) && !saved;
  useAutoSave(pending, () => act("consent", { values }), clearDraft, values);
  return <section className="live-rig-section"><h3>Consent and data sharing</h3><p>Record what the signed consent form allows. This can be updated later if the participant withdraws sharing permission.</p><button onClick={() => setValues(() => Object.fromEntries(CONSENT_FIELDS.map((field) => [field.id, "Yes"])))}>MARK ALL YES (PER SIGNED FORM)</button><FieldInputs fields={CONSENT_FIELDS} values={values} setValues={setValues} disabled={false} prefix="consent" /><p className={ready ? "good" : "attention"}>{!values.participation ? "Choose participation (*). Sharing answers default to No." : !ready ? "Recording is not allowed without participation consent." : "Consent recorded for this session."}<SaveState saved={saved} pending={pending} /></p><button onClick={() => void act("consent", { values }).then((next) => next && clearDraft())}>SAVE CONSENT</button></section>;
}

function CohortDashboard() {
  const [cohort, setCohort] = useState<CohortOverview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const load = () => fetch("/api/sessions?cohort=1", { cache: "no-store" }).then((response) => response.json()).then((data) => { if (!cancelled) { if (data.cohort) setCohort(data.cohort); else setError(data.error || "Unable to load the cohort."); } }).catch(() => !cancelled && setError("Unable to load the cohort."));
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  if (!cohort) return <section className="live-workspace-content"><p>{error || "Loading cohort..."}</p></section>;
  const maxCell = Math.max(1, ...cohort.coverage.flat());
  const download = () => {
    const header = Object.keys(cohort.sessions[0] ?? {});
    const rows = cohort.sessions.map((session) => header.map((key) => String((session as Record<string, unknown>)[key] ?? "")).join("\t"));
    const url = URL.createObjectURL(new Blob([[header.join("\t"), ...rows].join("\n")], { type: "text/tab-separated-values" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "meridian-cohort.tsv"; anchor.click(); URL.revokeObjectURL(url);
  };
  return <section className="live-workspace-content live-cohort">
    <div className="live-content-heading"><div><WorkspaceLabel>Cohort</WorkspaceLabel><h2>The dataset<br /><i>so far.</i></h2></div><div><span>{cohort.completedParticipants} PARTICIPANTS COMPLETE</span><p>Recruitment balance, counterbalancing coverage, and session quality across all sessions.</p></div></div>
    <div className="live-cohort-stats">{Object.entries(cohort.statusCounts).map(([status, total]) => <article key={status}><b>{total}</b><span>{status}</span></article>)}{cohort.duplicateParticipants.length ? <article className="attention"><b>{cohort.duplicateParticipants.length}</b><span>participants with repeat sessions: {cohort.duplicateParticipants.join(", ")}</span></article> : null}</div>
    <div className="live-cohort-grid">
      <article><WorkspaceLabel>Counterbalancing coverage</WorkspaceLabel><p>Completed sessions per emotion order (rows) and task order (columns). Aim for every cell.</p><table className="live-coverage"><thead><tr><th />{[1, 2, 3, 4, 5, 6].map((column) => <th key={column}>T{column}</th>)}</tr></thead><tbody>{cohort.coverage.map((row, index) => <tr key={index}><th>E{index + 1}</th>{row.map((value, column) => <td key={column} style={{ background: value ? `rgba(61,107,69,${0.2 + 0.8 * value / maxCell})` : undefined }}>{value || ""}</td>)}</tr>)}</tbody></table><small>{cohort.coverage.flat().filter((value) => value === 0).length} of 36 cells still empty.</small></article>
      {(["skinType", "sex", "ageBand"] as const).map((key) => <article key={key}><WorkspaceLabel>{key === "skinType" ? "Skin type (Fitzpatrick)" : key === "sex" ? "Sex" : "Age band"}</WorkspaceLabel><ul className="live-distribution">{Object.entries(cohort.distributions[key]).map(([label, total]) => <li key={label}><span>{label}</span><i style={{ width: `${Math.min(100, total * 100 / Math.max(1, cohort.completedParticipants))}%` }} /><b>{total}</b></li>)}</ul></article>)}
    </div>
    <article className="live-cohort-table"><header><WorkspaceLabel>Sessions</WorkspaceLabel><button onClick={download}><Download size={14} /> EXPORT TSV</button></header><div><table><thead><tr><th>Code</th><th>P</th><th>Status</th><th>Protocol</th><th>Min</th><th>Order</th><th>Skin</th><th>Details</th><th>Consent</th><th>Pauses</th><th>Overrides</th><th>Skipped</th><th>Artifacts</th><th>CSI baseline</th></tr></thead><tbody>{cohort.sessions.map((session) => <tr key={session.code}><td>{session.code}</td><td>{session.participantId}</td><td>{session.status}</td><td>{session.protocolVersion}</td><td>{session.durationMin ?? ""}</td><td>E{session.emotionRow}{session.taskRow ? `/T${session.taskRow}` : ""}</td><td>{session.skinType ?? ""}</td><td className={session.missingDetails ? "attention" : ""}>{session.missingDetails ? `${session.missingDetails} missing` : "complete"}</td><td className={session.consent ? "" : "attention"}>{session.consent ? "yes" : "no"}</td><td>{session.pauses}</td><td className={session.gateOverrides ? "attention" : ""}>{session.gateOverrides}</td><td>{session.skippedSteps}</td><td>{session.artifacts}</td><td>{session.csiBaseline}</td></tr>)}</tbody></table></div></article>
  </section>;
}

type MediaAsset = { id: string; object_key: string; filename: string; content_type: string; size: number; duration_sec: number | null };

/** Read a media file's real length in the browser. Workers cannot decode media, so this is the only measurement. */
function readDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const element = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
    const url = URL.createObjectURL(file);
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      element.removeAttribute("src");
      if (value) resolve(value); else reject(new Error("no duration"));
    };
    element.preload = "metadata";
    element.onloadedmetadata = () => done(Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null);
    element.onerror = () => done(null);
    element.src = url;
  });
}

/** Must stay in step with MAX_UPLOAD_MB in app/api/media/route.ts and the bodySizeLimit in next.config.ts. */
const MAX_UPLOAD_MB = 100;

/** A rejection from the runtime rather than the route is plain text, so parsing it as JSON throws over the throw. */
async function readJson(response: Response): Promise<{ error?: string; asset?: { id: string; key: string; filename: string } }> {
  const text = await response.text();
  try {
    return JSON.parse(text) as { error?: string };
  } catch {
    return { error: text.trim().slice(0, 200) || undefined };
  }
}

const fmt = (seconds: number | null | undefined) => seconds == null ? "not set" : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s` : `${Math.round(seconds * 10) / 10}s`;

/**
 * Edits the study's protocol: which steps run, in what order, for how long, and on which clips.
 *
 * Emotion clips stay slots. Which emotion lands in each is the participant's counterbalancing, so the preview shows
 * this session's assignment while the template itself stays participant independent.
 */
function ProtocolBuilder({ assignment }: { assignment: Assignment }) {
  const [template, setTemplate] = useState<ProtocolTemplate | null>(null);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Starts from the open session's participant, so a demo runs the same task and clip order as the session on screen.
  // A fixed "1" gave participant 1's N-back while the list above showed the open session's Stroop.
  const [previewPid, setPreviewPid] = useState(String(assignment.pid));
  const [addKey, setAddKey] = useState("");
  const [addAfter, setAddAfter] = useState("");
  const [preview_, setPreview_] = useState<{ code: string } | null>(null);

  const loadAssets = useCallback(() => fetch("/api/media", { cache: "no-store" }).then((r) => r.json()).then((data) => setAssets(data.assets ?? [])).catch(() => {}), []);
  useEffect(() => {
    void fetch("/api/protocol", { cache: "no-store" }).then((r) => r.json())
      .then((data) => { setTemplate(data.template ?? null); setStatus(data.saved ? "" : "Showing the built-in protocol. Saving creates your first version."); })
      .catch(() => setError("Unable to load the protocol."));
    void loadAssets();
  }, [loadAssets]);

  if (!template) return <section className="live-workspace-content"><p>{error || "Loading protocol..."}</p></section>;

  const edit = (next: Partial<ProtocolTemplate>) => { setTemplate({ ...template, ...next }); setStatus("Unsaved changes."); };
  const editSlot = (key: string, patch: Partial<ProtocolSlot>) => edit({ slots: template.slots.map((slot) => slot.key === key ? { ...slot, ...patch } : slot) });
  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= template.slots.length) return;
    const slots = [...template.slots];
    [slots[index], slots[target]] = [slots[target], slots[index]];
    edit({ slots });
  };
  const remove = (key: string) => edit({ slots: template.slots.filter((slot) => slot.key !== key) });
  // Every built-in step not already in the template, so a removed step can come back and new ones can be placed.
  const allOptions = Object.fromEntries(Object.keys(DEFAULT_PROTOCOL_OPTIONS).map((key) => [key, true])) as ProtocolOptions;
  const catalog = defaultProtocolTemplate(allOptions, assignment).slots;
  const missing = catalog.filter((slot) => !template.slots.some((item) => item.key === slot.key));
  const addStep = () => {
    const slot = catalog.find((item) => item.key === addKey);
    if (!slot) return;
    const after = template.slots.findIndex((item) => item.key === addAfter);
    const slots = [...template.slots];
    slots.splice(after + 1, 0, structuredClone(slot));
    edit({ slots });
    setAddKey("");
  };
  const slotName = (slot: ProtocolSlot) => slot.title || `${slot.type}${slot.clipSlot ? ` (${slot.clipSlot})` : slot.bufferSlot ? ` (task ${slot.bufferSlot})` : ""}`;

  const preview = buildPlan({ ...assignment, protocol: template });
  const demoPid = Number(previewPid);
  const demoTasks = Number.isSafeInteger(demoPid) && demoPid >= 1
    ? buildPlan({ ...assignFor(demoPid), protocol: template }).filter((step) => ["stroop", "nback", "conversation"].includes(step.type)).map((step) => step.title)
    : [];
  const warnings = [
    ...template.slots.filter((slot) => slot.minDurationSec && (slot.durationSec ?? 0) < slot.minDurationSec)
      .map((slot) => `${slot.title || slot.key} is under its ${slot.minDurationSec}s floor.`),
    ...CLIP_KINDS_EDITABLE.filter((clip) => !template.clips?.[clip]?.src).map((clip) => `No clip file for ${clip}.`),
  ];

  const save = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/protocol", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ template }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save the protocol.");
      setTemplate(data.template); setStatus(`Saved as version ${data.template.version}. New sessions will use it.`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not save the protocol."); }
    finally { setBusy(false); }
  };

  const upload = async (file: File, apply: (asset: MediaAsset, durationSec: number) => void) => {
    setBusy(true); setError("");
    try {
      let durationSec = 0;
      try { durationSec = await readDuration(file); }
      catch { throw new Error(`Could not read the length of ${file.name}. It may be corrupt or in a format this browser cannot play.`); }
      // Checked here as well as on the server so a 60 MB file is not sent twice over to be refused, and so the
      // reason names the file and its size.
      if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        throw new Error(`${file.name} is ${(file.size / 1e6).toFixed(0)} MB. The limit is ${MAX_UPLOAD_MB} MB; re-encode it with scripts/normalize-media.sh first.`);
      }
      const body = new FormData(); body.append("file", file); body.append("durationSec", String(durationSec));
      const response = await fetch("/api/media", { method: "POST", body });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.error || `Upload failed (${response.status}).`);
      if (!data.asset) throw new Error("The upload succeeded but returned nothing to use.");
      await loadAssets();
      apply({ id: data.asset.id, object_key: data.asset.key, filename: data.asset.filename, content_type: file.type, size: file.size, duration_sec: durationSec }, durationSec);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Upload failed."); }
    finally { setBusy(false); }
  };

  const assetUrl = (asset: MediaAsset) => `/api/media?key=${encodeURIComponent(asset.object_key)}`;

  // Runs the draft, not the saved template, so an edit can be walked through before it becomes what every future
  // participant gets. A demo needs no agent, consent or screening, and stays out of the cohort.
  const startPreview = async () => {
    const pid = Number(previewPid);
    if (!Number.isSafeInteger(pid) || pid < 1) { setError("Enter a participant number to preview."); return; }
    setBusy(true); setError(""); setPreview_(null);
    try {
      const response = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create", participantId: pid, operator: "Demo run", demo: true, protocol: template }) });
      const data = await readJson(response) as { error?: string; session?: { code: string } };
      if (!response.ok || !data.session) throw new Error(data.error || `Could not start the demo (${response.status}).`);
      setPreview_({ code: data.session.code });
      setStatus("");
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not start the demo."); }
    finally { setBusy(false); }
  };

  return <section className="live-workspace-content live-builder">
    <div className="live-content-heading">
      <div><WorkspaceLabel>Protocol builder</WorkspaceLabel><h2>The protocol,<br /><i>as you want it.</i></h2></div>
      <div><span>{preview.length} STEPS · ABOUT {Math.round(estimateRemaining(preview, 0) / 60)} MINUTES</span>
        <p>Order, timings and clips for every future session. Sessions already created keep the version they started with, so editing here never changes a recording that has happened.</p></div>
    </div>

    {error ? <p className="live-builder-error" role="alert">{error}</p> : null}
    {status ? <p className="live-builder-status" role="status">{status}</p> : null}
    {warnings.length ? <ul className="live-builder-warnings">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}

    <article className="live-builder-clips">
      <header><WorkspaceLabel>Clips</WorkspaceLabel><p>Each clip&apos;s length is read from the file, so the step timing follows whatever you upload.</p></header>
      <table><thead><tr><th>Clip</th><th>File</th><th>Length</th><th /></tr></thead><tbody>
        {CLIP_KINDS_EDITABLE.map((clip) => {
          const current = template.clips?.[clip];
          return <tr key={clip}>
            <td><strong>{clip}</strong></td>
            <td>{current?.src ? <code>{current.src.split("/").pop()}</code> : <em>none</em>}</td>
            <td>{fmt(current?.durationSec)}</td>
            <td>
              <label className="live-builder-upload">
                <Upload size={13} /> {current ? "REPLACE" : "UPLOAD"}
                <input type="file" accept="video/*,audio/*" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file, (asset, durationSec) => edit({ clips: { ...template.clips, [clip]: { assetId: asset.id, src: assetUrl(asset), durationSec } } })); }} />
              </label>
              {assets.length ? <select aria-label={`Existing file for ${clip}`} value="" disabled={busy} onChange={(event) => { const asset = assets.find((item) => item.id === event.target.value); if (asset?.duration_sec) edit({ clips: { ...template.clips, [clip]: { assetId: asset.id, src: assetUrl(asset), durationSec: asset.duration_sec } } }); }}>
                <option value="">Use an uploaded file</option>
                {assets.filter((asset) => asset.duration_sec).map((asset) => <option key={asset.id} value={asset.id}>{asset.filename} ({fmt(asset.duration_sec)})</option>)}
              </select> : null}
            </td>
          </tr>;
        })}
      </tbody></table>
    </article>

    <article className="live-builder-steps">
      <header><WorkspaceLabel>Steps</WorkspaceLabel><p>Preview shows participant {assignment.pid}. Clip and task slots are filled by counterbalancing, so they differ per participant.</p></header>
      {missing.length ? <div className="live-builder-add">
        <label>Add a step<select value={addKey} onChange={(event) => setAddKey(event.target.value)}>
          <option value="">Choose a step</option>
          {missing.map((slot) => <option key={slot.key} value={slot.key}>{slotName(slot)} · {slot.phase}</option>)}
        </select></label>
        <label>after<select value={addAfter} onChange={(event) => setAddAfter(event.target.value)}>
          <option value="">the start</option>
          {template.slots.map((slot, index) => <option key={slot.key} value={slot.key}>{index + 1}. {slotName(slot)}</option>)}
        </select></label>
        <button type="button" disabled={!addKey} onClick={addStep}>ADD</button>
      </div> : null}
      <ol>
        {template.slots.map((slot, index) => {
          const clip = slot.clipSlot ? resolveClipSlot(assignment, slot.clipSlot) : undefined;
          const task = slot.bufferSlot ? resolveBufferSlot(assignment, slot.bufferSlot) : undefined;
          const filled = slot.bufferSlot && slot.type !== "questionnaire" ? template.tasks?.[task!] : null;
          const tooShort = Boolean(slot.minDurationSec && (slot.durationSec ?? 0) < slot.minDurationSec);
          const mediaKey = slot.mediaKey;
          return <li key={slot.key} className={tooShort ? "attention" : ""}>
            <div className="live-builder-step-head">
              <span className="live-builder-order">{index + 1}</span>
              <div>
                <strong>{filled?.title || slot.title || `${slot.type} slot`}</strong>
                <small>{slot.phase} · {slot.type}{clip ? ` · ${clip} for this participant` : ""}{task ? ` · ${task} for this participant` : ""}</small>
              </div>
              <div className="live-builder-step-actions">
                <button aria-label={`Move ${slot.key} earlier`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></button>
                <button aria-label={`Move ${slot.key} later`} disabled={index === template.slots.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></button>
                <button aria-label={`Remove ${slot.key}`} onClick={() => remove(slot.key)}><X size={14} /></button>
              </div>
            </div>
            <div className="live-builder-step-fields">
              {slot.clipSlot
                ? <span className="live-builder-derived">Length from the clip file: {fmt(clip ? template.clips?.[clip]?.durationSec : null)}</span>
                : <label>Seconds<input type="number" min={0} step={1} value={(filled ?? slot).durationSec ?? ""} placeholder="no timer"
                    onChange={(event) => {
                      const value = event.target.value === "" ? undefined : Number(event.target.value);
                      if (filled && task) edit({ tasks: { ...template.tasks, [task]: { ...filled, durationSec: value, estimatedSec: value ?? filled.estimatedSec } } });
                      else editSlot(slot.key, { durationSec: value, estimatedSec: value ?? slot.estimatedSec });
                    }} /></label>}
              {slot.minDurationSec ? <span className={tooShort ? "attention" : ""}>Floor {slot.minDurationSec}s</span> : null}
              {mediaKey ? <label>Media<select value={template.media?.[mediaKey] ?? ""} onChange={(event) => edit({ media: { ...template.media, [mediaKey]: event.target.value } })}>
                <option value="">None</option>
                {(() => { const current = template.media?.[mediaKey]; return current && !assets.some((asset) => assetUrl(asset) === current) ? <option value={current}>{current.split("/").pop()}</option> : null; })()}
                {assets.map((asset) => <option key={asset.id} value={assetUrl(asset)}>{asset.filename}</option>)}
              </select></label> : null}
            </div>
          </li>;
        })}
      </ol>
    </article>

    <article className="live-builder-preview">
      <header><WorkspaceLabel>Try it</WorkspaceLabel><p>Walks these steps with no sensors, consent or screening. Runs what is on screen now, saved or not, and is never counted in the cohort.</p></header>
      <div>
        <label>Preview as participant<input type="number" min={1} value={previewPid} disabled={busy} onChange={(event) => setPreviewPid(event.target.value.replace(/\D/g, ""))} /></label>
        <button disabled={busy} onClick={() => void startPreview()}>{busy ? "STARTING" : "START DEMO RUN"}</button>
      </div>
      {demoTasks.length ? <small>Participant {demoPid} gets: {demoTasks.join(", ")}.</small> : null}
      {preview_ ? <div className="live-builder-preview-open">
        {/* Both links carry the code, so nothing has to be typed. The console opens in its own tab rather than
            taking this one over, which may be sitting on a real session. */}
        <p>Demo session <strong className="mono">{preview_.code}</strong> is ready. Open both, then step through it from the console tab.</p>
        <div className="live-builder-preview-links">
          <a href={`/instructor?session=${encodeURIComponent(preview_.code)}`} target="_blank" rel="noreferrer">1. OPEN CONSOLE FOR THIS DEMO <ArrowUpRight size={13} /></a>
          <a href={`/subject?session=${encodeURIComponent(preview_.code)}`} target="_blank" rel="noreferrer">2. OPEN SUBJECT DISPLAY <ArrowUpRight size={13} /></a>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(preview_.code).then(() => setStatus(`Copied ${preview_.code}.`)).catch(() => setStatus(`Session code is ${preview_.code}.`)); }}>COPY CODE</button>
        </div>
        <small>This tab stays on whatever session it already had. Close the demo tabs when you are done.</small>
      </div> : null}
    </article>

    <div className="live-builder-save">
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? "SAVING" : "SAVE PROTOCOL"}</button>
      <button disabled={busy} onClick={() => { setTemplate(defaultProtocolTemplate(assignment.options ?? DEFAULT_PROTOCOL_OPTIONS, assignment)); setStatus("Reset to the built-in protocol. Not saved yet."); }}>RESET TO DEFAULT</button>
      <small>Saving writes a new version. Sessions already created are unaffected.</small>
    </div>
  </section>;
}

/**
 * Blood pressure entry. INFLATE opens a "BP cuff" artifact span and saving the reading closes it, so the seconds the
 * cuff was squeezing the arm - a sympathetic stimulus in a study of sympathetic responses - can be excluded later.
 */
function BloodPressurePanel({ snapshot, step, plan, act, now }: { snapshot: SessionSnapshot; step: ProtocolStep; plan: readonly ProtocolStep[]; act: Act; now: number }) {
  const [sys, setSys] = useState<number | null>(BP_LIMITS.systolic.start);
  const [dia, setDia] = useState<number | null>(BP_LIMITS.diastolic.start);
  const [pulse, setPulse] = useState<number | null>(null);
  const inflating = openArtifactSpans(snapshot.events).has(BP_CUFF_ARTIFACT);
  const cuffStart = inflating ? [...snapshot.events].reverse().find((event) => event.eventType === "artifact" && event.metadata?.type === BP_CUFF_ARTIFACT && event.metadata?.kind === "start") : undefined;
  const cuffSec = cuffStart ? Math.max(0, Math.round((now - Date.parse(cuffStart.createdAt)) / 1000)) : 0;
  const bpSteps = plan.filter((item) => item.bp);
  const position = bpSteps.findIndex((item) => item.id === step.id) + 1;
  const active = ["running", "paused"].includes(snapshot.status);
  const recorded = bpRecorded(snapshot.bpReadings, step.id, snapshot.attempt);
  const latest = [...snapshot.bpReadings].reverse().find((reading) => reading.stepId === step.id && (reading.attempt ?? 1) === snapshot.attempt);
  const valid = sys !== null && dia !== null && sys > dia;
  const save = () => {
    void act("bp", { label: step.bpLabel, systolic: sys, diastolic: dia, pulse }).then((next) => {
      if (next) { setSys(BP_LIMITS.systolic.start); setDia(BP_LIMITS.diastolic.start); setPulse(null); }
    });
  };
  return <fieldset className="live-context-control bp">
    <legend>Blood pressure · reading {position} of {bpSteps.length} · {step.bpLabel}</legend>
    <p className="live-bp-hint">Non-dominant arm, supported at heart level, feet flat. No talking while the cuff inflates.</p>
    <div className="live-bp-cuff">
      <button type="button" disabled={!active || inflating} onClick={() => void act("artifact", { type: BP_CUFF_ARTIFACT })}>{inflating ? "INFLATING" : "INFLATE"}</button>
      <span>{inflating ? `Cuff on ${cuffSec} s` : "Press as the cuff starts inflating"}</span>
    </div>
    {latest ? <p className="live-bp-saved">Saved by {latest.source === "subject" ? "participant" : "operator"}: <strong>{latest.systolic}/{latest.diastolic}</strong>{latest.pulse != null ? `, pulse ${latest.pulse}` : ""}</p>
      : <p className="live-bp-saved">{step.durationSec ? "Participant enters the reading on their screen when the timer ends, or save it here." : "Participant enters the reading on their screen, or save it here."}</p>}
    <BpStepper label="Systolic" value={sys} onChange={setSys} {...BP_LIMITS.systolic} />
    <BpStepper label="Diastolic" value={dia} onChange={setDia} {...BP_LIMITS.diastolic} />
    <BpStepper label="Pulse" unit="optional" value={pulse} onChange={setPulse} {...BP_LIMITS.pulse} />
    <button disabled={!valid} onClick={save}>{recorded ? "SAVE ANOTHER READING" : "SAVE READING"}</button>
  </fieldset>;
}

/** What the operator needs during the word list: which list is in play, and the score once it lands. */
function WordListPanel({ snapshot, step }: { snapshot: SessionSnapshot; step: ProtocolStep }) {
  const list = wordListIndexFor(snapshot.assignment) + 1;
  const result = [...snapshot.events].reverse().find((event) => event.eventType === WORD_LIST_EVENT && event.stepId === step.id)?.metadata;
  return <fieldset className="live-context-control wordlist">
    <legend>Word list {list} · study and recognise</legend>
    {result ? <p>
      <strong>{String(result.hits)}/{String(Number(result.hits) + Number(result.misses))}</strong> recognised
      {` · ${String(result.falseAlarms)} look-alike${Number(result.falseAlarms) === 1 ? "" : "s"} wrongly accepted`}
      {` · d′ ${String(result.dPrime)}`}
      {result.meanRtMs != null ? ` · ${String(result.meanRtMs)} ms per word` : ""}
    </p> : <p>Waiting for the participant. The score appears here when they finish.</p>}
  </fieldset>;
}
