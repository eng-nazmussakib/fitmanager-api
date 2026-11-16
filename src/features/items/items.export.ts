import type { Response } from 'express';

import { attachment } from '#src/lib/http.ts';

import type { Item } from './items.repo.ts';

const COLUMNS: { header: string; width: number; value: (i: Item) => string | number }[] = [
    { header: 'Code', width: 12, value: i => i.code },
    { header: 'Name', width: 28, value: i => i.name_en },
    { header: 'Category', width: 16, value: i => i.category_en },
    { header: 'Mobile', width: 14, value: i => i.contact_mobile },
    { header: 'Effective date', width: 14, value: i => i.effective_date },
    { header: 'Amount', width: 14, value: i => i.amount },
    { header: 'Status', width: 10, value: i => i.status }
];

/**
 * A CSV cell. Quotes are doubled (the MSW mock and several project exports wrapped values in quotes without
 * escaping the quotes inside), and text starting with = + - @ gets a leading apostrophe: otherwise Excel runs it
 * as a FORMULA (CSV injection: a name like `=HYPERLINK(...)` typed into a form becomes a live link in the report).
 */
export function csvCell(value: string | number): string {
    if (typeof value === 'number') return String(value);
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
}

const BOM = '\uFEFF';

/** UTF-8 with a BOM, so Excel shows non-ASCII characters (৳) correctly; CRLF line ends (RFC 4180). */
export function sendCsv(res: Response, items: Item[], fileName: string): void {
    const lines = [COLUMNS.map(c => csvCell(c.header)).join(','), ...items.map(i => COLUMNS.map(c => csvCell(c.value(i))).join(','))];
    res.type('text/csv; charset=utf-8')
        .set('Content-Disposition', attachment(fileName))
        .send(BOM + lines.join('\r\n') + '\r\n');
}

/**
 * Excel with exceljs (in the OMS/SIB services), STREAMED into the response row by row instead of built in memory.
 * Loaded on first use: it is a large module that most requests never need.
 * (SheetJS `xlsx@0.18.5`, in ACAS admin, is the last version on npm and has known vulnerabilities; newer
 * versions are only on the SheetJS CDN.)
 */
export async function sendXlsx(res: Response, items: Item[], fileName: string): Promise<void> {
    const { default: ExcelJS } = await import('exceljs');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition', attachment(fileName));
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    const sheet = workbook.addWorksheet('Items', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = COLUMNS.map((c, i) => ({ header: c.header, key: String(i), width: c.width }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).commit();
    for (const item of items) sheet.addRow(COLUMNS.map(c => c.value(item))).commit();
    sheet.getColumn(7).numFmt = '#,##0.00';
    sheet.commit();
    await workbook.commit();
}
