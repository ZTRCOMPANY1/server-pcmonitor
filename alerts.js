const { db } = require("./db");
const { notifyAll } = require("./notifier");

function insertEvent(machineId, level, eventType, message) {
  db.prepare(`
    INSERT INTO events (machine_id, level, event_type, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(machineId, level, eventType, message, new Date().toISOString());
}

async function evaluateAlerts(machineId, payload) {
  const rules = db.prepare("SELECT * FROM alert_rules WHERE enabled = 1").all();

  const values = {
    cpu_percent: Number(payload.cpu?.percent || 0),
    memory_percent: Number(payload.memory?.percent || 0),
    disk_percent: Number(payload.disk?.percent || 0),
    cpu_temp: payload.cpu?.temperature_c == null ? null : Number(payload.cpu.temperature_c),
    ping_ms: payload.network?.ping_ms == null ? null : Number(payload.network.ping_ms)
  };

  for (const rule of rules) {
    const currentValue = values[rule.rule_key];
    if (currentValue == null) continue;

    if (currentValue >= rule.threshold) {
      const message = `[ALERTA] ${machineId}: ${rule.rule_key} = ${currentValue} (limite ${rule.threshold})`;
      insertEvent(machineId, "warn", "alert_triggered", message);
      await notifyAll(message);
    }
  }
}

module.exports = {
  insertEvent,
  evaluateAlerts
};