import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  DeliveryAcceptanceProvenancePolicyV1,
  parseDeliveryProvenance,
  resolveDeliveryProvenance,
  type GitDeliveryCommandInput,
} from "./git-delivery.js";

const root = "/tmp/gaia-93-provenance-policy";
const oid = "a".repeat(40);

describe("delivery acceptance provenance policy", () => {
  it("accepts the canonical default owned branch when a run ID ends in a hyphen", () => {
    const parsed = parseDeliveryProvenance({
      baseBranch: "main",
      baseRevision: "e".repeat(40),
      headBranch: "gaia/run-9oVhWWBlV-",
      mode: "pullRequest",
      remote: "origin",
    });

    expect(parsed._tag).toBe("Some");
  });

  it("resolves an explicit literal remote base and head with exact argv", async () => {
    const commands: GitDeliveryCommandInput[] = [];
    const policy = DeliveryAcceptanceProvenancePolicyV1.make({
      baseBranch: "gaia-93-smoke-base-abc123",
      headBranch: "gaia/gaia-93-smoke-head-abc123",
      remote: "origin",
      version: 1,
    });
    const result = await Effect.runPromise(resolveDeliveryProvenance("run-1234567890", {
      commandRunner: recording(commands),
      rootDirectory: root,
    }, policy));

    expect(result).toEqual({ baseBranch: policy.baseBranch, baseRevision: oid, headBranch: policy.headBranch, mode: "pullRequest", remote: policy.remote });
    expect(commands.map(({ args }) => args)).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["check-ref-format", "--branch", policy.baseBranch],
      ["check-ref-format", "--branch", policy.headBranch],
      ["remote", "get-url", "--", policy.remote],
      ["fetch", "--no-tags", policy.remote, `refs/heads/${policy.baseBranch}:refs/remotes/${policy.remote}/${policy.baseBranch}`],
      ["rev-parse", "--verify", `refs/remotes/${policy.remote}/${policy.baseBranch}^{commit}`],
    ]);
  });

  it("preserves the exact default resolver behavior", async () => {
    const commands: GitDeliveryCommandInput[] = [];
    const result = await Effect.runPromise(resolveDeliveryProvenance("run-1234567890", { commandRunner: recording(commands), rootDirectory: root }));

    expect(result).toEqual({ baseBranch: "main", baseRevision: oid, headBranch: "gaia/run-1234567890", mode: "pullRequest", remote: "origin" });
    expect(commands.map(({ args }) => args)).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["fetch", "origin", "main"],
      ["rev-parse", "origin/main"],
    ]);
  });

  for (const input of [
    { baseBranch: "main", headBranch: "gaia/head", remote: "--upload-pack=bad", version: 1 },
    { baseBranch: "main^{commit}", headBranch: "gaia/head", remote: "origin", version: 1 },
    { baseBranch: "main", headBranch: "refs/heads/injected", remote: "origin", version: 1 },
    { baseBranch: "main", headBranch: "gaia/head", remote: "../repo", version: 1 },
    { baseBranch: "main", headBranch: "gaia/head", remote: "https://github.com/cill-i-am/gaia", version: 1 },
    { baseBranch: "main", headBranch: "gaia/head", remote: "git@github.com:cill-i-am/gaia", version: 1 },
    { baseBranch: "main", headBranch: "gaia/head", remote: "origin:evil", version: 1 },
    { baseBranch: "main", headBranch: "gaia/head", remote: "origin", unexpected: true, version: 1 },
    { baseBranch: "main", headBranch: "main", remote: "origin", version: 1 },
    { baseBranch: "main", headBranch: "feature/unrelated", remote: "origin", version: 1 },
    { baseBranch: "main", headBranch: "gaia", remote: "origin", version: 1 },
    { baseBranch: 42, headBranch: "gaia/head", remote: "origin", version: 1 },
    { baseBranch: "main", headBranch: false, remote: "origin", version: 1 },
    { baseBranch: "main", headBranch: "gaia/head", remote: ["origin"], version: 1 },
  ]) {
    it(`rejects hostile acceptance policy ${JSON.stringify(input)}`, async () => {
      const commands: GitDeliveryCommandInput[] = [];
      await expect(Effect.runPromise(resolveDeliveryProvenance("run-1234567890", { commandRunner: recording(commands), rootDirectory: root }, input))).rejects.toBeTruthy();
      expect(commands).toEqual([]);
    });
  }


  it("rejects a same-branch topology before ref validation or fetch", async () => {
    const commands: GitDeliveryCommandInput[] = [];
    const policy = { baseBranch: "gaia/same", headBranch: "gaia/same", remote: "origin", version: 1 };
    await expect(Effect.runPromise(resolveDeliveryProvenance("run-1234567890", { commandRunner: recording(commands), rootDirectory: root }, policy))).rejects.toMatchObject({ code: "DeliveryProvenanceTopologyInvalid" });
    expect(commands).toEqual([]);
  });
});

function recording(commands: GitDeliveryCommandInput[]) {
  return (command: GitDeliveryCommandInput) => Effect.sync(() => {
    commands.push(command);
    if (command.args[0] === "rev-parse" && (command.args[1] === "origin/main" || command.args[1] === "--verify")) return { stderr: "", stdout: `${oid}\n` };
    return { stderr: "", stdout: command.args[0] === "remote" ? "https://github.com/cill-i-am/gaia.git\n" : `${root}\n` };
  });
}
