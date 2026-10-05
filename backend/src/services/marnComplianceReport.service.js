import PDFDocument from "pdfkit";

const PAGE_MARGIN = 46;
const COLORS = Object.freeze({
  forest: "#065f46",
  emerald: "#047857",
  mint: "#d1fae5",
  ink: "#0f172a",
  muted: "#475569",
  line: "#cbd5e1",
  red: "#b91c1c",
  green: "#15803d",
  amber: "#b45309",
});

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} es obligatorio.`);
  return value.trim();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeText(value, fallback = "Sin datos") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function formatNumber(value, decimals = 2) {
  const number = finiteNumber(value);
  return number === null
    ? "Sin datos"
    : new Intl.NumberFormat("es-GT", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(number);
}

function formatDate(value, options = { dateStyle: "long" }) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Sin datos";
  return new Intl.DateTimeFormat("es-GT", { ...options, timeZone: "America/Guatemala" }).format(date);
}

function assertReport(report) {
  if (!report || typeof report !== "object") throw new TypeError("Se requiere la información del dictamen.");
  requiredText(report.dictamenNumber, "El número de dictamen");
  requiredText(report.municipality?.name, "El municipio emisor");
  requiredText(report.basin?.name, "El nombre de la cuenca");
  if (!Array.isArray(report.complianceRows)) throw new TypeError("complianceRows debe ser un arreglo.");
}

function ensureSpace(doc, height) {
  if (doc.y + height <= doc.page.height - PAGE_MARGIN) return;
  doc.addPage();
  doc.y = PAGE_MARGIN;
}

function sectionTitle(doc, title) {
  ensureSpace(doc, 32);
  doc.fillColor(COLORS.forest).font("Helvetica-Bold").fontSize(12).text(title);
  const lineY = doc.y + 4;
  doc.moveTo(PAGE_MARGIN, lineY).lineTo(doc.page.width - PAGE_MARGIN, lineY).strokeColor(COLORS.mint).lineWidth(1).stroke();
  doc.moveDown(0.75);
}

function drawInstitutionalEmblem(doc, x, y, size) {
  // Emblema vectorial SMAM: no suplanta sellos ni escudos oficiales de una institución.
  doc.save();
  doc.roundedRect(x, y, size, size, 11).fill(COLORS.emerald);
  doc.circle(x + size * 0.5, y + size * 0.42, size * 0.21).fill("#ecfdf5");
  doc.moveTo(x + size * 0.49, y + size * 0.67)
    .bezierCurveTo(x + size * 0.25, y + size * 0.52, x + size * 0.25, y + size * 0.25, x + size * 0.48, y + size * 0.2)
    .bezierCurveTo(x + size * 0.7, y + size * 0.27, x + size * 0.73, y + size * 0.52, x + size * 0.49, y + size * 0.67)
    .fill("#a7f3d0");
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(size * 0.15).text("SMAM", x, y + size * 0.76, { width: size, align: "center" });
  doc.restore();
}

function drawHeader(doc, report) {
  drawInstitutionalEmblem(doc, PAGE_MARGIN, 38, 57);
  doc.fillColor(COLORS.forest).font("Helvetica-Bold").fontSize(18).text("SMAM Guatemala", 116, 43);
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(9)
    .text("Sistema de Monitoreo Ambiental Municipal", 116, 67)
    .text("Dictamen técnico de cumplimiento ambiental", 116, 80);
  doc.fillColor(COLORS.emerald).font("Helvetica-Bold").fontSize(9)
    .text(report.dictamenNumber, 347, 46, { width: 202, align: "right" });
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8)
    .text(`Municipio emisor: ${report.municipality.name}`, 347, 61, { width: 202, align: "right" })
    .text(`Fecha de emisión: ${formatDate(report.issuedAt)}`, 347, 73, { width: 202, align: "right" });
  doc.moveTo(PAGE_MARGIN, 108).lineTo(doc.page.width - PAGE_MARGIN, 108).strokeColor(COLORS.mint).lineWidth(1.2).stroke();
  doc.y = 124;
}

function keyValue(doc, x, y, label, value, width) {
  doc.fillColor(COLORS.muted).font("Helvetica-Bold").fontSize(7.5).text(label.toUpperCase(), x, y, { width });
  doc.fillColor(COLORS.ink).font("Helvetica").fontSize(9.5).text(safeText(value), x, y + 10, { width });
}

function drawTechnicalSheet(doc, report) {
  sectionTitle(doc, "Ficha técnica de la cuenca monitoreada");
  const top = doc.y;
  const width = (doc.page.width - PAGE_MARGIN * 2 - 16) / 2;
  const coordinates = report.basin.latitude !== null && report.basin.longitude !== null
    ? `${formatNumber(report.basin.latitude, 6)}, ${formatNumber(report.basin.longitude, 6)}`
    : "Sin datos";
  keyValue(doc, PAGE_MARGIN, top, "Cuenca / cuerpo receptor", report.basin.name, width);
  keyValue(doc, PAGE_MARGIN + width + 16, top, "Coordenadas WGS84", coordinates, width);
  keyValue(doc, PAGE_MARGIN, top + 42, "Período de monitoreo", report.monitoringPeriod, width);
  keyValue(doc, PAGE_MARGIN + width + 16, top + 42, "Régimen de caudal GloFAS", `${formatNumber(report.basin.riverDischargeM3s)} m³/s`, width);
  keyValue(doc, PAGE_MARGIN, top + 84, "Estación de monitoreo", report.station?.name, width);
  keyValue(doc, PAGE_MARGIN + width + 16, top + 84, "Código de estación", report.station?.code, width);
  doc.y = top + 122;
}

function statusFor(value, rule) {
  const numericValue = finiteNumber(value);
  if (numericValue === null) return "SIN DATOS";
  if (rule === "range") return numericValue >= 6 && numericValue <= 9 ? "CONFORME" : "NO CONFORME";
  if (rule === "max") return numericValue <= 100 ? "CONFORME" : "NO CONFORME";
  if (rule === "turbidity") return numericValue <= 50 ? "CONFORME" : "NO CONFORME";
  if (rule === "min") return numericValue > 3 ? "CONFORME" : "NO CONFORME";
  if (rule === "coliform") return numericValue < 1000 ? "CONFORME" : "NO CONFORME";
  return "SIN DATOS";
}

export function buildComplianceRows(measurements = {}) {
  return [
    { parameter: "pH", limit: "6.0 – 9.0", value: measurements.ph, unit: "", rule: "range" },
    { parameter: "DBO5 (mg/L)", limit: "100 mg/L", value: measurements.dbo5, unit: "mg/L", rule: "max" },
    { parameter: "Turbidez (NTU)", limit: "50 NTU", value: measurements.turbidity, unit: "NTU", rule: "turbidity" },
    { parameter: "Oxígeno disuelto", limit: "> 3.0 mg/L", value: measurements.dissolvedOxygen, unit: "mg/L", rule: "min" },
    { parameter: "Coliformes fecales", limit: "< 1000 NMP/100mL", value: measurements.fecalColiforms, unit: "NMP/100mL", rule: "coliform" },
  ].map((row) => ({ ...row, status: statusFor(row.value, row.rule) }));
}

function drawComplianceTable(doc, rows) {
  sectionTitle(doc, "Evaluación de cumplimiento · Acuerdo Gubernativo 236-2006");
  const columns = [138, 136, 118, 111];
  const headers = ["Parámetro", "Límite máximo permisible", "Valor promedio medido", "Estado de cumplimiento"];
  const x0 = PAGE_MARGIN;
  const drawRow = (cells, y, fill, bold = false) => {
    let x = x0;
    cells.forEach((cell, index) => {
      doc.rect(x, y, columns[index], 27).fill(fill).strokeColor(COLORS.line).lineWidth(0.5).stroke();
      const isStatus = index === 3;
      const color = isStatus && cell === "NO CONFORME" ? COLORS.red : isStatus && cell === "CONFORME" ? COLORS.green : COLORS.ink;
      doc.fillColor(color).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(7.5)
        .text(cell, x + 5, y + 7, { width: columns[index] - 10, align: isStatus ? "center" : "left", lineBreak: false });
      x += columns[index];
    });
  };
  ensureSpace(doc, 35 + rows.length * 28);
  let rowY = doc.y;
  drawRow(headers, rowY, COLORS.mint, true);
  rowY += 27;
  rows.forEach((row, index) => {
    const average = finiteNumber(row.value) === null ? "Sin datos" : `${formatNumber(row.value)}${row.unit ? ` ${row.unit}` : ""}`;
    drawRow([row.parameter, row.limit, average, row.status], rowY, index % 2 ? "#f8fafc" : "#ffffff");
    rowY += 27;
  });
  doc.y = rowY + 8;
}

function drawLegalNotice(doc, report) {
  sectionTitle(doc, "Marco legal y alcance técnico");
  const legalText = report.legalNotice || "El presente dictamen técnico se emite con referencia a los artículos 14, 18 y 23 del Acuerdo Gubernativo 236-2006, Reglamento de las descargas y reuso de aguas residuales y de la disposición de lodos, y sus reformas vigentes.";
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(9.2).text(legalText, { align: "justify", lineGap: 2 });
  doc.moveDown(0.55);
  doc.fillColor(COLORS.amber).font("Helvetica-Bold").fontSize(8.2)
    .text("Nota de alcance: este documento consolida evidencia técnica de monitoreo y no sustituye resoluciones, autorizaciones ni actos de autoridad de las entidades competentes.");
  doc.moveDown(0.7);
}

function drawIncidentTrail(doc, incidents) {
  sectionTitle(doc, "Trazabilidad de incidentes y remediación municipal");
  if (!incidents.length) {
    doc.fillColor(COLORS.muted).font("Helvetica").fontSize(9.2).text("No se registran alertas asociadas a la estación durante el período evaluado.");
    doc.moveDown(0.7);
    return;
  }
  incidents.forEach((incident) => {
    ensureSpace(doc, 49);
    const date = formatDate(incident.timestamp || incident.createdAt, { dateStyle: "medium", timeStyle: "short" });
    doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(8.7)
      .text(`${date} · ${safeText(incident.code, "Alerta")} · ${safeText(incident.severity, "Sin severidad").toUpperCase()}`);
    const body = [incident.parameter ? `Parámetro: ${incident.parameter}.` : "", incident.observations, incident.mitigation ? `Remediación: ${incident.mitigation}` : ""].filter(Boolean).join(" ");
    doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8.7).text(safeText(body, "Sin observaciones registradas."), { lineGap: 1.5 });
    doc.moveDown(0.55);
  });
}

function drawQrPlaceholder(doc, x, y, size) {
  const cells = 15;
  const cellSize = size / cells;
  const seed = "100100111010011001011101001101001011100100111010011";
  doc.save().rect(x, y, size, size).fill("#ffffff").strokeColor(COLORS.line).stroke();
  for (let row = 0; row < cells; row += 1) {
    for (let column = 0; column < cells; column += 1) {
      const index = (row * cells + column) % seed.length;
      if (seed[index] === "1" && !((row < 4 && column < 4) || (row < 4 && column > 10) || (row > 10 && column < 4))) {
        doc.rect(x + column * cellSize, y + row * cellSize, cellSize, cellSize).fill(COLORS.ink);
      }
    }
  }
  [[0, 0], [11, 0], [0, 11]].forEach(([column, row]) => {
    doc.rect(x + column * cellSize, y + row * cellSize, 4 * cellSize, 4 * cellSize).fill(COLORS.ink);
    doc.rect(x + (column + 1) * cellSize, y + (row + 1) * cellSize, 2 * cellSize, 2 * cellSize).fill("#ffffff");
  });
  doc.restore();
}

function drawSignatures(doc, report) {
  ensureSpace(doc, 150);
  sectionTitle(doc, "Verificación y suscripción oficial");
  const y = doc.y;
  drawQrPlaceholder(doc, PAGE_MARGIN, y, 78);
  doc.fillColor(COLORS.muted).font("Helvetica").fontSize(7.5).text("Código QR de verificación\n(reservado para el portal institucional)", PAGE_MARGIN, y + 84, { width: 78, align: "center" });
  const signatureX = 165;
  const signatureWidth = 175;
  const rightX = 370;
  [[signatureX, report.signatories?.environmentalDirector || "Director(a) Ambiental Municipal", "Director(a) de Gestión Ambiental"], [rightX, report.signatories?.licensedEngineer || "Ingeniero(a) colegiado(a)", "Responsable técnico y firma"]]
    .forEach(([x, name, role]) => {
      doc.moveTo(x, y + 68).lineTo(x + signatureWidth, y + 68).strokeColor(COLORS.muted).lineWidth(0.6).stroke();
      doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(8.4).text(safeText(name), x, y + 75, { width: signatureWidth, align: "center" });
      doc.fillColor(COLORS.muted).font("Helvetica").fontSize(7.8).text(role, x, y + 87, { width: signatureWidth, align: "center" });
    });
  doc.y = y + 113;
}

function drawFooter(doc, report) {
  const pageCount = doc.bufferedPageRange().count;
  for (let index = 0; index < pageCount; index += 1) {
    doc.switchToPage(index);
    doc.fillColor(COLORS.muted).font("Helvetica").fontSize(7.2)
      .text(`${report.dictamenNumber} · SMAM Guatemala · Página ${index + 1} de ${pageCount}`, PAGE_MARGIN, doc.page.height - 31, { width: doc.page.width - PAGE_MARGIN * 2, align: "center" });
  }
}

/**
 * Creates a readable PDF stream. Attach error handlers and pipe it before the
 * current event loop completes; the document is composed on the next tick.
 */
export function createMarnComplianceReportStream(report) {
  assertReport(report);
  const document = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    bufferPages: true,
    info: { Title: `Dictamen MARN ${report.dictamenNumber}`, Author: "SMAM Guatemala", Subject: "Cumplimiento AG 236-2006" },
  });
  queueMicrotask(() => {
    try {
      drawHeader(document, report);
      drawLegalNotice(document, report);
      drawTechnicalSheet(document, report);
      drawComplianceTable(document, report.complianceRows);
      drawIncidentTrail(document, Array.isArray(report.incidents) ? report.incidents : []);
      drawSignatures(document, report);
      drawFooter(document, report);
      document.end();
    } catch (error) {
      document.destroy(new Error(`No fue posible generar el dictamen MARN: ${error.message}`, { cause: error }));
    }
  });
  return document;
}

