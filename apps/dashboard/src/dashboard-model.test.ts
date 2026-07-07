import { describe, expect, it } from "vitest";

import {
  dashboardRuns,
  getInitialNode,
  getInitialRun,
} from "./dashboard-model";

describe("dashboard shell model", () => {
  it("keeps the foundation shell centered on a selected run and node", () => {
    const run = getInitialRun();
    const node = getInitialNode(run);

    expect(run.title).toContain("dashboard shell");
    expect(node.role).toBe("orchestrator");
    expect(run.nodes.length).toBeGreaterThanOrEqual(4);
    expect(run.edges.map((edge) => edge.source)).toContain(node.id);
  });

  it("does not model live API state in the GAIA-38 placeholders", () => {
    expect(dashboardRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "run_gaia_39",
          status: "blocked",
        }),
      ]),
    );
  });
});
