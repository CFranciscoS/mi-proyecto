import { randomUUID } from "node:crypto";

const OPEN_STATES = ["activa", "en_revision"];
const SEVERITY_RANK = { baja: 1, media: 2, alta: 3, critica: 4 };
const ALLOWED_TRANSITIONS = { activa: "en_revision", en_revision: "atendida", atendida: "cerrada", cerrada: null };

export const DEFAULT_THRESHOLDS = {
  aire: {
    pm2_5: { unit: "µg/m³", source: "OMS 2021 / EPA AQI", warning: 15, high: 35.4, critical: 55.4, direction: "above" },
    pm10: { unit: "µg/m³", source: "OMS 2021 / EPA NAAQS", warning: 45, high: 100, critical: 150, direction: "above" },
    aqi: { unit: "AQI", source: "EPA AQI", warning: 101, high: 151, critical: 201, direction: "above" },
    no2: { unit: "µg/m³", source: "OMS 2021", warning: 25, high: 100, critical: 200, direction: "above" },
    o3: { unit: "µg/m³", source: "OMS 2021", warning: 100, high: 120, critical: 160, direction: "above" },
  },
  agua: {
    ph: { unit: "pH", source: "MARN AG 236-2006 / perfil municipal", minimum: 6, maximum: 9, direction: "range" },
    turbidez: { unit: "NTU", source: "Límite operativo municipal configurable", warning: 5, high: 25, critical: 50, direction: "above" },
    dbo: { unit: "mg/L", source: "MARN AG 236-2006, reuso tipo III/V", warning: 100, high: 150, critical: 200, direction: "above" },
    coliformes_fecales: { unit: "NMP/100 mL", source: "MARN AG 236-2006, reuso tipo IV/V", warning: 200, high: 500, critical: 1000, direction: "above" },
    oxigeno_disuelto: { unit: "mg/L", source: "Criterio de protección acuática municipal", warning: 5, high: 3, critical: 2, direction: "below" },
  },
};

function assertPool(pool) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("Se requiere un pool PostgreSQL compatible con pg.");
}
function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError("recordedAt debe ser una fecha válida.");
  return date;
}
function rank(severity) { return SEVERITY_RANK[severity] ?? 0; }
function maxSeverity(left, right) { return rank(left) >= rank(right) ? left : right; }

function assess(value, threshold) {
  if (!Number.isFinite(Number(value))) return null;
  const numericValue = Number(value);
  if (threshold.direction === "range") {
    if (numericValue >= threshold.minimum && numericValue <= threshold.maximum) return null;
    const distance = numericValue < threshold.minimum ? threshold.minimum - numericValue : numericValue - threshold.maximum;
    return { severity: distance >= 2 ? "alta" : "media", limit: numericValue < threshold.minimum ? threshold.minimum : threshold.maximum };
  }
  const isViolation = threshold.direction === "below" ? numericValue < threshold.warning : numericValue > threshold.warning;
  if (!isViolation) return null;
  if (threshold.direction === "below") {
    if (numericValue <= threshold.critical) return { severity: "critica", limit: threshold.critical };
    if (numericValue <= threshold.high) return { severity: "alta", limit: threshold.high };
    return { severity: "media", limit: threshold.warning };
  }
  if (numericValue >= threshold.critical) return { severity: "critica", limit: threshold.critical };
  if (numericValue >= threshold.high) return { severity: "alta", limit: threshold.high };
  return { severity: "media", limit: threshold.warning };
}

function escalate(severity, consecutiveCycles) {
  if (consecutiveCycles < 2 || severity === "critica") return severity;
  if (severity === "media") return "alta";
  return "critica";
}

function alertCode(type, parameter) {
  return "SMAM-" + type.slice(0, 1).toUpperCase() + "-" + parameter.toUpperCase() + "-" + randomUUID().slice(0, 8).toUpperCase();
}

