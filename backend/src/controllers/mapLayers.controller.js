import { Router } from "express";
import { get72hForecast, getGlofasRiverBasins, getNasaFirmsFires, getWaqiAirStations, getWindPlume } from "../services/multiSourceIngestor.service.js";

function optionalCoordinate(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError("lat y lng deben ser numéricos.");
  return parsed;
}

function resultValue(result, fallback) {
  return result.status === "fulfilled" ? result.value : fallback;
}

function sourceErrors(results, labels) {
  return results.flatMap((result, index) => result.status === "rejected" ? [{ source: labels[index], message: result.reason?.message || "Fuente no disponible" }] : []);
}

export async function getMapLayers(req, res, next) {
  try {
    const lat = optionalCoordinate(req.query.lat, 14.64);
    const lng = optionalCoordinate(req.query.lng, -90.51);
    const jobs = [getWaqiAirStations(), getGlofasRiverBasins(), getNasaFirmsFires(), getWindPlume(lat, lng)];
    const results = await Promise.allSettled(jobs);
    res.status(200).json({
      success: true,
      data: {
        airStations: resultValue(results[0], []),
        riverBasins: resultValue(results[1], []),
        activeFires: resultValue(results[2], []),
        plumeTrajectory: resultValue(results[3], null),
        timestamp: new Date().toISOString(),
      },
      warnings: sourceErrors(results, ["WAQI/CAMS", "GloFAS", "NASA FIRMS", "Open-Meteo viento"]),
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return res.status(400).json({ success: false, error: error.message });
    return next(error);
  }
}

export async function getForecast72h(req, res, next) {
  try {
    const lat = optionalCoordinate(req.query.lat, 14.64);
    const lng = optionalCoordinate(req.query.lng, -90.51);
    const forecast = await get72hForecast(lat, lng);
    return res.status(200).json({ success: true, data: { location: { lat, lng }, forecast, timestamp: new Date().toISOString() } });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return res.status(400).json({ success: false, error: error.message });
    return next(error);
  }
}

export function createMapLayersRouter() {
  const router = Router();
  router.get("/map-layers", getMapLayers);
  router.get("/forecast/72h", getForecast72h);
  return router;
}

