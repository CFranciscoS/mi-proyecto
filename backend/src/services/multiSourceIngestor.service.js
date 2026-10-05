import axios from "axios";

const HTTP_TIMEOUT_MS = 12_000;
const GUATEMALA_BOUNDS = Object.freeze({ minLat: 13.5, minLng: -92.5, maxLat: 18, maxLng: -88 });
const WAQI_URL = "https://api.waqi.info/v2/map/bounds/";
const CAMS_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const FLOOD_URL = "https://flood-api.open-meteo.com/v1/flood";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/api/country/csv/open_key/VIIRS_SNPP_NRT/GTM/1";

const BASINS = Object.freeze([
  { id: "amatitlan", name: "Lago de Amatitlán", lat: 14.478, lng: -90.57 },
  { id: "atitlan", name: "Lago de Atitlán", lat: 14.69, lng: -91.2 },
  { id: "peten-itza", name: "Lago Petén Itzá", lat: 16.954, lng: -89.859 },
  { id: "izabal", name: "Lago de Izabal", lat: 15.483, lng: -88.983 },
  { id: "lachua", name: "Laguna Lachuá", lat: 15.868, lng: -90.668 },
  { id: "calderas", name: "Laguna de Calderas", lat: 14.405, lng: -90.646 },
  { id: "motagua-alta", name: "Río Motagua · Cuenca Alta", lat: 14.811, lng: -90.119 },
  { id: "motagua-baja", name: "Río Motagua · Cuenca Baja", lat: 15.579, lng: -89.0 },
  { id: "villalobos", name: "Río Villalobos", lat: 14.52, lng: -90.55 },
  { id: "las-vacas", name: "Río Las Vacas", lat: 14.72, lng: -90.51 },
  { id: "samala", name: "Río Samalá", lat: 14.7, lng: -91.47 },
  { id: "coyolate", name: "Río Coyolate", lat: 14.159, lng: -91.034 },
]);

const CAMS_GRID = Object.freeze([
  { id: "cams-guatemala-z1", name: "Ciudad de Guatemala · Zona 1", lat: 14.642, lng: -90.513 },
  { id: "cams-guatemala-z10", name: "Ciudad de Guatemala · Zona 10", lat: 14.594, lng: -90.514 },
  { id: "cams-mixco", name: "Mixco", lat: 14.634, lng: -90.607 },
  { id: "cams-villa-nueva", name: "Villa Nueva", lat: 14.526, lng: -90.587 },
  { id: "cams-amatitlan", name: "Amatitlán", lat: 14.478, lng: -90.57 },
  { id: "cams-antigua", name: "Antigua Guatemala", lat: 14.558, lng: -90.734 },
  { id: "cams-chimaltenango", name: "Chimaltenango", lat: 14.664, lng: -90.819 },
  { id: "cams-xela", name: "Quetzaltenango · Xela", lat: 14.834, lng: -91.518 },
  { id: "cams-escuintla", name: "Escuintla", lat: 14.305, lng: -90.786 },
  { id: "cams-puerto-san-jose", name: "Puerto San José", lat: 13.927, lng: -90.821 },
  { id: "cams-mazatenango", name: "Mazatenango", lat: 14.534, lng: -91.504 },
  { id: "cams-retalhuleu", name: "Retalhuleu", lat: 14.536, lng: -91.677 },
  { id: "cams-huehuetenango", name: "Huehuetenango", lat: 15.319, lng: -91.472 },
  { id: "cams-coban", name: "Cobán", lat: 15.47, lng: -90.371 },
  { id: "cams-salama", name: "Salamá", lat: 15.102, lng: -90.318 },
  { id: "cams-zacapa", name: "Zacapa", lat: 14.972, lng: -89.531 },
  { id: "cams-chiquimula", name: "Chiquimula", lat: 14.797, lng: -89.544 },
  { id: "cams-puerto-barrios", name: "Puerto Barrios", lat: 15.727, lng: -88.595 },
  { id: "cams-flores", name: "Flores · Petén", lat: 16.925, lng: -89.893 },
]);

const http = axios.create({ timeout: HTTP_TIMEOUT_MS, validateStatus: (status) => status >= 200 && status < 300 });

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function withinGuatemala(lat, lng) {
  return lat >= GUATEMALA_BOUNDS.minLat && lat <= GUATEMALA_BOUNDS.maxLat
    && lng >= GUATEMALA_BOUNDS.minLng && lng <= GUATEMALA_BOUNDS.maxLng;
}

function assertLocation(lat, lng) {
  const latitude = number(lat);
  const longitude = number(lng);
  if (latitude === null || longitude === null) throw new TypeError("lat y lng deben ser valores numéricos.");
  if (!withinGuatemala(latitude, longitude)) throw new RangeError("Las coordenadas deben encontrarse dentro de Guatemala.");
  return { lat: latitude, lng: longitude };
}

