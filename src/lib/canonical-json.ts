function serializeCanonical(
  value: unknown,
  stack: Set<object>,
  arrayElement = false,
): string | undefined {
  if (value === null) return "null";

  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") {
    return JSON.stringify(value);
  }
  if (valueType === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (valueType === "bigint") {
    throw new TypeError("BigInt values cannot be serialized as JSON");
  }
  if (valueType === "undefined" || valueType === "function" || valueType === "symbol") {
    return arrayElement ? "null" : undefined;
  }

  const object = value as object & { toJSON?: () => unknown };
  if (typeof object.toJSON === "function") {
    return serializeCanonical(object.toJSON(), stack, arrayElement);
  }
  if (stack.has(object)) {
    throw new TypeError("Cannot canonicalize a circular structure");
  }

  stack.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object
        .map((item) => serializeCanonical(item, stack, true) ?? "null")
        .join(",")}]`;
    }

    const entries: string[] = [];
    for (const key of Object.keys(object).sort()) {
      const serialized = serializeCanonical(
        (object as Record<string, unknown>)[key],
        stack,
      );
      if (serialized !== undefined) {
        entries.push(`${JSON.stringify(key)}:${serialized}`);
      }
    }
    return `{${entries.join(",")}}`;
  } finally {
    stack.delete(object);
  }
}

export function canonicalJson(value: unknown): string {
  const serialized = serializeCanonical(value, new Set());
  if (serialized === undefined) {
    throw new TypeError("Value cannot be serialized as JSON");
  }
  return serialized;
}

export async function sha256CanonicalJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
