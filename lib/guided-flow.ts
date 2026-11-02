import type { ProtocolStep } from "./types";

/** The button label is not authority: enforce the same boundaries for subject API calls. */
export function permitsGuidedTransition(step: ProtocolStep, action: string, event: unknown, elapsedMs: number) {
  switch (action) {
    case "advance":
      return step.type === "setup" || step.type === "clip" ||
        (step.type === "gate" && elapsedMs >= (step.durationSec ?? 40) * 1000);
    case "autoAdvance":
      return step.advance === "timer" && !!step.durationSec && elapsedMs >= step.durationSec * 1000;
    case "rating": return step.type === "sam";
    case "taskComplete":
      return (step.type === "stroop" && event === "stroop_complete") ||
        (step.type === "nback" && event === "nback_complete") ||
        (step.title === "Breath hold" && event === "breath_hold_complete");
    default: return false;
  }
}
