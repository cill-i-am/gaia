import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat as nodeLstat } from "node:fs/promises";
import { promisify } from "node:util";

import { canonicalV1 } from "@gaia/core";
import {
  Context,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Scope,
} from "effect";

import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import {
  makeRunStorePaths,
  parseRuntimePath,
  type RunStorageOptions,
  type RuntimePath,
} from "./paths.js";

const execFile = promisify(nodeExecFile);
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const LowerDigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
);
export const RunStoreRootDigestV1Schema = LowerDigestSchema.pipe(
  Schema.brand("RunStoreRootDigestV1")
);
export const RunStoreLockOwnerDigestV3Schema = LowerDigestSchema.pipe(
  Schema.brand("RunStoreLockOwnerDigestV3")
);
export const RunStoreLockAnchorDigestV1Schema = LowerDigestSchema.pipe(
  Schema.brand("RunStoreLockAnchorDigestV1")
);
export const RunStoreLockSuccessorEdgeDigestV1Schema = LowerDigestSchema.pipe(
  Schema.brand("RunStoreLockSuccessorEdgeDigestV1")
);
export const RunStoreLockTerminalDigestV1Schema = LowerDigestSchema.pipe(
  Schema.brand("RunStoreLockTerminalDigestV1")
);

export const RunStoreLockOperationSchema = Schema.Literals([
  "specRun",
  "browserEvidence",
  "serverRunAcceptance",
  "factoryRunAcceptance",
  "serverRunContinuation",
  "serverStartupReconciliation",
  "workerContinuation",
  "workerCorrelation",
  "desktopOriginCorrelation",
  "agentSessionAction",
  "claimVerification",
  "deliveryPublication",
  "deliveryRemediation",
  "deliveryReadyForReview",
  "deliveryReviewAttestation",
  "deliveryMerge",
  "deliveryCleanup",
  "workerRecovery",
  "mergeDecision",
  "linearIssueGraph",
  "githubChecks",
  "githubCiWatch",
  "githubFeedback",
  "githubPrLoop",
  "githubRemediation",
  "githubComment",
  "genericRunStoreMutation",
] as const);
export const RunStoreLockNextActionSchema = Schema.Literals([
  "waitThenRetry",
  "refreshThenRetry",
  "inspectThenRetry",
] as const);
const ProcessStartTokenSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^ps-start-unix-seconds-v1:[0-9]+$/u))
);

export class RunStoreRootIdentityPayloadV1 extends Schema.Class<RunStoreRootIdentityPayloadV1>(
  "RunStoreRootIdentityPayloadV1"
)(
  { canonicalRoot: Schema.NonEmptyString, version: Schema.Literal(1) },
  strict
) {}

export class RunStoreLockOwnerPayloadV3 extends Schema.Class<RunStoreLockOwnerPayloadV3>(
  "RunStoreLockOwnerPayloadV3"
)(
  {
    nextAction: RunStoreLockNextActionSchema,
    nonce: Schema.String.pipe(
      Schema.check(Schema.isPattern(/^[a-f0-9]{32}$/u))
    ),
    operation: RunStoreLockOperationSchema,
    pid: Schema.Number.pipe(
      Schema.check(Schema.isInt(), Schema.isGreaterThan(0))
    ),
    processStartToken: ProcessStartTokenSchema,
    rootDigest: RunStoreRootDigestV1Schema,
    version: Schema.Literal(3),
  },
  strict
) {}

export class RunStoreLockAnchorPayloadV1 extends Schema.Class<RunStoreLockAnchorPayloadV1>(
  "RunStoreLockAnchorPayloadV1"
)(
  {
    initialOwnerDigest: RunStoreLockOwnerDigestV3Schema,
    rootDigest: RunStoreRootDigestV1Schema,
    version: Schema.Literal(1),
  },
  strict
) {}

export class RunStoreLockSuccessorEdgePayloadV1 extends Schema.Class<RunStoreLockSuccessorEdgePayloadV1>(
  "RunStoreLockSuccessorEdgePayloadV1"
)(
  {
    anchorDigest: RunStoreLockAnchorDigestV1Schema,
    predecessorOwnerDigest: RunStoreLockOwnerDigestV3Schema,
    rootDigest: RunStoreRootDigestV1Schema,
    successorOwnerDigest: RunStoreLockOwnerDigestV3Schema,
    version: Schema.Literal(1),
  },
  strict
) {}

export class RunStoreLockTerminalPayloadV1 extends Schema.Class<RunStoreLockTerminalPayloadV1>(
  "RunStoreLockTerminalPayloadV1"
)(
  {
    anchorDigest: RunStoreLockAnchorDigestV1Schema,
    disposition: Schema.Literals(["released", "abandoned"] as const),
    ownerDigest: RunStoreLockOwnerDigestV3Schema,
    protectedEffectStarted: Schema.Boolean,
    rootDigest: RunStoreRootDigestV1Schema,
    successorEdgeDigest: Schema.optionalKey(
      RunStoreLockSuccessorEdgeDigestV1Schema
    ),
    version: Schema.Literal(1),
  },
  strict
) {}

export class RunStoreLockOwnerEnvelopeV3 extends Schema.Class<RunStoreLockOwnerEnvelopeV3>(
  "RunStoreLockOwnerEnvelopeV3"
)(
  {
    ownerDigest: RunStoreLockOwnerDigestV3Schema,
    payload: RunStoreLockOwnerPayloadV3,
  },
  strict
) {}

