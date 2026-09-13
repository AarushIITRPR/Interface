import { EMOTIONS, type Assignment, type BufferKind, type Emotion, type ProtocolStep } from "./types";

const WILLIAMS6 = [[1,2,6,3,5,4],[2,3,1,4,6,5],[3,4,2,5,1,6],[4,5,3,6,2,1],[5,6,4,1,3,2],[6,1,5,2,4,3]];
const BUFFER_ORDERS: BufferKind[][] = [
  ["stroop","nback","conversation"],["stroop","conversation","nback"],["nback","stroop","conversation"],
  ["nback","conversation","stroop"],["conversation","stroop","nback"],["conversation","nback","stroop"],
];

export function assignFor(raw: number | string): Assignment {
  const pid = Math.max(1, Number.parseInt(String(raw), 10) || 1);
  const row = (pid - 1) % 6;
  const order = WILLIAMS6[row].map((n) => EMOTIONS[n - 1]);
  const buffers = BUFFER_ORDERS[row];
  return { pid, row: row + 1, buf1: buffers[0], buf2: buffers[1], buf3: buffers[2], block1: [order[0],order[1]], block2: [order[2],order[3]], block3: [order[4],order[5]], fullOrder: order };
}

// The plan depends only on the counterbalancing row, so there are at most six distinct plans to build.
const planCache = new Map<string, readonly ProtocolStep[]>();

export function buildPlan(a: Assignment): readonly ProtocolStep[] {
  const key = JSON.stringify([a.block1,a.block2,a.block3,a.buf1,a.buf2,a.buf3]);
  let plan = planCache.get(key);
  if (!plan) { plan = Object.freeze(createPlan(a)); planCache.set(key, plan); }
  return plan;
}

