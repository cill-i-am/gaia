import type {
  LocalRunArtifact,
  LocalRunDetail,
  LocalRunEvents,
  LocalRunList,
  LocalRunReadDiagnostic,
} from "@gaia/runtime";
import {
  listLocalRuns,
  readLocalRun,
  readLocalRunArtifact,
  readLocalRunEvents,
} from "@gaia/runtime";
import { Cause, Effect, FileSystem, Path } from "effect";

export type LocalRunApiOptions = {
  readonly rootDirectory?: string;
};

export type LocalRunApiSuccess<T> = {
  readonly data: T;
  readonly status: "success";
};

export type LocalRunApiPartial<T> = {
  readonly data: T;
  readonly diagnostics: ReadonlyArray<LocalRunReadDiagnostic>;
  readonly status: "partial";
};

export type LocalRunApiError = {
  readonly error: LocalRunReadDiagnostic | MethodNotAllowedDiagnostic | NotFoundDiagnostic;
  readonly status: "error";
};

export type MethodNotAllowedDiagnostic = {
  readonly code: "MethodNotAllowed";
  readonly message: string;
  readonly recoverable: false;
};

export type NotFoundDiagnostic = {
  readonly code: "EndpointNotFound";
  readonly message: string;
  readonly recoverable: false;
};

export type LocalRunApiEnvelope<T> =
  | LocalRunApiError
  | LocalRunApiPartial<T>
  | LocalRunApiSuccess<T>;

export function handleLocalRunApiRequest(
  request: Request,
  options: LocalRunApiOptions = {},
): Effect.Effect<
  globalThis.Response,
  unknown,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const url = new URL(request.url);
    const route = parseRoute(url.pathname);

    if (request.method !== "GET") {
      return jsonResponse(
        {
          error: {
            code: "MethodNotAllowed",
            message: "Local Gaia API is read-only.",
            recoverable: false,
          },
          status: "error",
        } satisfies LocalRunApiError,
        405,
      );
    }

    if (route._tag === "ListRuns") {
      const runs = yield* listLocalRuns(options);
      const status = runs.diagnostics.length === 0 ? "success" : "partial";
      if (status === "success") {
        return jsonResponse({
          data: runs,
          status,
        } satisfies LocalRunApiSuccess<LocalRunList>);
      }

      return jsonResponse({
        data: runs,
        diagnostics: runs.diagnostics,
        status,
      } satisfies LocalRunApiPartial<LocalRunList>);
    }

    if (route._tag === "ReadRun") {
      const exit = yield* Effect.exit(readLocalRun(route.runId, options));
      if (exit._tag === "Success") {
        return jsonResponse({
          data: exit.value,
          status: "success",
        } satisfies LocalRunApiSuccess<LocalRunDetail>);
      }

      return diagnosticResponse(exit.cause, 422);
    }

    if (route._tag === "ReadEvents") {
      const exit = yield* Effect.exit(readLocalRunEvents(route.runId, options));
      if (exit._tag === "Success") {
        return jsonResponse({
          data: exit.value,
          status: "success",
        } satisfies LocalRunApiSuccess<LocalRunEvents>);
      }

      return diagnosticResponse(exit.cause, 422);
    }

    if (route._tag === "ReadArtifact") {
      const exit = yield* Effect.exit(
        readLocalRunArtifact(route.runId, route.artifactName, options),
      );
      if (exit._tag === "Success") {
        return jsonResponse({
          data: exit.value,
          status: "success",
        } satisfies LocalRunApiSuccess<LocalRunArtifact>);
      }

      return diagnosticResponse(exit.cause, 404);
    }

    return jsonResponse(
      {
        error: {
          code: "EndpointNotFound",
          message: "Endpoint does not exist.",
          recoverable: false,
        },
        status: "error",
      } satisfies LocalRunApiError,
      404,
    );
  });
}

type Route =
  | { readonly _tag: "ListRuns" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "ReadArtifact"; readonly artifactName: string; readonly runId: string }
  | { readonly _tag: "ReadEvents"; readonly runId: string }
  | { readonly _tag: "ReadRun"; readonly runId: string };

function parseRoute(pathname: string): Route {
  const segments = decodePathSegments(pathname);
  if (segments === undefined) {
    return { _tag: "NotFound" };
  }

  if (segments.length === 1 && segments[0] === "runs") {
    return { _tag: "ListRuns" };
  }

  if (segments.length === 2 && segments[0] === "runs") {
    const runId = segments[1];
    if (runId !== undefined) {
      return { _tag: "ReadRun", runId };
    }
  }

  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "events") {
    const runId = segments[1];
    if (runId !== undefined) {
      return { _tag: "ReadEvents", runId };
    }
  }

  if (segments.length === 4 && segments[0] === "runs" && segments[2] === "artifacts") {
    const runId = segments[1];
    const artifactName = segments[3];
    if (runId !== undefined && artifactName !== undefined) {
      return { _tag: "ReadArtifact", artifactName, runId };
    }
  }

  return { _tag: "NotFound" };
}

function decodePathSegments(pathname: string): ReadonlyArray<string> | undefined {
  const segments: Array<string> = [];
  for (const segment of pathname.split("/")) {
    if (segment.length === 0) {
      continue;
    }

    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }

  return segments;
}

function diagnosticResponse(cause: unknown, fallbackStatus: number) {
  const diagnostic = causeToDiagnostic(cause);
  return jsonResponse(
    {
      error: diagnostic,
      status: "error",
    } satisfies LocalRunApiError,
    diagnosticStatus(diagnostic, fallbackStatus),
  );
}

function causeToDiagnostic(cause: unknown): LocalRunReadDiagnostic {
  if (Cause.isCause(cause)) {
    for (const reason of cause.reasons) {
      if (Cause.isFailReason(reason) && isDiagnostic(reason.error)) {
        return reason.error;
      }
    }
  }

  return {
    code: "RunUnreadable",
    message: "Run could not be read from events.jsonl.",
    recoverable: false,
  };
}

function isDiagnostic(input: unknown): input is LocalRunReadDiagnostic {
  return (
    typeof input === "object" &&
    input !== null &&
    "code" in input &&
    "message" in input &&
    "recoverable" in input
  );
}

function diagnosticStatus(
  diagnostic: LocalRunReadDiagnostic,
  fallbackStatus: number,
): number {
  if (diagnostic.code === "InvalidRunId") {
    return 400;
  }

  if (
    diagnostic.code === "ArtifactNotAllowed" ||
    diagnostic.code === "ArtifactNotFound" ||
    diagnostic.code === "RunNotFound"
  ) {
    return 404;
  }

  return fallbackStatus;
}

function jsonResponse(body: LocalRunApiEnvelope<unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });
}
