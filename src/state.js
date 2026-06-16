const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const CONFIG_FILE = path.join(ROOT_DIR, "config.json");

const state = {
  db: { channels: [], usage: [] },
  rr: new Map(),
  apiKey: ""
};

function backupBadFile(file) {
  if (!fs.existsSync(file)) return;
  const backup = `${file}.bad-${Date.now()}`;
  try {
    fs.renameSync(file, backup);
    console.warn(`Invalid data file moved to ${backup}`);
  } catch (error) {
    console.warn(`Failed to backup invalid file ${file}: ${error.message}`);
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const next = { port: 8880, apiKey: "pwd" };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    return next;
  }
  let current;
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (error) {
    console.warn(`Failed to read config.json: ${error.message}`);
    backupBadFile(CONFIG_FILE);
    const next = { port: 8880, apiKey: "pwd" };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    return next;
  }
  const next = {
    port: current.port || 8880,
    apiKey: current.apiKey || "pwd"
  };
  if (next.port !== current.port || next.apiKey !== current.apiKey) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  }
  return next;
}

const config = loadConfig();
const PORT = Number(process.env.PORT || config.port || 8880);
const KEEP_ALIVE_TIMEOUT_MS = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000);
const HEADERS_TIMEOUT_MS = Number(process.env.HEADERS_TIMEOUT_MS || KEEP_ALIVE_TIMEOUT_MS + 1000);

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  state.apiKey = process.env.PROXY_API_KEY || config.apiKey;
  if (fs.existsSync(DB_FILE)) {
    try {
      const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      state.db = {
        channels: Array.isArray(db.channels) ? db.channels : [],
        usage: Array.isArray(db.usage) ? db.usage : []
      };
    } catch (error) {
      console.warn(`Failed to read data/db.json: ${error.message}`);
      backupBadFile(DB_FILE);
      state.db = { channels: [], usage: [] };
      saveDb();
    }
  } else {
    saveDb();
  }
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(state.db, null, 2));
}

function usageRecord(record) {
  state.db.usage.unshift({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    ...record
  });
  state.db.usage = state.db.usage.slice(0, 1000);
  try {
    saveDb();
  } catch (error) {
    console.warn(`Failed to save usage record: ${error.message}`);
  }
}

module.exports = {
  PUBLIC_DIR,
  PORT,
  KEEP_ALIVE_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  state,
  ensureData,
  saveDb,
  usageRecord
};
