"use client";
/* eslint-disable @next/next/no-img-element -- MJPEG sensor previews require native img elements. */

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildPlan, shortLabel } from "@/lib/protocol";
import type {
  DeviceConfig,
  DeviceInventoryItem,
  MediaConfig,
  ProtocolStep,
  RecordingArtifact,
  SensorChannel,
  SessionSnapshot,
} from "@/lib/types";

type Mode = "setup" | "monitor" | "protocol" | "review";
type Act = (action: string, payload?: Record<string, unknown>) => Promise<void>;
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

const SETUP_SENSOR_IDS = ["face", "audio", "oximeter", "csi", "emg", "gsr", "ecg", "thermal"];
const CANNED_MESSAGES = ["Please wait a moment.", "Keep still.", "You can continue.", "Please look at the screen."];

async function api(body: Record<string, unknown>) {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to save.");
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
  if (!response.ok) throw new Error(data.error || "Unable to check existing sessions.");
  return (data.sessions || []) as HistoryItem[];
}

export function OperatorConsole({ operatorName }: { operatorName: string }) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [mode, setMode] = useState<Mode>("setup");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const activeCode = useRef("");

  const acceptSnapshot = useCallback((next: SessionSnapshot) => {
    if (next.code !== activeCode.current) return;
    setSnapshot((current) => (!current || current.code !== next.code || next.revision > current.revision ? next : current));
  }, []);

  const switchSession = useCallback((next: SessionSnapshot) => {
    activeCode.current = next.code;
    setSnapshot(next);
  }, []);

  const code = snapshot?.code || "";
  const refresh = useCallback(async () => {
    if (!code) return;
    try {
      acceptSnapshot(await load(code));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to refresh.");
    }
  }, [acceptSnapshot, code]);

  const heartbeat = useCallback(async () => {
    if (!code) return;
    try {
      acceptSnapshot(await api({ code, action: "heartbeat" }));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to keep the session connected.");
    }
  }, [acceptSnapshot, code]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!code) return;
    const first = window.setTimeout(refresh, 0);
    const id = window.setInterval(refresh, 1800);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [code, refresh]);

  useEffect(() => {
    if (!code) return;
    const first = window.setTimeout(heartbeat, 0);
    const id = window.setInterval(heartbeat, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [code, heartbeat]);

  const act = useCallback<Act>(async (action, payload = {}) => {
    if (!code) return;
    try {
      const next = await api({ code, action, payload });
      acceptSnapshot(next);
      setError("");
      if (action === "startSession") setMode("monitor");
      if (["complete", "abort"].includes(action)) setMode("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save.");
    }
  }, [acceptSnapshot, code]);

  const openSession = useCallback((session: SessionSnapshot) => {
    switchSession(session);
    setMode(session.status === "setup" ? "setup" : ["complete", "aborted"].includes(session.status) ? "review" : "monitor");
  }, [switchSession]);

  if (!snapshot) {
    return (
      <SessionEntry
        defaultOperator={operatorName}
        onStarted={openSession}
        onRestore={async (value) => openSession(await load(value))}
      />
    );
  }

  const agentOnline = isAgentOnline(snapshot, now);
  const healthyRequired = snapshot.requiredSensors.filter((id) =>
    sensorOperational(snapshot.sensors.find((item) => item.id === id), now, agentOnline),
  ).length;
  const subjectOnline = Boolean(snapshot.subjectLastSeenAt && now - Date.parse(snapshot.subjectLastSeenAt) < 11000);
  const elapsed = snapshot.recordingStartedAt ? Math.max(0, (now - Date.parse(snapshot.recordingStartedAt)) / 1000) : 0;
  const warnings = buildWarnings(snapshot, now);

  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
      <main className="operator-shell">
        <OperatorHeader
          snapshot={snapshot}
          elapsed={elapsed}
          mode={mode}
          setMode={setMode}
          warnings={warnings.length}
          healthyRequired={healthyRequired}
          agentOnline={agentOnline}
          act={act}
          onDiagnostics={() => setDiagnosticsOpen(true)}
        />

        {error ? <div className="operator-error" role="alert">{error}</div> : null}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            className="operator-view"
            key={mode}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
          >
            {mode === "setup" ? <SetupMode key={`${snapshot.code}-${snapshot.configRevision}`} snapshot={snapshot} act={act} now={now} subjectOnline={subjectOnline} /> : null}
            {mode === "monitor" ? <MonitorMode snapshot={snapshot} act={act} now={now} subjectOnline={subjectOnline} /> : null}
            {mode === "protocol" ? <ProtocolMode snapshot={snapshot} act={act} now={now} subjectOnline={subjectOnline} /> : null}
            {mode === "review" ? <ReviewMode snapshot={snapshot} onRestore={openSession} /> : null}
          </motion.div>
        </AnimatePresence>

        <AnimatePresence>
          {diagnosticsOpen ? (
            <DiagnosticsDrawer snapshot={snapshot} now={now} onClose={() => setDiagnosticsOpen(false)} />
          ) : null}
        </AnimatePresence>
      </main>
    </MotionConfig>
  );
}

