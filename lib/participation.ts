import {SENSOR_CATALOG, type SessionSnapshot} from "./types";

export const FORM_VERSION = "research-consent-1";
export const consentChoices = [
  "I choose to take part in this study.",
  "I agree to the recording described above.",
  "I agree to the research and model training described above.",
] as const;
export const experienceRatings = ["Difficult", "Okay", "Easy"] as const;
export const dataNames: Record<string,string> = {
  face:"face video", audio:"microphone audio", oximeter:"pulse and blood oxygen",
  thermal:"thermal video", csi:"WiFi signal measurements", emg:"muscle activity",
  gsr:"skin conductance", ecg:"heart electrical activity", ppg:"pulse waveform",
  resp:"breathing", imu:"movement", eye:"eye movements", screen:"screen video",
  interaction:"interaction logs", photodiode:"display timing",
};
export function selectedSources(s:SessionSnapshot) {
  return SENSOR_CATALOG.filter(({id})=>s.requiredSensors.includes(id) ||
    (s.deviceConfig[id] && s.deviceConfig[id]!=="none")).map(({id})=>id);
}
export function hasConsent(s:SessionSnapshot) {
  return s.consent?.version===FORM_VERSION && selectedSources(s).every(id=>s.consent!.sources.includes(id));
}
export function feedbackStage(s:SessionSnapshot):"none"|"stopping"|"open" {
  if(!s.recordingStartedAt || !s.consent || s.feedback || !["complete","aborted"].includes(s.status)) return "none";
  return s.acquisition.finalizedAt && s.acquisition.finalizedAt>=s.recordingStartedAt ? "open":"stopping";
}
