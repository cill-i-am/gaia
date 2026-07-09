import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  type FactoryActivityDto,
  type FactoryArtifactBodyDto,
  type FactoryArtifactDto,
  RunEvent,
} from "@gaia/core";
import { Option, Schema } from "effect";
import {
  ActivityIcon,
  AlertCircleIcon,
  BoxIcon,
  BracesIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDotIcon,
  GitCompareArrowsIcon,
  HelpCircleIcon,
  InspectIcon,
  LoaderCircleIcon,
  type LucideIcon,
  PlayIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";

import {
  type DashboardRun,
  type EvidenceTab,
  type RunReplayState,
  type RunStatus,
  buildRunCanvasModel,
  buildRunReplayState,
  eventTypeLabel,
  isTerminalRunEvent,
  mergeRunEvents,
  stateLabel,
} from "@/run-canvas-model";
import {
  buildFactoryCanvasModel,
  type FactoryCanvasModel,
  type FactoryCanvasNode,
} from "@/factory-canvas-model";
import {
  buildSelectedNodeInspectorModel,
  type InspectorNotice,
  type InspectorResource,
  type SelectedNodeInspectorModel,
} from "@/selected-node-inspector-model";
import {
  factoryAgentRoleVisual,
  factoryAgentStateBadgeVariant,
  factoryAgentStateLabel,
} from "@/factory-agent-visuals";
import {
  buildRunCompareModel,
  type RunCompareModel,
  type RunCompareSignal,
} from "@/run-compare-model";
import { defaultLocalGaiaServerUrl } from "@/lib/local-gaia-client";
import {
  localGaiaFactoryAgentActivityQueryOptions,
  localGaiaFactoryArtifactQueryOptions,
  localGaiaFactoryArtifactsQueryOptions,
  localGaiaFactoryGraphQueryOptions,
  localGaiaFactoryRunActivityQueryOptions,
  localGaiaCreateRunMutationOptions,
  localGaiaHealthQueryOptions,
  localGaiaRunEventsQueryOptions,
  localGaiaRunQueryOptions,
  localGaiaRunsQueryOptions,
} from "@/lib/local-gaia-query";
import {
  buildRunConsoleState,
  dashboardQueryFailure,
  reconcileSelectedRunId,
  selectedRunFromConsoleState,
  type RunConsoleRun,
  type RunConsoleState,
} from "@/run-console-model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const statusLabels = {
  running: "Running",
  reviewing: "Reviewing",
  blocked: "Blocked",
  complete: "Complete",
} satisfies Record<RunStatus, string>;

function statusBadgeVariant(status: RunStatus) {
  if (status === "blocked") {
    return "destructive";
  }

  if (status === "complete") {
    return "secondary";
  }

  return "outline";
}

function signalBadgeVariant(
  signal: RunCompareSignal | undefined,
): "destructive" | "outline" | "secondary" {
  if (signal?.state === "failed") {
    return "destructive";
  }

  if (signal?.state === "available") {
    return "secondary";
  }

  return "outline";
}

function reconcileComparisonRunId(input: {
  readonly primaryRunId: string | undefined;
  readonly requestedComparisonRunId: string | undefined;
  readonly runs: ReadonlyArray<RunConsoleRun>;
}) {
  if (
    input.requestedComparisonRunId !== undefined &&
    input.requestedComparisonRunId !== input.primaryRunId &&
    input.runs.some((run) => run.id === input.requestedComparisonRunId)
  ) {
    return input.requestedComparisonRunId;
  }

  return input.runs.find((run) => run.id !== input.primaryRunId)?.id;
}

type ServerConnectionState = {
  readonly runConsole: RunConsoleState;
  readonly selectedRun: RunConsoleRun | undefined;
};

type CommandMode = "activity" | "compare" | "inspect" | "replay" | "source";

