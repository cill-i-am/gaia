export type RunStatus = "running" | "reviewing" | "blocked" | "complete";

export type EvidenceTab = "summary" | "events" | "artifacts" | "raw";

export type DashboardEvent = {
  readonly id: string;
  readonly time: string;
  readonly label: string;
  readonly tone: RunStatus;
};

export type RunNode = {
  readonly id: string;
  readonly label: string;
  readonly role: "orchestrator" | "worker" | "reviewer" | "spec" | "artifact";
  readonly status: RunStatus;
  readonly summary: string;
  readonly evidence: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<string>;
  readonly position: {
    readonly x: number;
    readonly y: number;
  };
};

export type RunEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label: string;
};

export type DashboardRun = {
  readonly id: string;
  readonly title: string;
  readonly status: RunStatus;
  readonly branch: string;
  readonly updatedAt: string;
  readonly nodes: ReadonlyArray<RunNode>;
  readonly edges: ReadonlyArray<RunEdge>;
  readonly events: ReadonlyArray<DashboardEvent>;
};

export const dashboardRuns = [
  {
    id: "run_gaia_38",
    title: "GAIA-38 dashboard shell",
    status: "running",
    branch: "codex/gaia-38-dashboard-scaffold",
    updatedAt: "11:56",
    nodes: [
      {
        id: "orchestrator",
        label: "Orchestrator dispatch",
        role: "orchestrator",
        status: "complete",
        summary:
          "Scope is pinned to the foundation shell and Browser evidence.",
        evidence: ["Linear issue refreshed", "PRD read", "Worker plan posted"],
        artifacts: ["dispatch-comment.md"],
        position: { x: 0, y: 120 },
      },
      {
        id: "worker",
        label: "Worker thread",
        role: "worker",
        status: "running",
        summary: "Builds the TanStack Start app and static shell.",
        evidence: [
          "pnpm check baseline",
          "shadcn initialized",
          "TanStack docs checked",
        ],
        artifacts: ["apps/dashboard", "components.json"],
        position: { x: 340, y: 40 },
      },
      {
        id: "reviewer",
        label: "Reviewer/spec lane",
        role: "reviewer",
        status: "reviewing",
        summary:
          "Waits for plan and PR evidence before final read-only review.",
        evidence: ["Scope reminders available", "Reviewer worktree assigned"],
        artifacts: ["review-thread"],
        position: { x: 340, y: 230 },
      },
      {
        id: "browser",
        label: "Browser evidence",
        role: "artifact",
        status: "blocked",
        summary: "Pending local dev server and screenshot capture.",
        evidence: ["Desktop screenshot required", "Interaction smoke required"],
        artifacts: ["browser-screenshot.png"],
        position: { x: 690, y: 138 },
      },
    ],
    edges: [
      {
        id: "orchestrator-worker",
        source: "orchestrator",
        target: "worker",
        label: "dispatches",
      },
      {
        id: "orchestrator-reviewer",
        source: "orchestrator",
        target: "reviewer",
        label: "pairs",
      },
      {
        id: "worker-browser",
        source: "worker",
        target: "browser",
        label: "proves",
      },
      {
        id: "reviewer-browser",
        source: "reviewer",
        target: "browser",
        label: "checks",
      },
    ],
    events: [
      {
        id: "evt-1",
        time: "11:55",
        label: "Issue and PRD refreshed from Linear",
        tone: "complete",
      },
      {
        id: "evt-2",
        time: "11:56",
        label: "Baseline pnpm check passed",
        tone: "complete",
      },
      {
        id: "evt-3",
        time: "11:58",
        label: "Dashboard package scaffold in progress",
        tone: "running",
      },
    ],
  },
  {
    id: "run_gaia_39",
    title: "GAIA-39 API wiring",
    status: "blocked",
    branch: "future",
    updatedAt: "next",
    nodes: [
      {
        id: "api-client",
        label: "Effect Query client",
        role: "spec",
        status: "blocked",
        summary:
          "Future slice owns typed local-server calls and run projections.",
        evidence: ["Not part of GAIA-38"],
        artifacts: ["follow-up-scope"],
        position: { x: 120, y: 120 },
      },
    ],
    edges: [],
    events: [
      {
        id: "evt-4",
        time: "next",
        label: "Waiting for dashboard foundation PR",
        tone: "blocked",
      },
    ],
  },
] as const satisfies ReadonlyArray<DashboardRun>;

export function getInitialRun(): DashboardRun {
  return dashboardRuns[0];
}

export function getInitialNode(run: DashboardRun): RunNode {
  const node = run.nodes[0];

  if (node === undefined) {
    throw new Error(`Dashboard run ${run.id} has no nodes.`);
  }

  return node;
}
