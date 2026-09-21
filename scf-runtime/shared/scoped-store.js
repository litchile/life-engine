// The adapter owns physical paths. Callers and stored references always use
// logical keys, including lock names and generated-image references.
import { validateRelativeKey } from "./character-pack.js";

export function createScopedStore(store, prefix = "") {
  validateRelativeKey(prefix, { allowEmpty: true });
  if (!prefix) return store;
  const base = `${prefix}/`;
  const physical = (key) => `${base}${validateRelativeKey(key)}`;
  const scoped = {};
  for (const method of ["getJson", "putJson", "getObject", "putObject", "exists", "tryAcquireLock", "releaseLock"]) {
    if (typeof store[method] === "function") scoped[method] = (key, ...args) => store[method](physical(key), ...args);
  }
  scoped.listKeys = async (key = "", limit) => {
    // A listing prefix may end in '/'; ordinary object keys may not.
    const checked = key.endsWith("/") ? key.slice(0, -1) : key;
    validateRelativeKey(checked, { allowEmpty: true });
    const keys = await store.listKeys(`${base}${key}`, limit);
    return keys.filter((item) => item.startsWith(base)).map((item) => item.slice(base.length));
  };
  return scoped;
}

export function logicalEventKey(physicalKey, prefix = "") {
  validateRelativeKey(prefix, { allowEmpty: true });
  if (!prefix) return physicalKey;
  const base = `${prefix}/`;
  return physicalKey.startsWith(base) ? physicalKey.slice(base.length) : null;
}