export class RunStoreLockAnchorEnvelopeV1 extends Schema.Class<RunStoreLockAnchorEnvelopeV1>(
  "RunStoreLockAnchorEnvelopeV1"
)(
  {
    anchorDigest: RunStoreLockAnchorDigestV1Schema,
    initialOwner: RunStoreLockOwnerEnvelopeV3,
    payload: RunStoreLockAnchorPayloadV1,
  },
  strict
) {}

export class RunStoreLockSuccessorEnvelopeV1 extends Schema.Class<RunStoreLockSuccessorEnvelopeV1>(
  "RunStoreLockSuccessorEnvelopeV1"
)(
  {
    payload: RunStoreLockSuccessorEdgePayloadV1,
    successorEdgeDigest: RunStoreLockSuccessorEdgeDigestV1Schema,
    successorOwner: RunStoreLockOwnerEnvelopeV3,
  },
  strict
) {}

export class RunStoreLockTerminalEnvelopeV1 extends Schema.Class<RunStoreLockTerminalEnvelopeV1>(
  "RunStoreLockTerminalEnvelopeV1"
)(
  {
    payload: RunStoreLockTerminalPayloadV1,
    terminalDigest: RunStoreLockTerminalDigestV1Schema,
  },
  strict
) {}

const parseRootDigest = Schema.decodeUnknownSync(RunStoreRootDigestV1Schema);
const parseOwnerDigest = Schema.decodeUnknownSync(
  RunStoreLockOwnerDigestV3Schema
);
const parseAnchorDigest = Schema.decodeUnknownSync(
  RunStoreLockAnchorDigestV1Schema
);
const parseEdgeDigest = Schema.decodeUnknownSync(
  RunStoreLockSuccessorEdgeDigestV1Schema
);
const parseTerminalDigest = Schema.decodeUnknownSync(
  RunStoreLockTerminalDigestV1Schema
);

function identityDigest(domain: string, encoded: unknown) {
  return createHash("sha256")
    .update(canonicalV1(domain, [encoded]))
    .digest("hex");
}

export const deriveRunStoreRootDigestV1 = (
  input: typeof RunStoreRootIdentityPayloadV1.Type
) =>
  parseRootDigest(
    identityDigest(
      "gaia.run-store-root-identity.v1",
      Schema.encodeSync(RunStoreRootIdentityPayloadV1)(
        Schema.decodeUnknownSync(RunStoreRootIdentityPayloadV1)(input)
      )
    )
  );
export const deriveRunStoreLockOwnerDigestV3 = (
  input: typeof RunStoreLockOwnerPayloadV3.Type
) =>
  parseOwnerDigest(
    identityDigest(
      "gaia.run-store-lock-owner.v3",
      Schema.encodeSync(RunStoreLockOwnerPayloadV3)(
        Schema.decodeUnknownSync(RunStoreLockOwnerPayloadV3)(input)
      )
    )
  );
export const deriveRunStoreLockAnchorDigestV1 = (
  input: typeof RunStoreLockAnchorPayloadV1.Type
) =>
  parseAnchorDigest(
    identityDigest(
      "gaia.run-store-lock-anchor.v1",
      Schema.encodeSync(RunStoreLockAnchorPayloadV1)(
        Schema.decodeUnknownSync(RunStoreLockAnchorPayloadV1)(input)
      )
    )
  );
export const deriveRunStoreLockSuccessorEdgeDigestV1 = (
  input: typeof RunStoreLockSuccessorEdgePayloadV1.Type
) =>
  parseEdgeDigest(
    identityDigest(
      "gaia.run-store-lock-successor-edge.v1",
      Schema.encodeSync(RunStoreLockSuccessorEdgePayloadV1)(
        Schema.decodeUnknownSync(RunStoreLockSuccessorEdgePayloadV1)(input)
      )
    )
  );
export const deriveRunStoreLockTerminalDigestV1 = (
  input: typeof RunStoreLockTerminalPayloadV1.Type
) =>
  parseTerminalDigest(
    identityDigest(
      "gaia.run-store-lock-terminal.v1",
      Schema.encodeSync(RunStoreLockTerminalPayloadV1)(
        Schema.decodeUnknownSync(RunStoreLockTerminalPayloadV1)(input)
      )
    )
  );

const DarwinProcessStartRawSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(128))
);
const decodeDarwinProcessStartRaw = Schema.decodeUnknownSync(
  DarwinProcessStartRawSchema
);
const decodeProcessStartToken = Schema.decodeUnknownSync(
  ProcessStartTokenSchema
);

export function parseDarwinProcessStartToken(rawInput: unknown) {
  const raw = decodeDarwinProcessStartRaw(rawInput);
  if (!raw.isWellFormed() || Buffer.byteLength(raw, "ascii") !== raw.length)
    throw new Error("Process start output must be ASCII.");
  const match =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ 0-9][0-9]) ([0-2][0-9]):([0-5][0-9]):([0-5][0-9]) ([0-9]{4}) {0,8}\n$/u.exec(
      raw
    );
  if (match === null)
    throw new Error("Process start output has invalid grammar.");
  const [
    ,
    weekday,
    monthName,
    dayText,
    hourText,
    minuteText,
    secondText,
    yearText,
  ] = match;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = months.indexOf(monthName!);
  const timestamp = Date.UTC(
    Number(yearText),
    month,
    Number(dayText!.trim()),
    Number(hourText),
    Number(minuteText),
    Number(secondText)
  );
  const date = new Date(timestamp);
  if (
    !Number.isFinite(timestamp) ||
    date.getUTCFullYear() !== Number(yearText) ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== Number(dayText!.trim()) ||
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()] !==
      weekday
  )
    throw new Error("Process start output is not a real UTC calendar instant.");
  return decodeProcessStartToken(
    `ps-start-unix-seconds-v1:${Math.floor(timestamp / 1_000)}`
  );
}