function SessionEntry({ defaultOperator, onStarted, onRestore }: {
  defaultOperator: string;
  onStarted: (session: SessionSnapshot) => void;
  onRestore: (code: string) => Promise<void>;
}) {
  const [participant, setParticipant] = useState("");
  const [existing, setExisting] = useState<HistoryItem | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!participant) return;
    const id = window.setTimeout(async () => {
      setChecking(true);
      try {
        const sessions = await listSessions();
        const match = sessions
          .filter((item) => item.participant_id === Number(participant) && !["complete", "aborted"].includes(item.status))
          .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
        setExisting(match || null);
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to check sessions.");
      } finally {
        setChecking(false);
      }
    }, 350);
    return () => clearTimeout(id);
  }, [participant]);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const session = await api({ action: "create", participantId: Number(participant), operator: defaultOperator });
      window.localStorage.setItem("meridian.operator.code", session.code);
      onStarted(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to prepare the session.");
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (!existing) return;
    setBusy(true);
    setError("");
    try {
      await onRestore(existing.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to restore the session.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <MotionConfig reducedMotion="user">
      <main className="operator-entry">
        <header className="entry-header">
          <Link href="/" className="operator-brand" aria-label="Meridian home"><i />Meridian</Link>
          <span>Research operations</span>
        </header>
        <section className="entry-workflow" aria-labelledby="entry-title">
          <div className="entry-heading">
            <h1 id="entry-title">Start an acquisition</h1>
            <p>Enter the participant ID to continue.</p>
          </div>
          <label className="participant-field">
            <span>Participant ID</span>
            <input
              inputMode="numeric"
              autoComplete="off"
              value={participant}
              onChange={(event) => { setParticipant(event.target.value.replace(/\D/g, "")); setExisting(null); }}
              placeholder="0001"
              aria-describedby="participant-status"
            />
          </label>

          <div id="participant-status" className="participant-status" role="status" aria-atomic="true">
            {checking ? <span>Checking for an existing session</span> : existing ? (
              <span><strong>Existing session found</strong> Last active {new Date(existing.updated_at).toLocaleString()}</span>
            ) : participant ? <span>Ready to continue to hardware setup</span> : <span>Participant ID required</span>}
          </div>

          {error ? <p className="entry-error" role="alert">{error}</p> : null}

          <div className="entry-actions">
            {existing ? (
              <>
                <button className="operator-primary" disabled={busy} onClick={resume}>{busy ? "Opening session" : "Resume session"}</button>
                <button className="operator-link-button" disabled={busy} onClick={start}>Start a new acquisition instead</button>
              </>
            ) : (
              <button className="operator-primary" disabled={!participant || busy || checking} onClick={start}>
                {busy ? "Preparing session" : "Continue"}
              </button>
            )}
          </div>
          <p className="operator-identity">Signed in as <strong>{defaultOperator}</strong></p>
        </section>
      </main>
    </MotionConfig>
  );
}

function OperatorHeader({ snapshot, elapsed, mode, setMode, warnings, healthyRequired, agentOnline, act, onDiagnostics }: {
  snapshot: SessionSnapshot;
  elapsed: number;
  mode: Mode;
  setMode: (mode: Mode) => void;
  warnings: number;
  healthyRequired: number;
  agentOnline: boolean;
  act: Act;
  onDiagnostics: () => void;
}) {
  const status = snapshot.status === "setup" ? "Setup" : snapshot.status === "running" ? "Recording" : snapshot.status === "paused" ? "Paused" : snapshot.status === "complete" ? "Complete" : "Ended early";
  const systemLabel = !agentOnline ? "Acquisition computer offline" : warnings ? `${warnings} ${warnings === 1 ? "issue" : "issues"} need attention` : snapshot.status === "setup" ? `${healthyRequired} of ${snapshot.requiredSensors.length} required devices ready` : "Recording healthy";

  return (
    <>
      <header className="operator-header">
        <Link href="/" className="operator-brand" aria-label="Meridian home"><i />Meridian</Link>
        <div className="operator-session-title">
          <strong>Participant P{String(snapshot.participantId).padStart(3, "0")}</strong>
          <span>{status}{snapshot.recordingStartedAt ? ` / ${formatClock(elapsed)}` : ""}</span>
        </div>
        <div className="operator-header-actions">
          {snapshot.status === "running" ? <button onClick={() => act("pause", { reason: "Operator pause" })}>Pause</button> : null}
          {snapshot.status === "paused" ? <button className="operator-primary compact" onClick={() => act("resume")}>Resume</button> : null}
          {snapshot.status === "setup" ? <button className="operator-danger-link" onClick={() => window.confirm("Discard this session?") && act("abort")}>Discard</button> : null}
          {["running", "paused"].includes(snapshot.status) ? <button className="operator-danger-link" onClick={() => window.confirm("End the session and finalize all recordings?") && act("complete")}>End session</button> : null}
        </div>
      </header>
      <nav className="operator-navigation" aria-label="Operator workflow">
        <div>
          {(["setup", "monitor", "protocol", "review"] as Mode[]).map((value) => (
            <button key={value} className={mode === value ? "active" : ""} aria-current={mode === value ? "page" : undefined} onClick={() => setMode(value)}>
              {value === "setup" ? "Setup" : value === "monitor" ? "Monitor" : value === "protocol" ? "Protocol" : "Review"}
            </button>
          ))}
        </div>
        <button className={`system-summary ${warnings || !agentOnline ? "attention" : "healthy"}`} onClick={onDiagnostics}>
          <i />{systemLabel}<span>Diagnostics</span>
        </button>
      </nav>
    </>
  );
}

function SetupMode({ snapshot, act, now, subjectOnline }: { snapshot: SessionSnapshot; act: Act; now: number; subjectOnline: boolean }) {
  const [devices, setDevices] = useState<DeviceConfig>(snapshot.deviceConfig);
  const [required, setRequired] = useState(snapshot.requiredSensors);
  const [preview, setPreview] = useState<string | null>(null);
  const online = isAgentOnline(snapshot, now);
  const locked = snapshot.configurationLocked;
  const setupSensors = snapshot.sensors.filter((sensor) => SETUP_SENSOR_IDS.includes(sensor.id));
  const requiredRows = setupSensors.filter((sensor) => required.includes(sensor.id));
  const optionalRows = setupSensors.filter((sensor) => !required.includes(sensor.id));
  const readyRequired = requiredRows.filter((sensor) => sensorOperational(sensor, now, online)).length;
  const storageGood = (snapshot.acquisition.diskFreeGb ?? 0) >= 10;
  const syncGood = snapshot.acquisition.clockOffsetMs != null && Math.abs(snapshot.acquisition.clockOffsetMs) < 100;
  const allStreamsGood = online && requiredRows.length > 0 && readyRequired === requiredRows.length;
  const pass = snapshot.preflightTest.status === "pass" && allStreamsGood && storageGood && syncGood;
  const attentionCount = requiredRows.length - readyRequired + (online ? 0 : 1);

  const save = async () => {
    await act("deviceConfig", { devices });
    await act("requiredSensors", { ids: required });
  };
  const test = async () => {
    await save();
    await act("startPreflight");
  };

  return (
    <section className="operator-page setup-page">
      <PageHeading
        title="Hardware setup"
        description="Make every required device ready, then run the preflight check."
        status={pass ? "Ready to record" : attentionCount > 0 ? `${attentionCount} ${attentionCount === 1 ? "item needs" : "items need"} attention` : "Run preflight to continue"}
        tone={pass ? "good" : attentionCount > 0 ? "bad" : "neutral"}
      />

      <div className="setup-layout">
        <div className="setup-devices">
          <section className="device-section" aria-labelledby="required-devices-title">
            <div className="section-heading-row">
              <div>
                <h2 id="required-devices-title">Required devices</h2>
                <p>{readyRequired} of {requiredRows.length} ready</p>
              </div>
              <button className="operator-secondary compact" disabled={locked || !online} onClick={() => act("refreshDevices")}>Refresh devices</button>
            </div>
            <div className="device-list">
              {requiredRows.map((sensor) => (
                <DeviceRow
                  key={sensor.id}
                  sensor={sensor}
                  selected={devices[sensor.id] || "none"}
                  options={inventoryFor(sensor, snapshot)}
                  required
                  locked={locked}
                  previewOpen={preview === sensor.id}
                  previewUrl={snapshot.acquisition.previewUrls[sensor.id]}
                  onPreview={() => setPreview((value) => value === sensor.id ? null : sensor.id)}
                  onRequired={(value) => setRequired((items) => value ? [...new Set([...items, sensor.id])] : items.filter((id) => id !== sensor.id))}
                  onDevice={(value) => setDevices((current) => ({ ...current, [sensor.id]: value }))}
                />
              ))}
            </div>
          </section>

          <details className="disclosure-section">
            <summary>
              <span><strong>Optional devices</strong><small>{optionalRows.length} available</small></span>
              <b>Configure</b>
            </summary>
            <div className="device-list optional">
              {optionalRows.map((sensor) => (
                <DeviceRow
                  key={sensor.id}
                  sensor={sensor}
                  selected={devices[sensor.id] || "none"}
                  options={inventoryFor(sensor, snapshot)}
                  required={false}
                  locked={locked}
                  previewOpen={preview === sensor.id}
                  previewUrl={snapshot.acquisition.previewUrls[sensor.id]}
                  onPreview={() => setPreview((value) => value === sensor.id ? null : sensor.id)}
                  onRequired={(value) => setRequired((items) => value ? [...new Set([...items, sensor.id])] : items.filter((id) => id !== sensor.id))}
                  onDevice={(value) => setDevices((current) => ({ ...current, [sensor.id]: value }))}
                />
              ))}
            </div>
          </details>

          <MediaEditor snapshot={snapshot} act={act} />
        </div>

        <aside className="setup-sidebar">
          <section className="setup-status-block">
            <h2>Acquisition computer</h2>
            <StatusLine good={online} title={online ? "Connected" : "Not connected"} detail={online ? snapshot.acquisition.host : "Start the local acquisition agent."} />
            <StatusLine good={subjectOnline} title={subjectOnline ? "Subject display connected" : "Subject display waiting"} detail={`Session code ${snapshot.code}`} />
            <div className="subject-actions">
              <button className="operator-secondary" onClick={() => void navigator.clipboard?.writeText(snapshot.code)}>Copy subject code</button>
              <a className="operator-text-link" href={`/subject?session=${snapshot.code}`} target="_blank" rel="noreferrer">Open subject display</a>
            </div>
          </section>

          <section className="preflight-action" aria-labelledby="preflight-title">
            <div>
              <h2 id="preflight-title">Preflight</h2>
              <p>{preflightMessage(snapshot, online, allStreamsGood, storageGood, syncGood)}</p>
            </div>
            {locked ? <p className="locked-copy">Device configuration is locked while recording.</p> : null}
            {!locked && !pass ? (
              <button className="operator-primary" disabled={!online || !required.length || snapshot.preflightTest.status === "running"} onClick={test}>
                {snapshot.preflightTest.status === "running" ? "Testing devices" : snapshot.preflightTest.status === "fail" ? "Run test again" : "Test required devices"}
              </button>
            ) : null}
            {pass ? <button className="operator-primary" disabled={snapshot.status !== "setup"} onClick={() => act("startSession")}>Start recording</button> : null}
            {!locked ? <button className="operator-link-button" disabled={!online} onClick={save}>Save device assignments</button> : null}
            <details className="preflight-details">
              <summary>View preflight evidence</summary>
              <PreflightEvidence snapshot={snapshot} now={now} />
            </details>
          </section>

          <details className="technical-setup">
            <summary>Technical setup</summary>
            <p>Run this command on the computer connected to the sensors.</p>
            <code>python -m meridian_agent --server http://localhost:3000 --code {snapshot.code} --token {snapshot.acquisitionToken}</code>
            <button onClick={() => void navigator.clipboard?.writeText(snapshot.acquisitionToken)}>Copy acquisition token</button>
          </details>
        </aside>
      </div>
    </section>
  );
}

function DeviceRow({ sensor, selected, options, required, locked, previewOpen, previewUrl, onPreview, onRequired, onDevice }: {
  sensor: SensorChannel;
  selected: string;
  options: DeviceInventoryItem[];
  required: boolean;
  locked: boolean;
  previewOpen: boolean;
  previewUrl?: string;
  onPreview: () => void;
  onRequired: (value: boolean) => void;
  onDevice: (value: string) => void;
}) {
  const ready = sensor.quality === "good" && sensor.dataDetected;
  const configured = selected !== "none";
  const status = ready ? "Ready" : sensor.hardwareDetected ? "Needs validation" : configured ? "Not connected" : required ? "Not connected" : "Not in use";
  const canPreview = ["face", "thermal"].includes(sensor.id) && Boolean(previewUrl);

  return (
    <details className={`device-row ${ready ? "ready" : required ? "attention" : "quiet"}`}>
      <summary>
        <span className="device-name"><i /><strong>{sensor.label}</strong>{required ? <small>Required</small> : null}</span>
        <span className="device-state"><strong>{status}</strong>{ready ? <small>{sensor.latestValue || "Signal validated"}</small> : <small>{sensor.detail || "Choose a device to continue"}</small>}</span>
        <b>Details</b>
      </summary>
      <div className="device-controls">
        <label>
          <span>Device</span>
          <select aria-label={`${sensor.label} device`} value={selected} disabled={locked} onChange={(event) => onDevice(event.target.value)}>
            <option value="none">Not assigned</option>
            <option value="auto">Auto-detect</option>
            {options.map((option) => <option key={`${option.kind}-${option.id}`} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <label className="required-toggle"><input type="checkbox" checked={required} disabled={locked} onChange={(event) => onRequired(event.target.checked)} />Required for this study</label>
        <div className="device-evidence">
          <StatusLine good={sensor.hardwareDetected} title="Hardware" detail={sensor.device || "Not detected"} />
          <StatusLine good={sensor.dataDetected} title="Data" detail={sensor.rateHz == null ? "No samples" : `${formatRate(sensor.rateHz)} Hz`} />
          <StatusLine good={sensor.quality === "good"} title="Quality" detail={qualityLabel(sensor)} />
        </div>
        {canPreview ? <button className="operator-secondary compact" onClick={onPreview}>{previewOpen ? "Close preview" : "Preview camera"}</button> : null}
        {previewOpen && previewUrl ? <div className="device-preview-new"><img src={previewUrl} alt={`${sensor.label} live preview`} /></div> : null}
      </div>
    </details>
  );
}

function PreflightEvidence({ snapshot, now }: { snapshot: SessionSnapshot; now: number }) {
  const online = isAgentOnline(snapshot, now);
  const rows = snapshot.requiredSensors.map((id) => snapshot.sensors.find((item) => item.id === id)).filter((item): item is SensorChannel => Boolean(item));
  const storageGood = (snapshot.acquisition.diskFreeGb ?? 0) >= 10;
  const syncGood = snapshot.acquisition.clockOffsetMs != null && Math.abs(snapshot.acquisition.clockOffsetMs) < 100;
  return (
    <div className="evidence-list">
      <StatusLine good={online} title="Acquisition computer" detail={online ? `${snapshot.acquisition.host} connected` : "Heartbeat missing"} />
      {rows.map((sensor) => <StatusLine key={sensor.id} good={sensor.quality === "good"} title={sensor.label} detail={`${sensor.latestValue || sensor.detail} / ${sensor.rateHz == null ? "0" : formatRate(sensor.rateHz)} Hz`} />)}
      <StatusLine good={storageGood} title="Storage" detail={snapshot.acquisition.diskFreeGb == null ? "Not measured" : `${snapshot.acquisition.diskFreeGb.toFixed(1)} GB free`} />
      <StatusLine good={syncGood} title="Synchronization" detail={snapshot.acquisition.clockOffsetMs == null ? "Not measured" : `${signed(snapshot.acquisition.clockOffsetMs)} ms offset`} />
      <StatusLine good={snapshot.preflightTest.status === "pass"} title="Test recording" detail={snapshot.preflightTest.detail || "Not run"} />
    </div>
  );
}

function MonitorMode({ snapshot, act, now, subjectOnline }: { snapshot: SessionSnapshot; act: Act; now: number; subjectOnline: boolean }) {
  const [expanded, setExpanded] = useState("oximeter");
  const plan = buildPlan(snapshot.assignment);
  const step = plan[snapshot.stepIndex];
  const monitored = snapshot.sensors.filter((sensor) => ["oximeter", "emg", "gsr", "ecg", "csi", "audio", "thermal"].includes(sensor.id));
  const face = snapshot.sensors.find((sensor) => sensor.id === "face");
  const warnings = buildWarnings(snapshot, now);
  const online = isAgentOnline(snapshot, now);
  const healthy = snapshot.requiredSensors.filter((id) => sensorOperational(snapshot.sensors.find((sensor) => sensor.id === id), now, online)).length;

  return (
    <section className="operator-page monitor-page">
      <PageHeading
        title={warnings.length ? `${warnings.length} ${warnings.length === 1 ? "issue needs" : "issues need"} attention` : "Recording is healthy"}
        description={warnings.length ? "Resolve the highlighted issue while the rest of the session continues." : "All required streams are arriving normally."}
        status={`${healthy} of ${snapshot.requiredSensors.length} required devices ready`}
        tone={warnings.length ? "bad" : "good"}
      />

      {warnings.length ? <ActionableWarnings warnings={warnings} act={act} /> : null}

      <CurrentTaskBar snapshot={snapshot} step={step} plan={plan} act={act} subjectOnline={subjectOnline} />

      <div className="monitor-primary-grid">
        <section className="camera-surface">
          <div className="section-heading-row">
            <div><h2>Subject camera</h2><p>{qualityLabel(face)}</p></div>
            <span className={`plain-status ${face?.quality === "good" ? "good" : "bad"}`}><i />{face?.quality === "good" ? "Live" : "Unavailable"}</span>
          </div>
          {snapshot.acquisition.previewUrls.face ? <img src={snapshot.acquisition.previewUrls.face} alt="Live subject camera preview" /> : <div className="camera-empty"><strong>Camera preview unavailable</strong><span>{face?.detail || "Waiting for the camera"}</span></div>}
        </section>
        <RecordingOverview snapshot={snapshot} now={now} />
      </div>

      <details className="disclosure-section signal-disclosure">
        <summary><span><strong>Signal diagnostics</strong><small>Rates, rolling windows, and validation details</small></span><b>Inspect</b></summary>
        <div className="signal-list-new">
          {monitored.map((sensor) => <SignalCard key={sensor.id} sensor={sensor} expanded={expanded === sensor.id} onToggle={() => setExpanded((value) => value === sensor.id ? "" : sensor.id)} />)}
        </div>
      </details>

      <div className="monitor-secondary-grid">
        <OperatorChannel snapshot={snapshot} act={act} />
        <details className="event-disclosure"><summary>Session activity</summary><EventLog snapshot={snapshot} /></details>
      </div>
    </section>
  );
}

function CurrentTaskBar({ snapshot, step, plan, act, subjectOnline }: { snapshot: SessionSnapshot; step: ProtocolStep; plan: ProtocolStep[]; act: Act; subjectOnline: boolean }) {
  return (
    <section className="current-task-bar" aria-labelledby="current-task-title">
      <div>
        <span>{step.phase}</span>
        <h2 id="current-task-title">{shortLabel(step)}</h2>
      </div>
      <div className="task-bar-actions">
        <button disabled={snapshot.status === "setup" || snapshot.stepIndex === 0} onClick={() => act("navigate", { direction: -1 })}>Previous</button>
        <button disabled={snapshot.status === "setup" || snapshot.stepIndex >= plan.length - 1} onClick={() => act("navigate", { direction: 1 })}>Next</button>
      </div>
      <div className="subject-state">
        <span className={subjectOnline ? "good" : "bad"}><i />{subjectOnline ? "Subject display connected" : "Subject display waiting"}</span>
        <a href={`/subject?session=${snapshot.code}`} target="_blank" rel="noreferrer">Open display</a>
      </div>
    </section>
  );
}

function RecordingOverview({ snapshot, now }: { snapshot: SessionSnapshot; now: number }) {
  const online = isAgentOnline(snapshot, now);
  const sensors = snapshot.sensors.filter((sensor) => snapshot.requiredSensors.includes(sensor.id));
  return (
    <section className="recording-overview">
      <div className="section-heading-row"><div><h2>Required devices</h2><p>Healthy devices stay quiet</p></div></div>
      <div className="recording-device-list">
        {sensors.map((sensor) => {
          const ready = sensorOperational(sensor, now, online);
          return <div className={ready ? "ready" : "attention"} key={sensor.id}><span><i /><strong>{sensor.label}</strong></span><span><strong>{ready ? "Ready" : "Check device"}</strong><small>{sensor.latestValue || sensor.detail}</small></span></div>;
        })}
      </div>
    </section>
  );
}

function ActionableWarnings({ warnings, act }: { warnings: ReturnType<typeof buildWarnings>; act: Act }) {
  return (
    <section className="warning-list" aria-labelledby="warning-title">
      <h2 id="warning-title">Action required</h2>
      {warnings.map((warning) => (
        <article key={warning.id}>
          <div><strong>{warning.title}</strong><p>{warning.detail}</p><ol>{warning.actions.map((action) => <li key={action}>{action}</li>)}</ol></div>
          <button onClick={() => act("log", { eventType: "warning_acknowledged", label: `Acknowledged: ${warning.title}`, detail: warning.detail, severity: "warn", source: "operator" })}>Acknowledge</button>
        </article>
      ))}
    </section>
  );
}

function ProtocolMode({ snapshot, act, now, subjectOnline }: { snapshot: SessionSnapshot; act: Act; now: number; subjectOnline: boolean }) {
  const plan = buildPlan(snapshot.assignment);
  const step = plan[snapshot.stepIndex];
  const progress = Math.round(((snapshot.stepIndex + 1) / plan.length) * 100);
  const warnings = buildWarnings(snapshot, now);

  return (
    <section className="operator-page protocol-page">
      <div className="protocol-heading">
        <div><p>{step.phase}</p><h1>{step.title}</h1></div>
        <div className="protocol-progress"><span>Protocol progress</span><strong>{progress}%</strong><i><b style={{ width: `${progress}%` }} /></i></div>
      </div>

      <div className="protocol-workspace">
        <CurrentStep snapshot={snapshot} step={step} next={plan[snapshot.stepIndex + 1]} act={act} subjectOnline={subjectOnline} />
        <aside className="protocol-side">
          {warnings.length ? <ActionableWarnings warnings={warnings} act={act} /> : <SystemReady snapshot={snapshot} now={now} />}
          <OperatorChannel snapshot={snapshot} act={act} />
          <details className="event-disclosure"><summary>Session activity</summary><EventLog snapshot={snapshot} /></details>
        </aside>
      </div>

      <details className="protocol-outline">
        <summary><span><strong>Full protocol</strong><small>Review past and upcoming activities</small></span><b>View outline</b></summary>
        <ol>{plan.map((item) => <li className={item.index < snapshot.stepIndex ? "done" : item.index === snapshot.stepIndex ? "current" : "upcoming"} key={item.id}><i /><span><small>{item.phase}</small><strong>{shortLabel(item)}</strong></span>{item.durationSec ? <time>{formatClock(item.durationSec)}</time> : null}</li>)}</ol>
      </details>
    </section>
  );
}

function CurrentStep({ snapshot, step, next, act, subjectOnline }: { snapshot: SessionSnapshot; step: ProtocolStep; next?: ProtocolStep; act: Act; subjectOnline: boolean }) {
  const [reason, setReason] = useState("");
  const [checks, setChecks] = useState([false, false, false]);
  const [sys, setSys] = useState("");
  const [dia, setDia] = useState("");
  const [pulse, setPulse] = useState("");
  const plan = buildPlan(snapshot.assignment);

  return (
    <section className="current-step-new" aria-labelledby="step-instruction-title">
      <div className="operator-instruction">
        <span>Say to the subject</span>
        <h2 id="step-instruction-title">{step.operatorScript}</h2>
        {step.operatorNote ? <p>{step.operatorNote}</p> : null}
      </div>

      {step.type === "gate" ? (
        <fieldset className="gate-check-new">
          <legend>Return-to-baseline check</legend>
          {["Tonic GSR near resting reference", "Heart rate near resting reference", "Subject settled and breathing regularly"].map((label, index) => (
            <label key={label}><input type="checkbox" checked={checks[index]} onChange={(event) => setChecks((values) => values.map((value, itemIndex) => itemIndex === index ? event.target.checked : value))} />{label}</label>
          ))}
        </fieldset>
      ) : null}

      {step.type === "nback" ? (
        <fieldset className="nback-control"><legend>N-back difficulty</legend>{[1, 2, 3].map((level) => <button className={snapshot.nbackLevel === level ? "selected" : ""} key={level} onClick={() => act("nbackLevel", { level })}>{level}-back</button>)}</fieldset>
      ) : null}

      {step.safety ? <section className="safety-notice"><strong>Keep the subject within reach.</strong><span>Stop immediately if they report discomfort.</span><button onClick={() => act("advance", { reason: "Safety step skipped" })}>Skip and log</button></section> : null}

      {step.bp ? (
        <fieldset className="bp-entry">
          <legend>Blood pressure <span>{step.bpLabel}</span></legend>
          <label>Systolic<input aria-label="Systolic blood pressure" inputMode="numeric" value={sys} onChange={(event) => setSys(event.target.value.replace(/\D/g, ""))} /></label>
          <label>Diastolic<input aria-label="Diastolic blood pressure" inputMode="numeric" value={dia} onChange={(event) => setDia(event.target.value.replace(/\D/g, ""))} /></label>
          <label>Pulse<input aria-label="Pulse" inputMode="numeric" value={pulse} onChange={(event) => setPulse(event.target.value.replace(/\D/g, ""))} /></label>
          <button className="operator-secondary" disabled={!sys || !dia} onClick={() => { act("bp", { label: step.bpLabel, systolic: Number(sys), diastolic: Number(dia), pulse: pulse ? Number(pulse) : null }); setSys(""); setDia(""); setPulse(""); }}>Save reading</button>
        </fieldset>
      ) : null}

      <div className="step-primary-actions">
        {["operator", "gate"].includes(step.advance) ? (
          <button className="operator-primary" disabled={snapshot.status === "setup" || (step.advance === "gate" && !checks.every(Boolean))} onClick={() => act("advance", { reason: step.advance === "gate" ? "Baseline gate cleared" : "Operator continued" })}>Continue</button>
        ) : <p>{step.advance === "timer" ? "This activity advances when the timer completes." : step.advance === "media" ? "This activity advances when the clip ends." : "The subject controls completion of this activity."}</p>}
        {next ? <span>Next: <strong>{shortLabel(next)}</strong></span> : null}
      </div>

      <div className="step-navigation">
        <button disabled={snapshot.status === "setup" || snapshot.stepIndex === 0 || snapshot.status === "aborted"} onClick={() => act("navigate", { direction: -1 })}>Previous task</button>
        <button disabled={snapshot.status === "setup" || snapshot.stepIndex >= plan.length - 1 || snapshot.status === "aborted"} onClick={() => act("navigate", { direction: 1 })}>Next task</button>
      </div>

      <details className="repeat-disclosure">
        <summary>Repeat this task</summary>
        <label>Reason<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for repeating" /></label>
        <button className="operator-secondary" disabled={snapshot.status === "setup"} onClick={() => act("repeat", { reason: reason || "Operator repeat" })}>Repeat and log</button>
      </details>

      <div className="subject-preview-line">
        <span className={subjectOnline ? "good" : "bad"}><i />{subjectOnline ? "Subject display connected" : "Waiting for subject display"}</span>
        <a href={`/subject?session=${snapshot.code}`} target="_blank" rel="noreferrer">Open display</a>
      </div>
    </section>
  );
}

function SystemReady({ snapshot, now }: { snapshot: SessionSnapshot; now: number }) {
  const online = isAgentOnline(snapshot, now);
  const healthy = snapshot.requiredSensors.filter((id) => sensorOperational(snapshot.sensors.find((sensor) => sensor.id === id), now, online)).length;
  return (
    <section className="system-ready">
      <span className="plain-status good"><i />Recording healthy</span>
      <p>{healthy} of {snapshot.requiredSensors.length} required devices are ready.</p>
    </section>
  );
}

function OperatorChannel({ snapshot, act }: { snapshot: SessionSnapshot; act: Act }) {
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  const [category, setCategory] = useState("general");
  return (
    <section className="operator-channel">
      <div className="section-heading-row"><div><h2>Operator channel</h2><p>Communicate without interrupting recording</p></div></div>
      <div className="quick-messages">{CANNED_MESSAGES.map((text) => <button key={text} onClick={() => act("message", { text })}>{text}</button>)}</div>
      <label className="compose-field"><span>Message to subject</span><div><input value={message} onChange={(event) => setMessage(event.target.value)} maxLength={180} placeholder="Short instruction" /><button disabled={!message.trim()} onClick={() => { act("message", { text: message }); setMessage(""); }}>Send</button></div></label>
      <details className="note-disclosure">
        <summary>Add operator note</summary>
        <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option>general</option><option>sensor</option><option>participant</option><option>safety</option><option>protocol</option></select></label>
        <label>Note<div><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Timestamped note" /><button disabled={!note.trim()} onClick={() => { act("note", { body: note, category }); setNote(""); }}>Log</button></div></label>
        {snapshot.notes.length ? <ul>{snapshot.notes.slice(-3).reverse().map((item) => <li key={item.id}><strong>{item.category}</strong>{item.body}</li>)}</ul> : null}
      </details>
    </section>
  );
}

function EventLog({ snapshot }: { snapshot: SessionSnapshot }) {
  return <ol className="event-list">{snapshot.events.slice(-20).reverse().map((event) => <li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span><strong>{event.label}</strong>{event.detail ? <small>{event.detail}</small> : null}</span></li>)}</ol>;
}

function SignalCard({ sensor, expanded, onToggle }: { sensor: SensorChannel; expanded: boolean; onToggle: () => void }) {
  const isCsi = sensor.id === "csi";
  return (
    <article className={`signal-row ${sensor.quality}`}>
      <button className="signal-summary-new" onClick={onToggle} aria-expanded={expanded}>
        <span><i /><strong>{sensor.label}</strong></span><span>{sensor.latestValue || sensor.detail}</span><b>{expanded ? "Close" : "Inspect"}</b>
      </button>
      {expanded ? (
        <div className="signal-detail-new">
          <div className="signal-plot">{isCsi ? <Spectrum values={sensor.series} /> : <Sparkline values={sensor.series} tone={sensor.quality} />}</div>
          <dl>
            <div><dt>Actual rate</dt><dd>{sensor.rateHz == null ? "0" : formatRate(sensor.rateHz)} Hz</dd></div>
            <div><dt>Target</dt><dd>{sensor.targetRateHz == null ? "Not set" : `${formatRate(sensor.targetRateHz)} Hz`}</dd></div>
            <div><dt>Dropped</dt><dd>{formatCount(sensor.droppedSamples)}</dd></div>
            <div><dt>Loss</dt><dd>{sensor.dropoutPct.toFixed(2)}%</dd></div>
            {Object.entries(sensor.metrics).filter(([key]) => key !== "lastSequence").slice(0, 4).map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{String(value)}</dd></div>)}
          </dl>
          {sensor.validation.length ? <ul>{sensor.validation.map((item) => <li key={item}>{item}</li>)}</ul> : null}
        </div>
      ) : null}
    </article>
  );
}

function Sparkline({ values, tone }: { values: number[]; tone: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const width = Math.max(320, canvas.clientWidth * window.devicePixelRatio);
    const height = Math.max(100, canvas.clientHeight * window.devicePixelRatio);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = tone === "bad" ? "#b33a31" : tone === "degraded" ? "#9a6b1f" : "#397265";
    context.lineWidth = 2 * window.devicePixelRatio;
    const data = values.length > 1 ? values : [0, 0];
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    context.beginPath();
    data.forEach((value, index) => {
      const x = index / (data.length - 1) * width;
      const y = height - 10 * window.devicePixelRatio - (value - min) / range * (height - 20 * window.devicePixelRatio);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.stroke();
  }, [values, tone]);
  return <canvas ref={ref} aria-label="Recent signal preview" />;
}

function Spectrum({ values }: { values: number[] }) {
  const data = values.length ? values : Array.from({ length: 52 }, () => 0);
  const max = Math.max(1, ...data.map(Math.abs));
  return <div className="spectrum-new" aria-label="CSI subcarrier amplitudes">{data.slice(0, 52).map((value, index) => <i key={index} style={{ height: `${Math.max(4, Math.abs(value) / max * 100)}%` }} />)}</div>;
}

function ReviewMode({ snapshot, onRestore }: { snapshot: SessionSnapshot; onRestore: (snapshot: SessionSnapshot) => void }) {
  const artifacts = snapshot.recordings;
  const result = overallQuality(artifacts);
  const complete = snapshot.status === "complete";
  return (
    <section className="operator-page review-page">
      <PageHeading
        title={complete ? "Session complete" : snapshot.status === "aborted" ? "Session ended early" : "Session review"}
        description={`Participant P${String(snapshot.participantId).padStart(3, "0")}. ${complete ? "Recordings are finalized and ready for review." : "Available evidence is provisional until recording ends."}`}
        status={result === "PASS" ? "All required recordings passed" : result === "PENDING" ? "Final recording evidence pending" : `${result.toLowerCase()} requires review`}
        tone={result === "PASS" ? "good" : result === "FAIL" ? "bad" : "neutral"}
      />

      <section className="review-files" aria-labelledby="recordings-title">
        <div className="section-heading-row"><div><h2 id="recordings-title">Recording quality</h2><p>Open a channel only when you need its evidence.</p></div></div>
        <div className="quality-list">
          {snapshot.sensors.filter((sensor) => snapshot.requiredSensors.includes(sensor.id) || artifacts.some((file) => file.sensorId === sensor.id)).map((sensor) => <QualityRow key={sensor.id} sensor={sensor} artifact={artifacts.find((file) => file.sensorId === sensor.id)} />)}
        </div>
      </section>

      <details className="disclosure-section coverage-disclosure">
        <summary><span><strong>Capture coverage</strong><small>Availability and gaps by finalized file</small></span><b>View details</b></summary>
        <div className="coverage-list">{artifacts.length ? artifacts.map((file) => <div key={file.sensorId}><strong>{file.sensorId}</strong><span><i className={file.gapCount ? "has-gaps" : ""} style={{ width: `${file.availabilityPct || 0}%` }} /></span><small>{file.availabilityPct.toFixed(1)}% available / {file.gapCount} gaps</small></div>) : <p>No finalized recording files yet.</p>}</div>
      </details>

      <DataExports snapshot={snapshot} />
      <details className="disclosure-section history-disclosure"><summary><span><strong>Session history</strong><small>Restore another acquisition</small></span><b>Open history</b></summary><HistoryPanel onRestore={onRestore} /></details>
    </section>
  );
}

function QualityRow({ sensor, artifact }: { sensor: SensorChannel; artifact?: RecordingArtifact }) {
  const quality = artifact?.quality || sensor.quality;
  const status = ["pass", "good"].includes(quality) ? "Passed" : quality === "pending" || quality === "waiting" ? "Pending" : quality === "warning" || quality === "degraded" ? "Review" : "Failed";
  return (
    <details className={`quality-item ${status.toLowerCase()}`}>
      <summary><span><i /><strong>{sensor.label}</strong></span><span><strong>{status}</strong><small>{artifact ? `${artifact.availabilityPct.toFixed(1)}% available` : sensor.detail}</small></span><b>Evidence</b></summary>
      <dl>
        <div><dt>Average rate</dt><dd>{formatRate(artifact?.averageRateHz || sensor.rateHz || 0)} Hz</dd></div>
        <div><dt>Samples</dt><dd>{formatCount(artifact?.sampleCount || sensor.sampleCount)}</dd></div>
        <div><dt>Packet loss</dt><dd>{(artifact?.dropoutPct ?? sensor.dropoutPct).toFixed(2)}%</dd></div>
        <div><dt>Longest gap</dt><dd>{artifact?.longestGapSec ?? 0} s</dd></div>
        <div><dt>Size</dt><dd>{formatBytes(artifact?.bytes || sensor.bytesWritten)}</dd></div>
        <div><dt>Availability</dt><dd>{artifact?.availabilityPct ?? (sensor.dataDetected ? 100 : 0)}%</dd></div>
      </dl>
      <code>{artifact?.relativePath || sensor.recordingFile || "Recording path not available"}</code>
    </details>
  );
}

function DataExports({ snapshot }: { snapshot: SessionSnapshot }) {
  const exports = [
    ["Session JSON", "Complete session snapshot", () => download(`meridian_${snapshot.participantId}_${snapshot.code}.json`, JSON.stringify(exportableSnapshot(snapshot), null, 2), "application/json")],
    ["Event CSV", "Timestamped event ledger", () => download(`meridian_${snapshot.participantId}_${snapshot.code}_events.csv`, eventsCsv(snapshot), "text/csv")],
    ["Event JSONL", "Machine-readable event stream", () => download(`meridian_${snapshot.participantId}_${snapshot.code}_events.jsonl`, snapshot.events.map((event) => JSON.stringify(event)).join("\n"), "application/x-ndjson")],
    ["Sensor CSV", "Latest sensor status", () => download(`meridian_${snapshot.participantId}_${snapshot.code}_sensors.csv`, sensorStatusCsv(snapshot), "text/csv")],
    ["Recording manifest", "Files and acquisition evidence", () => download(`meridian_${snapshot.participantId}_${snapshot.code}_manifest.json`, JSON.stringify({ sessionCode: snapshot.code, participantId: snapshot.participantId, agent: snapshot.acquisition, recordings: snapshot.recordings }, null, 2), "application/json")],
    ["Session report", "Readable session summary", () => download(`meridian_${snapshot.participantId}_${snapshot.code}_report.txt`, report(snapshot), "text/plain")],
  ] as const;
  return (
    <section className="data-exports-new" aria-labelledby="exports-title">
      <div className="section-heading-row"><div><h2 id="exports-title">Export session data</h2><p>Raw sensor files remain on the acquisition computer.</p></div></div>
      <div>{exports.map(([label, detail, run]) => <button key={label} onClick={run}><span><strong>{label}</strong><small>{detail}</small></span><b>Download</b></button>)}</div>
    </section>
  );
}

function MediaEditor({ snapshot, act }: { snapshot: SessionSnapshot; act: Act }) {
  const [media, setMedia] = useState<MediaConfig>(snapshot.media);
  const [uploading, setUploading] = useState("");
  const rows: [string, string, string][] = [
    ["emotions.happy", "Clip 1", media.emotions.happy], ["emotions.sad", "Clip 2", media.emotions.sad],
    ["emotions.anger", "Clip 3", media.emotions.anger], ["emotions.fear", "Clip 4", media.emotions.fear],
    ["emotions.surprise", "Clip 5", media.emotions.surprise], ["emotions.disgust", "Clip 6", media.emotions.disgust],
    ["washout", "Washout media", media.washout], ["boxBreathing", "Breathing media", media.boxBreathing],
    ["bodyScan", "Body scan audio", media.bodyScan], ["fixation", "Fixation media", media.fixation],
  ];
  const update = (key: string, value: string) => setMedia((current) => key.startsWith("emotions.") ? { ...current, emotions: { ...current.emotions, [key.split(".")[1]]: value } } : { ...current, [key]: value });
  const upload = async (key: string, file: File) => {
    setUploading(key);
    const form = new FormData();
    form.append("file", file);
    const response = await fetch("/api/media", { method: "POST", body: form });
    const data = await response.json();
    if (response.ok) update(key, data.asset.url);
    setUploading("");
  };
  return (
    <details className="disclosure-section media-editor-new">
      <summary><span><strong>Protocol media</strong><small>Clips and audio for this study</small></span><b>Configure</b></summary>
      <div className="media-config-list">{rows.map(([key, label, value]) => <div key={key}><label><span>{label}</span><input value={value} placeholder="No media assigned" onChange={(event) => update(key, event.target.value)} /></label><label className="media-upload">{uploading === key ? "Uploading" : "Upload"}<input type="file" accept="video/*,audio/*,image/*" onChange={(event) => event.target.files?.[0] && upload(key, event.target.files[0])} /></label></div>)}</div>
      <button className="operator-secondary" onClick={() => act("media", { media })}>Save media configuration</button>
    </details>
  );
}

function HistoryPanel({ onRestore }: { onRestore: (snapshot: SessionSnapshot) => void }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    listSessions().then(setItems).catch(() => setError("Unable to load session history."));
  }, []);
  return (
    <div className="history-list">
      {error ? <p>{error}</p> : null}
      {items.map((item) => <div key={item.code}><span><strong>P{item.participant_id}</strong><small>{item.code} / {item.status}</small></span><time>{new Date(item.updated_at).toLocaleString()}</time><button onClick={async () => onRestore(await load(item.code))}>Restore</button></div>)}
    </div>
  );
}

function DiagnosticsDrawer({ snapshot, now, onClose }: { snapshot: SessionSnapshot; now: number; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const online = isAgentOnline(snapshot, now);
  return (
    <motion.div className="diagnostics-layer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <button className="diagnostics-backdrop" aria-label="Close diagnostics" onClick={onClose} />
      <motion.aside className="diagnostics-drawer" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}>
        <header><div><span>Advanced</span><h2 id="diagnostics-title">Diagnostics</h2></div><button ref={closeRef} onClick={onClose}>Close</button></header>
        <section>
          <h3>Acquisition system</h3>
          <dl className="diagnostic-metrics">
            <div><dt>Agent</dt><dd>{online ? "Online" : "Offline"}</dd></div>
            <div><dt>Disk</dt><dd>{snapshot.acquisition.diskFreeGb == null ? "Not measured" : `${snapshot.acquisition.diskFreeGb.toFixed(1)} GB`}</dd></div>
            <div><dt>Clock offset</dt><dd>{snapshot.acquisition.clockOffsetMs == null ? "Not measured" : `${signed(snapshot.acquisition.clockOffsetMs)} ms`}</dd></div>
            <div><dt>Dropped</dt><dd>{snapshot.acquisition.droppedPct.toFixed(2)}%</dd></div>
            <div><dt>Open files</dt><dd>{snapshot.acquisition.openFileCount}</dd></div>
            <div><dt>Configuration</dt><dd>Revision {snapshot.configRevision}</dd></div>
          </dl>
        </section>
        <section>
          <h3>Connection credentials</h3>
          <div className="diagnostic-credential"><span>Subject code</span><div><code>{snapshot.code}</code><button onClick={() => void navigator.clipboard?.writeText(snapshot.code)}>Copy</button></div></div>
          <div className="diagnostic-credential"><span>Acquisition token</span><div><code>{snapshot.acquisitionToken}</code><button onClick={() => void navigator.clipboard?.writeText(snapshot.acquisitionToken)}>Copy</button></div></div>
          <div className="diagnostic-credential"><span>Agent command</span><code className="command-code">python -m meridian_agent --server http://localhost:3000 --code {snapshot.code} --token {snapshot.acquisitionToken}</code></div>
        </section>
        <section>
          <h3>Sensor channels</h3>
          <div className="diagnostic-sensors">{snapshot.sensors.map((sensor) => <details key={sensor.id}><summary><span>{sensor.label}</span><strong>{sensor.quality}</strong></summary><dl><div><dt>Status</dt><dd>{sensor.status}</dd></div><div><dt>Rate</dt><dd>{sensor.rateHz == null ? "0" : formatRate(sensor.rateHz)} Hz</dd></div><div><dt>Samples</dt><dd>{formatCount(sensor.sampleCount)}</dd></div><div><dt>Loss</dt><dd>{sensor.dropoutPct.toFixed(2)}%</dd></div><div><dt>Device</dt><dd>{sensor.device || "None"}</dd></div><div><dt>File</dt><dd>{sensor.recordingFile || "None"}</dd></div></dl></details>)}</div>
        </section>
      </motion.aside>
    </motion.div>
  );
}

function PageHeading({ title, description, status, tone }: { title: string; description: string; status: string; tone: "good" | "bad" | "neutral" }) {
  return <header className="page-heading"><div><h1>{title}</h1><p>{description}</p></div><div className={`page-status ${tone}`} role="status"><i /><strong>{status}</strong></div></header>;
}

function StatusLine({ good, title, detail }: { good: boolean; title: string; detail: string }) {
  return <div className={`status-line ${good ? "good" : "bad"}`}><i /><span><strong>{title}</strong><small>{detail}</small></span></div>;
}

function preflightMessage(snapshot: SessionSnapshot, online: boolean, streamsGood: boolean, storageGood: boolean, syncGood: boolean) {
  if (!online) return "Connect the acquisition computer to continue.";
  if (!streamsGood) return "One or more required devices still need attention.";
  if (!storageGood) return "Free storage space before recording.";
  if (!syncGood) return "Wait for clock synchronization.";
  if (snapshot.preflightTest.status === "running") return "Testing each required stream for 10 seconds.";
  if (snapshot.preflightTest.status === "fail") return snapshot.preflightTest.detail || "The preflight test found an issue.";
  if (snapshot.preflightTest.status === "pass") return "All required systems are ready.";
  return "Run the device test to verify recording quality.";
}

function inventoryFor(sensor: SensorChannel, snapshot: SessionSnapshot) {
  const kind = sensor.group === "video" ? "video" : sensor.group === "audio" ? "audio" : "serial";
  return snapshot.acquisition.inventory[kind];
}

function isAgentOnline(snapshot: SessionSnapshot, now: number) {
  return Boolean(snapshot.acquisition.lastSeenAt && now - Date.parse(snapshot.acquisition.lastSeenAt) <= 10000);
}

function sensorOperational(sensor: SensorChannel | undefined, now: number, agentOnline: boolean) {
  return Boolean(agentOnline && sensor?.dataDetected && sensor.quality === "good" && now - Date.parse(sensor.updatedAt) <= 10000);
}

function qualityLabel(sensor?: SensorChannel) {
  if (!sensor) return "Waiting";
  if (sensor.quality === "good") return "Ready";
  if (sensor.quality === "degraded") return "Needs attention";
  if (sensor.quality === "bad") return "Failed";
  if (sensor.quality === "disabled") return "Off";
  return sensor.hardwareDetected ? "Validating" : "Not connected";
}

function humanize(value: string) { return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()); }
function signed(value: number) { return `${value > 0 ? "+" : ""}${value.toFixed(1)}`; }

