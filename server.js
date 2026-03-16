require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");
const { db, seedAdminUser, seedAlertRules } = require("./db");
const { loginAdmin, requireAuth } = require("./auth");
const { insertEvent, evaluateAlerts } = require("./alerts");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = Number(process.env.PORT || 3000);
const AGENT_GLOBAL_TOKEN = process.env.AGENT_GLOBAL_TOKEN || "ztr280520";
const OFFLINE_TIMEOUT_MS = Number(process.env.OFFLINE_TIMEOUT_MS || 20000);

seedAdminUser(
  process.env.ADMIN_USERNAME || "admin",
  process.env.ADMIN_PASSWORD || "admin123"
);
seedAlertRules();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function isMachineOnline(lastSeenAt) {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < OFFLINE_TIMEOUT_MS;
}

function safeMachine(machine) {
  return {
    ...machine,
    is_online: Boolean(machine.is_online)
  };
}

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const token = loginAdmin(username, password);
  if (!token) {
    return res.status(401).json({ ok: false, error: "Usuário ou senha inválidos" });
  }
  return res.json({ ok: true, token });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, serverTime: new Date().toISOString() });
});

app.get("/api/machines", requireAuth, (req, res) => {
  const machines = db.prepare(`
    SELECT * FROM machines
    ORDER BY updated_at DESC
  `).all().map((machine) => ({
    ...safeMachine(machine),
    is_online: isMachineOnline(machine.last_seen_at)
  }));

  res.json({ ok: true, machines });
});

