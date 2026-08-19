const fs = require('node:fs/promises');
const path = require('node:path');
const defaultMedia = require('../config/defaultMedia');

const dataDirectory = path.resolve(__dirname, '..', 'data');
const sessionsDirectory = path.join(dataDirectory, 'sessions');
const mediaConfigPath = path.join(dataDirectory, 'media-config.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeKnownMedia(source = {}) {
  const merged = clone(defaultMedia);
  const emotions = source.emotions && typeof source.emotions === 'object'
    ? source.emotions
    : {};

  for (const key of Object.keys(merged.emotions)) {
    if (typeof emotions[key] === 'string') merged.emotions[key] = emotions[key].trim();
  }

  for (const key of ['washout', 'box_breathing', 'body_scan', 'fixation']) {
    if (typeof source[key] === 'string') merged[key] = source[key].trim();
  }

  return merged;
}

async function ensureDataDirectories() {
  await fs.mkdir(sessionsDirectory, { recursive: true });
}

async function readMediaConfig() {
  await ensureDataDirectories();

  try {
    const contents = await fs.readFile(mediaConfigPath, 'utf8');
    return mergeKnownMedia(JSON.parse(contents));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return clone(defaultMedia);
  }
}

async function writeMediaConfig(config) {
  await ensureDataDirectories();
  const normalized = mergeKnownMedia(config);
  await fs.writeFile(mediaConfigPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function sessionFileName(session) {
  const participantId = String(session?.participant?.pid ?? 'unknown').replace(/[^0-9A-Za-z_-]/g, '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `session_P${participantId || 'unknown'}_${timestamp}.json`;
}

async function writeSession(session) {
  await ensureDataDirectories();
  const fileName = sessionFileName(session);
  await fs.writeFile(
    path.join(sessionsDirectory, fileName),
    `${JSON.stringify(session, null, 2)}\n`,
    'utf8'
  );
  return fileName;
}

module.exports = {
  readMediaConfig,
  writeMediaConfig,
  writeSession
};