export async function initializeAlertEngine(pool) {
  assertPool(pool);
  await pool.query("CREATE TABLE IF NOT EXISTS alertas_evaluaciones (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, estacion_id UUID NOT NULL REFERENCES estaciones(id) ON DELETE CASCADE, tipo VARCHAR(30) NOT NULL, parametro VARCHAR(80) NOT NULL, valor NUMERIC(18,6) NOT NULL, limite NUMERIC(18,6) NOT NULL, severidad VARCHAR(15) NOT NULL CHECK (severidad IN ('baja','media','alta','critica')), evaluada_en TIMESTAMPTZ NOT NULL, contexto JSONB NOT NULL DEFAULT '{}'::jsonb)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_alertas_evaluaciones_ciclos ON alertas_evaluaciones (estacion_id, tipo, parametro, evaluada_en DESC)");
  await pool.query("CREATE TABLE IF NOT EXISTS alertas_historial (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, alerta_id UUID NOT NULL REFERENCES alertas(id) ON DELETE CASCADE, estado_anterior VARCHAR(20), estado_nuevo VARCHAR(20), operador_id UUID REFERENCES usuarios(id) ON DELETE SET NULL, observaciones TEXT, acciones_mitigacion TEXT, creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, metadatos JSONB NOT NULL DEFAULT '{}'::jsonb)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_alertas_historial_alerta ON alertas_historial (alerta_id, creado_en ASC)");
}

async function previousCycle(client, stationId, type, parameter, windowMinutes) {
  const sql = "SELECT evaluada_en FROM alertas_evaluaciones WHERE estacion_id = $1 AND tipo = $2 AND parametro = $3 AND evaluada_en >= NOW() - ($4::text || ' minutes')::interval ORDER BY evaluada_en DESC LIMIT 1";
  const { rows } = await client.query(sql, [stationId, type, parameter, String(windowMinutes)]);
  return rows[0] ?? null;
}