function airRisk(aqi) {
  if (aqi === null) return "Precaución";
  if (aqi <= 50) return "Normal";
  if (aqi <= 100) return "Precaución";
  return "Alerta";
}

function waterRisk(discharge, wqi) {
  if ((wqi !== null && wqi < 51) || (discharge !== null && discharge >= 250)) return "Alerta";
  if ((wqi !== null && wqi < 76) || (discharge !== null && discharge >= 100)) return "Precaución";
  return "Normal";
}

function calculateWqiEstimate(discharge) {
  if (discharge === null) return null;
  // Estimación hidrológica para visualización cuando aún no hay sonda de calidad.
  return Math.max(42, Math.min(92, Math.round((86 - Math.log10(Math.max(1, discharge)) * 11) * 10) / 10));
}

function calculateTurbidityEstimate(discharge) {
  if (discharge === null) return null;
  return Math.round(Math.max(2, Math.min(180, 4 + Math.sqrt(Math.max(0, discharge)) * 3.7)) * 10) / 10;
}

function pm25ToAqi(pm25) {
  const concentration = number(pm25);
  if (concentration === null) return null;
  const c = Math.floor(concentration * 10) / 10;
  const brackets = [[0, 12, 0, 50], [12.1, 35.4, 51, 100], [35.5, 55.4, 101, 150], [55.5, 150.4, 151, 200], [150.5, 250.4, 201, 300], [250.5, 350.4, 301, 400], [350.5, 500.4, 401, 500]];
  const bracket = brackets.find(([low, high]) => c >= low && c <= high) || (c > 500.4 ? [350.5, 500.4, 401, 500] : brackets[0]);
  const [cLow, cHigh, iLow, iHigh] = bracket;
  return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (Math.min(c, cHigh) - cLow) + iLow);
}

function csvRecords(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const parseLine = (line) => {
    const cells = [];
    let cell = "", quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"' && line[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = !quoted;
      else if (character === "," && !quoted) { cells.push(cell.trim()); cell = ""; }
      else cell += character;
    }
    cells.push(cell.trim());
    return cells;
  };
  const headers = parseLine(lines.shift()).map((header) => header.toLowerCase());
  return lines.map(parseLine).map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}

async function camsStation(station) {
  const { data } = await http.get(CAMS_URL, {
    params: { latitude: station.lat, longitude: station.lng, current: "pm2_5,pm10,us_aqi", timezone: "UTC" },
  });
  const pm25 = number(data.current?.pm2_5);
  const aqi = number(data.current?.us_aqi) ?? pm25ToAqi(pm25);
  return { ...station, aqi, pm25, riskLevel: airRisk(aqi), source: "Copernicus CAMS vía Open-Meteo" };
}

export async function getWaqiAirStations() {
  // CAMS entrega una cobertura homogénea para los 18 nodos nacionales. WAQI se
  // consulta de forma oportunista para enriquecer nodos, nunca para reducir la red.
  const camsResults = await Promise.allSettled(CAMS_GRID.map(camsStation));
  const stations = camsResults.map((result, index) => result.status === "fulfilled" ? result.value : {
    ...CAMS_GRID[index], aqi: null, pm25: null, riskLevel: "Precaución", source: "Copernicus CAMS temporalmente no disponible",
  });
  try {
    const { data } = await http.get(WAQI_URL, { params: { latlng: "13.5,-92.5,18.0,-88.0", token: "demo" } });
    if (data.status !== "ok" || !Array.isArray(data.data)) return stations;
    for (const station of stations) {
      const nearest = data.data
        .filter((candidate) => number(candidate.lat) !== null && number(candidate.lon) !== null)
        .sort((a, b) => (Number(a.lat) - station.lat) ** 2 + (Number(a.lon) - station.lng) ** 2 - ((Number(b.lat) - station.lat) ** 2 + (Number(b.lon) - station.lng) ** 2))[0];
      const aqi = number(nearest?.aqi);
      if (aqi !== null) Object.assign(station, { aqi, riskLevel: airRisk(aqi), source: "Copernicus CAMS + WAQI" });
    }
  } catch {
    // El token demo de WAQI es opcional y puede tener límites de frecuencia.
  }
  return stations;
}

async function fetchBasin(basin) {
  const { data } = await http.get(FLOOD_URL, {
    params: { latitude: basin.lat, longitude: basin.lng, daily: "river_discharge,river_discharge_max", forecast_days: 3, timezone: "UTC" },
  });
  const discharge = number(data.daily?.river_discharge?.[0]);
  const wqi = calculateWqiEstimate(discharge);
  return {
    ...basin,
    discharge_m3s: discharge,
    turbidity_ntu: calculateTurbidityEstimate(discharge),
    wqi_score: wqi,
    riskLevel: waterRisk(discharge, wqi),
    source: "Copernicus GloFAS vía Open-Meteo",
  };
}

