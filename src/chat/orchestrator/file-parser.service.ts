import { Injectable, Logger } from '@nestjs/common';
import * as mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';

const MAX_FILE_TEXT_LENGTH = 5000;
const XLSX_MAX_SHEETS = 2;
const XLSX_MAX_ROWS = 200;

@Injectable()
export class FileParserService {
  private readonly logger = new Logger(FileParserService.name);

  async parse(buffer: Buffer, mimeType: string): Promise<string> {
    const mime = mimeType.toLowerCase().trim();

    if (this.isPlainText(mime)) {
      return buffer.toString('utf-8').slice(0, MAX_FILE_TEXT_LENGTH);
    }

    if (mime === 'application/pdf') {
      return this.parsePdf(buffer);
    }

    if (
      mime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      return this.parseDocx(buffer);
    }

    if (
      mime ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mime === 'application/vnd.ms-excel'
    ) {
      return this.parseXlsx(buffer);
    }

    // Images and unsupported formats → caller decides what to do
    return '';
  }

  private isPlainText(mime: string): boolean {
    return (
      mime === 'text/plain' ||
      mime === 'text/markdown' ||
      mime === 'text/csv' ||
      mime === 'text/x-markdown'
    );
  }

  private async parsePdf(buffer: Buffer): Promise<string> {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text.trim().slice(0, MAX_FILE_TEXT_LENGTH);
    } finally {
      await parser.destroy();
    }
  }

  private async parseDocx(buffer: Buffer): Promise<string> {
    const result = await mammoth.extractRawText({ buffer });
    if (result.messages.length) {
      this.logger.warn(
        `mammoth warnings: ${result.messages.map((m) => m.message).join('; ')}`,
      );
    }
    return result.value.trim().slice(0, MAX_FILE_TEXT_LENGTH);
  }

  private parseXlsx(buffer: Buffer): string {
    const MAX_XLSX_SIZE = 5 * 1024 * 1024;
    if (buffer.length > MAX_XLSX_SIZE) {
      throw new Error('xlsx file too large');
    }

    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetNames = workbook.SheetNames.slice(0, XLSX_MAX_SHEETS);
    const lines: string[] = [];

    for (const name of sheetNames) {
      const sheet = workbook.Sheets[name];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

      lines.push(`[Sheet: ${name}]`);
      for (const row of rows.slice(0, XLSX_MAX_ROWS)) {
        if (
          Array.isArray(row) &&
          row.some((c) => c !== null && c !== undefined && c !== '')
        ) {
          lines.push(
            row
              .map((c) =>
                typeof c === 'object' && c !== null
                  ? JSON.stringify(c)
                  : String(c),
              )
              .join('\t'),
          );
        }
      }
    }

    return lines.join('\n').slice(0, MAX_FILE_TEXT_LENGTH);
  }
}
