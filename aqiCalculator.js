const PM25 = [[0,9,0,50],[9.1,35.4,51,100],[35.5,55.4,101,150],[55.5,125.4,151,200],[125.5,225.4,201,300],[225.5,325.4,301,400],[325.5,500.4,401,500]];
const PM10 = [[0,54,0,50],[55,154,51,100],[155,254,101,150],[255,354,151,200],[355,424,201,300],[425,504,301,400],[505,604,401,500]];
function classify(aqi) {
  if (aqi <= 50) return ["Buena", "Normal"];
  if (aqi <= 100) return ["Moderada", "Normal"];
  if (aqi <= 150) return ["Dañina para grupos sensibles", "Precaución"];
  if (aqi <= 200) return ["Dañina", "Alerta"];
  if (aqi <= 300) return ["Muy dañina", "Alerta"];
  return ["Peligrosa", "Alerta"];
}
function compute(value, ranges, decimals) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) return null;
  const concentration = Math.floor(Number(value) * 10 ** decimals) / 10 ** decimals;
  const range = ranges.find(([low, high]) => concentration >= low && concentration <= high);
  if (!range) return concentration > ranges.at(-1)[1] ? { aqi: 500, concentration, ...labels(500) } : null;
  const [cLow, cHigh, iLow, iHigh] = range;
  const aqi = Math.round(((iHigh - iLow) / (cHigh - cLow)) * (concentration - cLow) + iLow);
  return { aqi, concentration, ...labels(aqi) };
}
function labels(aqi) { const [category, riskLevel] = classify(aqi); return { category, riskLevel }; }
export const calculatePm25Aqi = (value) => compute(value, PM25, 1);
export const calculatePm10Aqi = (value) => compute(value, PM10, 0);
export function calculateAirQualityIndex({ pm25, pm10 }) {
  const pollutants = { pm25: calculatePm25Aqi(pm25), pm10: calculatePm10Aqi(pm10) };
  const candidates = Object.entries(pollutants).filter(([, value]) => value);
  if (!candidates.length) return { aqi: null, category: null, riskLevel: null, dominantPollutant: null, pollutants };
  const [key, result] = candidates.reduce((best, item) => item[1].aqi > best[1].aqi ? item : best);
  return { aqi: result.aqi, category: result.category, riskLevel: result.riskLevel, dominantPollutant: key === "pm25" ? "PM2.5" : "PM10", pollutants };
}
