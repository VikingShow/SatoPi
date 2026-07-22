import "@testing-library/jest-dom/vitest";

// ── localStorage mock — Node 22+ conditionally provides localStorage via
// the --localstorage-file flag.  Without the flag (our CI / dev workflow)
// globalThis.localStorage is undefined, which crashes i18n initialisation
// (module-level localStorage.getItem call) and Zustand's persist middleware
// (storage.setItem).  Define a stable in-memory store before any test
// module is evaluated so all consumers work unconditionally.
const storage = new Map<string, string>();
const mock = {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => { storage.set(key, value); },
	removeItem: (key: string) => { storage.delete(key); },
	clear: () => { storage.clear(); },
	get length() { return storage.size; },
	key: (index: number) => [...storage.keys()][index] ?? null,
};

Object.defineProperty(globalThis, "localStorage", {
	value: mock,
	writable: true,
	configurable: true,
});