export function DashboardShell() {
  const serverUrl = defaultLocalGaiaServerUrl;
  const healthQuery = useQuery(localGaiaHealthQueryOptions({ serverUrl }));
  const runsQuery = useQuery(localGaiaRunsQueryOptions({ serverUrl }));
  const createRunMutation = useMutation(
    localGaiaCreateRunMutationOptions({ serverUrl }),
  );
  const runConsole = React.useMemo(
    () =>
      buildRunConsoleState({
        healthError: healthQuery.error,
        healthFetching: healthQuery.isFetching,
        healthPending: healthQuery.isPending,
        healthStatus: healthQuery.data?.status,
        runs: runsQuery.data?.data.runs ?? [],
        runsDiagnostics: runsQuery.data?.data.diagnostics ?? [],
        runsError: runsQuery.error,
        runsFetching: runsQuery.isFetching,
        runsPending: runsQuery.isPending,
        serverUrl,
      }),
    [
      healthQuery.data?.status,
      healthQuery.error,
      healthQuery.isFetching,
      healthQuery.isPending,
      runsQuery.data?.data.diagnostics,
      runsQuery.data?.data.runs,
      runsQuery.error,
      runsQuery.isFetching,
      runsQuery.isPending,
      serverUrl,
    ],
  );
  const [requestedSelectedRunId, setRequestedSelectedRunId] = React.useState<
    string | undefined
  >();
  const selectedRunId = reconcileSelectedRunId(
    requestedSelectedRunId,
    runConsole.runs,
  );
  const [requestedComparisonRunId, setRequestedComparisonRunId] =
    React.useState<string | undefined>();
  const [commandMode, setCommandMode] = React.useState<CommandMode>("inspect");
  const comparisonRunId = reconcileComparisonRunId({
    primaryRunId: selectedRunId,
    requestedComparisonRunId,
    runs: runConsole.runs,
  });
  const comparisonModeEnabled = commandMode === "compare";
  const selectedConsoleRun = selectedRunFromConsoleState(
    selectedRunId,
    runConsole.runs,
  );
  const selectedRunSummaryFromList = runsQuery.data?.data.runs.find(
    (run) => run.runId === selectedRunId,
  );
  const comparisonRunSummaryFromList = runsQuery.data?.data.runs.find(
    (run) => run.runId === comparisonRunId,
  );
  const selectedRunDetailQuery = useQuery(
    localGaiaRunQueryOptions({
      runId: selectedRunId ?? "",
      serverUrl,
    }),
  );
  const selectedFactoryGraphQuery = useQuery(
    localGaiaFactoryGraphQueryOptions({
      runId: selectedRunId ?? "",
      serverUrl,
    }),
  );
  const selectedFactoryRunActivityQuery = useQuery(
    localGaiaFactoryRunActivityQueryOptions({
      runId: selectedRunId ?? "",
      serverUrl,
    }),
  );
  const selectedFactoryArtifactsQuery = useQuery(
    localGaiaFactoryArtifactsQueryOptions({
      runId: selectedRunId ?? "",
      serverUrl,
    }),
  );
  const selectedRunEventsQuery = useQuery(
    localGaiaRunEventsQueryOptions({
      runId: selectedRunId ?? "",
      serverUrl,
    }),
  );
  const comparisonRunDetailQuery = useQuery(
    localGaiaRunQueryOptions({
      runId: comparisonModeEnabled ? (comparisonRunId ?? "") : "",
      serverUrl,
    }),
  );
  const comparisonRunEventsQuery = useQuery(
    localGaiaRunEventsQueryOptions({
      runId: comparisonModeEnabled ? (comparisonRunId ?? "") : "",
      serverUrl,
    }),
  );
  const runEventStream = useRunEventStream({
    enabled:
      commandMode === "activity" &&
      selectedRunId !== undefined &&
      selectedConsoleRun?.isTerminal === false,
    runId: selectedRunId,
    serverUrl,
  });
  const selectedRunEvents = React.useMemo(
    () =>
      mergeRunEvents({
        historical: selectedRunEventsQuery.data?.data.events ?? [],
        live: runEventStream.events,
      }),
    [selectedRunEventsQuery.data?.data.events, runEventStream.events],
  );
  const selectedRunSummary =
    selectedRunDetailQuery.data?.data ?? selectedRunSummaryFromList;
  const comparisonRunSummary =
    comparisonRunDetailQuery.data?.data ?? comparisonRunSummaryFromList;
  const selectedRun = React.useMemo(
    () =>
      buildRunCanvasModel({
        events: selectedRunEvents,
        run: selectedRunSummary,
      }),
    [selectedRunEvents, selectedRunSummary],
  );
  const [requestedReplayIndex, setRequestedReplayIndex] = React.useState<
    number | undefined
  >();
  const replayState = React.useMemo(
    () =>
      buildRunReplayState({
        requestedIndex: requestedReplayIndex,
        run: selectedRun,
      }),
    [requestedReplayIndex, selectedRun],
  );
  const runCompare = React.useMemo(
    () =>
      buildRunCompareModel({
        comparisonEvents: comparisonRunEventsQuery.data?.data.events ?? [],
        comparisonRun: comparisonRunSummary,
        primaryEvents: selectedRunEvents,
        primaryRun: selectedRunSummary,
      }),
    [
      comparisonRunEventsQuery.data?.data.events,
      comparisonRunSummary,
      selectedRunEvents,
      selectedRunSummary,
    ],
  );
  const serverConnection: ServerConnectionState = {
    runConsole,
    selectedRun: selectedConsoleRun,
  };
  const [selectedNodeId, setSelectedNodeId] = React.useState<
    string | undefined
  >();
  const selectedFactoryCanvas = React.useMemo(
    () =>
      selectedFactoryGraphQuery.data?.data === undefined
        ? undefined
        : buildFactoryCanvasModel(selectedFactoryGraphQuery.data.data, {
            activities:
              selectedFactoryRunActivityQuery.data?.data.activities ?? [],
          }),
    [
      selectedFactoryGraphQuery.data?.data,
      selectedFactoryRunActivityQuery.data?.data.activities,
    ],
  );
  const selectedFactoryNode =
    selectedFactoryCanvas?.nodes.find((node) => node.id === selectedNodeId);
  const selectedFactoryAgentActivityQuery = useQuery(
    localGaiaFactoryAgentActivityQueryOptions({
      agentId:
        selectedFactoryNode?.kind === "agent" ? selectedFactoryNode.rawId : "",
      runId: selectedRunId ?? "",
      serverUrl,
    }),
  );
  const runCanvas = {
    diagnostics: selectedFactoryCanvas?.diagnostics ?? [],
    graphError: dashboardQueryFailure(selectedFactoryGraphQuery.error),
    isLoading:
      selectedRunId !== undefined && selectedFactoryGraphQuery.isPending,
  };
  const agentActivityFailure = dashboardQueryFailure(
    selectedFactoryAgentActivityQuery.error,
  );
  const runActivityFailure = dashboardQueryFailure(
    selectedFactoryRunActivityQuery.error,
  );
  const artifactsFailure = dashboardQueryFailure(
    selectedFactoryArtifactsQuery.error,
  );
  const inspectorActivityResource = React.useMemo<
    InspectorResource<typeof FactoryActivityDto.Type>
  >(() => {
    if (selectedRunId === undefined || selectedFactoryNode === undefined) {
      return { data: [], status: "ready" };
    }

    if (selectedFactoryNode.kind === "agent") {
      if (selectedFactoryAgentActivityQuery.isPending) {
        return {
          message: "Agent activity is loading from the public agent endpoint.",
          status: "loading",
        };
      }

      if (agentActivityFailure !== undefined) {
        return {
          message: dashboardFailureMessage(
            agentActivityFailure,
            "Agent activity could not be loaded.",
          ),
          status: "error",
        };
      }

      return {
        data: selectedFactoryAgentActivityQuery.data?.data.activities ?? [],
        status: "ready",
      };
    }

    if (selectedFactoryRunActivityQuery.isPending) {
      return {
        message: "Run activity is loading from the public run endpoint.",
        status: "loading",
      };
    }

    if (runActivityFailure !== undefined) {
      return {
        message: dashboardFailureMessage(
          runActivityFailure,
          "Run activity could not be loaded.",
        ),
        status: "error",
      };
    }

    return {
      data: selectedFactoryRunActivityQuery.data?.data.activities ?? [],
      status: "ready",
    };
  }, [
    agentActivityFailure,
    runActivityFailure,
    selectedFactoryAgentActivityQuery.data?.data.activities,
    selectedFactoryAgentActivityQuery.isPending,
    selectedFactoryNode,
    selectedFactoryRunActivityQuery.data?.data.activities,
    selectedFactoryRunActivityQuery.isPending,
    selectedRunId,
  ]);
  const inspectorArtifactResource = React.useMemo<
    InspectorResource<typeof FactoryArtifactDto.Type>
  >(() => {
    if (selectedRunId === undefined || selectedFactoryNode === undefined) {
      return { data: [], status: "ready" };
    }

    if (selectedFactoryArtifactsQuery.isPending) {
      return {
        message: "Artifact catalog is loading from the public artifact endpoint.",
        status: "loading",
      };
    }

    if (artifactsFailure !== undefined) {
      return {
        message: dashboardFailureMessage(
          artifactsFailure,
          "Artifact catalog could not be loaded.",
        ),
        status: "error",
      };
    }

    return {
      data: selectedFactoryArtifactsQuery.data?.data.artifacts ?? [],
      status: "ready",
    };
  }, [
    artifactsFailure,
    selectedFactoryArtifactsQuery.data?.data.artifacts,
    selectedFactoryArtifactsQuery.isPending,
    selectedFactoryNode,
    selectedRunId,
  ]);
  const selectedNodeInspector = React.useMemo(
    () =>
      buildSelectedNodeInspectorModel({
        activity: inspectorActivityResource,
        artifactCatalog: inspectorArtifactResource,
        graph: selectedFactoryGraphQuery.data?.data,
        graphIsLoading: runCanvas.isLoading,
        selectedNode: selectedFactoryNode,
        selectedRunId,
      }),
    [
      inspectorActivityResource,
      inspectorArtifactResource,
      runCanvas.isLoading,
      selectedFactoryGraphQuery.data?.data,
      selectedFactoryNode,
      selectedRunId,
    ],
  );
  const terminalStreamEventKey =
    runEventStream.terminalEvent === undefined
      ? undefined
      : `${runEventStream.terminalEvent.sequence}:${runEventStream.terminalEvent.type}`;
  const refetchRuns = runsQuery.refetch;
  const refetchSelectedRunDetail = selectedRunDetailQuery.refetch;
  const refetchSelectedRunEvents = selectedRunEventsQuery.refetch;
  const refetchSelectedFactoryGraph = selectedFactoryGraphQuery.refetch;
  const refetchSelectedFactoryRunActivity =
    selectedFactoryRunActivityQuery.refetch;
  const refetchSelectedFactoryArtifacts = selectedFactoryArtifactsQuery.refetch;

  React.useEffect(() => {
    if (terminalStreamEventKey === undefined) {
      return;
    }

    void refetchRuns();
    void refetchSelectedRunDetail();
    void refetchSelectedRunEvents();
    void refetchSelectedFactoryGraph();
    void refetchSelectedFactoryRunActivity();
    void refetchSelectedFactoryArtifacts();
  }, [
    refetchSelectedFactoryArtifacts,
    refetchSelectedFactoryGraph,
    refetchSelectedFactoryRunActivity,
    refetchRuns,
    refetchSelectedRunDetail,
    refetchSelectedRunEvents,
    terminalStreamEventKey,
  ]);

  function refreshRunConsole() {
    const refreshes: Array<Promise<unknown>> = [
      healthQuery.refetch(),
      runsQuery.refetch(),
    ];

    if (selectedRunId !== undefined) {
      refreshes.push(
        selectedFactoryArtifactsQuery.refetch(),
        selectedFactoryGraphQuery.refetch(),
        selectedFactoryRunActivityQuery.refetch(),
        selectedRunDetailQuery.refetch(),
        selectedRunEventsQuery.refetch(),
      );
    }

    if (comparisonRunId !== undefined) {
      refreshes.push(
        comparisonRunDetailQuery.refetch(),
        comparisonRunEventsQuery.refetch(),
      );
    }

    void Promise.all(refreshes);
  }

  function selectRun(runId: string) {
    setRequestedSelectedRunId(runId);
    setSelectedNodeId(undefined);
    setRequestedReplayIndex(undefined);
    setCommandMode("inspect");
  }

  async function createIssueDeliveryRun(input: {
    readonly description: string;
    readonly title: string;
  }) {
    const result = await createRunMutation.mutateAsync(input);
    await runsQuery.refetch();
    selectRun(result.runId);
  }

  function selectReplayIndex(index: number) {
    setRequestedReplayIndex(index);

    const event = selectedRun.events[index];
    if (event !== undefined) {
      setSelectedNodeId(event.id);
    }
  }

  return (
    <TooltipProvider delay={250}>
      <SidebarProvider className="min-h-svh flex-col overflow-x-clip bg-background text-sm lg:h-svh lg:min-h-0 lg:flex-row lg:overflow-hidden">
        <RunConsole
          selectedRunId={selectedRunId}
          serverConnection={serverConnection}
          createRunError={dashboardQueryFailure(createRunMutation.error)}
          createRunIsPending={createRunMutation.isPending}
          onRefresh={refreshRunConsole}
          onCreateIssueDeliveryRun={createIssueDeliveryRun}
          onSelectRun={selectRun}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-hidden">
          <CommandHeader
            commandMode={commandMode}
            selectedRun={selectedRun}
            serverConnection={serverConnection}
            onSelectCommandMode={setCommandMode}
          />
          <SecondaryCommandPanel
            commandMode={commandMode}
            comparisonRunId={comparisonRunId}
            comparisonRunIsLoading={
              comparisonRunId !== undefined &&
              (comparisonRunDetailQuery.isPending ||
                comparisonRunEventsQuery.isPending)
            }
            inspector={selectedNodeInspector}
            primaryRunId={selectedRunId}
            replayState={replayState}
            runCompare={runCompare}
            runEventStream={runEventStream}
            runs={runConsole.runs}
            selectedConsoleRun={selectedConsoleRun}
            selectedRun={selectedRun}
            onSelectCommandMode={setCommandMode}
            onSelectComparisonRun={setRequestedComparisonRunId}
            onSelectPrimaryRun={selectRun}
            onSelectReplayIndex={selectReplayIndex}
          />
          <DesktopWorkspace
            factoryCanvas={selectedFactoryCanvas}
            inspector={selectedNodeInspector}
            runCanvas={runCanvas}
            replayState={replayState}
            runCompare={runCompare}
            selectedFactoryNode={selectedFactoryNode}
            selectedRun={selectedRun}
            serverUrl={serverUrl}
            onSelectNode={setSelectedNodeId}
          />
          <MobileWorkspace
            factoryCanvas={selectedFactoryCanvas}
            inspector={selectedNodeInspector}
            runCanvas={runCanvas}
            replayState={replayState}
            runCompare={runCompare}
            selectedFactoryNode={selectedFactoryNode}
            selectedRun={selectedRun}
            serverUrl={serverUrl}
            onSelectNode={setSelectedNodeId}
          />
        </main>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function RunReplayScrubber({
  replayState,
  selectedRun,
  onSelectReplayIndex,
}: {
  readonly replayState: RunReplayState;
  readonly selectedRun: DashboardRun;
  readonly onSelectReplayIndex: (index: number) => void;
}) {
  const currentStep = replayState.currentStep;
  const previousIndex = Math.max(replayState.currentIndex - 1, 0);
  const nextIndex = Math.min(
    replayState.currentIndex + 1,
    Math.max(replayState.steps.length - 1, 0),
  );
  const isDisabled = replayState.steps.length === 0;
  const handleReplayRangeInput = (
    event: React.FormEvent<HTMLInputElement>,
  ) => onSelectReplayIndex(Number(event.currentTarget.value));

  return (
    <section
      className="shrink-0 border-b bg-background px-3 py-2"
      data-testid="run-replay-scrubber"
    >
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="flex min-w-0 items-center justify-between gap-3 lg:w-72 lg:justify-start">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Run Replay
            </p>
            <p className="truncate text-sm font-medium">
              {currentStep?.event.label ?? "No ordered events"}
            </p>
          </div>
          <Badge variant={isDisabled ? "outline" : "secondary"}>
            {currentStep?.progressLabel ?? "Idle"}
          </Badge>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Previous replay event"
                  disabled={isDisabled || replayState.currentIndex === 0}
                  onClick={() => onSelectReplayIndex(previousIndex)}
                  size="icon"
                  variant="outline"
                />
              }
            >
              <ChevronLeftIcon />
            </TooltipTrigger>
            <TooltipContent>Previous replay event</TooltipContent>
          </Tooltip>
          <input
            aria-label="Replay event position"
            className="h-2 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="run-replay-range"
            disabled={isDisabled}
            max={Math.max(replayState.steps.length - 1, 0)}
            min={0}
            onChange={handleReplayRangeInput}
            onInput={handleReplayRangeInput}
            type="range"
            value={replayState.currentIndex}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Next replay event"
                  disabled={
                    isDisabled ||
                    replayState.currentIndex >= replayState.steps.length - 1
                  }
                  onClick={() => onSelectReplayIndex(nextIndex)}
                  size="icon"
                  variant="outline"
                />
              }
            >
              <ChevronRightIcon />
            </TooltipTrigger>
            <TooltipContent>Next replay event</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 lg:w-80 lg:justify-end">
          <Badge variant="outline">
            {selectedRun.events.length} ordered events
          </Badge>
          <Badge variant="outline">
            {Math.round(replayState.progressPercent)}% replayed
          </Badge>
          <Badge variant="outline">
            {replayState.visibleArtifactIds.length} artifacts reached
          </Badge>
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            data-testid="run-replay-current-event"
          >
            {currentStep === undefined
              ? "Select a run with public events."
              : `#${currentStep.event.sequence} · ${currentStep.event.timestamp}`}
          </span>
        </div>
      </div>
    </section>
  );
}