export async function getGlofasRiverBasins() {
  const settled = await Promise.allSettled(BASINS.map(fetchBasin));
  return settled.map((result, index) => result.status === "fulfilled" ? result.value : {
    ...BASINS[index], discharge_m3s: null, turbidity_ntu: null, wqi_score: null, riskLevel: "Precaución", source: "Copernicus GloFAS temporalmente no disponible",
  });
}

function fallbackFires() {
  // Se muestra sólo si FIRMS no responde: ubicaciones históricamente plausibles, no observaciones en tiempo real.
  return [
    { id: "fallback-firms-escuintla", lat: 14.236, lng: -90.783, brightness: null, confidence: "sin confirmar", time: null, source: "Respaldo estimado; FIRMS no disponible", isFallback: true },
    { id: "fallback-firms-jutiapa", lat: 14.292, lng: -89.897, brightness: null, confidence: "sin confirmar", time: null, source: "Respaldo estimado; FIRMS no disponible", isFallback: true },
  ];
}

export async function getNasaFirmsFires() {
  try {
    const { data } = await http.get(FIRMS_URL, { responseType: "text" });
    const fires = csvRecords(data).map((row, index) => {
      const lat = number(row.latitude);
      const lng = number(row.longitude);
      if (lat === null || lng === null || !withinGuatemala(lat, lng)) return null;
      const time = row.acq_date && row.acq_time
        ? `${row.acq_date}T${String(row.acq_time).padStart(4, "0").slice(0, 2)}:${String(row.acq_time).padStart(4, "0").slice(2)}:00Z`
        : null;
      return { id: `firms-${row.acq_date || "unknown"}-${row.acq_time || index}-${lat}-${lng}`, lat, lng, brightness: number(row.brightness || row.bright_ti4), confidence: row.confidence || null, time, source: "NASA FIRMS VIIRS SNPP NRT", isFallback: false };
    }).filter(Boolean);
    return fires;
  } catch {
    return fallbackFires();
  }
}

function destination(lat, lng, bearingDeg, distanceKm) {
  const radiusKm = 6371.0088;
  const bearing = bearingDeg * Math.PI / 180;
  const angularDistance = distanceKm / radiusKm;
  const latitude = lat * Math.PI / 180;
  const longitude = lng * Math.PI / 180;
  const resultLat = Math.asin(Math.sin(latitude) * Math.cos(angularDistance) + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing));
  const resultLng = longitude + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude), Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(resultLat));
  return [Number((resultLat * 180 / Math.PI).toFixed(6)), Number((((resultLng * 180 / Math.PI + 540) % 360) - 180).toFixed(6))];
}

export async function getWindPlume(lat = 14.64, lng = -90.51) {
  const origin = assertLocation(lat, lng);
  const { data } = await http.get(WEATHER_URL, { params: { latitude: origin.lat, longitude: origin.lng, current: "wind_speed_10m,wind_direction_10m", timezone: "UTC" } });
  const speed = number(data.current?.wind_speed_10m) ?? 0;
  const fromBearing = number(data.current?.wind_direction_10m);
  const bearing = fromBearing === null ? 0 : (fromBearing + 180) % 360;
  const distanceKm = Math.max(2, Math.min(30, speed * 1.25));
  return {
    origin: [origin.lat, origin.lng], bearing_deg: bearing, speed_kmh: speed,
    cone_points: [[origin.lat, origin.lng], destination(origin.lat, origin.lng, (bearing + 18) % 360, distanceKm), destination(origin.lat, origin.lng, (bearing - 18 + 360) % 360, distanceKm)],
    observed_at: data.current?.time || new Date().toISOString(), source: "Open-Meteo",
  };
}

export async function get72hForecast(lat = 14.64, lng = -90.51) {
  const location = assertLocation(lat, lng);
  const [airResponse, weatherResponse] = await Promise.all([
    http.get(CAMS_URL, { params: { latitude: location.lat, longitude: location.lng, hourly: "pm2_5,pm10,us_aqi", forecast_days: 3, timezone: "UTC" } }),
    http.get(WEATHER_URL, { params: { latitude: location.lat, longitude: location.lng, hourly: "precipitation,precipitation_probability,temperature_2m", forecast_days: 3, timezone: "UTC" } }),
  ]);
  const air = airResponse.data.hourly || {};
  const weather = weatherResponse.data.hourly || {};
  const length = Math.min(72, air.time?.length || 0, weather.time?.length || 0);
  if (!length) throw new Error("CAMS u Open-Meteo no devolvieron el pronóstico horario solicitado.");
  return Array.from({ length }, (_, index) => ({
    time: air.time[index], pm25: number(air.pm2_5?.[index]), pm10: number(air.pm10?.[index]), aqi: number(air.us_aqi?.[index]) ?? pm25ToAqi(air.pm2_5?.[index]),
    precipitation_mm: number(weather.precipitation?.[index]), rain_probability: number(weather.precipitation_probability?.[index]), temperature_c: number(weather.temperature_2m?.[index]),
  }));
}
