export function toIsoStringOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : String(value);
}

export function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : String(value ?? '');
}
