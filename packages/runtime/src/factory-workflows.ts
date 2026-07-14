import {
  FactoryAgentIdSchema,
  FactoryWorkItemIdSchema,
  IssueDeliveryWorkflowDefinition,
  type FactoryAgentRole,
  type FactoryAgentId,
  type FactoryWorkItemId,
} from "@gaia/core";
import { Schema } from "effect";

const decodeFactoryAgentId = Schema.decodeUnknownSync(FactoryAgentIdSchema);
const decodeFactoryWorkItemId = Schema.decodeUnknownSync(
  FactoryWorkItemIdSchema
);

export const issueDeliveryAgentIds = {
  ciWatcher: decodeFactoryAgentId("agent-ci-watcher"),
  orchestrator: decodeFactoryAgentId("agent-orchestrator"),
  reviewer: decodeFactoryAgentId("agent-reviewer"),
  tester: decodeFactoryAgentId("agent-tester"),
  worker: decodeFactoryAgentId("agent-worker"),
} as const satisfies Record<
  Extract<
    FactoryAgentRole,
    "ciWatcher" | "orchestrator" | "reviewer" | "tester" | "worker"
  >,
  FactoryAgentId
>;

export const issueDeliveryRootWorkItemId: FactoryWorkItemId =
  decodeFactoryWorkItemId("work-item-root");

export const issueDeliveryAgentParentIds = {
  ciWatcher: issueDeliveryAgentIds.tester,
  orchestrator: undefined,
  reviewer: issueDeliveryAgentIds.worker,
  tester: issueDeliveryAgentIds.reviewer,
  worker: issueDeliveryAgentIds.orchestrator,
} as const;

export const issueDeliveryWorkflow = IssueDeliveryWorkflowDefinition;
