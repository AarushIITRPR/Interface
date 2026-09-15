/**
 * Cohort-level view across sessions: recruitment balance, counterbalancing coverage, and data-quality signals the
 * server knows about (pauses, overrides, skips, missing details). Per-stream coverage lives in each agent's QA report.
 */
import { PARTICIPANT_FIELDS, consentReady, missingParticipantFields } from "./rig";
import type { SessionSnapshot } from "./types";

export type CohortSession = {
  code: string;
  participantId: number;
  status: SessionSnapshot["status"];
  protocolVersion: string;
  createdAt: string;
  durationMin: number | null;
  emotionRow: number;
  taskRow: number | null;
  skinType: string | null;
  sex: string | null;
  ageBand: string | null;
  missingDetails: number;
  consent: boolean;
  pauses: number;
  gateOverrides: number;
  skippedSteps: number;
  artifacts: number;
  questionnaires: number;
  ratings: number;
  csiBaseline: string;
};

const count = (snapshot: SessionSnapshot, types: string[]) => snapshot.events.filter((event) => types.includes(event.eventType)).length;

export function summarizeSession(snapshot: SessionSnapshot): CohortSession {
  const values = snapshot.participantMetadata?.values;
  const end = snapshot.events.findLast?.((event) => ["session_complete", "session_aborted"].includes(event.eventType))?.createdAt;
  const start = snapshot.recordingStartedAt;
  return {
    code: snapshot.code,
    participantId: snapshot.participantId,
    status: snapshot.status,
    protocolVersion: snapshot.protocolVersion,
    createdAt: snapshot.createdAt,
    durationMin: start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 6000) / 10 : null,
    emotionRow: snapshot.assignment.row,
    taskRow: snapshot.assignment.bufferRow ?? null,
    skinType: values?.fitzpatrick ? String(values.fitzpatrick) : null,
    sex: values?.sex ? String(values.sex) : null,
    ageBand: values?.ageBand ? String(values.ageBand) : null,
    missingDetails: missingParticipantFields(values).length,
    consent: consentReady(snapshot.consent?.values),
    pauses: count(snapshot, ["session_paused", "operator_lost", "sensor_lost"]),
    gateOverrides: count(snapshot, ["gate_override"]),
    skippedSteps: count(snapshot, ["step_skipped"]),
    artifacts: count(snapshot, ["artifact"]),
    questionnaires: snapshot.questionnaires?.length ?? 0,
    ratings: snapshot.ratings.length,
    csiBaseline: snapshot.csiCalibration?.status ?? "not recorded",
  };
}

export type CohortOverview = {
  sessions: CohortSession[];
  statusCounts: Record<string, number>;
  completedParticipants: number;
  duplicateParticipants: number[];
  coverage: number[][];
  distributions: Record<"skinType" | "sex" | "ageBand", Record<string, number>>;
};

export function summarizeCohort(sessions: CohortSession[]): CohortOverview {
  const statusCounts: Record<string, number> = {};
  for (const session of sessions) statusCounts[session.status] = (statusCounts[session.status] ?? 0) + 1;
  const completed = sessions.filter((session) => session.status === "complete");
  const perParticipant = new Map<number, number>();
  for (const session of completed) perParticipant.set(session.participantId, (perParticipant.get(session.participantId) ?? 0) + 1);
  // Rows are emotion-order rows 1-6, columns task-order rows 1-6; each cell counts completed sessions.
  const coverage = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 0));
  for (const session of completed) if (session.taskRow) coverage[session.emotionRow - 1][session.taskRow - 1] += 1;
  const options = (id: string) => (PARTICIPANT_FIELDS.find((field) => field.id === id) as { options?: readonly string[] } | undefined)?.options ?? [];
  const distribution = (key: "skinType" | "sex" | "ageBand", fieldId: string) => {
    const result: Record<string, number> = Object.fromEntries(options(fieldId).map((option) => [option, 0]));
    for (const session of completed) {
      const value = session[key] ?? "Not recorded";
      result[value] = (result[value] ?? 0) + 1;
    }
    return result;
  };
  return {
    sessions,
    statusCounts,
    completedParticipants: perParticipant.size,
    duplicateParticipants: [...perParticipant.entries()].filter(([, total]) => total > 1).map(([pid]) => pid).sort((a, b) => a - b),
    coverage,
    distributions: { skinType: distribution("skinType", "fitzpatrick"), sex: distribution("sex", "sex"), ageBand: distribution("ageBand", "ageBand") },
  };
}