class RunStoreLockContextSchema extends Schema.Class<RunStoreLockContextSchema>(
  "RunStoreLockContext"
)({
  nextSafeAction: Schema.optionalKey(Schema.NonEmptyString),
  operation: Schema.optionalKey(Schema.NonEmptyString),
}) {}

export type RunStoreLockContext = RunStoreLockContextSchema;

type OwnerEnvelope = RunStoreLockOwnerEnvelopeV3;
type AnchorEnvelope = RunStoreLockAnchorEnvelopeV1;
type SuccessorEnvelope = RunStoreLockSuccessorEnvelopeV1;

class RunStoreLockLease {
  protectedEffectStarted = false;
  verified = false;

  constructor(
    readonly anchor: AnchorEnvelope,
    readonly anchorPath: RuntimePath,
    readonly canonicalRoot: RuntimePath,
    readonly edge: SuccessorEnvelope | undefined,
    readonly finalPath: RuntimePath,
    readonly owner: OwnerEnvelope,
    readonly rootDigest: typeof RunStoreRootDigestV1Schema.Type,
    readonly stagePath: RuntimePath
  ) {}
}

const CurrentRunStoreLease = Context.Reference<RunStoreLockLease | undefined>(
  "@gaia/runtime/CurrentRunStoreLease",
  { defaultValue: () => undefined }
);
const textEncoder = new TextEncoder();

function lockError(code: string, message: string, cause?: unknown) {
  return makeRuntimeError({ cause, code, message, recoverable: false });
}

function canonicalBody<A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: A
) {
  const decoded = Schema.decodeUnknownSync(schema)(value);
  return `${JSON.stringify(Schema.encodeSync(schema)(decoded))}\n`;
}

function ownerEnvelope(payload: typeof RunStoreLockOwnerPayloadV3.Type) {
  const decoded = Schema.decodeUnknownSync(RunStoreLockOwnerPayloadV3)(payload);
  return RunStoreLockOwnerEnvelopeV3.make({
    ownerDigest: deriveRunStoreLockOwnerDigestV3(decoded),
    payload: decoded,
  });
}

function anchorEnvelope(
  rootDigest: typeof RunStoreRootDigestV1Schema.Type,
  initialOwner: OwnerEnvelope
) {
  const payload = RunStoreLockAnchorPayloadV1.make({
    initialOwnerDigest: initialOwner.ownerDigest,
    rootDigest,
    version: 1,
  });
  return RunStoreLockAnchorEnvelopeV1.make({
    anchorDigest: deriveRunStoreLockAnchorDigestV1(payload),
    initialOwner,
    payload,
  });
}

function successorEnvelope(
  anchor: AnchorEnvelope,
  predecessor: OwnerEnvelope,
  successorOwner: OwnerEnvelope
) {
  const payload = RunStoreLockSuccessorEdgePayloadV1.make({
    anchorDigest: anchor.anchorDigest,
    predecessorOwnerDigest: predecessor.ownerDigest,
    rootDigest: anchor.payload.rootDigest,
    successorOwnerDigest: successorOwner.ownerDigest,
    version: 1,
  });
  return RunStoreLockSuccessorEnvelopeV1.make({
    payload,
    successorEdgeDigest: deriveRunStoreLockSuccessorEdgeDigestV1(payload),
    successorOwner,
  });
}

function terminalEnvelope(
  lease: RunStoreLockLease,
  disposition: "abandoned" | "released"
) {
  const payload = RunStoreLockTerminalPayloadV1.make({
    anchorDigest: lease.anchor.anchorDigest,
    disposition,
    ownerDigest: lease.owner.ownerDigest,
    protectedEffectStarted: lease.protectedEffectStarted,
    rootDigest: lease.rootDigest,
    ...(lease.edge === undefined
      ? {}
      : { successorEdgeDigest: lease.edge.successorEdgeDigest }),
    version: 1,
  });
  return RunStoreLockTerminalEnvelopeV1.make({
    payload,
    terminalDigest: deriveRunStoreLockTerminalDigestV1(payload),
  });
}

function operationFromContext(input: string | undefined) {
  const value = (input ?? "").toLowerCase();
  if (value.includes("browser")) return "browserEvidence" as const;
  if (value.includes("factory") && value.includes("accept"))
    return "factoryRunAcceptance" as const;
  if (value.includes("server") && value.includes("accept"))
    return "serverRunAcceptance" as const;
  if (value.includes("server") && value.includes("continu"))
    return "serverRunContinuation" as const;
  if (value.includes("startup") || value.includes("reconcil"))
    return "serverStartupReconciliation" as const;
  if (value.includes("agent session")) return "agentSessionAction" as const;
  if (value.includes("remediation")) return "deliveryRemediation" as const;
  if (value.includes("verification")) return "claimVerification" as const;
  if (value.includes("publication")) return "deliveryPublication" as const;
  if (value.includes("ready") && value.includes("review"))
    return "deliveryReadyForReview" as const;
  if (value.includes("attestation"))
    return "deliveryReviewAttestation" as const;
  if (value.includes("cleanup")) return "deliveryCleanup" as const;
  if (value.includes("merge")) return "deliveryMerge" as const;
  if (value.includes("correlation") && value.includes("desktop"))
    return "desktopOriginCorrelation" as const;
  if (value.includes("correlation")) return "workerCorrelation" as const;
  if (value.includes("worker") && value.includes("continu"))
    return "workerContinuation" as const;
  if (value.includes("worker") && value.includes("recover"))
    return "workerRecovery" as const;
  if (value.includes("spec") || value.includes("run command"))
    return "specRun" as const;
  return "genericRunStoreMutation" as const;
}

