import {
  HarnessCapabilities,
  HarnessProviderDescriptor,
  ResolvedHarnessExecution,
  codexAppServerHarnessProfileId,
  parseHarnessProviderId,
} from "@gaia/core";

export const testFactoryExecution = ResolvedHarnessExecution.make({
  capabilities: HarnessCapabilities.make({
    approvals: [],
    fileChangeEvents: true,
    interruption: true,
    resumableSessions: true,
    review: false,
    steering: false,
    streamingMessages: true,
    structuredOutput: false,
    subagents: false,
    toolEvents: false,
    usageReporting: false,
    userQuestions: false,
  }),
  executionMode: "local",
  harnessProfileId: codexAppServerHarnessProfileId,
  provider: HarnessProviderDescriptor.make({
    displayName: "Synthetic Harness",
    executionModes: ["local"],
    providerId: parseHarnessProviderId("synthetic"),
  }),
  version: "synthetic-1",
});
