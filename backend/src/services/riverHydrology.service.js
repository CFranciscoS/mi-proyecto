import axios from "axios";

const FLOOD_API = "https://flood-api.open-meteo.com/v1/flood";
const WEATHER_API = "https://api.open-meteo.com/v1/forecast";
const GUATEMALA = { minLat: 13.5, maxLat: 18, minLng: -92.5, maxLng: -88 };

function coordinate(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(name + " debe ser numérico.");
  return number;
}
function validateLocation(lat, lng) {
  const latitude = coordinate(lat, "lat");
  const longitude = coordinate(lng, "lng");
  if (latitude < GUATEMALA.minLat || latitude > GUATEMALA.maxLat || longitude < GUATEMALA.minLng || longitude > GUATEMALA.maxLng) throw new RangeError("La coordenada está fuera del territorio de Guatemala.");
  return { latitude, longitude };
}
async function request(url, params, timeoutMs) {
  try {
    const response = await axios.get(url, { params, timeout: timeoutMs, validateStatus: (status) => status >= 200 && status < 300 });
    return response.data;
  } catch (error) {
    const detail = error.response ? " HTTP " + error.response.status : "";
    throw new Error("Consulta hidrológica falló en " + url + detail + ": " + error.message, { cause: error });
  }
}
function valueAt(array, index) {
  const value = Array.isArray(array) ? Number(array[index]) : Number(array);
  return Number.isFinite(value) ? value : null;
}
function computeWqiScore(quality = {}) {
  const values = ["dissolved_oxygen", "ph", "turbidity", "bod5", "coliforms", "conductance"];
  if (values.some((key) => !Number.isFinite(Number(quality[key])))) return null;
  const score = 100 - Number(quality.turbidity) * 0.15 - Number(quality.bod5) * 1.5 - Math.max(0, Number(quality.coliforms) - 200) / 30 - Math.abs(Number(quality.ph) - 7) * 8 + Number(quality.dissolved_oxygen) * 2 - Number(quality.conductance) / 100;
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}
function riskLevel(discharge, precipitation, wqi) {
  if (wqi !== null && wqi < 26) return "critica";
  if ((discharge !== null && discharge > 250) || (precipitation !== null && precipitation >= 50)) return "alta";
  if ((discharge !== null && discharge > 100) || (precipitation !== null && precipitation >= 20) || (wqi !== null && wqi < 51)) return "media";
  return "normal";
}

export async function getRiverBasinTelemetry({ lat, lng, turbidity_ntu = null, quality = {}, timeoutMs = 15000 } = {}) {
  const location = validateLocation(lat, lng);
  const [flood, weather] = await Promise.all([
    request(FLOOD_API, { latitude: location.latitude, longitude: location.longitude, daily: "river_discharge,river_discharge_max", forecast_days: 3 }, timeoutMs),
    request(WEATHER_API, { latitude: location.latitude, longitude: location.longitude, current: "precipitation,temperature_2m,wind_speed_10m,wind_direction_10m", timezone: "UTC" }, timeoutMs),
  ]);
  const discharge = valueAt(flood.daily?.river_discharge, 0);
  const precipitation = Number.isFinite(Number(weather.current?.precipitation)) ? Number(weather.current.precipitation) : null;
  const turbidity = Number.isFinite(Number(turbidity_ntu)) ? Number(turbidity_ntu) : null;
  const wqi = computeWqiScore(quality);
  return {
    basin: { latitude: location.latitude, longitude: location.longitude },
    observed_at: new Date().toISOString(),
    river_discharge_m3s: discharge,
    river_discharge_max_m3s: valueAt(flood.daily?.river_discharge_max, 0),
    precipitation_mm: precipitation,
    turbidity_ntu: turbidity,
    wqi_score: wqi,
    risk_level: riskLevel(discharge, precipitation, wqi),
    weather: weather.current ?? {},
    forecast: flood.daily ?? {},
    provenance: { hydrology: "Copernicus GloFAS via Open-Meteo", weather: "Open-Meteo" },
  };
}

export async function saveHydrologyObservation(pool, stationId, telemetry) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("Se requiere un pool PostgreSQL.");
  if (!stationId) throw new TypeError("stationId es obligatorio.");
  await pool.query("INSERT INTO mediciones_agua (timestamp,estacion_id,turbidez,ica_wqi,calidad_nivel,fuente_raw) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (timestamp,estacion_id) DO UPDATE SET turbidez=EXCLUDED.turbidez,ica_wqi=EXCLUDED.ica_wqi,calidad_nivel=EXCLUDED.calidad_nivel,fuente_raw=EXCLUDED.fuente_raw", [telemetry.observed_at, stationId, telemetry.turbidity_ntu, telemetry.wqi_score, telemetry.risk_level, JSON.stringify(telemetry)]);
  return telemetry;
}
