/**
 * Stimulus registry. Add alternative clips per emotion, or a neutral control clip, by placing the normalized file in
 * public/protocol-media (see scripts/normalize-media.sh) and adding an entry here. Each session stores the exemplar it
 * was assigned, so later registry edits never change existing sessions.
 */
import { EMOTIONS, type Emotion } from "./types";

export type ClipKind = Emotion | "neutral";
export const CLIP_KINDS: readonly ClipKind[] = [...EMOTIONS, "neutral"];

export type Stimulus = {
  id: string;
  clip: ClipKind;
  src: string;
  durationSec: number;
  /** Where the clip comes from (film, validated set, normative ratings), for the dataset documentation. */
  source: string;
};

export const STIMULI: readonly Stimulus[] = [
  { id: "happy-1", clip: "happy", src: "/protocol-media/happy.mp4", durationSec: 93, source: "Meridian registered clip" },
  { id: "sad-1", clip: "sad", src: "/protocol-media/sad.mp4", durationSec: 148, source: "Meridian registered clip" },
  { id: "anger-1", clip: "anger", src: "/protocol-media/anger.mp4", durationSec: 151, source: "Meridian registered clip" },
  { id: "fear-1", clip: "fear", src: "/protocol-media/fear.mp4", durationSec: 95, source: "Meridian registered clip" },
  { id: "surprise-1", clip: "surprise", src: "/protocol-media/surprise.mp4", durationSec: 183, source: "Meridian registered clip" },
  { id: "disgust-1", clip: "disgust", src: "/protocol-media/disgust.mp4", durationSec: 151, source: "Meridian registered clip" },
];

export function stimulusById(id: string | undefined, registry: readonly Stimulus[] = STIMULI) {
  return registry.find((stimulus) => stimulus.id === id);
}

/**
 * One exemplar per clip kind. The exemplar index advances every six participants (one full cycle of emotion orders)
 * and is offset per emotion, so each exemplar is used equally often and is not tied to one emotion order row.
 */
export function chooseStimuli(pid: number, registry: readonly Stimulus[] = STIMULI): Partial<Record<ClipKind, string>> {
  const chosen: Partial<Record<ClipKind, string>> = {};
  CLIP_KINDS.forEach((clip, offset) => {
    const pool = registry.filter((stimulus) => stimulus.clip === clip);
    if (pool.length) chosen[clip] = pool[(Math.floor((Math.max(1, pid) - 1) / 6) + offset) % pool.length].id;
  });
  return chosen;
}
