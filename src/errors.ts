export function describeBg3TestError(error: unknown): string {
  const visited = new Set<Error>();
  function describe(value: unknown): string {
    if (!(value instanceof Error)) return String(value);
    if (visited.has(value)) return "[repeated error]";
    visited.add(value);
    const details = value instanceof AggregateError
      ? value.errors.map(describe)
      : [];
    if (value.cause !== undefined) details.push(describe(value.cause));
    return [value.message, ...details.map((detail) => `  ${detail.replaceAll("\n", "\n  ")}`)].join("\n");
  }
  return describe(error);
}