function nextActionFromContext(input: string | undefined) {
  const value = (input ?? "").toLowerCase();
  if (value.includes("refresh")) return "refreshThenRetry" as const;
  if (value.includes("inspect")) return "inspectThenRetry" as const;
  return "waitThenRetry" as const;
}

function processToken(pid: number) {
  return Effect.tryPromise({
    try: async () => {
      const result = await execFile(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        {
          encoding: "utf8",
          env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
          maxBuffer: 128,
          timeout: 1_000,
        }
      );
      if (result.stderr !== "") throw new Error("Unexpected process output.");
      return parseDarwinProcessStartToken(result.stdout);
    },
    catch: (cause) =>
      lockError(
        "RunStoreLockProcessIdentityUnavailable",
        "Gaia could not establish the bounded process identity required for the run-store lock.",
        cause
      ),
  });
}

function processLiveness(owner: OwnerEnvelope) {
  return Effect.gen(function* () {
    const pid = owner.payload.pid;
    const firstKill = yield* Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return "reachable" as const;
      } catch (cause) {
        return (cause as NodeJS.ErrnoException).code === "ESRCH"
          ? ("dead" as const)
          : ("unknown" as const);
      }
    });
    if (firstKill === "dead") return "provenDead" as const;
    if (firstKill === "unknown") return "unknown" as const;
    const firstProbe = yield* Effect.exit(processToken(pid));
    if (firstProbe._tag === "Failure") return "unknown" as const;
    if (firstProbe.value === owner.payload.processStartToken)
      return "alive" as const;
    const secondKill = yield* Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!secondKill) return "provenDead" as const;
    const secondProbe = yield* Effect.exit(processToken(pid));
    return secondProbe._tag === "Success" &&
      secondProbe.value === firstProbe.value &&
      secondProbe.value !== owner.payload.processStartToken
      ? ("provenDead" as const)
      : ("unknown" as const);
  });
}

function makeOwner(
  rootDigest: typeof RunStoreRootDigestV1Schema.Type,
  context: RunStoreLockContext
) {
  return Effect.gen(function* () {
    const token = yield* processToken(process.pid);
    return ownerEnvelope({
      nextAction: nextActionFromContext(context.nextSafeAction),
      nonce: randomBytes(16).toString("hex"),
      operation: operationFromContext(context.operation),
      pid: process.pid,
      processStartToken: token,
      rootDigest,
      version: 3,
    });
  });
}

function childPath(
  path: Path.Path,
  parent: string,
  ownerDigest: typeof RunStoreLockOwnerDigestV3Schema.Type
) {
  return parseRuntimePath(path.join(parent, `${ownerDigest}.json`));
}

function nodeErrorCode(cause: unknown) {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code)
    : undefined;
}

function lstatNoFollow(filePath: string) {
  return Effect.tryPromise({
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("No-follow stat failed."),
    try: () => nodeLstat(filePath, { bigint: true }),
  });
}

function ensureExactLockChild(
  canonicalRoot: RuntimePath,
  childName: "lock-successors" | "lock-terminals"
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const expected = parseRuntimePath(path.join(canonicalRoot, childName));
    const existing = yield* lstatNoFollow(expected).pipe(
      Effect.map((info) => Option.some(info)),
      Effect.catch((cause) =>
        nodeErrorCode(cause) === "ENOENT"
          ? Effect.succeed(Option.none())
          : Effect.fail(
              lockError(
                "RunStoreLockRootMismatch",
                "A lock child could not be inspected without following links.",
                cause
              )
            )
      )
    );
    if (Option.isNone(existing))
      yield* fs
        .makeDirectory(expected)
        .pipe(
          Effect.mapError((cause) =>
            lockError(
              "RunStoreLockRootMismatch",
              "A lock child could not be created exclusively in the run root.",
              cause
            )
          )
        );
    const info = Option.isSome(existing)
      ? existing.value
      : yield* lstatNoFollow(expected).pipe(
          Effect.mapError((cause) =>
            lockError(
              "RunStoreLockRootMismatch",
              "A created lock child could not be inspected without following links.",
              cause
            )
          )
        );
    const real = yield* fs
      .realPath(expected)
      .pipe(
        Effect.mapError((cause) =>
          lockError(
            "RunStoreLockRootMismatch",
            "A lock child could not be resolved inside the run root.",
            cause
          )
        )
      );
    if (info.isSymbolicLink() || !info.isDirectory() || real !== expected)
      return yield* Effect.fail(
        lockError(
          "RunStoreLockRootMismatch",
          "A lock child was not the exact canonical no-follow directory."
        )
      );
    return expected;
  });
}