async function persistEvaluation(client, event, parameter, value, assessment, context) {
  await client.query("INSERT INTO alertas_evaluaciones (estacion_id,tipo,parametro,valor,limite,severidad,evaluada_en,contexto) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [event.stationId, event.type, parameter, value, assessment.limit, assessment.severity, event.recordedAt, JSON.stringify(context)]);
}

async function findOpenAlert(client, stationId, parameter) {
  const sql = "SELECT id,severidad,estado FROM alertas WHERE estacion_id = $1 AND parametro = $2 AND estado = ANY($3::varchar[]) AND creado_en >= NOW() - INTERVAL '12 hours' ORDER BY creado_en DESC LIMIT 1 FOR UPDATE";
  const { rows } = await client.query(sql, [stationId, parameter, OPEN_STATES]);
  return rows[0] ?? null;
}

async function writeHistory(client, alertId, fromState, toState, note, metadata) {
  await client.query("INSERT INTO alertas_historial (alerta_id,estado_anterior,estado_nuevo,observaciones,metadatos) VALUES ($1,$2,$3,$4,$5::jsonb)", [alertId, fromState, toState, note, JSON.stringify(metadata)]);
}

async function upsertIncident(client, event, parameter, value, threshold, severity, consecutiveCycles) {
  const existing = await findOpenAlert(client, event.stationId, parameter);
  const metadata = { thresholdSource: threshold.source, consecutiveCycles, observedAt: event.recordedAt.toISOString() };
  if (existing) {
    const finalSeverity = maxSeverity(existing.severidad, severity);
    await client.query("UPDATE alertas SET severidad = $1, valor_registrado = $2, valor_limite = $3, geom = COALESCE($4,geom), descripcion = $5 WHERE id = $6", [finalSeverity, value, threshold.limit ?? null, event.geometry ?? null, "Incidente persistente: " + parameter + " fuera de umbral.", existing.id]);
    if (rank(finalSeverity) > rank(existing.severidad)) await writeHistory(client, existing.id, existing.estado, existing.estado, "Severidad escalada automáticamente a " + finalSeverity + ".", metadata);
    return { alertId: existing.id, created: false, severity: finalSeverity };
  }
  const { rows } = await client.query("INSERT INTO alertas (codigo,estacion_id,municipio_id,tipo,parametro,valor_registrado,valor_limite,severidad,estado,geom,descripcion) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'activa',$9,$10) RETURNING id", [alertCode(event.type, parameter), event.stationId, event.municipioId ?? null, event.type, parameter, value, threshold.limit ?? null, severity, event.geometry ?? null, "Lectura fuera de umbral " + threshold.source + "."]);
  await writeHistory(client, rows[0].id, null, "activa", "Alerta creada automáticamente.", metadata);
  return { alertId: rows[0].id, created: true, severity };
}

export async function evaluateTelemetry(pool, telemetry, options = {}) {
  assertPool(pool);
  const event = {
    stationId: telemetry.stationId,
    municipioId: telemetry.municipioId ?? null,
    type: telemetry.type,
    values: telemetry.values ?? {},
    recordedAt: asDate(telemetry.recordedAt ?? new Date()),
    geometry: telemetry.geometry ?? null,
  };
  if (!event.stationId || !["aire", "agua"].includes(event.type)) throw new TypeError("stationId y type ('aire' o 'agua') son obligatorios.");
  const catalog = options.thresholds?.[event.type] ?? DEFAULT_THRESHOLDS[event.type];
  const cycleWindowMinutes = Number(options.cycleWindowMinutes ?? 30);
  if (!Number.isFinite(cycleWindowMinutes) || cycleWindowMinutes <= 0) throw new TypeError("cycleWindowMinutes debe ser positivo.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const incidents = [];
    for (const [parameter, threshold] of Object.entries(catalog)) {
      const value = event.values[parameter];
      const assessment = assess(value, threshold);
      if (!assessment) continue;
      const last = await previousCycle(client, event.stationId, event.type, parameter, cycleWindowMinutes);
      const consecutiveCycles = last ? 2 : 1;
      const severity = escalate(assessment.severity, consecutiveCycles);
      const limit = assessment.limit;
      const incident = await upsertIncident(client, event, parameter, Number(value), { ...threshold, limit }, severity, consecutiveCycles);
      await persistEvaluation(client, event, parameter, Number(value), { ...assessment, severity, limit }, { threshold, incident });
      incidents.push({ parameter, value: Number(value), limit, source: threshold.source, consecutiveCycles, ...incident });
    }
    await client.query("COMMIT");
    return { stationId: event.stationId, evaluatedAt: event.recordedAt, incidents };
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error("No fue posible evaluar la telemetría: " + error.message, { cause: error });
  } finally {
    client.release();
  }
}

export async function transitionAlert(pool, payload) {
  assertPool(pool);
  if (!payload?.alertId || !payload?.operatorId || !payload?.toState) throw new TypeError("alertId, operatorId y toState son obligatorios.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT id,estado FROM alertas WHERE id = $1 FOR UPDATE", [payload.alertId]);
    const alert = rows[0];
    if (!alert) throw new Error("La alerta indicada no existe.");
    if (ALLOWED_TRANSITIONS[alert.estado] !== payload.toState) throw new Error("Transición de estado no permitida desde " + alert.estado + ".");
    if (alert.estado === "en_revision" && (!String(payload.observations ?? "").trim() || !String(payload.mitigationActions ?? "").trim())) throw new Error("La atención exige observaciones y medidas de contingencia.");
    if (alert.estado === "atendida" && !String(payload.observations ?? "").trim()) throw new Error("El cierre exige una observación de normalización.");
    const attendedAt = ["atendida", "cerrada"].includes(payload.toState) ? new Date() : null;
    await client.query("UPDATE alertas SET estado = $1, atendido_por = $2, atendida_en = COALESCE($3,atendida_en) WHERE id = $4", [payload.toState, payload.operatorId, attendedAt, alert.id]);
    await client.query("INSERT INTO alertas_historial (alerta_id,estado_anterior,estado_nuevo,operador_id,observaciones,acciones_mitigacion,metadatos) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)", [alert.id, alert.estado, payload.toState, payload.operatorId, payload.observations ?? null, payload.mitigationActions ?? null, JSON.stringify({ origin: "municipal-action-modal", occurredAt: new Date().toISOString() })]);
    await client.query("INSERT INTO auditoria (usuario_id,accion,entidad,entidad_id,datos_nuevos) VALUES ($1,'transicion_estado','alertas',$2,$3::jsonb)", [payload.operatorId, alert.id, JSON.stringify({ from: alert.estado, to: payload.toState, observations: payload.observations ?? null, mitigationActions: payload.mitigationActions ?? null })]);
    await client.query("COMMIT");
    return { alertId: alert.id, fromState: alert.estado, toState: payload.toState, attendedAt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error("No fue posible actualizar el incidente: " + error.message, { cause: error });
  } finally {
    client.release();
  }
}


