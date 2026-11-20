import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ArchiveRecord, CatalogEntry, GradingResult, WatermarkName } from '../types.js';

/**
 * On-disk archive layout:
 *   <root>/<year>/<setCode>/<stampId>/<side>-<timestamp>.json
 *   <root>/index.json            (all records, flat list)
 *   <root>/catalog.json          (catalogue reference entries)
 */
export class ArchiveStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  save(entry: CatalogEntry, result: GradingResult, certificatePdfPath?: string): ArchiveRecord {
    const dir = join(this.root, String(entry.year), entry.setCode, entry.id);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date(result.analyzedAt).toISOString().replace(/[:.]/g, '-');
    const fileName = `${result.scanSide}-${stamp}.json`;
    const record: ArchiveRecord = {
      entry,
      result,
      archivedAt: new Date().toISOString(),
      certificatePdfPath,
    };
    writeFileSync(join(dir, fileName), JSON.stringify(record, null, 2), 'utf8');
    this.appendIndex(record);
    return record;
  }

  list(): ArchiveRecord[] {
    const indexPath = join(this.root, 'index.json');
    if (!existsSync(indexPath)) return [];
    return JSON.parse(readFileSync(indexPath, 'utf8')) as ArchiveRecord[];
  }

  findBySet(setCode: string): ArchiveRecord[] {
    return this.list().filter((r) => r.entry.setCode === setCode);
  }

  findByYear(year: number): ArchiveRecord[] {
    return this.list().filter((r) => r.entry.year === year);
  }

  saveCatalog(entries: CatalogEntry[]): void {
    writeFileSync(join(this.root, 'catalog.json'), JSON.stringify(entries, null, 2), 'utf8');
  }

  loadCatalog(): CatalogEntry[] {
    const p = join(this.root, 'catalog.json');
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, 'utf8')) as CatalogEntry[];
  }

  /** Walk every per-stamp JSON when the index is missing/corrupt. */
  rebuildIndex(): ArchiveRecord[] {
    const records: ArchiveRecord[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else if (name.name.endsWith('.json') && name.name !== 'index.json' && name.name !== 'catalog.json') {
          records.push(JSON.parse(readFileSync(full, 'utf8')) as ArchiveRecord);
        }
      }
    };
    walk(this.root);
    writeFileSync(join(this.root, 'index.json'), JSON.stringify(records, null, 2), 'utf8');
    return records;
  }

  private appendIndex(record: ArchiveRecord): void {
    const indexPath = join(this.root, 'index.json');
    const records = existsSync(indexPath)
      ? (JSON.parse(readFileSync(indexPath, 'utf8')) as ArchiveRecord[])
      : [];
    records.push(record);
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, JSON.stringify(records, null, 2), 'utf8');
  }
}

export function catalogEntryFromSpec(spec: {
  id: string;
  setCode: string;
  setName: string;
  year: number;
  catalogNumber: string;
  denomination: string;
  title: string;
  baseColor: { r: number; g: number; b: number };
  watermark: WatermarkName;
}): CatalogEntry {
  return {
    id: spec.id,
    setCode: spec.setCode,
    year: spec.year,
    catalogNumber: spec.catalogNumber,
    denomination: spec.denomination,
    title: `${spec.setName} · ${spec.title}`,
    reference: { colorRgb: spec.baseColor, watermark: spec.watermark },
  };
}