function readStrictBody<A>(
  filePath: RuntimePath,
  schema: Schema.Codec<A, unknown, never, never>,
  expected?: A
): Effect.Effect<A, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* lstatNoFollow(filePath).pipe(
      Effect.mapError((cause) =>
        lockError(
          "RunStoreLockIdentityUnavailable",
          "A run-store lock identity could not be inspected safely.",
          cause
        )
      )
    );
    const real = yield* fs.realPath(filePath);
    if (info.isSymbolicLink() || !info.isFile() || real !== filePath)
      return yield* Effect.fail(
        lockError(
          "RunStoreLockIdentityMismatch",
          "A run-store lock identity path was not the expected canonical regular file."
        )
      );
    const body = yield* fs.readFileString(filePath);
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(schema)(JSON.parse(body)),
      catch: (cause) =>
        lockError(
          "RunStoreLockIdentityMismatch",
          "A run-store lock identity body was invalid.",
          cause
        ),
    });
    if (
      body !== canonicalBody(schema, decoded) ||
      (expected !== undefined && body !== canonicalBody(schema, expected))
    )
      return yield* Effect.fail(
        lockError(
          "RunStoreLockIdentityMismatch",
          "A run-store lock identity body was not canonical or did not match its expected identity."
        )
      );
    return decoded;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        lockError(
          "RunStoreLockIdentityUnavailable",
          "A run-store lock identity could not be read safely.",
          cause
        )
      )
    )
  );
}

function verifyOwner(owner: OwnerEnvelope) {
  if (deriveRunStoreLockOwnerDigestV3(owner.payload) !== owner.ownerDigest)
    throw lockError(
      "RunStoreLockIdentityMismatch",
      "A run-store lock owner digest did not authenticate its payload."
    );
}

function verifyAnchor(
  anchor: AnchorEnvelope,
  rootDigest: typeof RunStoreRootDigestV1Schema.Type
) {
  verifyOwner(anchor.initialOwner);
  if (
    anchor.payload.rootDigest !== rootDigest ||
    anchor.payload.initialOwnerDigest !== anchor.initialOwner.ownerDigest ||
    deriveRunStoreLockAnchorDigestV1(anchor.payload) !== anchor.anchorDigest
  )
    throw lockError(
      "RunStoreLockIdentityMismatch",
      "The run-store lock anchor did not authenticate its root and owner."
    );
}

function verifySuccessor(
  edge: SuccessorEnvelope,
  anchor: AnchorEnvelope,
  predecessor: OwnerEnvelope
) {
  verifyOwner(edge.successorOwner);
  if (
    edge.payload.rootDigest !== anchor.payload.rootDigest ||
    edge.payload.anchorDigest !== anchor.anchorDigest ||
    edge.payload.predecessorOwnerDigest !== predecessor.ownerDigest ||
    edge.payload.successorOwnerDigest !== edge.successorOwner.ownerDigest ||
    edge.successorOwner.ownerDigest === predecessor.ownerDigest ||
    deriveRunStoreLockSuccessorEdgeDigestV1(edge.payload) !==
      edge.successorEdgeDigest
  )
    throw lockError(
      "RunStoreLockIdentityMismatch",
      "A run-store lock successor did not authenticate its chain relation."
    );
}

function verifyTerminal(
  terminal: typeof RunStoreLockTerminalEnvelopeV1.Type,
  anchor: AnchorEnvelope,
  owner: OwnerEnvelope,
  edge: SuccessorEnvelope | undefined
) {
  if (
    terminal.payload.rootDigest !== anchor.payload.rootDigest ||
    terminal.payload.anchorDigest !== anchor.anchorDigest ||
    terminal.payload.ownerDigest !== owner.ownerDigest ||
    terminal.payload.successorEdgeDigest !== edge?.successorEdgeDigest ||
    deriveRunStoreLockTerminalDigestV1(terminal.payload) !==
      terminal.terminalDigest
  )
    throw lockError(
      "RunStoreLockIdentityMismatch",
      "A run-store lock terminal did not authenticate its owner and chain."
    );
}

function readChain(input: {
  readonly anchor: AnchorEnvelope;
  readonly path: Path.Path;
  readonly successors: RuntimePath;
  readonly terminals: RuntimePath;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let owner = input.anchor.initialOwner;
    let edge: SuccessorEnvelope | undefined;
    const seen = new Set<string>();
    for (let depth = 0; depth < 8; depth += 1) {
      const currentOwner = owner;
      const currentEdge = edge;
      if (seen.has(currentOwner.ownerDigest))
        return yield* Effect.fail(
          lockError(
            "RunStoreLockChainInvalid",
            "The run-store lock successor chain contains a cycle."
          )
        );
      seen.add(currentOwner.ownerDigest);
      const successorPath = childPath(
        input.path,
        input.successors,
        currentOwner.ownerDigest
      );
      if (!(yield* fs.exists(successorPath))) {
        const terminalPath = childPath(
          input.path,
          input.terminals,
          currentOwner.ownerDigest
        );
        const terminal = (yield* fs.exists(terminalPath))
          ? yield* readStrictBody(terminalPath, RunStoreLockTerminalEnvelopeV1)
          : undefined;
        if (terminal !== undefined)
          yield* Effect.try({
            try: () =>
              verifyTerminal(terminal, input.anchor, currentOwner, currentEdge),
            catch: (cause) => cause as GaiaRuntimeError,
          });
        return { edge: currentEdge, owner: currentOwner, terminal } as const;
      }
      const next = yield* readStrictBody(
        successorPath,
        RunStoreLockSuccessorEnvelopeV1
      );
      yield* Effect.try({
        try: () => verifySuccessor(next, input.anchor, currentOwner),
        catch: (cause) => cause as GaiaRuntimeError,
      });
      edge = next;
      owner = next.successorOwner;
    }
    return yield* Effect.fail(
      lockError(
        "RunStoreLockChainDepthExceeded",
        "The bounded run-store lock successor chain exceeded eight owners."
      )
    );
  });
}

