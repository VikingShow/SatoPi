import { transformData, RawRecord, NormalizedRecord } from "../transformer";

describe("transformData", () => {
  it("should transform valid records correctly", () => {
    const input: RawRecord[] = [
      { id: 1, name: "Alice", value: 100, category: "sales", tags: ["vip"] },
      { id: 2, name: "Bob", value: 200, category: "support", tags: [] },
    ];
    const result = transformData(input);
    expect(result).toEqual([
      { id: 1, name: "Alice", value: 100, category: "sales", tags: ["vip"] },
      { id: 2, name: "Bob", value: 200, category: "support", tags: [] },
    ]);
  });

  it("should return empty array for empty input", () => {
    expect(transformData([])).toEqual([]);
  });

  it("should use defaults for missing optional fields", () => {
    const input: RawRecord[] = [{ id: 1, name: "Alice" }];
    const result = transformData(input);
    expect(result).toEqual([
      { id: 1, name: "Alice", value: 0, category: "uncategorized", tags: [] },
    ]);
  });

  it("should use defaults for null or undefined optional fields", () => {
    const input: RawRecord[] = [
      { id: 1, name: "Alice", value: undefined, category: undefined, tags: undefined },
    ];
    const result = transformData(input);
    expect(result).toEqual([
      { id: 1, name: "Alice", value: 0, category: "uncategorized", tags: [] },
    ]);
  });

  it("should filter out records with invalid id", () => {
    const input: RawRecord[] = [
      { id: 0, name: "Zero" },
      { id: -1, name: "Negative" },
      { id: 1, name: "Valid", value: 42 },
    ];
    const result = transformData(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Valid");
  });

  it("should trim whitespace from name", () => {
    const input: RawRecord[] = [{ id: 1, name: "  Alice  " }];
    const result = transformData(input);
    expect(result[0]!.name).toBe("Alice");
  });
});
