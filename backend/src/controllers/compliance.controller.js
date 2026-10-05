import { Router } from "express";
import { buildComplianceRows, createMarnComplianceReportStream } from "../services/marnComplianceReport.service.js";

function parsePeriod(query) {
  const month = Number.parseInt(query.month, 10);
  const year = Number.parseInt(query.year, 10);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError("month debe ser un entero entre 1 y 12.");
  if (!Number.isInteger(year) || year < 2006 || year > 2100) throw new RangeError("year debe ser un entero entre 2006 y 2100.");
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { month, year, start: start.toISOString(), end: end.toISOString(), label: new Intl.DateTimeFormat("es-GT", { month: "long", year: "numeric", timeZone: "UTC" }).format(start) };
}

function validateStationId(stationId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stationId)) {
    throw new TypeError("stationId debe ser un UUID válido.");
  }
  return stationId;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dictamenNumber(year, stationId, month) {
  // Identificador reproducible para descarga. Integre una serie documental municipal
  // mediante issueNumber para asignar correlativos oficialmente controlados.
  let hash = 2166136261;
  for (const character of `${stationId}-${month}-${year}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `DICT-MARN-${year}-${String((hash >>> 0) % 10000).padStart(4, "0")}`;
}

async function stationSummary(pool, stationId) {
  const query = `
    SELECT e.id, e.codigo_externo, e.nombre, e.latitud, e.longitud,
           m.nombre AS municipio_nombre, m.departamento AS municipio_departamento
      FROM estaciones e
      LEFT JOIN municipios m ON ST_Contains(m.geom, e.geom)
     WHERE e.id = $1
     LIMIT 1`;
  const { rows } = await pool.query(query, [stationId]);
  if (!rows[0]) {
    const error = new Error("Estación no encontrada.");
    error.statusCode = 404;
    throw error;
  }
  return rows[0];
}

async function measurementAverages(pool, stationId, start, end) {
  const query = `
    SELECT AVG(ph)::float8 AS ph,
           AVG(dbo)::float8 AS dbo5,
           AVG(turbidez)::float8 AS turbidity,
           AVG(oxigeno_disuelto)::float8 AS dissolved_oxygen,
           AVG(coliformes_fecales)::float8 AS fecal_coliforms,
           AVG(CASE WHEN COALESCE(fuente_raw->>'river_discharge_m3s', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                    THEN (fuente_raw->>'river_discharge_m3s')::numeric END)::float8 AS river_discharge_m3s
      FROM mediciones_agua
     WHERE estacion_id = $1 AND timestamp >= $2::timestamptz AND timestamp < $3::timestamptz`;
  const { rows } = await pool.query(query, [stationId, start, end]);
  return rows[0] ?? {};
}

async function incidentTrail(pool, stationId, start, end) {
  const baseQuery = `
    SELECT a.codigo, a.severidad, a.parametro, a.descripcion, a.creado_en AS created_at,
           h.creado_en AS history_at, h.observaciones, h.acciones_mitigacion
      FROM alertas a
      LEFT JOIN alertas_historial h ON h.alerta_id = a.id
     WHERE a.estacion_id = $1
       AND a.creado_en >= $2::timestamptz AND a.creado_en < $3::timestamptz
     ORDER BY COALESCE(h.creado_en, a.creado_en) ASC`;
  try {
    const { rows } = await pool.query(baseQuery, [stationId, start, end]);
    return rows.map((row) => ({
      code: row.codigo,
      severity: row.severidad,
      parameter: row.parametro,
      timestamp: row.history_at || row.created_at,
      observations: row.observaciones || row.descripcion,
      mitigation: row.acciones_mitigacion,
    }));
  } catch (error) {
    if (error.code !== "42P01") throw error;
    const { rows } = await pool.query(`
      SELECT codigo, severidad, parametro, descripcion, creado_en
        FROM alertas
       WHERE estacion_id = $1 AND creado_en >= $2::timestamptz AND creado_en < $3::timestamptz
       ORDER BY creado_en ASC`, [stationId, start, end]);
    return rows.map((row) => ({ code: row.codigo, severity: row.severidad, parameter: row.parametro, timestamp: row.creado_en, observations: row.descripcion }));
  }
}

/**
 * Creates the compliance-report route. `issueNumber` may asynchronously return
 * a municipality-controlled official consecutive number for the supplied context.
 */
export function createComplianceRouter({ pool, issueNumber } = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("createComplianceRouter requiere un pool de PostgreSQL válido.");
  const router = Router();

  router.get("/compliance-marn/:stationId", async (req, res, next) => {
    try {
      const stationId = validateStationId(req.params.stationId);
      const period = parsePeriod(req.query);
      const [station, averages, incidents] = await Promise.all([
        stationSummary(pool, stationId),
        measurementAverages(pool, stationId, period.start, period.end),
        incidentTrail(pool, stationId, period.start, period.end),
      ]);
      const assignedNumber = typeof issueNumber === "function"
        ? await issueNumber({ stationId, year: period.year, month: period.month, municipality: station.municipio_nombre })
        : null;
      const report = {
        dictamenNumber: typeof assignedNumber === "string" && /^DICT-MARN-\\d{4}-\\d{4}$/.test(assignedNumber)
          ? assignedNumber
          : dictamenNumber(period.year, stationId, period.month),
        issuedAt: new Date(),
        municipality: { name: station.municipio_nombre || "Municipio no determinado", department: station.municipio_departamento },
        station: { name: station.nombre, code: station.codigo_externo },
        basin: {
          name: station.nombre,
          latitude: numeric(station.latitud),
          longitude: numeric(station.longitud),
          riverDischargeM3s: numeric(averages.river_discharge_m3s),
        },
        monitoringPeriod: period.label,
        complianceRows: buildComplianceRows({
          ph: averages.ph,
          dbo5: averages.dbo5,
          turbidity: averages.turbidity,
          dissolvedOxygen: averages.dissolved_oxygen,
          fecalColiforms: averages.fecal_coliforms,
        }),
        incidents,
      };
      const pdf = createMarnComplianceReportStream(report);
      pdf.once("error", (error) => {
        if (!res.headersSent) next(error);
        else res.destroy(error);
      });
      res.status(200);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=dictamen_marn_236_2006.pdf");
      pdf.pipe(res);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) return res.status(400).json({ error: error.message });
      if (error.statusCode === 404) return res.status(404).json({ error: error.message });
      return next(error);
    }
  });
  return router;
}

