import { fromUrl } from "geotiff";
import proj4 from "proj4";
import { calculateWaterQualityIndex } from "./wqiCalculator.js";
import { createDatabasePool } from "./camsAirIngestor.js";

const STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
const SIGN_URL = "https://planetarycomputer.microsoft.com/api/sas/v1/sign";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const INSERT_WATER = "INSERT INTO mediciones_agua (timestamp,estacion_id,ph,oxigeno_disuelto,turbidez,conductividad,temperatura_agua,dbo,coliformes_fecales,ica_wqi,ndci_clorofila,ndti_turbidez,calidad_nivel,fuente_raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) ON CONFLICT (timestamp,estacion_id) DO UPDATE SET ph=EXCLUDED.ph,oxigeno_disuelto=EXCLUDED.oxigeno_disuelto,turbidez=EXCLUDED.turbidez,conductividad=EXCLUDED.conductividad,temperatura_agua=EXCLUDED.temperatura_agua,dbo=EXCLUDED.dbo,coliformes_fecales=EXCLUDED.coliformes_fecales,ica_wqi=EXCLUDED.ica_wqi,ndci_clorofila=EXCLUDED.ndci_clorofila,ndti_turbidez=EXCLUDED.ndti_turbidez,calidad_nivel=EXCLUDED.calidad_nivel,fuente_raw=EXCLUDED.fuente_raw";

export const calculateNdti = (red, green) => Number(red) + Number(green) ? (Number(red) - Number(green)) / (Number(red) + Number(green)) : null;
export const calculateNdci = (redEdge, red) => Number(redEdge) + Number(red) ? (Number(redEdge) - Number(red)) / (Number(redEdge) + Number(red)) : null;

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error("Servicio público respondió HTTP " + response.status + ".");
  return response.json();
}
function getAsset(item, band) {
  const href = Object.entries(item.assets ?? {}).find(([key]) => key.toLowerCase() === band.toLowerCase())?.[1]?.href;
  if (!href) throw new Error("La escena no contiene banda " + band + ".");
  return href;
}
async function sampleReflectance(href, latitude, longitude) {
  const signed = await getJson(SIGN_URL + "?" + new URLSearchParams({ href }));
  const image = await (await fromUrl(signed.href ?? signed)).getImage();
  const zone = Math.floor((Number(longitude) + 180) / 6) + 1;
  const projection = "+proj=utm +zone=" + zone + " +datum=WGS84 +units=m +no_defs";
  const [x, y] = proj4("EPSG:4326", projection, [Number(longitude), Number(latitude)]);
  const [originX, originY] = image.getOrigin(), [resolutionX, resolutionY] = image.getResolution();
  const column = Math.floor((x - originX) / resolutionX), row = Math.floor((y - originY) / resolutionY);
  if (column < 0 || row < 0 || column >= image.getWidth() || row >= image.getHeight()) throw new Error("Coordenada fuera de escena.");
  const value = (await image.readRasters({ window: [column, row, column + 1, row + 1] }))[0][0];
  if (!Number.isFinite(value) || value <= 0) throw new Error("Píxel Sentinel-2 inválido.");
  return value / 10000;
}
async function loadSpectralIndexes(latitude, longitude) {
  const body = { collections: ["sentinel-2-l2a"], intersects: { type: "Point", coordinates: [Number(longitude), Number(latitude)] }, limit: 10, query: { "eo:cloud_cover": { lt: 25 } }, sortby: [{ field: "datetime", direction: "desc" }] };
  const item = (await getJson(STAC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).features?.[0];
  if (!item) throw new Error("No hay escena Sentinel-2 despejada.");
  const [red, green, redEdge] = await Promise.all([sampleReflectance(getAsset(item, "B04"), latitude, longitude),sampleReflectance(getAsset(item, "B03"), latitude, longitude),sampleReflectance(getAsset(item, "B05"), latitude, longitude)]);
  return { ndti: calculateNdti(red, green), ndci: calculateNdci(redEdge, red), reflectance: { red, green, redEdge }, scene: { id: item.id, capturedAt: item.properties?.datetime, cloudCover: item.properties?.["eo:cloud_cover"] } };
}
async function loadRainfall(latitude, longitude) {
  const data = await getJson(WEATHER_URL + "?" + new URLSearchParams({ latitude, longitude, timezone: "UTC", hourly: "precipitation", past_days: 1, forecast_days: 1 }));
  const precipitation24hMm = (data.hourly?.precipitation ?? []).slice(-24).reduce((total, value) => total + (Number(value) || 0), 0);
  return { timestamp: new Date(), precipitation24hMm, raw: data };
}

export async function ingestLiveWater({ pool, logger = console } = {}) {
  const database = pool ?? createDatabasePool(), ownPool = !pool;
  try {
    const stationQuery = "SELECT id,codigo_externo,latitud,longitud,metadatos FROM estaciones WHERE activo AND codigo_externo IN ('AMSA-AMATITLAN','MARN-RIO-VILLALOBOS','MARN-RIO-LAS-VACAS')";
    const { rows: stations } = await database.query(stationQuery);
    const results = [];
    for (const station of stations) {
      try {
        const [spectral, rainfall] = await Promise.all([loadSpectralIndexes(station.latitud, station.longitud), loadRainfall(station.latitud, station.longitud)]);
        const sample = station.metadatos?.telemetria_agua ?? {};
        const wqi = calculateWaterQualityIndex({ dissolvedOxygen: Number(sample.oxigeno_disuelto), ph: Number(sample.ph), turbidity: Number(sample.turbidez), bod5: Number(sample.dbo), coliforms: Number(sample.coliformes_fecales), conductance: Number(sample.conductividad), temperatureC: Number(sample.temperatura_agua) });
        const raw = { provider: "Planetary Computer Sentinel-2 L2A + Open-Meteo", scene: spectral.scene, reflectance: spectral.reflectance, indexes: { ndti: spectral.ndti, ndci: spectral.ndci }, runoff: { precipitation24hMm: rainfall.precipitation24hMm, note: "No equivale a caudal medido." }, weather: rainfall.raw, wqi };
        await database.query(INSERT_WATER, [rainfall.timestamp,station.id,sample.ph ?? null,sample.oxigeno_disuelto ?? null,sample.turbidez ?? null,sample.conductividad ?? null,sample.temperatura_agua ?? null,sample.dbo ?? null,sample.coliformes_fecales ?? null,wqi.score,spectral.ndci,spectral.ndti,wqi.category?.toLowerCase().replace(" ","_") ?? null,JSON.stringify(raw)]);
        results.push({ station: station.codigo_externo, status: "ok", scene: spectral.scene.id });
      } catch (error) {
        logger.error("Ingesta hídrica falló para " + station.codigo_externo + ": " + error.message);
        results.push({ station: station.codigo_externo, status: "error", error: error.message });
      }
    }
    return results;
  } finally {
    if (ownPool) await database.end();
  }
}
