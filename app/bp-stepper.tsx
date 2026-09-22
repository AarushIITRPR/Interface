"use client";

import { useEffect, useRef } from "react";

const HOLD_DELAY_MS = 400;
const HOLD_REPEAT_MS = 80;

/**
 * A number set with the mouse: -5 -1 [value] +1 +5, where holding a button keeps stepping. The value can still be
 * typed. An empty value (an optional pulse) starts at `start` on the first press.
 */
export function BpStepper({ label, value, onChange, min, max, start, unit, disabled }: {
  label: string; value: number | null; onChange: (value: number | null) => void;
  min: number; max: number; start: number; unit?: string; disabled?: boolean;
}) {
  const latest = useRef(value);
  latest.current = value;
  const timers = useRef<{ delay?: number; repeat?: number }>({});
  const stop = () => { window.clearTimeout(timers.current.delay); window.clearInterval(timers.current.repeat); timers.current = {}; };
  useEffect(() => stop, []);
  useEffect(() => { if (disabled) stop(); }, [disabled]);

  const step = (delta: number) => {
    const next = latest.current === null ? start : Math.max(min, Math.min(max, latest.current + delta));
    latest.current = next;
    onChange(next);
  };
  const press = (delta: number) => {
    if (disabled) return;
    stop();
    step(delta);
    timers.current.delay = window.setTimeout(() => { timers.current.repeat = window.setInterval(() => step(delta), HOLD_REPEAT_MS); }, HOLD_DELAY_MS);
  };
  const button = (delta: number) => <button type="button" disabled={disabled} aria-label={`${label} ${delta > 0 ? "plus" : "minus"} ${Math.abs(delta)}`}
    onPointerDown={(event) => { if (event.button === 0) press(delta); }} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); step(delta); } }}
    onContextMenu={(event) => event.preventDefault()}>{delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`}</button>;

  return <div className="bp-stepper" role="group" aria-label={label}>
    <span className="bp-stepper-label">{label}{unit ? <small>{unit}</small> : null}</span>
    <div className="bp-stepper-row">
      {button(-5)}{button(-1)}
      <input inputMode="numeric" aria-label={label} disabled={disabled} value={value ?? ""} placeholder={"–"}
        onChange={(event) => { const digits = event.target.value.replace(/\D/g, "").slice(0, 3); onChange(digits ? Number(digits) : null); }}
        onBlur={() => { if (value !== null) onChange(Math.max(min, Math.min(max, value))); }} />
      {button(1)}{button(5)}
    </div>
  </div>;
}
