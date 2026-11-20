import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalysisResult, Lab, StampMeta } from './types.js';

/** 标准票参考库（标称齿孔度数、标准刷色 Lab、水印）与评审档案管理 */

export interface ReferenceEntry {
  meta: StampMeta;
  nominalGauge: Record<'top' | 'right' | 'bottom' | 'left', number>;
  standardLab: Lab;
  watermarkId: string | null;
  watermarkName: string | null;
}

export interface ArchiveIndexEntry {
  year: number;
  setCode: string;
  catalogNo: string;
  name: string;
  resultFile: string;
  certificateFile?: string;
  analyzedAt: string;
}

export class Catalog {
  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
  }

  private referenceFile(): string {
    return join(this.rootDir, 'reference.json');
  }

  loadReferences(): ReferenceEntry[] {
    const f = this.referenceFile();
    if (!existsSync(f)) return [];
    return JSON.parse(readFileSync(f, 'utf8')) as ReferenceEntry[];
  }

  saveReference(entry: ReferenceEntry): void {
    const all = this.loadReferences().filter((e) => e.meta.catalogNo !== entry.meta.catalogNo);
    all.push(entry);
    all.sort((a, b) => a.meta.catalogNo.localeCompare(b.meta.catalogNo));
    writeFileSync(this.referenceFile(), JSON.stringify(all, null, 2), 'utf8');
  }

  findReference(catalogNo: string): ReferenceEntry | undefined {
    return this.loadReferences().find((e) => e.meta.catalogNo === catalogNo);
  }

  /** 按 年份/套票编号 归档分析结果，返回结果 JSON 路径 */
  archive(result: AnalysisResult): string {
    const dir = join(this.rootDir, String(result.meta.year), result.meta.setCode);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${result.meta.catalogNo}.analysis.json`);
    writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
    this.updateIndex(result, file);
    return file;
  }

  attachCertificate(catalogNo: string, certificateFile: string): void {
    const index = this.readIndex();
    const entry = index.find((e) => e.catalogNo === catalogNo);
    if (entry) {
      entry.certificateFile = certificateFile;
      writeFileSync(this.indexFile(), JSON.stringify(index, null, 2), 'utf8');
    }
  }

  listByYear(year: number): ArchiveIndexEntry[] {
    return this.readIndex().filter((e) => e.year === year);
  }

  listBySet(setCode: string): ArchiveIndexEntry[] {
    return this.readIndex().filter((e) => e.setCode === setCode);
  }

  listAll(): ArchiveIndexEntry[] {
    return this.readIndex();
  }

  private indexFile(): string {
    return join(this.rootDir, 'archive-index.json');
  }

  private readIndex(): ArchiveIndexEntry[] {
    const f = this.indexFile();
    if (!existsSync(f)) return [];
    return JSON.parse(readFileSync(f, 'utf8')) as ArchiveIndexEntry[];
  }

  private updateIndex(result: AnalysisResult, resultFile: string): void {
    const index = this.readIndex().filter((e) => e.catalogNo !== result.meta.catalogNo);
    index.push({
      year: result.meta.year,
      setCode: result.meta.setCode,
      catalogNo: result.meta.catalogNo,
      name: result.meta.name,
      resultFile,
      analyzedAt: result.meta.analyzedAt,
    });
    index.sort((a, b) => a.year - b.year || a.setCode.localeCompare(b.setCode) || a.catalogNo.localeCompare(b.catalogNo));
    writeFileSync(this.indexFile(), JSON.stringify(index, null, 2), 'utf8');
  }

  listYears(): number[] {
    return readdirSync(this.rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
      .map((d) => Number(d.name))
      .sort((a, b) => a - b);
  }
}
