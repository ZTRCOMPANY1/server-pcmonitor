const Database = require("better-sqlite3");
const path = require("path");
const bcrypt = require("bcryptjs");

const db = new Database(path.join(__dirname, "monitor.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT UNIQUE NOT NULL,
  name TEXT,
  hostname TEXT,
  username TEXT,
  os TEXT,
  os_version TEXT,
  architecture TEXT,
  local_ip TEXT,
  public_ip TEXT,
  agent_version TEXT,
  last_seen_at TEXT,
  first_seen_at TEXT,
  is_online INTEGER DEFAULT 0,
  token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cpu_percent REAL,
  cpu_temp REAL,
  gpu_percent REAL,
  gpu_temp REAL,
  fan_speed_rpm REAL,
  memory_percent REAL,
  memory_total_bytes INTEGER,
  memory_used_bytes INTEGER,
  disk_percent REAL,
  disk_total_bytes INTEGER,
  disk_used_bytes INTEGER,
  disk_free_bytes INTEGER,
  disk_read_bytes INTEGER,
  disk_write_bytes INTEGER,
  bytes_sent INTEGER,
  bytes_recv INTEGER,
  ping_ms REAL,
  packet_loss_percent REAL,
  battery_percent REAL,
  battery_plugged INTEGER,
  uptime_seconds INTEGER,
  boot_time TEXT
);

CREATE TABLE IF NOT EXISTS partitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  device TEXT,
  mountpoint TEXT,
  filesystem TEXT,
  total_bytes INTEGER,
  used_bytes INTEGER,
  free_bytes INTEGER,
  percent REAL
);

CREATE TABLE IF NOT EXISTS processes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  pid INTEGER,
  process_name TEXT,
  cpu_percent REAL,
  memory_percent REAL,
  status TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  level TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_key TEXT UNIQUE NOT NULL,
  threshold REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
`);

function seedAdminUser(username, password) {
  const existing = db.prepare("SELECT id FROM admin_users WHERE username = ?").get(username);
  if (existing) return;

  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare(`
    INSERT INTO admin_users (username, password_hash, created_at)
    VALUES (?, ?, ?)
  `).run(username, passwordHash, new Date().toISOString());
}

function seedAlertRules() {
  const defaults = [
    { rule_key: "cpu_percent", threshold: 85 },
    { rule_key: "memory_percent", threshold: 90 },
    { rule_key: "disk_percent", threshold: 90 },
    { rule_key: "cpu_temp", threshold: 85 },
    { rule_key: "ping_ms", threshold: 150 }
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO alert_rules (rule_key, threshold, enabled)
    VALUES (?, ?, 1)
  `);

  for (const rule of defaults) {
    stmt.run(rule.rule_key, rule.threshold);
  }
}

module.exports = {
  db,
  seedAdminUser,
  seedAlertRules
};