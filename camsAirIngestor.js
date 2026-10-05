import { Pool } from "pg";
import { calculateAirQualityIndex } from "./aqiCalculator.js";

const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const INSERT_AIR = "INSERT INTO mediciones_aire (timestamp,estacion_id,pm2_5,pm10,aqi,co,no2,o3,temperatura,humedad,calidad_nivel,fuente_raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT (timestamp,estacion_id) DO UPDATE SET pm2_5=EXCLUDED.pm2_5,pm10=EXCLUDED.pm10,aqi=EXCLUDED.aqi,co=EXCLUDED.co,no2=EXCLUDED.no2,o3=EXCLUDED.o3,temperatura=EXCLUDED.temperatura,humedad=EXCLUDED.humedad,calidad_nivel=EXCLUDED.calidad_nivel,fuente_raw=EXCLUDED.fuente_raw";

export function createDatabasePool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL es obligatoria.");
  return new Pool({ connectionString, max: 8, idleTimeoutMillis: 30000 });
}

async function request(url, parameters, signal) {
  const response = await fetch(url + "?" + new URLSearchParams(parameters), { signal });
  if (!response.ok) throw new Error("Open-Meteo respondió HTTP " + response.status + ".");
  return response.json();
}

export async function ingestLiveAir({ pool, logger = console, timeoutMs = 20000 } = {}) {
  const database = pool ?? createDatabasePool(), ownPool = !pool;
  try {
    const query = "SELECT id,codigo_externo,latitud,longitud FROM estaciones WHERE activo AND tipo IN ('aire','mixta')";
    const { rows: stations } = await database.query(query);
    const results = [];
    for (const station of stations) {
      const aborter = new AbortController(), timer = setTimeout(() => aborter.abort(), timeoutMs);
      try {
        const common = { latitude: station.latitud, longitude: station.longitud, timezone: "UTC" };
        const [air, weather] = await Promise.all([
          request(AIR_URL, { ...common, current: "pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,ozone,us_aqi" }, aborter.signal),
          request(WEATHER_URL, { ...common, current: "temperature_2m,relative_humidity_2m,surface_pressure" }, aborter.signal),
        ]);
        if (!air.current || !weather.current) throw new Error("Respuesta actual incompleta.");
        const timestamp = new Date(air.current.time + "Z");
        if (Number.isNaN(timestamp.valueOf())) throw new Error("Marca temporal inválida.");
        const aqi = calculateAirQualityIndex({ pm25: air.current.pm2_5, pm10: air.current.pm10 });
        const raw = { provider: "Open-Meteo", pressure_hpa: weather.current.surface_pressure, aqi, air, weather };
        await database.query(INSERT_AIR, [timestamp,station.id,air.current.pm2_5,air.current.pm10,aqi.aqi,air.current.carbon_monoxide,air.current.nitrogen_dioxide,air.current.ozone,weather.current.temperature_2m,weather.current.relative_humidity_2m,aqi.category,JSON.stringify(raw)]);
        results.push({ station: station.codigo_externo, status: "ok" });
      } catch (error) {
        logger.error("Ingesta aérea falló para " + station.codigo_externo + ": " + error.message);
        results.push({ station: station.codigo_externo, status: "error", error: error.message });
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  } finally {
    if (ownPool) await database.end();
  }
}
