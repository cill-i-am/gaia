export function createReadinessActionId(): string {
  return `readiness-${crypto.randomUUID()}`;
}

export function mergeDecisionIdentity(input: {
  readonly payloadDigest: string;
  readonly sequence: number;
}): string {
  return `merge-${input.payloadDigest}-${input.sequence}`;
}
