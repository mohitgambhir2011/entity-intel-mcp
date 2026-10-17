// Lookup tables keyed by text that a registry sends us.

/**
 * Reads `table[key]` only when `key` is one of the table's own keys. Registry codes and wording are
 * untrusted data: a plain `table[code]` answers "constructor", "toString" or "__proto__" with a
 * member of Object.prototype, which is neither a value of the table nor safe to destructure.
 */
export function ownEntry<V>(
  table: Readonly<Record<string, V>>,
  key: string | undefined,
): V | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}