function RunComparePanel({
  comparisonRunId,
  comparisonRunIsLoading,
  primaryRunId,
  runCompare,
  runs,
  onSelectComparisonRun,
  onSelectPrimaryRun,
}: {
  readonly comparisonRunId: string | undefined;
  readonly comparisonRunIsLoading: boolean;
  readonly primaryRunId: string | undefined;
  readonly runCompare: RunCompareModel;
  readonly runs: ReadonlyArray<RunConsoleRun>;
  readonly onSelectComparisonRun: (runId: string | undefined) => void;
  readonly onSelectPrimaryRun: (runId: string) => void;
}) {
  const canCompare = runs.length >= 2;
  const comparisonOptions = runs.filter((run) => run.id !== primaryRunId);

  return (
    <section
      className="shrink-0 border-b bg-background px-3 py-2 lg:max-h-[34svh] lg:overflow-y-auto"
      data-testid="run-compare-panel"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            <GitCompareArrowsIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase text-muted-foreground">
                Run Compare
              </p>
              <p className="truncate text-sm font-medium">
                {runCompare.summary}
              </p>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:w-[34rem]">
            <RunSelectControl
              label="Primary"
              testId="run-compare-primary-select"
              value={primaryRunId ?? ""}
              runs={runs}
              disabled={runs.length === 0}
              onChange={(runId) => {
                if (runId.length > 0) {
                  onSelectPrimaryRun(runId);
                }
              }}
            />
            <RunSelectControl
              label="Comparison"
              testId="run-compare-comparison-select"
              value={comparisonRunId ?? ""}
              runs={comparisonOptions}
              disabled={!canCompare}
              onChange={(runId) =>
                onSelectComparisonRun(runId.length === 0 ? undefined : runId)
              }
            />
          </div>
        </div>
        {!canCompare ? (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            At least two local runs are required for side-by-side comparison.
          </div>
        ) : comparisonRunIsLoading ? (
          <div
            className="grid gap-2 md:grid-cols-2 xl:grid-cols-5"
            data-testid="run-compare-loading"
          >
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div
              className="grid gap-2 md:grid-cols-2 xl:grid-cols-5"
              data-testid="run-compare-metrics"
            >
              {runCompare.metrics.map((metric) => (
                <RunCompareMetricTile key={metric.label} metric={metric} />
              ))}
            </div>
            <div className="grid gap-2 xl:grid-cols-[1fr_1fr_1fr_1.2fr]">
              <RunCompareSignalTile
                label="Primary signals"
                report={runCompare.primary?.reportSignal}
                checks={runCompare.primary?.checkSignal}
                review={runCompare.primary?.reviewSignal}
              />
              <RunCompareSignalTile
                label="Comparison signals"
                report={runCompare.comparison?.reportSignal}
                checks={runCompare.comparison?.checkSignal}
                review={runCompare.comparison?.reviewSignal}
              />
              <ArtifactDelta delta={runCompare.artifactDelta} />
              <MissingDataList items={runCompare.missingData} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function SourceDetailPanel({
  inspector,
  selectedRun,
}: {
  readonly inspector: SelectedNodeInspectorModel;
  readonly selectedRun: DashboardRun;
}) {
  const selectedRunId =
    selectedRun.id === "no-run-selected" ? undefined : selectedRun.id;

  if (inspector.kind === "empty") {
    return (
      <section
        className="flex flex-col gap-3 p-3"
        data-testid="source-detail-panel"
      >
        <DiagnosticCallout
          message={inspector.message}
          title={inspector.title}
        />
        <SourceDetailRows
          rows={[
            {
              label: "Run",
              value: selectedRunId ?? "No selected run",
            },
            {
              label: "Topology",
              value: "Select a run and node to inspect public FactoryGraph sources.",
            },
          ]}
        />
      </section>
    );
  }

  const node = inspector.node;
  const activityEndpoint =
    inspector.kind === "agent"
      ? `GET /runs/${selectedRunId ?? ":runId"}/agents/${inspector.agent.id}/activity`
      : `GET /runs/${selectedRunId ?? ":runId"}/activity`;
  const rows = [
    {
      label: "Selected node",
      value: `${node.kind}:${node.rawId}`,
    },
    {
      label: "Topology",
      value: `GET /runs/${selectedRunId ?? ":runId"}/factory-graph`,
    },
    {
      label: "Activity",
      value: `${activityEndpoint} (${inspector.activityStatus}, ${inspector.activity.length} entries)`,
    },
    {
      label: "Artifacts",
      value: `GET /runs/${selectedRunId ?? ":runId"}/artifacts (${inspector.artifactStatus}, ${inspector.artifacts.length} linked)`,
    },
    {
      label: "Artifact bodies",
      value:
        "Read on demand from GET /runs/:runId/artifacts/:artifactId after choosing an inspector artifact.",
    },
    {
      label: "Private state",
      value: "No hidden .gaia reads or raw local files are used by this view.",
    },
  ];

  return (
    <section
      className="grid gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]"
      data-testid="source-detail-panel"
    >
      <SourceDetailRows rows={rows} />
      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Selected-node detail</p>
        <p className="mt-2">
          The inspector owns source detail through Summary, Activity, Artifacts,
          and Raw tabs. This panel keeps source context reachable without
          turning it into a separate canvas mode.
        </p>
      </div>
    </section>
  );
}

function SourceDetailRows({
  rows,
}: {
  readonly rows: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
  }>;
}) {
  return (
    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((row) => (
        <div
          className="min-w-0 rounded-md border bg-background p-2"
          data-testid={`source-detail-${row.label.toLowerCase().replaceAll(" ", "-")}`}
          key={row.label}
        >
          <p className="text-xs font-medium text-muted-foreground">
            {row.label}
          </p>
          <p className="mt-1 truncate text-sm">{row.value}</p>
        </div>
      ))}
    </div>
  );
}

function RunSelectControl({
  disabled,
  label,
  runs,
  testId,
  value,
  onChange,
}: {
  readonly disabled: boolean;
  readonly label: string;
  readonly runs: ReadonlyArray<RunConsoleRun>;
  readonly testId: string;
  readonly value: string;
  readonly onChange: (runId: string) => void;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <select
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
        data-testid={testId}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value}
      >
        {runs.length === 0 ? <option value="">Unavailable</option> : null}
        {runs.map((run) => (
          <option key={run.id} value={run.id}>
            {run.title}
          </option>
        ))}
      </select>
    </label>
  );
}

function RunCompareMetricTile({
  metric,
}: {
  readonly metric: RunCompareModel["metrics"][number];
}) {
  return (
    <div
      className="min-w-0 rounded-md border bg-background p-2"
      data-testid={`run-compare-metric-${metric.label.toLowerCase()}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium text-muted-foreground">
          {metric.label}
        </p>
        <Badge variant={metric.isDifferent ? "outline" : "secondary"}>
          {metric.isDifferent ? "Different" : "Same"}
        </Badge>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div className="min-w-0">
          <p className="text-muted-foreground">Primary</p>
          <p className="truncate font-medium">{metric.primaryValue}</p>
        </div>
        <div className="min-w-0">
          <p className="text-muted-foreground">Comparison</p>
          <p className="truncate font-medium">{metric.comparisonValue}</p>
        </div>
      </div>
    </div>
  );
}

function RunCompareSignalTile({
  checks,
  label,
  report,
  review,
}: {
  readonly checks: RunCompareSignal | undefined;
  readonly label: string;
  readonly report: RunCompareSignal | undefined;
  readonly review: RunCompareSignal | undefined;
}) {
  return (
    <div className="rounded-md border bg-background p-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        <SignalBadge label="Report" signal={report} />
        <SignalBadge label="Checks" signal={checks} />
        <SignalBadge label="Review" signal={review} />
      </div>
    </div>
  );
}

function SignalBadge({
  label,
  signal,
}: {
  readonly label: string;
  readonly signal: RunCompareSignal | undefined;
}) {
  return (
    <Badge variant={signalBadgeVariant(signal)}>
      {label}: {signal?.label ?? "Unavailable"}
    </Badge>
  );
}

function ArtifactDelta({
  delta,
}: {
  readonly delta: RunCompareModel["artifactDelta"];
}) {
  return (
    <div className="rounded-md border bg-background p-2">
      <p className="text-xs font-medium text-muted-foreground">
        Artifact availability
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        <Badge variant="secondary">{delta.shared.length} shared</Badge>
        <Badge variant="outline">{delta.primaryOnly.length} primary only</Badge>
        <Badge variant="outline">
          {delta.comparisonOnly.length} comparison only
        </Badge>
      </div>
      <p
        className="mt-2 truncate text-xs text-muted-foreground"
        data-testid="run-compare-artifact-delta"
      >
        {artifactDeltaLabel(delta)}
      </p>
    </div>
  );
}

function MissingDataList({
  items,
}: {
  readonly items: ReadonlyArray<string>;
}) {
  return (
    <div className="rounded-md border bg-background p-2">
      <p className="text-xs font-medium text-muted-foreground">
        Missing or unavailable
      </p>
      {items.length === 0 ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="run-compare-missing-data"
        >
          No missing public comparison data.
        </p>
      ) : (
        <ul
          className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground"
          data-testid="run-compare-missing-data"
        >
          {items.map((item) => (
            <li className="truncate" key={item}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunConsole({
  createRunError,
  createRunIsPending,
  selectedRunId,
  serverConnection,
  onCreateIssueDeliveryRun,
  onRefresh,
  onSelectRun,
}: {
  readonly createRunError: ReturnType<typeof dashboardQueryFailure>;
  readonly createRunIsPending: boolean;
  readonly selectedRunId: string | undefined;
  readonly serverConnection: ServerConnectionState;
  readonly onCreateIssueDeliveryRun: (input: {
    readonly description: string;
    readonly title: string;
  }) => Promise<void>;
  readonly onRefresh: () => void;
  readonly onSelectRun: (runId: string) => void;
}) {
  const [filter, setFilter] = React.useState("");
  const runConsole = serverConnection.runConsole;
  const visibleRuns = React.useMemo(() => {
    const normalizedFilter = filter.trim().toLowerCase();
    if (normalizedFilter.length === 0) {
      return runConsole.runs;
    }

    return runConsole.runs.filter((run) =>
      [run.id, run.latestEventLabel, run.specHint, run.stateLabel, run.status]
        .join(" ")
        .toLowerCase()
        .includes(normalizedFilter),
    );
  }, [filter, runConsole.runs]);

  return (
    <Sidebar
      collapsible="none"
      className="run-console-sidebar h-full shrink-0 overflow-hidden border-r max-lg:h-auto max-lg:w-full max-lg:overflow-y-auto max-lg:border-r-0 max-lg:border-b"
    >
      <SidebarHeader className="gap-3 border-b">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Run Console
            </p>
            <h1 className="truncate text-base font-semibold">Gaia Dashboard</h1>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Refresh local runs"
                  disabled={runConsole.isLoading}
                  onClick={onRefresh}
                  size="icon"
                  variant="outline"
                />
              }
            >
              <RefreshCwIcon
                className={cn(runConsole.isLoading && "animate-spin")}
              />
            </TooltipTrigger>
            <TooltipContent>Refresh local runs</TooltipContent>
          </Tooltip>
        </div>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search runs"
            className="pl-8"
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search local runs"
            value={filter}
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Issue delivery</SidebarGroupLabel>
          <SidebarGroupContent>
            <IssueDeliveryIntake
              error={createRunError}
              isPending={createRunIsPending}
              runConsole={runConsole}
              onCreateIssueDeliveryRun={onCreateIssueDeliveryRun}
            />
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Local runs</SidebarGroupLabel>
          <SidebarGroupContent>
            <RunConsoleRuns
              runs={visibleRuns}
              selectedRunId={selectedRunId}
              state={runConsole}
              onSelectRun={onSelectRun}
            />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t" data-testid="command-rail-footer">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <ServerIcon className="shrink-0 text-muted-foreground" />
              <span className="truncate text-xs font-medium">
                {runConsole.serverUrl}
              </span>
            </div>
            <Badge variant={serverBadgeVariant(runConsole.health)}>
              {runConsole.health}
            </Badge>
          </div>
          <p
            className="line-clamp-2 text-xs text-muted-foreground"
            data-testid="run-console-server-message"
          >
            {runConsole.message}
          </p>
          <Badge variant={serverBadgeVariant(runConsole.health)}>
            {runConsole.runs.length} runs
          </Badge>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function IssueDeliveryIntake({
  error,
  isPending,
  runConsole,
  onCreateIssueDeliveryRun,
}: {
  readonly error: ReturnType<typeof dashboardQueryFailure>;
  readonly isPending: boolean;
  readonly runConsole: RunConsoleState;
  readonly onCreateIssueDeliveryRun: (input: {
    readonly description: string;
    readonly title: string;
  }) => Promise<void>;
}) {
  const [description, setDescription] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const normalizedDescription = description.trim();
  const normalizedTitle = title.trim();
  const titleError = submitted && normalizedTitle.length === 0;
  const descriptionError =
    submitted && normalizedDescription.length === 0;
  const isOffline = runConsole.health === "offline";
  const canSubmit =
    !isPending &&
    !isOffline &&
    normalizedDescription.length > 0 &&
    normalizedTitle.length > 0;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);

    if (!canSubmit) {
      return;
    }

    try {
      await onCreateIssueDeliveryRun({
        description: normalizedDescription,
        title: normalizedTitle,
      });
    } catch {
      // React Query retains the typed mutation error for rendering below.
    }
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-md border bg-background p-2"
      data-testid="issue-delivery-intake-form"
      onSubmit={handleSubmit}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Create run</p>
          <p className="line-clamp-2 text-xs text-muted-foreground">
            Issue-delivery only. Gaia creates the root issue work item.
          </p>
        </div>
        <Badge variant="outline">issueDelivery</Badge>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1.5" data-invalid={titleError}>
          <Label className="text-xs" htmlFor="issue-delivery-title">
            Issue title
          </Label>
          <Input
            aria-describedby={
              titleError ? "issue-delivery-title-error" : undefined
            }
            aria-invalid={titleError}
            disabled={isPending || isOffline}
            id="issue-delivery-title"
            onChange={(event) => setTitle(event.currentTarget.value)}
            placeholder="Linear issue or delivery title"
            value={title}
          />
          {titleError ? (
            <p
              className="text-xs text-destructive"
              id="issue-delivery-title-error"
            >
              Enter an issue title.
            </p>
          ) : null}
        </div>
        <div
          className="flex flex-col gap-1.5"
          data-invalid={descriptionError}
        >
          <Label className="text-xs" htmlFor="issue-delivery-description">
            Issue description
          </Label>
          <Textarea
            aria-describedby={
              descriptionError
                ? "issue-delivery-description-error"
                : undefined
            }
            aria-invalid={descriptionError}
            className="max-h-36 min-h-24 resize-y"
            disabled={isPending || isOffline}
            id="issue-delivery-description"
            onChange={(event) => setDescription(event.currentTarget.value)}
            placeholder="Describe the issue-delivery work to run"
            value={description}
          />
          {descriptionError ? (
            <p
              className="text-xs text-destructive"
              id="issue-delivery-description-error"
            >
              Enter an issue description.
            </p>
          ) : null}
        </div>
      </div>
      {isOffline ? (
        <p
          className="rounded-md border bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground"
          data-testid="issue-delivery-intake-offline"
        >
          Local server unavailable. Reconnect LocalGaiaServerApi before creating
          a run.
        </p>
      ) : null}
      {error === undefined ? null : (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          data-testid="issue-delivery-intake-error"
        >
          {dashboardFailureMessage(error, "Create run failed.")}
        </p>
      )}
      <Button disabled={!canSubmit} size="sm" type="submit">
        {isPending ? (
          <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
        ) : (
          <PlayIcon data-icon="inline-start" />
        )}
        {isPending ? "Creating run" : "Create run"}
      </Button>
    </form>
  );
}

function RunConsoleRuns({
  runs,
  selectedRunId,
  state,
  onSelectRun,
}: {
  readonly runs: ReadonlyArray<RunConsoleRun>;
  readonly selectedRunId: string | undefined;
  readonly state: RunConsoleState;
  readonly onSelectRun: (runId: string) => void;
}) {
  if (state.isLoading) {
    return (
      <div className="flex flex-col gap-2 px-2 py-1">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (state.isError) {
    return (
      <Empty className="min-h-44 border" data-testid="run-console-error">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertCircleIcon />
          </EmptyMedia>
          <EmptyTitle>Local server unavailable</EmptyTitle>
          <EmptyDescription>{state.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (state.isEmpty) {
    return (
      <Empty className="min-h-44 border" data-testid="run-console-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WorkflowIcon />
          </EmptyMedia>
          <EmptyTitle>No local runs</EmptyTitle>
          <EmptyDescription>
            Start a Gaia run and refresh the console to inspect it here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (state.diagnostics.length > 0 && state.runs.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <RunConsoleDurabilityNotices state={state} />
        <Empty
          className="min-h-36 border"
          data-testid="run-console-diagnostic-empty"
        >
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircleIcon />
            </EmptyMedia>
            <EmptyTitle>No valid local runs</EmptyTitle>
            <EmptyDescription>
              The local server returned run index diagnostics, but no readable
              run summaries.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <Empty className="min-h-36 border" data-testid="run-console-filter-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchIcon />
          </EmptyMedia>
          <EmptyTitle>No matching runs</EmptyTitle>
          <EmptyDescription>
            Clear the search filter to return to the local run list.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <RunConsoleDurabilityNotices state={state} />
      <SidebarMenu>
        {runs.map((run) => (
          <SidebarMenuItem key={run.id}>
            <SidebarMenuButton
              className="h-auto items-start gap-3 py-2"
              data-testid={`run-console-row-${run.id}`}
              isActive={run.id === selectedRunId}
              onClick={() => onSelectRun(run.id)}
            >
              <WorkflowIcon />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{run.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {run.specHint}
                </span>
                <span className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                  <span>{run.statusLabel}</span>
                  <span aria-hidden="true">·</span>
                  <span>{run.latestEventLabel}</span>
                  <span aria-hidden="true">·</span>
                  <span>{run.eventCount} events</span>
                  <span aria-hidden="true">·</span>
                  <span>{run.artifactCount} artifacts</span>
                </span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  Updated {run.updatedAtLabel}
                </span>
              </span>
            </SidebarMenuButton>
            <SidebarMenuBadge>{run.terminalLabel}</SidebarMenuBadge>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </div>
  );
}

function RunConsoleDurabilityNotices({
  state,
}: {
  readonly state: RunConsoleState;
}) {
  if (!state.hasStaleData && state.diagnostics.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 px-2" data-testid="run-console-notices">
      {state.hasStaleData ? (
        <div
          className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          data-testid="run-console-stale-data"
        >
          <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            Cached run data is being preserved while the latest refresh is
            unavailable. Treat timestamps and active state as stale until the
            API reconnects.
          </span>
        </div>
      ) : null}
      {state.diagnostics.length > 0 ? (
        <section
          className="rounded-md border bg-background px-3 py-2 text-xs"
          data-testid="run-console-diagnostics"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium">Run index diagnostics</p>
            <Badge variant="outline">{state.diagnostics.length}</Badge>
          </div>
          <ul className="mt-2 flex flex-col gap-1 text-muted-foreground">
            {state.diagnostics.map((diagnostic, index) => (
              <li
                className="min-w-0 truncate"
                key={`${diagnostic.code}:${diagnostic.runId ?? diagnostic.pathSegment ?? index}`}
              >
                {diagnosticLabel(diagnostic)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function CommandHeader({
  commandMode,
  selectedRun,
  serverConnection,
  onSelectCommandMode,
}: {
  readonly commandMode: CommandMode;
  readonly selectedRun: DashboardRun;
  readonly serverConnection: ServerConnectionState;
  readonly onSelectCommandMode: (mode: CommandMode) => void;
}) {
  const selectedConsoleRun = serverConnection.selectedRun;
  const selectedStatusLabel =
    selectedConsoleRun?.terminalLabel ?? statusLabels[selectedRun.status];

  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="lg:hidden" />
        <div className="min-w-0">
          <p
            className="truncate text-sm font-medium"
            data-testid="selected-run-title"
          >
            {selectedConsoleRun?.title ?? selectedRun.title}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {selectedConsoleRun === undefined
              ? selectedRun.id
              : `${selectedConsoleRun.stateLabel} · ${selectedConsoleRun.latestEventLabel}`}
          </p>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 max-lg:w-full max-lg:justify-start">
        <Badge
          variant={
            selectedConsoleRun === undefined
              ? statusBadgeVariant(selectedRun.status)
              : localRunBadgeVariant(selectedConsoleRun.status)
          }
        >
          {selectedStatusLabel}
        </Badge>
        <CommandModeButton
          icon={GitCompareArrowsIcon}
          isActive={commandMode === "compare"}
          label="Compare"
          mode="compare"
          onSelectCommandMode={onSelectCommandMode}
        />
        <CommandModeButton
          icon={ChevronRightIcon}
          isActive={commandMode === "replay"}
          label="Replay"
          mode="replay"
          onSelectCommandMode={onSelectCommandMode}
        />
        <CommandModeButton
          icon={ActivityIcon}
          isActive={commandMode === "activity"}
          label="Activity"
          mode="activity"
          onSelectCommandMode={onSelectCommandMode}
        />
        <CommandModeButton
          icon={HelpCircleIcon}
          isActive={commandMode === "source"}
          label="Source"
          mode="source"
          onSelectCommandMode={onSelectCommandMode}
          testId="source-detail-toggle"
        />
      </div>
    </header>
  );
}

function CommandModeButton({
  icon: Icon,
  isActive,
  label,
  mode,
  testId,
  onSelectCommandMode,
}: {
  readonly icon: LucideIcon;
  readonly isActive: boolean;
  readonly label: string;
  readonly mode: CommandMode;
  readonly testId?: string;
  readonly onSelectCommandMode: (mode: CommandMode) => void;
}) {
  return (
    <Button
      aria-pressed={isActive}
      data-testid={testId}
      onClick={() => onSelectCommandMode(mode)}
      size="sm"
      variant={isActive ? "default" : "outline"}
    >
      <Icon data-icon="inline-start" />
      {label}
    </Button>
  );
}

function SecondaryCommandPanel({
  commandMode,
  comparisonRunId,
  comparisonRunIsLoading,
  inspector,
  primaryRunId,
  replayState,
  runCompare,
  runEventStream,
  runs,
  selectedConsoleRun,
  selectedRun,
  onSelectCommandMode,
  onSelectComparisonRun,
  onSelectPrimaryRun,
  onSelectReplayIndex,
}: {
  readonly commandMode: CommandMode;
  readonly comparisonRunId: string | undefined;
  readonly comparisonRunIsLoading: boolean;
  readonly inspector: SelectedNodeInspectorModel;
  readonly primaryRunId: string | undefined;
  readonly replayState: RunReplayState;
  readonly runCompare: RunCompareModel;
  readonly runEventStream: RunEventStreamState;
  readonly runs: ReadonlyArray<RunConsoleRun>;
  readonly selectedConsoleRun: RunConsoleRun | undefined;
  readonly selectedRun: DashboardRun;
  readonly onSelectCommandMode: (mode: CommandMode) => void;
  readonly onSelectComparisonRun: (runId: string | undefined) => void;
  readonly onSelectPrimaryRun: (runId: string) => void;
  readonly onSelectReplayIndex: (index: number) => void;
}) {
  if (commandMode === "inspect") {
    return null;
  }

  return (
    <section
      className="max-h-[36svh] shrink-0 overflow-y-auto border-b bg-background"
      data-testid={`secondary-command-panel-${commandMode}`}
    >
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {secondaryCommandTitle(commandMode)}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            Opened on demand; the FactoryGraph canvas remains the primary
            workspace.
          </p>
        </div>
        <Button
          aria-label="Close command mode"
          onClick={() => onSelectCommandMode("inspect")}
          size="sm"
          variant="outline"
        >
          <XIcon data-icon="inline-start" />
          Close
        </Button>
      </div>
      {commandMode === "replay" ? (
        <div className="flex flex-col">
          <RunReplayScrubber
            replayState={replayState}
            selectedRun={selectedRun}
            onSelectReplayIndex={onSelectReplayIndex}
          />
          <div className="h-40">
            <EventStrip
              replayState={replayState}
              selectedConsoleRun={selectedConsoleRun}
              selectedRun={selectedRun}
              streamState={runEventStream}
            />
          </div>
        </div>
      ) : commandMode === "compare" ? (
        <RunComparePanel
          comparisonRunId={comparisonRunId}
          comparisonRunIsLoading={comparisonRunIsLoading}
          primaryRunId={primaryRunId}
          runCompare={runCompare}
          runs={runs}
          onSelectComparisonRun={onSelectComparisonRun}
          onSelectPrimaryRun={onSelectPrimaryRun}
        />
      ) : commandMode === "source" ? (
        <SourceDetailPanel inspector={inspector} selectedRun={selectedRun} />
      ) : (
        <div className="h-40">
          <EventStrip
            replayState={replayState}
            selectedConsoleRun={selectedConsoleRun}
            selectedRun={selectedRun}
            streamState={runEventStream}
          />
        </div>
      )}
    </section>
  );
}

function secondaryCommandTitle(mode: CommandMode) {
  if (mode === "compare") {
    return "Run compare";
  }

  if (mode === "replay") {
    return "Run replay";
  }

  if (mode === "source") {
    return "Source detail";
  }

  return "Run activity";
}

function DesktopWorkspace({
  factoryCanvas,
  inspector,
  runCanvas,
  replayState,
  runCompare,
  selectedFactoryNode,
  selectedRun,
  serverUrl,
  onSelectNode,
}: {
  readonly factoryCanvas: FactoryCanvasModel | undefined;
  readonly inspector: SelectedNodeInspectorModel;
  readonly runCanvas: RunCanvasQueryState;
  readonly replayState: RunReplayState;
  readonly runCompare: RunCompareModel;
  readonly selectedFactoryNode: FactoryCanvasNode | undefined;
  readonly selectedRun: DashboardRun;
  readonly serverUrl: string;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="hidden min-h-0 flex-1 lg:block">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="68%" minSize="44%">
          <RunCanvas
            factoryCanvas={factoryCanvas}
            queryState={runCanvas}
            selectedNode={selectedFactoryNode}
            onSelectNode={onSelectNode}
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="32%" minSize="24%">
          <EvidenceStudio
            inspector={inspector}
            replayState={replayState}
            runCompare={runCompare}
            selectedRun={selectedRun}
            serverUrl={serverUrl}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}

function MobileWorkspace({
  factoryCanvas,
  inspector,
  runCanvas,
  replayState,
  runCompare,
  selectedFactoryNode,
  selectedRun,
  serverUrl,
  onSelectNode,
}: {
  readonly factoryCanvas: FactoryCanvasModel | undefined;
  readonly inspector: SelectedNodeInspectorModel;
  readonly runCanvas: RunCanvasQueryState;
  readonly replayState: RunReplayState;
  readonly runCompare: RunCompareModel;
  readonly selectedFactoryNode: FactoryCanvasNode | undefined;
  readonly selectedRun: DashboardRun;
  readonly serverUrl: string;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="flex min-h-0 flex-col lg:hidden">
      <div className="h-[22rem] shrink-0 border-b">
        <RunCanvas
          factoryCanvas={factoryCanvas}
          queryState={runCanvas}
          selectedNode={selectedFactoryNode}
          onSelectNode={onSelectNode}
        />
      </div>
      <div className="h-[24rem] shrink-0 border-b">
        <EvidenceStudio
          inspector={inspector}
          replayState={replayState}
          runCompare={runCompare}
          selectedRun={selectedRun}
          serverUrl={serverUrl}
        />
      </div>
    </section>
  );
}

function RunCanvas({
  factoryCanvas,
  queryState,
  selectedNode,
  onSelectNode,
}: {
  readonly factoryCanvas: FactoryCanvasModel | undefined;
  readonly queryState: RunCanvasQueryState;
  readonly selectedNode: FactoryCanvasNode | undefined;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  const nodes = React.useMemo(
    () =>
      factoryCanvas === undefined
        ? []
        : toFactoryFlowNodes(factoryCanvas, selectedNode?.id),
    [factoryCanvas, selectedNode?.id],
  );
  const edges = React.useMemo(
    () => (factoryCanvas === undefined ? [] : toFactoryFlowEdges(factoryCanvas)),
    [factoryCanvas],
  );
  const handleNodeClick = React.useCallback<NodeMouseHandler>(
    (_event, node) => onSelectNode(node.id),
    [onSelectNode],
  );

  return (
    <section className="flex size-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b px-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">Run Canvas</h2>
          <p className="truncate text-xs text-muted-foreground">
            FactoryGraph topology for the selected run
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline">{factoryCanvas?.nodes.length ?? 0} nodes</Badge>
        </div>
      </div>
      {factoryCanvas?.diagnostics.length ? (
        <div
          className="flex shrink-0 flex-col gap-1 border-b bg-background px-3 py-2 text-xs text-muted-foreground"
          data-testid="run-canvas-diagnostics"
        >
          {factoryCanvas.diagnostics.map((diagnostic) => (
            <div className="flex min-w-0 items-center gap-2" key={diagnostic.code}>
              <AlertCircleIcon className="size-3.5 shrink-0" />
              <span className="truncate">
                {diagnostic.code}: {diagnostic.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden bg-muted/20">
        {queryState.graphError !== undefined ? (
          <Empty data-testid="run-canvas-error">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertCircleIcon />
              </EmptyMedia>
              <EmptyTitle>Run canvas unavailable</EmptyTitle>
              <EmptyDescription>
                {runCanvasErrorMessage(queryState)}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : queryState.isLoading ? (
          <div
            className="grid size-full place-items-center p-6"
            data-testid="run-canvas-loading"
          >
            <div className="flex w-full max-w-xl flex-col gap-3">
              <Skeleton className="h-20 w-56" />
              <Skeleton className="ml-32 h-20 w-64" />
              <Skeleton className="ml-auto h-20 w-56" />
            </div>
          </div>
        ) : factoryCanvas === undefined || factoryCanvas.nodes.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyTitle>No FactoryGraph topology</EmptyTitle>
              <EmptyDescription>
                Select a local run with public FactoryGraph data to populate the
                canvas.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ReactFlow
            edges={edges}
            fitView
            nodes={nodes}
            nodesDraggable={false}
            onNodeClick={handleNodeClick}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </section>
  );
}

function selectedInspectorNodeId(model: SelectedNodeInspectorModel) {
  return model.kind === "agent" || model.kind === "workItem"
    ? model.node.id
    : undefined;
}

function emptyInspectorBadge(reason: Extract<
  SelectedNodeInspectorModel,
  { readonly kind: "empty" }
>["reason"]) {
  if (reason === "loading") {
    return "Loading";
  }

  if (reason === "no-run") {
    return "No run";
  }

  return "Idle";
}

function noticeFor(
  model: Extract<
    SelectedNodeInspectorModel,
    { readonly kind: "agent" | "workItem" }
  >,
  prefix: "Activity" | "Artifacts",
) {
  return model.notices.find((notice) => notice.title.startsWith(prefix));
}

function EvidenceStudio({
  inspector,
  replayState,
  runCompare,
  selectedRun,
  serverUrl,
}: {
  readonly inspector: SelectedNodeInspectorModel;
  readonly replayState: RunReplayState;
  readonly runCompare: RunCompareModel;
  readonly selectedRun: DashboardRun;
  readonly serverUrl: string;
}) {
  const [tab, setTab] = React.useState<EvidenceTab>("summary");
  const nodeArtifacts =
    inspector.kind === "agent" || inspector.kind === "workItem"
      ? inspector.artifacts
      : [];
  const artifactIds = nodeArtifacts.map((artifact) => artifact.artifactId);
  const artifactIdStrings = artifactIds.map((artifactId) => String(artifactId));
  const artifactKey = artifactIdStrings.join("|");
  const [requestedArtifact, setRequestedArtifact] = React.useState<
    | {
        readonly artifactId: string;
        readonly nodeId: string;
      }
    | undefined
  >();
  const selectedArtifactId =
    requestedArtifact !== undefined &&
    requestedArtifact.nodeId === selectedInspectorNodeId(inspector) &&
    artifactIdStrings.includes(requestedArtifact.artifactId)
      ? requestedArtifact.artifactId
      : undefined;
  const selectedRunId =
    selectedRun.id === "no-run-selected" ? "" : selectedRun.id;
  const artifactQuery = useQuery(
    localGaiaFactoryArtifactQueryOptions({
      artifactId: selectedArtifactId ?? "",
      runId: selectedRunId,
      serverUrl,
    }),
  );

  React.useEffect(() => {
    setRequestedArtifact((current) =>
      current !== undefined &&
      current.nodeId === selectedInspectorNodeId(inspector) &&
      artifactIdStrings.includes(current.artifactId)
        ? current
        : undefined,
    );
  }, [artifactKey, inspector]);

  if (inspector.kind === "empty") {
    return (
      <aside className="flex size-full min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b px-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">Evidence Studio</h2>
            <p className="truncate text-xs text-muted-foreground">
              {inspector.title}
            </p>
          </div>
          <Badge variant="outline">{emptyInspectorBadge(inspector.reason)}</Badge>
        </div>
        <Empty className="min-h-0 flex-1" data-testid="evidence-studio-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InspectIcon />
            </EmptyMedia>
            <EmptyTitle>{inspector.title}</EmptyTitle>
            <EmptyDescription>{inspector.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </aside>
    );
  }

  const selectedNode = inspector.node;
  const roleVisual = factoryAgentRoleVisual(selectedNode.role);

  return (
    <aside className="flex size-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b px-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">Evidence Studio</h2>
          <p className="truncate text-xs text-muted-foreground">
            {selectedNode.label}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline">
            {selectedNode.kind === "agent" ? roleVisual.label : "Work item"}
          </Badge>
          <Badge variant={factoryAgentStateBadgeVariant(selectedNode.state)}>
            {factoryAgentStateLabel(selectedNode.state)}
          </Badge>
        </div>
      </div>
      <Tabs
        className="min-h-0 flex-1 gap-0"
        onValueChange={(value) => {
          if (
            value === "summary" ||
            value === "events" ||
            value === "artifacts" ||
            value === "raw"
          ) {
            setTab(value);
          }
        }}
        value={tab}
      >
        <div className="border-b px-3 py-2">
          <TabsList variant="line">
            <TabsTrigger value="summary">
              <InspectIcon data-icon="inline-start" />
              Summary
            </TabsTrigger>
            <TabsTrigger value="events">
              <ActivityIcon data-icon="inline-start" />
              Activity
            </TabsTrigger>
            <TabsTrigger value="artifacts">
              <BoxIcon data-icon="inline-start" />
              Artifacts
            </TabsTrigger>
            <TabsTrigger value="raw">
              <BracesIcon data-icon="inline-start" />
              Raw
            </TabsTrigger>
          </TabsList>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <TabsContent className="m-0 p-3" value="summary">
            <FactoryEvidenceSummary inspector={inspector} />
          </TabsContent>
          <TabsContent className="m-0 p-3" value="events">
            <FactoryEvidenceActivity
              activities={inspector.activity}
              status={inspector.activityStatus}
              notice={noticeFor(inspector, "Activity")}
              selectedNode={inspector.node}
            />
          </TabsContent>
          <TabsContent className="m-0 p-3" value="artifacts">
            <FactoryEvidenceArtifacts
              artifact={artifactQuery.data?.data}
              artifactFailure={dashboardQueryFailure(artifactQuery.error)}
              artifacts={nodeArtifacts}
              catalogNotice={noticeFor(inspector, "Artifacts")}
              catalogStatus={inspector.artifactStatus}
              isLoading={
                artifactQuery.isPending && selectedArtifactId !== undefined
              }
              selectedArtifactId={selectedArtifactId}
              onSelectArtifact={(artifactId) =>
                setRequestedArtifact({
                  artifactId,
                  nodeId: inspector.node.id,
                })
              }
            />
          </TabsContent>
          <TabsContent className="m-0 p-3" value="raw">
            <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
              {stringifyJson({
                node: selectedNode,
                replay: {
                  activeEventId: replayState.activeEventId,
                  activeSequence: replayState.activeSequence,
                  visibleEventIds: replayState.visibleEventIds,
                },
                activities: inspector.activity,
                compare: runCompare.summary,
                inspectorKind: inspector.kind,
                runId: selectedRun.id,
              })}
            </pre>
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </aside>
  );
}

function FactoryEvidenceSummary({
  inspector,
}: {
  readonly inspector: Extract<
    SelectedNodeInspectorModel,
    { readonly kind: "agent" | "workItem" }
  >;
}) {
  const selectedNode = inspector.node;
  const roleVisual = factoryAgentRoleVisual(selectedNode.role);
  const RoleIcon = roleVisual.Icon;
  const summaryItems =
    inspector.kind === "agent"
      ? [
          `Role: ${roleVisual.label}`,
          `State: ${factoryAgentStateLabel(inspector.agent.state)}`,
          inspector.agent.subState === undefined
            ? undefined
            : `Sub-state: ${inspector.agent.subState}`,
          `Work item: ${inspector.agent.workItemId}`,
          "Agent query: unavailable in this prototype",
        ]
      : [
          `Kind: ${inspector.workItem.kind}`,
          `Linked agents: ${countLabel(inspector.agents.length, "agent", "agents")}`,
          inspector.workItem.description === undefined
            ? undefined
            : inspector.workItem.description,
          "Agent chat/query: unavailable in this prototype",
        ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-md border",
            selectedNode.kind === "agent"
              ? roleVisual.accentClassName
              : "border-border bg-muted/40 text-muted-foreground",
          )}
        >
          <RoleIcon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-muted-foreground">
            Selected {selectedNode.kind === "agent" ? "agent" : "work item"}
          </p>
          <h3 className="mt-1 text-lg font-semibold">{selectedNode.label}</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {selectedNode.summary}
          </p>
        </div>
      </div>
      <Separator />
      <EvidenceList
        emptyDescription="This selection has no additional public context."
        emptyTitle="No context"
        items={summaryItems.filter(isPresent)}
      />
      <Separator />
      {inspector.notices.length > 0 ? (
        <div className="flex flex-col gap-2">
          {inspector.notices.map((notice) => (
            <DiagnosticCallout
              key={`${notice.title}:${notice.message}`}
              message={notice.message}
              title={notice.title}
            />
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">
          Recent activity
        </p>
        <EvidenceList
          emptyDescription="This node has no public activity entries yet."
          emptyTitle="No activity"
          items={inspector.activity.slice(0, 4).map((activity) => activity.label)}
        />
      </div>
      <Separator />
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">
          Linked artifacts
        </p>
        <EvidenceList
          emptyDescription="This node has no public artifacts linked yet."
          emptyTitle="No artifacts"
          items={inspector.artifacts.map((artifact) => artifact.label)}
        />
      </div>
      <Separator />
      <EvidenceList
        emptyDescription="This node has no additional FactoryGraph references."
        emptyTitle="No graph references"
        items={[
          selectedNode.latestActivityId === undefined
            ? undefined
            : `Latest activity: ${selectedNode.latestActivityId}`,
          selectedNode.artifactIds.length === 0
            ? undefined
            : `Linked artifacts: ${selectedNode.artifactIds.join(", ")}`,
        ].filter(isPresent)}
      />
    </div>
  );
}

function FactoryEvidenceActivity({
  activities,
  notice,
  selectedNode,
  status,
}: {
  readonly activities: ReadonlyArray<typeof FactoryActivityDto.Type>;
  readonly notice: InspectorNotice | undefined;
  readonly selectedNode: FactoryCanvasNode;
  readonly status: InspectorResource<typeof FactoryActivityDto.Type>["status"];
}) {
  if (status === "loading") {
    return (
      <div className="flex flex-col gap-3" data-testid="evidence-events-loading">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (status === "error" || status === "unavailable") {
    return (
      <DiagnosticCallout
        message={notice?.message ?? "Activity could not be loaded."}
        title={notice?.title ?? "Activity unavailable"}
      />
    );
  }

  if (activities.length === 0) {
    return (
      <Empty className="min-h-48 border" data-testid="evidence-events-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ActivityIcon />
          </EmptyMedia>
          <EmptyTitle>No node activity</EmptyTitle>
          <EmptyDescription>
            {selectedNode.label} has no activity exposed by the public factory
            activity endpoint.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {activities.map((activity) => (
        <section
          className="rounded-md border bg-background p-3"
          data-testid={`evidence-activity-${activity.sequence}`}
          key={activity.activityId}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{activity.label}</p>
              <p className="truncate text-xs text-muted-foreground">
                Sequence {activity.sequence} · {activity.timestamp}
              </p>
            </div>
            <Badge variant={factoryAgentStateBadgeVariant(activity.state)}>
              {factoryAgentStateLabel(activity.state)}
            </Badge>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge variant="outline">{activity.kind}</Badge>
            {activity.subState === undefined ? null : (
              <Badge variant="secondary">{activity.subState}</Badge>
            )}
            {activity.artifactIds.map((artifactId) => (
              <Badge key={artifactId} variant="secondary">
                {factoryArtifactLabel(String(artifactId))}
              </Badge>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function FactoryEvidenceArtifacts({
  artifact,
  artifactFailure,
  artifacts,
  catalogNotice,
  catalogStatus,
  isLoading,
  selectedArtifactId,
  onSelectArtifact,
}: {
  readonly artifact: typeof FactoryArtifactBodyDto.Type | undefined;
  readonly artifactFailure: ReturnType<typeof dashboardQueryFailure>;
  readonly artifacts: ReadonlyArray<typeof FactoryArtifactDto.Type>;
  readonly catalogNotice: InspectorNotice | undefined;
  readonly catalogStatus: InspectorResource<
    typeof FactoryArtifactDto.Type
  >["status"];
  readonly isLoading: boolean;
  readonly selectedArtifactId: string | undefined;
  readonly onSelectArtifact: (artifactId: string) => void;
}) {
  if (catalogStatus === "loading") {
    return (
      <div
        className="flex flex-col gap-3"
        data-testid="evidence-artifacts-loading"
      >
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  if (catalogStatus === "error" || catalogStatus === "unavailable") {
    return (
      <DiagnosticCallout
        message={catalogNotice?.message ?? "Artifact catalog could not be loaded."}
        title={catalogNotice?.title ?? "Artifacts unavailable"}
      />
    );
  }

  if (artifacts.length === 0) {
    return (
      <Empty className="min-h-48 border" data-testid="evidence-artifacts-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BoxIcon />
          </EmptyMedia>
          <EmptyTitle>No artifacts linked</EmptyTitle>
          <EmptyDescription>
            This FactoryGraph node has no produced or linked artifacts exposed
            by the public API.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {artifacts.map((item) => (
          <Button
            key={item.artifactId}
            size="sm"
            variant={
              item.artifactId === selectedArtifactId ? "default" : "outline"
            }
            onClick={() => onSelectArtifact(item.artifactId)}
          >
            <BoxIcon data-icon="inline-start" />
            {item.label}
          </Button>
        ))}
      </div>
      <Separator />
      {isLoading ? (
        <div
          className="flex flex-col gap-3"
          data-testid="evidence-artifact-loading"
        >
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : artifactFailure !== undefined ? (
        <Empty
          className="min-h-48 border"
          data-testid="evidence-artifact-error"
        >
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircleIcon />
            </EmptyMedia>
            <EmptyTitle>Artifact unavailable</EmptyTitle>
            <EmptyDescription>
              {dashboardFailureMessage(
                artifactFailure,
                "The selected artifact could not be loaded.",
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : artifact === undefined ? (
        <Empty
          className="min-h-48 border"
          data-testid="evidence-artifact-empty"
        >
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxIcon />
            </EmptyMedia>
            <EmptyTitle>Select an artifact</EmptyTitle>
            <EmptyDescription>
              Choose a linked artifact to read it through the Gaia API.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <section
          className="rounded-md border bg-background"
          data-testid="evidence-artifact-content"
        >
          <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {factoryArtifactLabel(artifact.artifactId)}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {artifact.contentType}
              </p>
            </div>
            <Badge variant="secondary">Loaded</Badge>
          </div>
          <pre className="max-h-72 overflow-auto p-3 text-xs">
            {artifact.body}
          </pre>
        </section>
      )}
    </div>
  );
}

function DiagnosticCallout({
  message,
  title,
}: {
  readonly message: string;
  readonly title: string;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      data-testid="factory-diagnostic-callout"
    >
      <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="font-medium text-foreground">{title}: </span>
        {message}
      </span>
    </div>
  );
}

function EvidenceList({
  emptyDescription,
  emptyTitle,
  items,
}: {
  readonly emptyDescription: string;
  readonly emptyTitle: string;
  readonly items: ReadonlyArray<string>;
}) {
  if (items.length === 0) {
    return (
      <Empty className="min-h-40 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <InspectIcon />
          </EmptyMedia>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li
          className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
          key={item}
        >
          <CircleDotIcon className="size-3 text-muted-foreground" />
          <span className="min-w-0 truncate">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function EventStrip({
  replayState,
  selectedConsoleRun,
  selectedRun,
  streamState,
}: {
  readonly replayState: RunReplayState;
  readonly selectedConsoleRun: RunConsoleRun | undefined;
  readonly selectedRun: DashboardRun;
  readonly streamState: RunEventStreamState;
}) {
  const streamDisplay = eventStripDisplay({
    selectedConsoleRun,
    selectedRun,
    streamState,
  });

  return (
    <section className="flex size-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold">Live Event Strip</h2>
          <span className="truncate text-xs text-muted-foreground">
            {streamDisplay.message}
          </span>
        </div>
        <Badge variant={streamDisplay.variant}>{streamDisplay.label}</Badge>
      </div>
      {selectedRun.events.length === 0 ? (
        <Empty className="min-h-0 flex-1" data-testid="event-strip-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ActivityIcon />
            </EmptyMedia>
            <EmptyTitle>No run events</EmptyTitle>
            <EmptyDescription>
              Select a run with ordered events to populate the strip.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex min-w-max gap-2 p-3">
            {selectedRun.events.map((event) => (
              <div
                className={cn(
                  "flex w-72 shrink-0 flex-col gap-2 rounded-md border bg-background p-3",
                  event.id === replayState.activeEventId &&
                    "ring-2 ring-ring",
                  replayState.futureEventIds.includes(event.id) &&
                    "opacity-55",
                )}
                data-testid={`event-strip-event-${event.sequence}`}
                key={event.id}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {event.time}
                  </span>
                  <Badge variant={statusBadgeVariant(event.tone)}>
                    {statusLabels[event.tone]}
                  </Badge>
                </div>
                <p className="truncate text-sm font-medium">{event.label}</p>
                <div className="flex flex-wrap gap-1">
                  <Badge variant="outline">#{event.sequence}</Badge>
                  {event.id === replayState.activeEventId ? (
                    <Badge variant="secondary">Replay point</Badge>
                  ) : null}
                  {event.artifactHints.map((artifactId) => (
                    <Badge key={artifactId} variant="secondary">
                      {artifactLabel(artifactId)}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}

type RunEventStreamStatus =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "terminal"
  | "unavailable"
  | "error";

type RunEventStreamState = {
  readonly events: ReadonlyArray<RunEvent>;
  readonly message: string;
  readonly status: RunEventStreamStatus;
  readonly terminalEvent: RunEvent | undefined;
};

function useRunEventStream({
  enabled,
  runId,
  serverUrl,
}: {
  readonly enabled: boolean;
  readonly runId: string | undefined;
  readonly serverUrl: string;
}): RunEventStreamState {
  const [state, setState] = React.useState<RunEventStreamState>({
    events: [],
    message: "Select an active run to stream events.",
    status: "idle",
    terminalEvent: undefined,
  });

  React.useEffect(() => {
    if (!enabled || runId === undefined) {
      setState({
        events: [],
        message: "No active event stream.",
        status: "idle",
        terminalEvent: undefined,
      });
      return;
    }

    if (typeof EventSource === "undefined") {
      setState({
        events: [],
        message: "Browser EventSource is unavailable.",
        status: "unavailable",
        terminalEvent: undefined,
      });
      return;
    }

    const source = new EventSource(runEventStreamUrl(serverUrl, runId));
    setState({
      events: [],
      message: "Connecting to run event stream.",
      status: "connecting",
      terminalEvent: undefined,
    });

    source.onopen = () => {
      setState((current) => ({
        ...current,
        message: "Listening for live run events.",
        status: "open",
      }));
    };

    source.onerror = () => {
      source.close();
      setState((current) => ({
        ...current,
        message: "Run event stream disconnected.",
        status: "error",
      }));
    };

    source.onmessage = (message) => {
      const event = parseStreamMessage(message);
      if (event === undefined) {
        source.close();
        setState((current) => ({
          ...current,
          message: "Run event stream returned an invalid event.",
          status: "error",
        }));
        return;
      }

      const isTerminal = isTerminalRunEvent(event);
      setState((current) => ({
        events: mergeRunEvents({
          historical: current.events,
          live: [event],
        }),
        message: isTerminal
          ? "Terminal event received; stream closed."
          : "Listening for live run events.",
        status: isTerminal ? "terminal" : "open",
        terminalEvent: isTerminal ? event : current.terminalEvent,
      }));

      if (isTerminal) {
        source.close();
      }
    };

    return () => source.close();
  }, [enabled, runId, serverUrl]);

  return state;
}

function runEventStreamUrl(serverUrl: string, runId: string) {
  const baseUrl = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
  return `${baseUrl}/runs/${encodeURIComponent(runId)}/events/stream`;
}

function parseStreamMessage(
  message: MessageEvent<string>,
): RunEvent | undefined {
  try {
    const parsedJson: unknown = JSON.parse(message.data);
    const parsedEvent = Schema.decodeUnknownOption(RunEvent)(parsedJson);
    return Option.isSome(parsedEvent) ? parsedEvent.value : undefined;
  } catch {
    return undefined;
  }
}

function eventStripDisplay({
  selectedConsoleRun,
  selectedRun,
  streamState,
}: {
  readonly selectedConsoleRun: RunConsoleRun | undefined;
  readonly selectedRun: DashboardRun;
  readonly streamState: RunEventStreamState;
}): {
  readonly label: string;
  readonly message: string;
  readonly variant: "destructive" | "outline" | "secondary";
} {
  if (selectedRun.id === "no-run-selected") {
    return {
      label: "Idle",
      message: "No selected run.",
      variant: "outline",
    };
  }

  if (selectedConsoleRun?.isTerminal === true) {
    return {
      label: "Snapshot",
      message: "Completed run; showing ordered event history.",
      variant: "secondary",
    };
  }

  if (streamState.status === "error" || streamState.status === "unavailable") {
    return {
      label: "Unavailable",
      message: streamState.message,
      variant: "destructive",
    };
  }

  if (streamState.status === "terminal" || streamState.status === "closed") {
    return {
      label: "Closed",
      message: streamState.message,
      variant: "secondary",
    };
  }

  if (streamState.status === "connecting") {
    return {
      label: "Connecting",
      message: streamState.message,
      variant: "outline",
    };
  }

  if (streamState.status === "open") {
    return {
      label: "Live",
      message: streamState.message,
      variant: "secondary",
    };
  }

  return {
    label: "Idle",
    message: "No active event stream.",
    variant: "outline",
  };
}

function toFactoryFlowNodes(
  model: FactoryCanvasModel,
  selectedNodeId: string | undefined,
): Array<Node<{ label: React.ReactNode }>> {
  return model.nodes.map((node) => {
    const roleVisual = factoryAgentRoleVisual(node.role);
    const RoleIcon = roleVisual.Icon;

    return {
      className: cn(
        "rounded-lg border bg-background px-2 py-1 shadow-sm",
        node.id === selectedNodeId && "ring-2 ring-ring",
      ),
      data: {
        label: (
          <div className="flex min-w-56 max-w-72 flex-col gap-2 text-left">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-md border",
                    node.kind === "agent"
                      ? roleVisual.accentClassName
                      : "border-border bg-muted/40 text-muted-foreground",
                  )}
                >
                  <RoleIcon className="size-3.5" />
                </span>
                <span className="min-w-0 truncate text-sm font-semibold">
                  {node.label}
                </span>
              </div>
              <Badge variant={factoryAgentStateBadgeVariant(node.state)}>
                {factoryAgentStateLabel(node.state)}
              </Badge>
            </div>
            <span className="truncate text-xs text-muted-foreground">
              {node.kind === "agent" ? roleVisual.label : String(node.type)}
              {node.summary.length > 0 ? ` · ${node.summary}` : ""}
            </span>
            <div className="flex flex-wrap gap-1">
              {node.artifactCount > 0 ? (
                <Badge variant="secondary">
                  {node.artifactCount} artifacts
                </Badge>
              ) : null}
              {node.latestActivityId === undefined ? null : (
                <Badge variant="outline">Activity linked</Badge>
              )}
              {node.activityCount > 0 ? (
                <Badge variant="outline">
                  {countLabel(node.activityCount, "activity", "activities")}
                </Badge>
              ) : null}
            </div>
          </div>
        ),
      },
      id: node.id,
      position: node.position,
      type: node.kind === "workItem" ? "input" : "default",
    };
  });
}

function toFactoryFlowEdges(model: FactoryCanvasModel): Array<Edge> {
  return model.edges.map((edge) => ({
    animated: edge.label === "spawned",
    id: edge.id,
    label: edge.label,
    source: edge.source,
    target: edge.target,
    type: "smoothstep",
  }));
}

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function serverBadgeVariant(
  health: RunConsoleState["health"],
): "destructive" | "outline" | "secondary" {
  if (health === "offline") {
    return "destructive";
  }

  if (health === "online") {
    return "secondary";
  }

  return "outline";
}

function localRunBadgeVariant(
  status: RunConsoleRun["status"],
): "destructive" | "outline" | "secondary" {
  if (status === "failed") {
    return "destructive";
  }

  if (status === "completed") {
    return "secondary";
  }

  return "outline";
}

function diagnosticLabel(
  diagnostic: RunConsoleState["diagnostics"][number],
) {
  const target =
    diagnostic.runId ?? diagnostic.pathSegment ?? diagnostic.artifactName;

  return target === undefined
    ? `${diagnostic.code}: ${diagnostic.message}`
    : `${diagnostic.code} (${target}): ${diagnostic.message}`;
}

type RunCanvasQueryState = {
  readonly diagnostics: FactoryCanvasModel["diagnostics"];
  readonly graphError: ReturnType<typeof dashboardQueryFailure>;
  readonly isLoading: boolean;
};

function runCanvasErrorMessage(state: RunCanvasQueryState) {
  return dashboardFailureMessage(
    state.graphError,
    "The selected FactoryGraph could not be loaded.",
  );
}

function dashboardFailureMessage(
  failure: ReturnType<typeof dashboardQueryFailure>,
  fallback: string,
) {
  if (failure?._tag === "DashboardGaiaApiError") {
    return `${failure.error.code}: ${failure.error.message}`;
  }

  if (failure?._tag === "DashboardGaiaParameterError") {
    return `Invalid ${failure.parameter} parameter.`;
  }

  if (failure?._tag === "DashboardGaiaTimeoutError") {
    return "Local server request timed out.";
  }

  if (failure?._tag === "DashboardGaiaHttpClientError") {
    return "Local server is not reachable.";
  }

  return fallback;
}

function artifactDeltaLabel(delta: RunCompareModel["artifactDelta"]) {
  const labels = [
    delta.primaryOnly.length > 0
      ? `Primary only: ${delta.primaryOnly.join(", ")}`
      : undefined,
    delta.comparisonOnly.length > 0
      ? `Comparison only: ${delta.comparisonOnly.join(", ")}`
      : undefined,
  ].filter(isPresent);

  return labels.length === 0
    ? "Both runs expose the same artifact names."
    : labels.join(" · ");
}

function artifactLabel(artifactId: string) {
  return artifactId
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function factoryArtifactLabel(artifactId: string) {
  return artifactId
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "Unable to serialize raw data.";
  }
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
