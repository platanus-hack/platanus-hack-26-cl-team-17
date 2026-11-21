/** Une clases CSS ignorando valores falsos (false, null, undefined, ""). Sin dependencias. */
export type ClassValue = string | number | false | null | undefined | ClassValue[];

/** Une clases condicionales: `cn("a", cond && "b", ["c", null])` → "a b c". */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  const walk = (v: ClassValue) => {
    if (!v && v !== 0) return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    out.push(String(v));
  };
  values.forEach(walk);
  return out.join(" ");
}
