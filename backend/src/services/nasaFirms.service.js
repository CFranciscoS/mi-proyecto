import axios from "axios";

const FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/api/country/csv/open_key/VIIRS_SNPP_NRT/GTM/1";
const CMR_URL = "https://cmr.earthdata.nasa.gov/search/granules.json";
const BBOX = { minLat: 13.5, maxLat: 18, minLng: -92.5, maxLng: -88 };

function csvRows(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines.shift().split(",").map((header) => header.trim());
  return lines.map((line) => {
    const values = line.match(/(?:^|,)(?:"((?:"")*)"|([^",]*))/g)?.map((cell) => cell.replace(/^,?"?|"?$/g, "").replace(/""/g, '"')) ?? [];
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}
function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function inGuatemala(lat, lng) {
  return lat >= BBOX.minLat && lat <= BBOX.maxLat && lng >= BBOX.minLng && lng <= BBOX.maxLng;
}
function normalizeFire(row) {
  const lat = number(row.latitude ?? row.lat ?? row.geometry?.coordinates?.[1]);
  const lng = number(row.longitude ?? row.lon ?? row.lng ?? row.geometry?.coordinates?.[0]);
  if (lat === null || lng === null || !inGuatemala(lat, lng)) return null;
  const acquired = row.acq_datetime ?? ((row.acq_date && row.acq_time) ? String(row.acq_date) + "T" + String(row.acq_time).padStart(4, "0") + "00Z" : row.datetime ?? row.properties?.datetime ?? null);
  return { type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { latitude: lat, longitude: lng, brightness_temperature_k: number(row.brightness ?? row.bright_ti4 ?? row.brightness_temperature), confidence: row.confidence ?? row.confidence_category ?? null, acquisition_time: acquired, satellite: row.satellite ?? "VIIRS_SNPP_NRT", instrument: row.instrument ?? "VIIRS", frp_mw: number(row.frp), source: "NASA FIRMS" } };
}
async function queryFirms(timeoutMs) {
  const response = await axios.get(FIRMS_URL, { timeout: timeoutMs, responseType: "text", validateStatus: (status) => status >= 200 && status < 300 });
  return csvRows(response.data);
}
async function queryCmr(timeoutMs) {
  const response = await axios.get(CMR_URL, { timeout: timeoutMs, params: { short_name: "VIIRS_SNPP_NRT", bounding_box: "-92.5,13.5,-88,18", page_size: 200 }, validateStatus: (status) => status >= 200 && status < 300 });
  const entries = response.data?.feed?.entry ?? [];
  return entries.flatMap((entry) => entry?.geometry ? [{ ...entry, geometry: entry.geometry }] : []);
}

export async function getActiveFires({ timeoutMs = 15000, logger = console } = {}) {
  let rows;
  let source = "NASA FIRMS";
  try {
    rows = await queryFirms(timeoutMs);
  } catch (error) {
    logger.warn("FIRMS CSV no disponible; intentando fallback CMR: " + error.message);
    source = "NASA CMR fallback";
    try { rows = await queryCmr(timeoutMs); } catch (fallbackError) { throw new Error("No fue posible consultar NASA FIRMS ni el fallback CMR: " + fallbackError.message, { cause: fallbackError }); }
  }
  return rows.map(normalizeFire).filter(Boolean).map((fire) => ({ ...fire, properties: { ...fire.properties, source } }));
}