function writeNoReplace(input: {
  readonly body: string;
  readonly finalPath: RuntimePath;
  readonly ownerDigest: typeof RunStoreLockOwnerDigestV3Schema.Type;
  readonly root: RuntimePath;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bodyDigest = createHash("sha256").update(input.body).digest("hex");
    const stagePath = parseRuntimePath(
      path.join(
        input.root,
        `.lock-stage-${input.ownerDigest}-${bodyDigest}.json`
      )
    );
    return yield* Effect.gen(function* () {
      const handle = yield* fs.open(stagePath, { flag: "wx", mode: 0o600 });
      yield* handle.writeAll(textEncoder.encode(input.body));
      yield* handle.sync;
      const info = yield* handle.stat;
      if (info.type !== "File")
        return yield* Effect.fail(
          lockError(
            "RunStoreLockPrepareFailed",
            "The run-store lock staging path was not a regular file."
          )
        );
      yield* fs.link(stagePath, input.finalPath);
      return { info, stagePath } as const;
    }).pipe(
      Effect.onError(() =>
        fs.exists(stagePath).pipe(
          Effect.flatMap((exists) =>
            exists ? fs.remove(stagePath) : Effect.void
          ),
          Effect.ignore
        )
      )
    );
  });
}

function acquireFreshAnchor(input: {
  readonly anchorPath: RuntimePath;
  readonly canonicalRoot: RuntimePath;
  readonly owner: OwnerEnvelope;
  readonly rootDigest: typeof RunStoreRootDigestV1Schema.Type;
}) {
  return Effect.gen(function* () {
    const anchor = anchorEnvelope(input.rootDigest, input.owner);
    const staged = yield* writeNoReplace({
      body: canonicalBody(RunStoreLockAnchorEnvelopeV1, anchor),
      finalPath: input.anchorPath,
      ownerDigest: input.owner.ownerDigest,
      root: input.canonicalRoot,
    }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "RunStoreLocked",
            message: "Another Gaia run-store mutation is already in progress.",
            recoverable: true,
          })
        )
      )
    );
    return new RunStoreLockLease(
      anchor,
      input.anchorPath,
      input.canonicalRoot,
      undefined,
      input.anchorPath,
      input.owner,
      input.rootDigest,
      staged.stagePath
    );
  });
}

function acquireSuccessorLease(input: {
  readonly anchor: AnchorEnvelope;
  readonly anchorPath: RuntimePath;
  readonly canonicalRoot: RuntimePath;
  readonly competitionMessage: string;
  readonly owner: OwnerEnvelope;
  readonly predecessor: OwnerEnvelope;
  readonly rootDigest: typeof RunStoreRootDigestV1Schema.Type;
  readonly successors: RuntimePath;
}) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const edge = successorEnvelope(
      input.anchor,
      input.predecessor,
      input.owner
    );
    yield* ensureExactLockChild(input.canonicalRoot, "lock-successors");
    const finalPath = childPath(
      path,
      input.successors,
      input.predecessor.ownerDigest
    );
    const staged = yield* writeNoReplace({
      body: canonicalBody(RunStoreLockSuccessorEnvelopeV1, edge),
      finalPath,
      ownerDigest: input.owner.ownerDigest,
      root: input.canonicalRoot,
    }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "RunStoreLocked",
            message: input.competitionMessage,
            recoverable: true,
          })
        )
      )
    );
    return new RunStoreLockLease(
      input.anchor,
      input.anchorPath,
      input.canonicalRoot,
      edge,
      finalPath,
      input.owner,
      input.rootDigest,
      staged.stagePath
    );
  });
}

function finishReconciliationElection(lease: RunStoreLockLease) {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* commitTerminalNoReplace(lease, "abandoned");
      if (yield* fs.exists(lease.stagePath)) yield* fs.remove(lease.stagePath);
    }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          lockError(
            "RunStoreLockReleaseFailed",
            "Gaia could not close the terminal-tail reconciliation election.",
            cause
          )
        )
      )
    )
  );
}

function assertReconciliationAnchorIdentity(input: {
  readonly anchor: AnchorEnvelope;
  readonly anchorPath: RuntimePath;
  readonly witnessPath: RuntimePath;
}) {
  return Effect.gen(function* () {
    yield* readStrictBody(
      input.witnessPath,
      RunStoreLockAnchorEnvelopeV1,
      input.anchor
    );
    yield* readStrictBody(
      input.anchorPath,
      RunStoreLockAnchorEnvelopeV1,
      input.anchor
    );
    const [witnessInfo, anchorInfo] = yield* Effect.all([
      lstatNoFollow(input.witnessPath),
      lstatNoFollow(input.anchorPath),
    ]).pipe(
      Effect.mapError((cause) =>
        lockError(
          "RunStoreLockIdentityUnavailable",
          "The terminal-tail reconciliation identity could not be inspected safely.",
          cause
        )
      )
    );
    if (
      witnessInfo.isSymbolicLink() ||
      anchorInfo.isSymbolicLink() ||
      !witnessInfo.isFile() ||
      !anchorInfo.isFile() ||
      witnessInfo.dev !== anchorInfo.dev ||
      witnessInfo.ino !== anchorInfo.ino
    )
      return yield* Effect.fail(
        lockError(
          "RunStoreLockIdentityMismatch",
          "The terminal-tail reconciliation witness did not bind the exact anchor."
        )
      );
  });
}

