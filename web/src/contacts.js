// Reading the contact list from Excel / CSV and cleaning up phone numbers.
import * as XLSX from 'xlsx';

export const normalizePhone = (raw, countryCode) => {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const hasPlus = text.startsWith('+');
  let digits = text.replace(/\D/g, '');
  if (!digits) return null;
  if (!hasPlus) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0') && countryCode) digits = countryCode + digits.slice(1);
    else if (countryCode === '255' && digits.length === 9 && /^[67]/.test(digits)) {
      // Excel often drops the leading zero from numbers
      digits = countryCode + digits;
    }
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return '+' + digits;
};

const PHONE_HEADERS = ['phone', 'mobile', 'simu', 'namba', 'number', 'tel', 'cell'];
const NAME_HEADERS = ['name', 'jina', 'majina', 'mgeni', 'guest', 'customer', 'contact'];

const detectColumns = (rows, countryCode) => {
  const header = (rows[0] || []).map((h) => String(h).toLowerCase().replace(/[._]/g, ' ').trim());
  const phoneByHeader = header.findIndex((h) => PHONE_HEADERS.some((k) => h.includes(k)));
  if (phoneByHeader !== -1) {
    const nameByHeader = header.findIndex((h, i) => i !== phoneByHeader && NAME_HEADERS.some((k) => h.includes(k)));
    return {
      hasHeader: true,
      phoneIndex: phoneByHeader,
      nameIndex: nameByHeader !== -1 ? nameByHeader : phoneByHeader === 0 ? 1 : 0,
    };
  }
  const sample = rows.slice(0, 25);
  const width = Math.max(0, ...sample.map((r) => r.length));
  let bestColumn = -1;
  let bestScore = 0;
  for (let c = 0; c < width; c += 1) {
    const score = sample.filter((r) => normalizePhone(r[c], countryCode)).length;
    if (score > bestScore) {
      bestColumn = c;
      bestScore = score;
    }
  }
  if (bestColumn === -1) return null;
  return {
    hasHeader: !normalizePhone(rows[0][bestColumn], countryCode),
    phoneIndex: bestColumn,
    nameIndex: width > 1 ? (bestColumn === 0 ? 1 : 0) : -1,
  };
};

export const readContactFile = async (file, countryCode, startId) => {
  const name = file.name.toLowerCase();
  if (!/\.(xlsx|xls|csv|txt|ods)$/.test(name)) {
    throw new Error('Please choose an Excel (.xlsx) or CSV file.');
  }
  let rows;
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet =
      workbook.SheetNames.map((n) => workbook.Sheets[n]).find((s) => s && s['!ref']) ||
      workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
  } catch {
    throw new Error('That file could not be read. Make sure it is a real Excel or CSV file.');
  }
  rows = rows.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some(Boolean));
  const columns = detectColumns(rows, countryCode);
  if (!columns) throw new Error('No phone numbers found. Put names in one column and phone numbers in another.');

  let id = startId;
  const contacts = [];
  (columns.hasHeader ? rows.slice(1) : rows).forEach((row) => {
    const rawPhone = row[columns.phoneIndex] ?? '';
    const rawName = columns.nameIndex >= 0 ? row[columns.nameIndex] ?? '' : '';
    if (!rawPhone && !rawName) return;
    const phone = normalizePhone(rawPhone, countryCode);
    contacts.push({
      id: id++,
      name: rawName || 'Unknown',
      phone: phone || rawPhone,
      status: phone ? 'pending' : 'invalid',
      note: phone ? '' : 'Not a valid phone number',
      durationSec: null,
      endedAt: null,
    });
  });
  if (!contacts.length) throw new Error('No phone numbers found. Put names in one column and phone numbers in another.');
  return contacts;
};

export const downloadTemplate = () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Name', 'Phone Number'],
    ['Example Person One', '0700 000 001'],
    ['Example Person Two', '0700 000 002'],
    ['Example Person Three', '+255 700 000 003'],
  ]);
  sheet['!cols'] = [{ wch: 32 }, { wch: 22 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Contacts');
  XLSX.writeFile(book, 'call-center-template.xlsx');
};

export const downloadResults = (contacts) => {
  const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Name', 'Phone', 'Status', 'Call length (seconds)', 'Called at', 'Note'].map(quote).join(',')];
  contacts.forEach((c) =>
    lines.push(
      [c.name, c.phone, c.status, c.durationSec ?? '', c.endedAt ? new Date(c.endedAt).toLocaleString() : '', c.note]
        .map(quote)
        .join(','),
    ),
  );
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'call-center-results.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
};