app.get("/api/machines/:machineId", requireAuth, (req, res) => {
  const machine = db.prepare("SELECT * FROM machines WHERE machine_id = ?").get(req.params.machineId);
  if (!machine) {
    return res.status(404).json({ ok: false, error: "Máquina não encontrada" });
  }

  const latestMetric = db.prepare(`
    SELECT * FROM metrics WHERE machine_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(req.params.machineId);

  const partitions = db.prepare(`
    SELECT * FROM partitions WHERE machine_id = ?
    ORDER BY created_at DESC
  `).all(req.params.machineId);

  const processes = db.prepare(`
    SELECT * FROM processes WHERE machine_id = ?
    ORDER BY created_at DESC, cpu_percent DESC
    LIMIT 15
  `).all(req.params.machineId);

  res.json({
    ok: true,
    machine: {
      ...safeMachine(machine),
      is_online: isMachineOnline(machine.last_seen_at)
    },
    latestMetric,
    partitions,
    processes
  });
});

app.get("/api/machines/:machineId/history", requireAuth, (req, res) => {
  const range = req.query.range || "day";
  let sinceMs = 24 * 60 * 60 * 1000;

  if (range === "hour") sinceMs = 60 * 60 * 1000;
  if (range === "week") sinceMs = 7 * 24 * 60 * 60 * 1000;

  const since = new Date(Date.now() - sinceMs).toISOString();

  const metrics = db.prepare(`
    SELECT * FROM metrics
    WHERE machine_id = ? AND created_at >= ?
    ORDER BY created_at ASC
  `).all(req.params.machineId, since);

  res.json({ ok: true, metrics });
});

app.get("/api/machines/:machineId/events", requireAuth, (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();

  let events;
  if (q) {
    events = db.prepare(`
      SELECT * FROM events
      WHERE machine_id = ? AND LOWER(message) LIKE ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(req.params.machineId, `%${q}%`);
  } else {
    events = db.prepare(`
      SELECT * FROM events
      WHERE machine_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(req.params.machineId);
  }

  res.json({ ok: true, events });
});

app.get("/api/export/:machineId.json", requireAuth, (req, res) => {
  const metrics = db.prepare(`
    SELECT * FROM metrics WHERE machine_id = ?
    ORDER BY created_at DESC LIMIT 500
  `).all(req.params.machineId);

  res.json({ ok: true, machineId: req.params.machineId, metrics });
});

app.get("/api/export/:machineId.csv", requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM metrics WHERE machine_id = ?
    ORDER BY created_at DESC LIMIT 500
  `).all(req.params.machineId);

  if (!rows.length) {
    res.type("text/csv");
    return res.send("no_data\n");
  }

  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((header) => JSON.stringify(row[header] ?? "")).join(",")
    )
  ].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

app.post("/api/agent/metrics", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();

  if (!token || token !== AGENT_GLOBAL_TOKEN) {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }

  const payload = req.body || {};
  const machine = payload.machine;
  if (!machine?.machine_id) {
    return res.status(400).json({ ok: false, error: "machine_id obrigatório" });
  }

  const now = new Date().toISOString();
  const existingMachine = db.prepare("SELECT * FROM machines WHERE machine_id = ?").get(machine.machine_id);

  if (!existingMachine) {
    db.prepare(`
      INSERT INTO machines (
        machine_id, name, hostname, username, os, os_version, architecture,
        local_ip, public_ip, agent_version, last_seen_at, first_seen_at,
        is_online, token, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      machine.machine_id,
      machine.name || machine.hostname || machine.machine_id,
      machine.hostname || null,
      machine.username || null,
      machine.os || null,
      machine.os_version || null,
      machine.architecture || null,
      machine.local_ip || null,
      machine.public_ip || null,
      machine.agent_version || null,
      now,
      now,
      1,
      token,
      now,
      now
    );

    insertEvent(machine.machine_id, "info", "machine_registered", `Máquina registrada: ${machine.machine_id}`);
  } else {
    db.prepare(`
      UPDATE machines SET
        name = ?, hostname = ?, username = ?, os = ?, os_version = ?, architecture = ?,
        local_ip = ?, public_ip = ?, agent_version = ?, last_seen_at = ?, is_online = 1, updated_at = ?
      WHERE machine_id = ?
    `).run(
      machine.name || existingMachine.name,
      machine.hostname || existingMachine.hostname,
      machine.username || existingMachine.username,
      machine.os || existingMachine.os,
      machine.os_version || existingMachine.os_version,
      machine.architecture || existingMachine.architecture,
      machine.local_ip || existingMachine.local_ip,
      machine.public_ip || existingMachine.public_ip,
      machine.agent_version || existingMachine.agent_version,
      now,
      now,
      machine.machine_id
    );
  }

  db.prepare(`
    INSERT INTO metrics (
      machine_id, created_at, cpu_percent, cpu_temp, gpu_percent, gpu_temp, fan_speed_rpm,
      memory_percent, memory_total_bytes, memory_used_bytes,
      disk_percent, disk_total_bytes, disk_used_bytes, disk_free_bytes,
      disk_read_bytes, disk_write_bytes, bytes_sent, bytes_recv,
      ping_ms, packet_loss_percent, battery_percent, battery_plugged,
      uptime_seconds, boot_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    machine.machine_id,
    now,
    payload.cpu?.percent ?? null,
    payload.cpu?.temperature_c ?? null,
    payload.gpu?.percent ?? null,
    payload.gpu?.temperature_c ?? null,
    payload.gpu?.fan_speed_rpm ?? null,
    payload.memory?.percent ?? null,
    payload.memory?.total_bytes ?? null,
    payload.memory?.used_bytes ?? null,
    payload.disk?.percent ?? null,
    payload.disk?.total_bytes ?? null,
    payload.disk?.used_bytes ?? null,
    payload.disk?.free_bytes ?? null,
    payload.disk?.read_bytes ?? null,
    payload.disk?.write_bytes ?? null,
    payload.network?.bytes_sent ?? null,
    payload.network?.bytes_recv ?? null,
    payload.network?.ping_ms ?? null,
    payload.network?.packet_loss_percent ?? null,
    payload.battery?.percent ?? null,
    payload.battery?.plugged == null ? null : Number(Boolean(payload.battery.plugged)),
    payload.system?.uptime_seconds ?? null,
    payload.system?.boot_time ?? null
  );

  db.prepare("DELETE FROM partitions WHERE machine_id = ?").run(machine.machine_id);
  for (const partition of payload.partitions || []) {
    db.prepare(`
      INSERT INTO partitions (
        machine_id, created_at, device, mountpoint, filesystem,
        total_bytes, used_bytes, free_bytes, percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      machine.machine_id,
      now,
      partition.device ?? null,
      partition.mountpoint ?? null,
      partition.filesystem ?? null,
      partition.total_bytes ?? null,
      partition.used_bytes ?? null,
      partition.free_bytes ?? null,
      partition.percent ?? null
    );
  }

  db.prepare("DELETE FROM processes WHERE machine_id = ?").run(machine.machine_id);
  for (const process of payload.top_processes || []) {
    db.prepare(`
      INSERT INTO processes (
        machine_id, created_at, pid, process_name, cpu_percent, memory_percent, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      machine.machine_id,
      now,
      process.pid ?? null,
      process.name ?? null,
      process.cpu_percent ?? null,
      process.memory_percent ?? null,
      process.status ?? null
    );
  }

  if (payload.events && Array.isArray(payload.events)) {
    for (const event of payload.events) {
      insertEvent(machine.machine_id, event.level || "info", event.event_type || "agent_event", event.message || "Evento");
    }
  }

  if (payload.network?.ping_ms != null && Number(payload.network.ping_ms) > 250) {
    insertEvent(machine.machine_id, "warn", "high_ping", `Ping alto: ${payload.network.ping_ms} ms`);
  }

  await evaluateAlerts(machine.machine_id, payload);

const latestMetric = db.prepare(`
  SELECT * FROM metrics
  WHERE machine_id = ?
  ORDER BY created_at DESC
  LIMIT 1
`).get(machine.machine_id);

const latestPartitions = db.prepare(`
  SELECT * FROM partitions
  WHERE machine_id = ?
  ORDER BY created_at DESC
`).all(machine.machine_id);

const latestProcesses = db.prepare(`
  SELECT * FROM processes
  WHERE machine_id = ?
  ORDER BY cpu_percent DESC, memory_percent DESC
  LIMIT 15
`).all(machine.machine_id);

const latestMachine = db.prepare(`
  SELECT * FROM machines
  WHERE machine_id = ?
`).get(machine.machine_id);

io.emit("monitor-update", {
  machineId: machine.machine_id,
  machine: latestMachine,
  latestMetric,
  partitions: latestPartitions,
  processes: latestProcesses
});

  return res.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.emit("connected", { ok: true });
});

setInterval(() => {
  const machines = db.prepare("SELECT * FROM machines").all();

  for (const machine of machines) {
    const online = isMachineOnline(machine.last_seen_at);
    if (Number(machine.is_online) !== Number(online)) {
      db.prepare("UPDATE machines SET is_online = ?, updated_at = ? WHERE machine_id = ?")
        .run(online ? 1 : 0, new Date().toISOString(), machine.machine_id);

      if (!online) {
        insertEvent(machine.machine_id, "error", "machine_offline", `Máquina offline: ${machine.machine_id}`);
      }
    }
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});