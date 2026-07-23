// Data transformer — converts raw records into normalized format
// This file has NO tests (test file needs to be created)

export interface RawRecord {
  id: number;
  name: string;
  value?: number;
  category?: string;
  tags?: string[];
}

export interface NormalizedRecord {
  id: number;
  name: string;
  value: number;
  category: string;
  tags: string[];
}

export function transformData(records: RawRecord[]): NormalizedRecord[] {
  return records
    .filter((r) => r.id > 0)
    .map((r) => ({
      id: r.id,
      name: r.name.trim(),
      value: r.value ?? 0,
      category: r.category ?? "uncategorized",
      tags: r.tags ?? [],
    }));
}
