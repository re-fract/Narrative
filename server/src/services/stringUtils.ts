/**
 * Utility to clean null bytes (\u0000) from strings, arrays, and plain objects.
 * PostgreSQL does not support storing null characters in text/varchar fields.
 */
export function cleanNullBytes<T>(val: T): T {
  if (val === null || val === undefined) {
    return val;
  }
  if (typeof val === 'string') {
    return val.replace(/\u0000/g, '') as unknown as T;
  }
  if (Array.isArray(val)) {
    return val.map(item => cleanNullBytes(item)) as unknown as T;
  }
  if (typeof val === 'object') {
    const proto = Object.getPrototypeOf(val);
    if (proto === Object.prototype || proto === null) {
      const obj = val as Record<string, unknown>;
      const res: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) {
        res[key] = cleanNullBytes(obj[key]);
      }
      return res as unknown as T;
    }
  }
  return val;
}
