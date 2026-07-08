import {
  IssueDeliveryWorkflowDefinition,
  type FactoryAgentRole,
} from "@gaia/core";

export const issueDeliveryAgentIds = {
  ciWatcher: "agent-ci-watcher",
  orchestrator: "agent-orchestrator",
  reviewer: "agent-reviewer",
  tester: "agent-tester",
  worker: "agent-worker",
} as const satisfies Record<
  Extract<
    FactoryAgentRole,
    "ciWatcher" | "orchestrator" | "reviewer" | "tester" | "worker"
  >,
  string
>;

export const issueDeliveryRootWorkItemId = "work-item-root";

export const issueDeliveryAgentParentIds = {
  ciWatcher: issueDeliveryAgentIds.tester,
  orchestrator: undefined,
  reviewer: issueDeliveryAgentIds.worker,
  tester: issueDeliveryAgentIds.reviewer,
  worker: issueDeliveryAgentIds.orchestrator,
} as const;

export const issueDeliveryWorkflow = IssueDeliveryWorkflowDefinition;