function reconcileClosedAnchor(input: {
  readonly anchor: AnchorEnvelope;
  readonly anchorPath: RuntimePath;
  readonly canonicalRoot: RuntimePath;
  readonly owner: OwnerEnvelope;
  readonly path: Path.Path;
  readonly predecessor: OwnerEnvelope;
  readonly rootDigest: typeof RunStoreRootDigestV1Schema.Type;
  readonly successors: RuntimePath;
  readonly terminal: typeof RunStoreLockTerminalEnvelopeV1.Type;
  readonly terminals: RuntimePath;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* ensureExactLockChild(
      parseRuntimePath(input.path.dirname(input.terminals)),
      "lock-terminals"
    );
    const witnessPath = parseRuntimePath(
      input.path.join(
        input.terminals,
        `.reconciled-${input.terminal.terminalDigest}.anchor`
      )
    );
    yield* fs.link(input.anchorPath, witnessPath).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        lstatNoFollow(witnessPath).pipe(
          Effect.asVoid,
          Effect.mapError(() =>
            makeRuntimeError({
              cause,
              code: "RunStoreLocked",
              message:
                "Another Gaia contender owns terminal-tail reconciliation.",
              recoverable: true,
            })
          )
        )
      )
    );
    yield* assertReconciliationAnchorIdentity({
      anchor: input.anchor,
      anchorPath: input.anchorPath,
      witnessPath,
    });
    yield* Effect.acquireUseRelease(
      acquireSuccessorLease({
        anchor: input.anchor,
        anchorPath: input.anchorPath,
        canonicalRoot: input.canonicalRoot,
        competitionMessage:
          "Another Gaia contender owns terminal-tail reconciliation.",
        owner: input.owner,
        predecessor: input.predecessor,
        rootDigest: input.rootDigest,
        successors: input.successors,
      }),
      (lease) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* assertRunStoreLease(lease);
            if ((yield* processLiveness(lease.owner)) !== "alive")
              return yield* Effect.fail(
                lockError(
                  "RunStoreLockOwnershipLost",
                  "The elected terminal-tail reconciler is not the exact live owner."
                )
              );
            yield* assertReconciliationAnchorIdentity({
              anchor: input.anchor,
              anchorPath: input.anchorPath,
              witnessPath,
            });
            yield* fs.remove(input.anchorPath);
          })
        ),
      finishReconciliationElection
    );
  });
}

function acquireRunStoreLock(
  options: RunStorageOptions,
  context: RunStoreLockContext
): Effect.Effect<
  RunStoreLockLease,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* makeRunStorePaths(options);
    yield* fs.makeDirectory(store.gaiaRoot, { recursive: true });
    const canonicalRoot = parseRuntimePath(yield* fs.realPath(store.gaiaRoot));
    const canonicalParent = yield* fs.realPath(path.dirname(store.gaiaRoot));
    const expectedRoot = parseRuntimePath(
      path.join(canonicalParent, path.basename(store.gaiaRoot))
    );
    if (
      canonicalRoot !== expectedRoot ||
      (yield* fs.stat(store.gaiaRoot)).type !== "Directory"
    )
      return yield* Effect.fail(
        lockError(
          "RunStoreLockRootMismatch",
          "The run-store lock root was not the expected canonical directory."
        )
      );
    const rootDigest = deriveRunStoreRootDigestV1({
      canonicalRoot,
      version: 1,
    });
    const successors = yield* ensureExactLockChild(
      canonicalRoot,
      "lock-successors"
    );
    const terminals = yield* ensureExactLockChild(
      canonicalRoot,
      "lock-terminals"
    );
    const owner = yield* makeOwner(rootDigest, context);
    const anchorPath = parseRuntimePath(path.join(canonicalRoot, "lock"));
    if (!(yield* fs.exists(anchorPath)))
      return yield* acquireFreshAnchor({
        anchorPath,
        canonicalRoot,
        owner,
        rootDigest,
      });
    const anchor = yield* readStrictBody(
      anchorPath,
      RunStoreLockAnchorEnvelopeV1
    ).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "RunStoreLocked",
          message: [
            `Another Gaia run-store mutation is already in progress${
              context.operation === undefined ? "." : `: ${context.operation}.`
            }`,
            context.nextSafeAction,
          ]
            .filter((value) => value !== undefined)
            .join(" "),
          recoverable: true,
        })
      )
    );
    yield* Effect.try({
      try: () => verifyAnchor(anchor, rootDigest),
      catch: (cause) => cause as GaiaRuntimeError,
    });
    const tail = yield* readChain({ anchor, path, successors, terminals });
    if (tail.terminal !== undefined) {
      yield* reconcileClosedAnchor({
        anchor,
        anchorPath,
        canonicalRoot,
        owner,
        path,
        predecessor: tail.owner,
        rootDigest,
        successors,
        terminal: tail.terminal,
        terminals,
      });
      const freshOwner = yield* makeOwner(rootDigest, context);
      return yield* acquireFreshAnchor({
        anchorPath,
        canonicalRoot,
        owner: freshOwner,
        rootDigest,
      });
    }
    const liveness = yield* processLiveness(tail.owner);
    if (liveness !== "provenDead")
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunStoreLocked",
          message:
            "Another Gaia run-store mutation owns this exact run store; its liveness is not proven dead.",
          recoverable: true,
        })
      );
    return yield* acquireSuccessorLease({
      anchor,
      anchorPath,
      canonicalRoot,
      competitionMessage:
        "Another Gaia contender won the immutable run-store lock successor election.",
      owner,
      predecessor: tail.owner,
      rootDigest,
      successors,
    });
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        lockError(
          "RunStoreLockPrepareFailed",
          "Gaia could not prepare the exact run-store ownership witness.",
          cause
        )
      )
    )
  );
}

