// Export controller — converts model output into downloadable files.
//
// Why server-side: PDF rendering needs real layout engines, and xlsx
// generation pulls a 1MB+ dep we'd rather not bundle into the FE. JSON /
// CSV / Markdown could be done in-browser but routing all formats
// through one endpoint keeps the FE simple — one button → one call.
//
// Accepts:
//   { format: 'json' | 'csv' | 'md' | 'xlsx' | 'pdf',
//     rows?: [...],          // for xlsx + csv (array of objects)
//     content?: '...',        // for md + pdf (text body)
//     title?: '...',          // PDF: doc title; xlsx: sheet name
//     filename?: '...'        // suggested download filename
//   }
//
// Returns the raw file with appropriate Content-Type + Content-Disposition.

import * as XLSX from 'xlsx';
import PDFDocument from 'pdfkit';
import logger from '../../helpers/logger.js';
import { error } from '../../helpers/res_helper.js';

// Whitelisted format slugs → display name used in logs.
const FORMATS = new Set(['json', 'csv', 'md', 'xlsx', 'pdf']);

// Sanitize a user-supplied filename so it can't escape downloads with
// path separators or break the Content-Disposition header.
function safeFilename(name, ext) {
  const base = String(name || 'export').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80) || 'export';
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

// CSV escape — wrap any cell that contains a comma, quote, or newline.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const cols = Array.from(rows.reduce((set, r) => {
    if (r && typeof r === 'object') Object.keys(r).forEach(k => set.add(k));
    return set;
  }, new Set()));
  const header = cols.map(csvCell).join(',');
  const body = rows.map(r => cols.map(c => csvCell(r?.[c])).join(',')).join('\r\n');
  return `${header}\r\n${body}`;
}

// Markdown → text renderer for PDFs. We don't ship a full markdown engine
// — instead we handle the most common assistant-output shapes (headings,
// bullets, code blocks, paragraphs, simple tables) line-by-line. Good
// enough for 95% of model output without a 30MB Puppeteer dep.
function renderMarkdownToPdf(doc, content, { title } = {}) {
  if (title) {
    doc.fontSize(20).font('Helvetica-Bold').text(title, { underline: false });
    doc.moveDown(0.5);
  }
  doc.fontSize(11).font('Helvetica').fillColor('#111');

  const lines = String(content || '').split(/\r?\n/);
  let inCode = false;
  for (const raw of lines) {
    const line = raw.replace(/ /g, ' ');

    if (/^```/.test(line)) {
      inCode = !inCode;
      doc.moveDown(0.2);
      continue;
    }
    if (inCode) {
      doc.font('Courier').fontSize(9).fillColor('#222').text(line || ' ');
      continue;
    }
    doc.font('Helvetica').fontSize(11).fillColor('#111');

    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^(#+)/)[1].length;
      const text = line.replace(/^#+\s*/, '');
      const sizes = { 1: 18, 2: 16, 3: 14, 4: 13, 5: 12, 6: 11 };
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(sizes[level] || 12).text(text);
      doc.moveDown(0.2);
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      doc.text(`  • ${line.replace(/^[-*]\s+/, '')}`);
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      doc.text(`  ${line}`);
      continue;
    }
    if (line.trim() === '') {
      doc.moveDown(0.4);
      continue;
    }
    // Strip light inline markdown for readability
    const cleaned = line
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
    doc.text(cleaned);
  }
}

export const postExport = async (req, res) => {
  try {
    const { format, rows, content, title, filename } = req.body || {};
    if (!FORMATS.has(format)) {
      return error(res, `format must be one of: ${[...FORMATS].join(', ')}`, 400);
    }
    const fname = safeFilename(filename || title || 'export', format);
    logger.info(`EXPORT | format=${format} | name=${fname} | rows=${rows?.length || '-'} | content=${content?.length || '-'} chars`);

    if (format === 'json') {
      const payload = rows !== undefined ? rows : content;
      const body = JSON.stringify(payload, null, 2);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      return res.send(body);
    }

    if (format === 'md') {
      const body = String(content || '');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      return res.send(body);
    }

    if (format === 'csv') {
      if (!Array.isArray(rows) || !rows.length) {
        return error(res, 'csv requires a non-empty `rows` array of objects', 400);
      }
      const body = rowsToCsv(rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      return res.send(body);
    }

    if (format === 'xlsx') {
      if (!Array.isArray(rows) || !rows.length) {
        return error(res, 'xlsx requires a non-empty `rows` array of objects', 400);
      }
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, (title || 'Sheet1').slice(0, 31));
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      return res.send(buf);
    }

    if (format === 'pdf') {
      const body = String(content || '');
      if (!body.trim()) return error(res, 'pdf requires a non-empty `content` string', 400);
      const doc = new PDFDocument({ size: 'A4', margin: 56 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      doc.pipe(res);
      renderMarkdownToPdf(doc, body, { title });
      doc.end();
      return;
    }
  } catch (err) {
    logger.error('Export failed', err.message);
    return error(res, err.message);
  }
};
