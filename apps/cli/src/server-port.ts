/** Parse the finite loopback server port accepted by the CLI boundary. */
export function parseServerPort(input: string): number | undefined {
  if (!/^\d+$/u.test(input)) return undefined;
  const parsed = Number(input);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535
    ? parsed
    : undefined;
}
