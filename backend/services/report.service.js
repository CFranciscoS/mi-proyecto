import PDFDocument from "pdfkit";
import { Parser } from "json2csv";

function assertReport(report) {
  if (!report || typeof report !== "object") throw new TypeError("Se requiere un objeto de informe.");
  if (!report.incident?.code || !report.station?.name) throw new TypeError("El informe requiere incident.code y station.name.");
}
function safeText(value, fallback = "No disponible") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}
function dateText(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "No disponible" : new Intl.DateTimeFormat("es-GT", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Guatemala" }).format(date);
}
function drawShield(doc, x, y, size) {
  doc.save().roundedRect(x, y, size, size * 1.16, 12).fill("#047857");
  doc.fillColor("#ffffff").fontSize(size * 0.34).font("Helvetica-Bold").text("SMAM", x + 7, y + size * 0.38, { width: size - 14, align: "center" });
  doc.restore();
}
function ensureSpace(doc, height) {
  if (doc.y + height <= doc.page.height - 68) return;
  doc.addPage();
}
function heading(doc, title) {
  ensureSpace(doc, 34);
  doc.fillColor("#065f46").font("Helvetica-Bold").fontSize(13).text(title);
  doc.moveTo(doc.page.margins.left, doc.y + 5).lineTo(doc.page.width - doc.page.margins.right, doc.y + 5).strokeColor("#a7f3d0").stroke();
  doc.moveDown(0.8);
}
function keyValue(doc, label, value, width = 250) {
  const x = doc.x, y = doc.y;
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#64748b").text(label.toUpperCase(), x, y, { width });
  doc.font("Helvetica").fontSize(10).fillColor("#0f172a").text(safeText(value), x, y + 11, { width });
  doc.y = y + 31;
}
function table(doc, rows) {
  const columns = [150, 72, 70, 94, 70];
  const headers = ["Parámetro", "Lectura", "Umbral", "Fuente", "Estado"];
  ensureSpace(doc, 32);
  let x = doc.page.margins.left;
  const headerY = doc.y;
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#ffffff");
  headers.forEach((header, index) => { doc.rect(x, headerY, columns[index], 18).fill("#047857"); doc.fillColor("#ffffff").text(header, x + 5, headerY + 5, { width: columns[index] - 10, lineBreak: false }); x += columns[index]; });
  doc.y = headerY + 18;
  rows.forEach((row, rowIndex) => {
    ensureSpace(doc, 25);
    x = doc.page.margins.left;
    const rowY = doc.y;
    const color = row.status === "FUERA DE UMBRAL" ? "#fef2f2" : rowIndex % 2 ? "#f8fafc" : "#ffffff";
    const cells = [safeText(row.parameter), safeText(row.reading), safeText(row.threshold), safeText(row.source), safeText(row.status)];
    cells.forEach((cell, index) => { doc.rect(x, rowY, columns[index], 22).fill(color).strokeColor("#e2e8f0").stroke(); doc.fillColor(index === 4 && row.status === "FUERA DE UMBRAL" ? "#b91c1c" : "#334155").font("Helvetica").fontSize(8).text(cell, x + 5, rowY + 7, { width: columns[index] - 10, lineBreak: false }); x += columns[index]; });
    doc.y = rowY + 22;
  });
}

export async function generateIncidentPdf(report) {
  assertReport(report);
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", margin: 48, info: { Title: "Informe forense " + report.incident.code, Author: "SMAM Guatemala" } });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.once("error", (error) => reject(new Error("No fue posible generar el PDF: " + error.message, { cause: error })));
    document.once("end", () => resolve(Buffer.concat(chunks)));
    try {
      drawShield(document, 48, 42, 48);
      document.font("Helvetica-Bold").fontSize(18).fillColor("#064e3b").text("SMAM Guatemala", 110, 47);
      document.font("Helvetica").fontSize(9).fillColor("#475569").text("Informe oficial de incidente ambiental y trazabilidad técnica", 110, 70);
      document.font("Helvetica-Bold").fontSize(9).fillColor("#047857").text("FORENSE · " + report.incident.code, 110, 87);
      document.moveTo(48, 108).lineTo(547, 108).strokeColor("#a7f3d0").stroke();
      document.moveDown(2.5);
      heading(document, "Identificación institucional");
      const municipality = report.municipality ?? {};
      keyValue(document, "Municipio", municipality.name);
      keyValue(document, "Departamento", municipality.department);
      keyValue(document, "Unidad responsable", municipality.environmentalUnit ?? "Dirección Municipal de Gestión Ambiental");
      heading(document, "Resumen técnico de estación");
      keyValue(document, "Estación", report.station.name);
      keyValue(document, "Código externo", report.station.code);
      keyValue(document, "Coordenadas", report.station.latitude && report.station.longitude ? String(report.station.latitude) + ", " + String(report.station.longitude) : null);
      keyValue(document, "Fuente", report.station.source);
      heading(document, "Comparación de parámetros y umbrales");
      table(document, report.parameters ?? []);
      heading(document, "Bitácora del incidente");
      const logEntries = report.incident.log ?? [];
      if (!logEntries.length) document.font("Helvetica").fontSize(10).fillColor("#475569").text("No se registran eventos adicionales.");
      logEntries.forEach((entry) => { ensureSpace(document, 42); document.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a").text(dateText(entry.timestamp) + " · " + safeText(entry.state)); document.font("Helvetica").fontSize(9).fillColor("#475569").text(safeText(entry.observations)); if (entry.mitigation) document.text("Mitigación: " + entry.mitigation); document.moveDown(0.65); });
      ensureSpace(document, 135);
      heading(document, "Verificación y firma oficial");
      document.rect(48, document.y, 90, 90).strokeColor("#94a3b8").stroke();
      document.font("Helvetica-Bold").fontSize(10).fillColor("#475569").text("QR", 78, document.y - 55, { width: 30, align: "center" });
      document.font("Helvetica").fontSize(8).fillColor("#64748b").text("Código de verificación reservado", 48, document.y + 8, { width: 90, align: "center" });
      const signatureX = 214, signatureY = document.y - 58;
      document.moveTo(signatureX, signatureY + 70).lineTo(500, signatureY + 70).strokeColor("#334155").stroke();
      document.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text(safeText(report.signatory?.name, "Director(a) de Gestión Ambiental"), signatureX, signatureY + 77, { width: 286, align: "center" });
      document.font("Helvetica").fontSize(9).fillColor("#64748b").text(safeText(report.signatory?.title, "Firma y sello institucional"), signatureX, signatureY + 90, { width: 286, align: "center" });
      document.font("Helvetica").fontSize(8).fillColor("#64748b").text("Generado por SMAM Guatemala · " + dateText(new Date()), 48, 790, { width: 499, align: "center" });
      document.end();
    } catch (error) {
      document.destroy();
      reject(new Error("No fue posible componer el informe: " + error.message, { cause: error }));
    }
  });
}

export function exportIncidentsCsv(incidents) {
  if (!Array.isArray(incidents)) throw new TypeError("incidents debe ser un arreglo.");
  try {
    const parser = new Parser({ fields: [
      { label: "Código", value: "codigo" }, { label: "Estado", value: "estado" }, { label: "Severidad", value: "severidad" },
      { label: "Estación", value: "estacion.nombre" }, { label: "Municipio", value: "municipio.nombre" }, { label: "Tipo", value: "tipo" },
      { label: "Parámetro", value: "parametro" }, { label: "Valor registrado", value: "valor_registrado" }, { label: "Valor límite", value: "valor_limite" },
      { label: "Creado", value: (row) => dateText(row.creado_en) }, { label: "Atendido", value: (row) => dateText(row.atendida_en) },
    ], withBOM: true, delimiter: "," });
    return parser.parse(incidents);
  } catch (error) {
    throw new Error("No fue posible exportar el CSV: " + error.message, { cause: error });
  }
}