function assertRunStoreLease(lease: RunStoreLockLease) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const anchor = yield* readStrictBody(
      lease.anchorPath,
      RunStoreLockAnchorEnvelopeV1,
      lease.anchor
    );
    yield* Effect.try({
      try: () => verifyAnchor(anchor, lease.rootDigest),
      catch: (cause) => cause as GaiaRuntimeError,
    });
    yield* readStrictBody(
      lease.finalPath,
      lease.edge === undefined
        ? RunStoreLockAnchorEnvelopeV1
        : RunStoreLockSuccessorEnvelopeV1,
      lease.edge ?? lease.anchor
    );
    const stageInfo = yield* fs.stat(lease.stagePath);
    const finalInfo = yield* fs.stat(lease.finalPath);
    if (
      stageInfo.type !== "File" ||
      finalInfo.type !== "File" ||
      stageInfo.dev !== finalInfo.dev ||
      (Option.isSome(stageInfo.ino) &&
        Option.isSome(finalInfo.ino) &&
        stageInfo.ino.value !== finalInfo.ino.value)
    )
      return yield* Effect.fail(
        lockError(
          "RunStoreLockOwnershipLost",
          "The run-store lock no longer matches its exact staged ownership witness."
        )
      );
    const path = yield* Path.Path;
    const chain = yield* readChain({
      anchor,
      path,
      successors: parseRuntimePath(
        path.join(lease.canonicalRoot, "lock-successors")
      ),
      terminals: parseRuntimePath(
        path.join(lease.canonicalRoot, "lock-terminals")
      ),
    });
    if (
      chain.owner.ownerDigest !== lease.owner.ownerDigest ||
      chain.terminal !== undefined
    )
      return yield* Effect.fail(
        lockError(
          "RunStoreLockOwnershipLost",
          "The run-store lock owner is no longer the unique undisposed terminal tail."
        )
      );
    lease.verified = true;
  });
}

function commitTerminalNoReplace(
  lease: RunStoreLockLease,
  disposition: "abandoned" | "released"
) {
  if (lease.edge === undefined) return Effect.void;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const terminals = parseRuntimePath(
      path.join(lease.canonicalRoot, "lock-terminals")
    );
    yield* ensureExactLockChild(lease.canonicalRoot, "lock-terminals");
    const finalPath = childPath(path, terminals, lease.owner.ownerDigest);
    const terminal = terminalEnvelope(lease, disposition);
    const body = canonicalBody(RunStoreLockTerminalEnvelopeV1, terminal);
    if (yield* fs.exists(finalPath)) {
      yield* readStrictBody(
        finalPath,
        RunStoreLockTerminalEnvelopeV1,
        terminal
      );
      return;
    }
    const staged = yield* writeNoReplace({
      body,
      finalPath,
      ownerDigest: lease.owner.ownerDigest,
      root: lease.canonicalRoot,
    });
    yield* readStrictBody(finalPath, RunStoreLockTerminalEnvelopeV1, terminal);
    if (yield* fs.exists(staged.stagePath)) yield* fs.remove(staged.stagePath);
  });
}

function finalizeRunStoreLock(lease: RunStoreLockLease) {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (lease.edge !== undefined) {
        yield* commitTerminalNoReplace(
          lease,
          lease.protectedEffectStarted ? "released" : "abandoned"
        );
      }
      yield* readStrictBody(
        lease.anchorPath,
        RunStoreLockAnchorEnvelopeV1,
        lease.anchor
      );
      yield* fs.remove(lease.anchorPath);
      if (yield* fs.exists(lease.stagePath)) yield* fs.remove(lease.stagePath);
    }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          lockError(
            "RunStoreLockReleaseFailed",
            "Gaia could not safely release the exact run-store lock.",
            cause
          )
        )
      )
    )
  );
}

function assertNestedRunStoreLeaseRoot(
  lease: RunStoreLockLease,
  options: RunStorageOptions
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeRunStorePaths(options);
    const requested = yield* fs
      .realPath(store.gaiaRoot)
      .pipe(
        Effect.mapError((cause) =>
          lockError(
            "RunStoreLockOwnershipLost",
            "The nested run-store operation does not share the exact owned root.",
            cause
          )
        )
      );
    if (requested !== lease.canonicalRoot)
      return yield* Effect.fail(
        lockError(
          "RunStoreLockOwnershipLost",
          "The nested run-store operation does not share the exact owned root."
        )
      );
  });
}

/** Run an effect while holding the local Gaia run-store mutation lock. */
export function withRunStoreLock<A, E, R>(
  options: RunStorageOptions,
  effect: Effect.Effect<A, E, R>,
  context: RunStoreLockContext = {}
): Effect.Effect<
  A,
  E | GaiaRuntimeError,
  R | FileSystem.FileSystem | Path.Path
> {
  return Effect.flatMap(CurrentRunStoreLease, (existing) => {
    if (existing !== undefined)
      return assertNestedRunStoreLeaseRoot(existing, options).pipe(
        Effect.andThen(assertRunStoreLease(existing)),
        Effect.andThen(effect)
      );
    return Effect.scoped(
      Effect.acquireUseRelease(
        acquireRunStoreLock(options, context),
        (lease) =>
          assertRunStoreLease(lease).pipe(
            Effect.andThen(
              Effect.sync(() => {
                lease.protectedEffectStarted = true;
              })
            ),
            Effect.andThen(
              Effect.provideService(effect, CurrentRunStoreLease, lease)
            )
          ),
        finalizeRunStoreLock
      )
    );
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        lockError(
          "RunStoreLockFailed",
          "Gaia could not verify or release the exact run-store ownership witness.",
          cause
        )
      )
    )
  );
}
