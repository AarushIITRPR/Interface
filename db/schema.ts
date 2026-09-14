import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  participantId: integer("participant_id").notNull(),
  operator: text("operator").notNull(),
  protocolVersion: text("protocol_version").notNull(),
  status: text("status").notNull(),
  stepIndex: integer("step_index").notNull(),
  revision: integer("revision").notNull(),
  assignmentJson: text("assignment_json").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("idx_sessions_code").on(table.code), index("idx_sessions_updated").on(table.updatedAt)]);

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  sequence: integer("sequence").notNull(),
  stepId: text("step_id").notNull(),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull(),
  source: text("source").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_events_session_sequence").on(table.sessionId, table.sequence)]);

export const mediaAssets = sqliteTable("media_assets", {
  id: text("id").primaryKey(),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_media_created").on(table.createdAt)]);

export const sessionTelemetry = sqliteTable("session_telemetry", {
  code: text("code").primaryKey(),
  sensorsJson: text("sensors_json"),
  acquisitionJson: text("acquisition_json"),
  operatorLastSeenAt: text("operator_last_seen_at"),
  subjectLastSeenAt: text("subject_last_seen_at"),
  updatedAt: text("updated_at").notNull(),
});

export const annotations = sqliteTable("annotations", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  stepId: text("step_id").notNull(),
  chunk: integer("chunk").notNull(),
  samplesJson: text("samples_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_annotations_code").on(table.code, table.stepId, table.chunk)]);
