import { describe, expect, it } from "vitest";
import { Effect, Fiber } from "effect";
import { makeCodexAppServerClient, makeCodexAppServerConnection, type CodexAppServerProcess } from "./codex-app-server-client.js";

function fakeProcess() {
  const lines = new Set<(line: string) => void>();
  const exits = new Set<(code: number | null) => void>();
  const errors = new Set<() => void>();
  const writes: Array<Record<string, unknown>> = [];
  let kills = 0;
  const process: CodexAppServerProcess = {
    kill: () => { kills += 1; },
    onError: (listener) => { errors.add(listener); return () => errors.delete(listener); },
    onExit: (listener) => { exits.add(listener); return () => exits.delete(listener); },
    onLine: (listener) => { lines.add(listener); return () => lines.delete(listener); },
    stderr: () => "bounded stderr",
    write: (line) => writes.push(JSON.parse(line)),
  };
  return { errors, exits, kills: () => kills, lines, process, writes };
}

describe("Codex App Server connection", () => {
  it("correlates out-of-order responses and ignores duplicate or late responses", async () => {
    const fake = fakeProcess();
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const connection = yield* makeCodexAppServerConnection({ process: fake.process });
      const first = yield* connection.request("first").pipe(Effect.forkChild);
      const second = yield* connection.request("second").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      for (const listener of fake.lines) listener(JSON.stringify({ id: 2, result: { value: "second" } }));
      for (const listener of fake.lines) listener(JSON.stringify({ id: 1, result: { value: "first" } }));
      for (const listener of fake.lines) listener(JSON.stringify({ id: 1, result: { value: "late" } }));
      return [yield* Fiber.join(first), yield* Fiber.join(second)] as const;
    })));
    expect(result).toEqual([{ value: "first" }, { value: "second" }]);
  });

  it("routes curated notifications and fails closed on unknown server requests", async () => {
    const fake = fakeProcess();
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const connection = yield* makeCodexAppServerConnection({ process: fake.process });
      const notifications: Array<string> = [];
      connection.onNotification(({ method }) => notifications.push(method));
      for (const listener of fake.lines) listener(JSON.stringify({ method: "turn/started", params: { threadId: "thr-1", turn: { id: "turn-1", status: "inProgress" } } }));
      for (const listener of fake.lines) listener(JSON.stringify({ method: "reasoning/text/delta", params: {} }));
      for (const listener of fake.lines) listener(JSON.stringify({ id: 40, method: "fs/read", params: {} }));
      expect(notifications).toEqual(["turn/started"]);
      expect(fake.writes.at(-1)).toEqual({ id: 40, error: { code: -32601, message: "Unsupported server request" } });
    })));
  });

  it("performs initialize followed by initialized and releases the process", async () => {
    const fake = fakeProcess();
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const connection = yield* makeCodexAppServerConnection({ process: fake.process });
      const client = makeCodexAppServerClient(connection);
      const fiber = yield* client.initialize({ name: "gaia", title: "Gaia", version: "0.1.0" }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      for (const listener of fake.lines) listener(JSON.stringify({ id: 1, result: { userAgent: "Codex Desktop/0.137.0 (test)", platformFamily: "unix", platformOs: "macos" } }));
      yield* Fiber.join(fiber);
      expect(fake.writes.map(({ method }) => method)).toEqual(["initialize", "initialized"]);
    })));
    expect(fake.kills()).toBe(1);
  });

  it("fails every pending request exactly once when the process exits", async () => {
    const fake = fakeProcess();
    const tags = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const connection = yield* makeCodexAppServerConnection({ process: fake.process });
      const first = yield* connection.request("first").pipe(Effect.exit, Effect.forkChild);
      const second = yield* connection.request("second").pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      for (const listener of fake.exits) listener(17);
      for (const listener of fake.exits) listener(18);
      return [(yield* Fiber.join(first))._tag, (yield* Fiber.join(second))._tag];
    })));
    expect(tags).toEqual(["Failure", "Failure"]);
  });

  it("returns a typed timeout and ignores its late response", async () => {
    const fake = fakeProcess();
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const connection = yield* makeCodexAppServerConnection({ process: fake.process });
      return yield* connection.request("slow", {}, 1).pipe(Effect.exit);
    })));
    expect(exit._tag).toBe("Failure");
  });

  it("maps process startup errors into the typed transport channel", async () => {
    const fake = fakeProcess();
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const connection = yield* makeCodexAppServerConnection({ process: fake.process });
      const request = yield* connection.request("initialize").pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      for (const listener of fake.errors) listener();
      return yield* Fiber.join(request);
    })));
    expect(exit._tag).toBe("Failure");
  });

  it("rejects an incompatible initialized server", async () => {
    const fake = fakeProcess();
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const connection = yield* makeCodexAppServerConnection({ process: fake.process });
      const client = makeCodexAppServerClient(connection);
      const fiber = yield* client.initialize({ name: "gaia", title: "Gaia", version: "0.1.0" }).pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      for (const listener of fake.lines) listener(JSON.stringify({ id: 1, result: { userAgent: "Codex Desktop/0.136.0 (test)", platformFamily: "unix", platformOs: "macos" } }));
      return yield* Fiber.join(fiber);
    })));
    expect(exit._tag).toBe("Failure");
  });

  it("returns a typed failure immediately when request write throws", async () => {
    const fake = fakeProcess();
    Object.defineProperty(fake.process, "write", { value: () => { throw new Error("closed"); } });
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const connection = yield* makeCodexAppServerConnection({ process: fake.process });
      return yield* connection.request("initialize", {}, 10_000).pipe(Effect.exit);
    })));
    expect(exit._tag).toBe("Failure");
  });
});