function createPlan(a: Assignment): ProtocolStep[] {
  const steps: ProtocolStep[] = [];
  const add = (step: Omit<ProtocolStep,"id"|"index">) => steps.push({ ...step, id:`s${String(steps.length).padStart(2,"0")}-${step.type}${step.emo ? `-${step.emo}` : ""}`, index:steps.length });
  const clip = (emo: Emotion, phase: string) => add({ type:"clip", title:`Emotion clip: ${emo}`, subjectPrompt:"Watch naturally.", operatorScript:"Watch the clip naturally and react however feels natural. There is no right or wrong response.", operatorNote:"Onset and offset are logged automatically.", phase, emo, advance:"media", estimatedSec:12 });
  const rating = (emo: Emotion, phase: string) => add({ type:"sam", title:`Self-report: ${emo}`, subjectPrompt:"Choose what fits best.", operatorScript:"Choose the response that best matches your experience. Go with your first instinct.", operatorNote:"Valence, arousal, and dominance are presented one at a time on a 1 to 10 scale.", phase, emo, advance:"task", estimatedSec:25 });
  const washout = (phase: string) => add({ type:"washout", title:"Neutral washout", subjectPrompt:"", operatorScript:"Rest your eyes on the cross and breathe normally.", operatorNote:"Neutral fixation period.", phase, durationSec:20, advance:"timer", estimatedSec:20 });
  const gate = (phase: string, title="Return-to-baseline gate") => add({ type:"gate", title, subjectPrompt:"Sit quietly and breathe normally.", operatorScript:"Sit quietly and breathe normally while we prepare the next activity.", operatorNote:"Advance after the return-to-baseline checks are complete.", phase, durationSec:40, advance:"gate", estimatedSec:45 });
  const buffer = (kind: BufferKind, phase: string) => {
    if (kind === "stroop") add({ type:"stroop", title:"Stroop colour-word task", subjectPrompt:"Select the ink colour, not the word.", operatorScript:"Select the button matching the ink colour, not what the word says. Respond as quickly and accurately as you can.", operatorNote:"30 trials with reaction time and accuracy logging.", phase, advance:"task", estimatedSec:90 });
    else if (kind === "nback") add({ type:"nback", title:"N-back task", subjectPrompt:"Press Match when the position repeats from N steps ago.", operatorScript:"Press Match whenever the current position is the same as the position from N steps ago.", operatorNote:"20 scored trials with hits, misses, false alarms, and response time.", phase, advance:"task", estimatedSec:50 });
    else add({ type:"conversation", title:"Conversation", subjectPrompt:"Talk together about something familiar.", operatorScript:"Talk for a few minutes about a recent trip, a hobby, or how the day has been.", operatorNote:"Neutral semi-structured conversation.", phase, durationSec:180, advance:"timer", estimatedSec:180 });
  };

  add({ type:"setup", title:"Sensor and synchronization check", subjectPrompt:"Look toward the screen and stay still.", operatorScript:"Stay fairly still and keep facing the screen while the recording is checked.", operatorNote:"Verify every required stream and trigger synchronization before continuing.", phase:"Getting settled", advance:"operator", estimatedSec:30 });
  add({ type:"baseline", title:"Resting baseline, eyes open", subjectPrompt:"Look at the cross. Breathe naturally.", operatorScript:"Look at the cross and breathe normally.", operatorNote:"Eyes-open resting reference. Take the resting BP reading after settling.", phase:"Getting settled", durationSec:120, fixation:true, bp:true, bpLabel:"Resting anchor", advance:"timer", estimatedSec:120 });
  add({ type:"baseline", title:"Resting baseline, eyes closed", subjectPrompt:"Close your eyes. Breathe naturally.", operatorScript:"Gently close your eyes and keep breathing naturally.", operatorNote:"Eyes-closed resting reference.", phase:"Getting settled", durationSec:90, advance:"timer", estimatedSec:90 });

  const block = (pair:[Emotion,Emotion], kind:BufferKind, phase:string, withGate=true) => { clip(pair[0],phase); rating(pair[0],phase); washout(phase); clip(pair[1],phase); rating(pair[1],phase); buffer(kind,phase); if(withGate) gate(phase); };
  block(a.block1,a.buf1,"Part 1"); block(a.block2,a.buf2,"Part 2"); block(a.block3,a.buf3,"Part 3",false);
  gate("Movement and breathing","Settle before physiological sweep");
  add({ type:"sweep", title:"Seated rest", subjectPrompt:"Sit comfortably and stay still.", operatorScript:"Sit comfortably and stay still for a short moment.", operatorNote:"20 second seated anchor.", phase:"Movement and breathing", durationSec:20, advance:"timer", estimatedSec:20 });
  add({ type:"sweep", title:"Box breathing", subjectPrompt:"Follow the circle.", operatorScript:"Breathe in as the circle grows, hold, breathe out as it shrinks, then hold again.", operatorNote:"Use the registered media when available, otherwise use the visual pacer.", phase:"Movement and breathing", durationSec:45, advance:"timer", estimatedSec:45 });
  add({ type:"sweep", title:"Breath hold", subjectPrompt:"Breathe in and hold. Release whenever you need to.", operatorScript:"Take a normal breath in and hold only for as long as feels comfortable.", operatorNote:"Voluntary and comfort limited. Skip if contraindicated.", phase:"Movement and breathing", safety:true, advance:"subject", estimatedSec:40 });
  add({ type:"sweep", title:"Head movement and speaking", subjectPrompt:"Turn left. Turn right. Look up. Look down. Then speak.", operatorScript:"Slowly turn left, right, up, and down. Then speak aloud for a few seconds.", operatorNote:"Motion and speech segment.", phase:"Movement and breathing", durationSec:30, advance:"timer", estimatedSec:30 });
  add({ type:"sweep", title:"Standing", subjectPrompt:"Stand up slowly. Stay still.", operatorScript:"Stand up slowly and remain still. Tell me immediately if you feel dizzy.", operatorNote:"Orthostatic measurement. Skip if contraindicated.", phase:"Movement and breathing", durationSec:45, safety:true, bp:true, bpLabel:"Orthostatic standing", advance:"timer", estimatedSec:45 });
  add({ type:"sweep", title:"Brief exertion", subjectPrompt:"March in place or do sit-to-stands.", operatorScript:"March in place or do comfortable sit-to-stands.", operatorNote:"20 second exertion period. Skip if contraindicated.", phase:"Movement and breathing", durationSec:20, safety:true, advance:"timer", estimatedSec:20 });
  add({ type:"sweep", title:"Post-exertion recovery", subjectPrompt:"Sit down. Stay still.", operatorScript:"Sit back down and stay still while your breathing settles.", operatorNote:"60 second recovery and post-exertion BP.", phase:"Movement and breathing", durationSec:60, bp:true, bpLabel:"Post-exertion peak", advance:"timer", estimatedSec:60 });
  add({ type:"bodyscan", title:"Guided body scan", subjectPrompt:"Get comfortable. Close your eyes.", operatorScript:"Sit comfortably, close your eyes, and follow the guided audio.", operatorNote:"Four minute guided body scan.", phase:"Relaxation", durationSec:240, advance:"timer", estimatedSec:240 });
  add({ type:"recovery", title:"Return to normal", subjectPrompt:"Open your eyes when you are ready.", operatorScript:"Open your eyes whenever you are ready.", operatorNote:"Final eyes-open return and BP.", phase:"Relaxation", durationSec:60, bp:true, bpLabel:"Relaxed final", advance:"timer", estimatedSec:60 });
  add({ type:"end", title:"Session complete", subjectPrompt:"Thank you.", operatorScript:"That is everything. Thank you.", operatorNote:"Confirm recorders saved, then export.", phase:"All done", advance:"operator", estimatedSec:15 });
  return steps;
}

export function shortLabel(step: ProtocolStep) {
  if (step.type === "clip") return `Clip: ${step.emo}`;
  if (step.type === "sam") return `Rating: ${step.emo}`;
  return step.title;
}

export function estimateRemaining(plan: readonly ProtocolStep[], index: number) {
  return plan.slice(index).reduce((sum, step) => sum + step.estimatedSec, 0);
}