function buildWarnings(snapshot: SessionSnapshot, now: number) {
  const warnings: Array<{ id: string; title: string; detail: string; actions: string[] }> = [];
  const online = isAgentOnline(snapshot, now);
  if (!online) warnings.push({ id: "agent", title: "Acquisition computer offline", detail: "No heartbeat has arrived in the last 10 seconds.", actions: ["Check the agent window", "Check network access", "Keep local recording files open"] });
  if (snapshot.acquisition.diskFreeGb != null && snapshot.acquisition.diskFreeGb < 10) warnings.push({ id: "disk", title: "Storage critically low", detail: `Only ${snapshot.acquisition.diskFreeGb.toFixed(1)} GB remains on the acquisition computer.`, actions: ["Stop recording safely", "Free local storage", "Verify finalized files"] });
  for (const id of snapshot.requiredSensors) {
    const sensor = snapshot.sensors.find((item) => item.id === id);
    if (!sensor || !online) continue;
    if (["bad", "waiting", "disabled"].includes(sensor.quality)) warnings.push({ id, title: `${sensor.label} signal lost`, detail: sensor.detail || "No valid samples are arriving.", actions: sensor.id === "oximeter" ? ["Check finger placement", "Check sensor power", "Check USB cable"] : sensor.id === "face" ? ["Check camera power", "Check USB cable", "Close other camera applications"] : ["Check sensor power", "Check device assignment", "Check cable"] });
    else if (sensor.quality === "degraded") warnings.push({ id, title: `${sensor.label} quality degraded`, detail: `Current rate ${sensor.rateHz ?? 0} Hz. Target ${sensor.targetRateHz ?? "not set"} Hz.`, actions: ["Inspect signal diagnostics", "Check packet loss", "Check the device connection"] });
  }
  return warnings;
}

