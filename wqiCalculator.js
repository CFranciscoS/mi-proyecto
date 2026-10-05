const weights = { dissolvedOxygen: 0.25, ph: 0.15, turbidity: 0.15, bod5: 0.20, coliforms: 0.15, conductance: 0.10 };
const clamp = (value) => Math.max(0, Math.min(100, value));
function interpolate(value, points) {
  if (value <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index += 1) {
    const [x2, y2] = points[index], [x1, y1] = points[index - 1];
    if (value <= x2) return y1 + ((value - x1) * (y2 - y1)) / (x2 - x1);
  }
  return points.at(-1)[1];
}
const oxygenSaturation = (temperature) => 14.652 - 0.41022 * temperature + 0.007991 * temperature ** 2 - 0.000077774 * temperature ** 3;
function category(score) { return score >= 91 ? "Excelente" : score >= 71 ? "Buena" : score >= 51 ? "Regular" : score >= 26 ? "Mala" : "Muy mala"; }
export function calculateWaterQualityIndex(input) {
  const fields = ["dissolvedOxygen", "ph", "turbidity", "bod5", "coliforms", "conductance"];
  const missing = fields.filter((field) => !Number.isFinite(Number(input[field])) || Number(input[field]) < 0);
  if (missing.length) return { score: null, category: null, subindices: null, missing };
  const oxygenPercent = Number(input.dissolvedOxygen) / oxygenSaturation(Number(input.temperatureC) || 25) * 100;
  const subindices = {
    dissolvedOxygen: clamp(interpolate(oxygenPercent, [[0,0],[30,30],[50,50],[70,70],[90,90],[100,100]])),
    ph: clamp(interpolate(Number(input.ph), [[2,0],[4,35],[6,75],[7,100],[8,90],[10,45],[12,0]])),
    turbidity: clamp(interpolate(Number(input.turbidity), [[0,100],[5,90],[10,80],[25,65],[50,50],[100,35],[500,0]])),
    bod5: clamp(interpolate(Number(input.bod5), [[0,100],[1,96],[3,85],[5,70],[10,45],[20,20],[50,0]])),
    coliforms: clamp(interpolate(Math.log10(Math.max(1, Number(input.coliforms))), [[0,100],[1,96],[2,85],[3,65],[4,35],[5,15],[6,0]])),
    conductance: clamp(interpolate(Number(input.conductance), [[0,100],[100,95],[250,85],[500,70],[1000,40],[1500,20],[2500,0]])),
  };
  const score = Math.round(Object.entries(weights).reduce((sum, [name, weight]) => sum + subindices[name] * weight, 0) * 10) / 10;
  return { score, category: category(score), subindices, missing: [] };
}
