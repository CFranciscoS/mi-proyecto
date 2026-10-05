import axios from "axios";
import { Router } from "express";

const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const GUATEMALA = { minLat: 13.5, maxLat: 18, minLng: -92.5, maxLng: -88 };

function location(query) {
  const lat = Number(query.lat), lng = Number(query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new TypeError("lat y lng deben ser numéricos.");
  if (lat < GUATEMALA.minLat || lat > GUATEMALA.maxLat || lng < GUATEMALA.minLng || lng > GUATEMALA.maxLng) throw new RangeError("La coordenada debe estar dentro de Guatemala.");
  return { lat, lng };
}
async function request(url, params, timeoutMs) {
  try {
    const response = await axios.get(url, { params, timeout: timeoutMs, validateStatus: (status) => status >= 200 && status < 300 });
    return response.data;
  } catch (error) {
    throw new Error("Pronóstico externo no disponible: " + (error.response ? "HTTP " + error.response.status : error.message), { cause: error });
  }
}
function number(value) { const result = Number(value); return Number.isFinite(result) ? result : null; }
function destination(lat, lng, bearing, distanceMeters) {
  const radius = 6371008.8, angular = distanceMeters / radius, bearingRad = bearing * Math.PI / 180, latRad = lat * Math.PI / 180, lngRad = lng * Math.PI / 180;
  const destLat = Math.asin(Math.sin(latRad) * Math.cos(angular) + Math.cos(latRad) * Math.sin(angular) * Math.cos(bearingRad));
  const destLng = lngRad + Math.atan2(Math.sin(bearingRad) * Math.sin(angular) * Math.cos(latRad), Math.cos(angular) - Math.sin(latRad) * Math.sin(destLat));
  return { lat: destLat * 180 / Math.PI, lng: ((destLng * 180 / Math.PI + 540) % 360) - 180 };
}
function dispersionVector(lat, lng, speedKmh, meteorologicalDirection) {
  const speed = number(speedKmh) ?? 0, from = number(meteorologicalDirection);
  if (from === null) return { bearing_degrees: null, speed_kmh: speed, vector: null };
  const bearing = (from + 180) % 360;
  const endpoint = destination(lat, lng, bearing, speed * 1000);
  return { bearing_degrees: bearing, speed_kmh: speed, vector: { origin: { lat, lng }, endpoint, distance_km: speed } };
}

export async function get72HourForecast(req, res, next) {
  try {
    const { lat, lng } = location(req.query);
    const timeoutMs = 20000;
    const [air, weather] = await Promise.all([
      request(AIR_URL, { latitude: lat, longitude: lng, hourly: "pm10,pm2_5,ozone,us_aqi", forecast_days: 3, timezone: "UTC" }, timeoutMs),
      request(WEATHER_URL, { latitude: lat, longitude: lng, hourly: "precipitation,precipitation_probability,temperature_2m,wind_speed_10m,wind_direction_10m", forecast_days: 3, timezone: "UTC" }, timeoutMs),
    ]);
    const hours = Math.min(72, air.hourly?.time?.length ?? weather.hourly?.time?.length ?? 0);
    if (!hours) throw new Error("Las APIs no devolvieron horas de pronóstico.");
    const forecast = Array.from({ length: hours }, (_, index) => {
      const speed = number(weather.hourly.wind_speed_10m?.[index]);
      const direction = number(weather.hourly.wind_direction_10m?.[index]);
      return { timestamp: air.hourly?.time?.[index] ?? weather.hourly.time[index], air: { pm10: number(air.hourly.pm10?.[index]), pm2_5: number(air.hourly.pm2_5?.[index]), ozone: number(air.hourly.ozone?.[index]), us_aqi: number(air.hourly.us_aqi?.[index]) }, weather: { precipitation_mm: number(weather.hourly.precipitation?.[index]), precipitation_probability: number(weather.hourly.precipitation_probability?.[index]), temperature_2m: number(weather.hourly.temperature_2m?.[index]), wind_speed_10m: speed, wind_direction_10m: direction }, dispersion: dispersionVector(lat, lng, speed, direction) };
    });
    res.json({ location: { lat, lng }, horizon_hours: forecast.length, generated_at: new Date().toISOString(), sources: { air: "Copernicus CAMS via Open-Meteo", weather: "NOAA/GFS via Open-Meteo" }, forecast });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return res.status(400).json({ error: error.message });
    if (typeof next === "function") return next(error);
    return res.status(502).json({ error: error.message });
  }
}

export function createForecastRouter() {
  const router = Router();
  router.get("/72h", get72HourForecast);
  return router;
}