function overallQuality(files: RecordingArtifact[]) { if (!files.length) return "PENDING"; if (files.some((file) => file.quality === "fail")) return "FAIL"; if (files.some((file) => file.quality === "warning")) return "WARNING"; return "PASS"; }
function eventsCsv(snapshot: SessionSnapshot) { const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`; return [["sequence", "timestamp", "participant", "session", "step", "event", "severity", "source", "detail"].join(","), ...snapshot.events.map((event) => [event.sequence, event.createdAt, snapshot.participantId, snapshot.code, event.stepLabel, event.eventType, event.severity, event.source, event.detail].map(quote).join(","))].join("\n"); }
function sensorStatusCsv(snapshot: SessionSnapshot) { const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`; return [["sensor", "status", "quality", "rate_hz", "target_hz", "samples", "dropped", "loss_pct", "latest", "device", "file", "bytes", "updated_at"].join(","), ...snapshot.sensors.map((sensor) => [sensor.id, sensor.status, sensor.quality, sensor.rateHz, sensor.targetRateHz, sensor.sampleCount, sensor.droppedSamples, sensor.dropoutPct, sensor.latestValue, sensor.device, sensor.recordingFile, sensor.bytesWritten, sensor.updatedAt].map(quote).join(","))].join("\n"); }
function report(snapshot: SessionSnapshot) { return ["Meridian session report", `Participant: ${snapshot.participantId}`, `Session: ${snapshot.code}`, `Operator: ${snapshot.operator}`, `Protocol: ${snapshot.protocolVersion}`, `Status: ${snapshot.status}`, `Started: ${snapshot.recordingStartedAt || "Not started"}`, `Updated: ${snapshot.updatedAt}`, `Acquisition agent: ${snapshot.acquisition.state} ${snapshot.acquisition.host}`, `Recording files: ${snapshot.recordings.length}`, `Overall quality: ${overallQuality(snapshot.recordings)}`, `Sensor samples: ${snapshot.sensors.reduce((sum, item) => sum + item.sampleCount, 0)}`, `Events: ${snapshot.events.length}`, `Ratings: ${snapshot.ratings.length}`, `Notes: ${snapshot.notes.length}`, `BP readings: ${snapshot.bpReadings.length}`].join("\n"); }
function exportableSnapshot(snapshot: SessionSnapshot) { const { acquisitionToken: secret, ...safe } = snapshot; void secret; return safe; }
function download(name: string, content: string, type: string) { const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); }
function formatClock(seconds: number) { const value = Math.max(0, Math.round(seconds)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`; }
function formatRate(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value.toFixed(value < 100 ? 1 : 0)}`; }
function formatCount(value: number) { return new Intl.NumberFormat("en", { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`; if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`; return `${(value / 1073741824).toFixed(1)} GB`; }
