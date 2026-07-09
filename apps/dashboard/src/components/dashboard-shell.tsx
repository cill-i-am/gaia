import {
  Background,
  Controls,
  Position,
  ReactFlow,
  type Edge,
  type FitViewOptions,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  type FactoryActivityDto,
  type FactoryArtifactBodyDto,
  type FactoryArtifactDto,
  type FactoryGraphDto,
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
  CirclePlusIcon,
  GitCompareArrowsIcon,
  InspectIcon,
  LoaderCircleIcon,
  PauseIcon,
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
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  SidebarRail,
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

function buildSelectedRunArtifactEvidence(input: {
  readonly artifactCatalog: InspectorResource<typeof FactoryArtifactDto.Type>;
  readonly canvas: FactoryCanvasModel | undefined;
  readonly graph: typeof FactoryGraphDto.Type | undefined;
  readonly graphIsLoading: boolean;
}): SelectedRunArtifactEvidence {
  if (input.graphIsLoading || input.artifactCatalog.status === "loading") {
    return { status: "loading" };
  }

  const graphArtifactIds = new Set<string>();

  for (const artifact of input.graph?.linkedArtifacts ?? []) {
    graphArtifactIds.add(String(artifact.artifactId));
  }

  for (const node of input.canvas?.nodes ?? []) {
    for (const artifactId of node.artifactIds) {
      graphArtifactIds.add(artifactId);
    }
  }

  if (graphArtifactIds.size > 0) {
    return {
      count: graphArtifactIds.size,
      source: "factoryGraph",
      status: "ready",
    };
  }

  const catalogArtifacts =
    input.artifactCatalog.status === "ready" ? input.artifactCatalog.data : [];
  if (catalogArtifacts.length > 0) {
    return {
      count: uniqueArtifactCount(catalogArtifacts),
      source: "artifactCatalog",
      status: "ready",
    };
  }

  return input.graph === undefined || input.artifactCatalog.status !== "ready"
    ? { status: "unavailable" }
    : { count: 0, source: "factoryGraph", status: "ready" };
}

function runArtifactCountLabel(input: {
  readonly evidence: SelectedRunArtifactEvidence | undefined;
  readonly run: RunConsoleRun;
}) {
  if (input.run.artifactCount > 0) {
    return `${input.run.artifactCount} ${artifactNoun(input.run.artifactCount)}`;
  }

  if (input.evidence?.status === "ready") {
    if (input.evidence.count > 0) {
      const qualifier =
        input.evidence.source === "factoryGraph" ? " graph" : "";

      return `${input.evidence.count}${qualifier} ${artifactNoun(input.evidence.count)}`;
    }

    return "No graph artifacts";
  }

  if (input.evidence?.status === "loading") {
    return "Artifacts loading";
  }

  if (input.evidence?.status === "unavailable") {
    return "Artifacts unavailable";
  }

  return "0 artifacts";
}

function runEventCountLabel(count: number) {
  return `${count} ${count === 1 ? "event" : "events"}`;
}

function artifactNoun(count: number) {
  return count === 1 ? "artifact" : "artifacts";
}

function uniqueArtifactCount(
  artifacts: ReadonlyArray<typeof FactoryArtifactDto.Type>,
) {
  return new Set(artifacts.map((artifact) => String(artifact.artifactId))).size;
}

type ServerConnectionState = {
  readonly runConsole: RunConsoleState;
  readonly selectedRunArtifactEvidence: SelectedRunArtifactEvidence | undefined;
  readonly selectedRun: RunConsoleRun | undefined;
};

type CommandMode = "activity" | "compare" | "inspect" | "replay";

type SelectedRunArtifactEvidence =
  | { readonly status: "loading" }
  | {
      readonly count: number;
      readonly source: "artifactCatalog" | "factoryGraph";
      readonly status: "ready";
    }
  | { readonly status: "unavailable" };

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
  const [isReplayPlaying, setIsReplayPlaying] = React.useState(false);
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
  const selectedRunArtifactEvidence = React.useMemo(
    () =>
      selectedRunId === undefined
        ? undefined
        : buildSelectedRunArtifactEvidence({
            artifactCatalog: inspectorArtifactResource,
            canvas: selectedFactoryCanvas,
            graph: selectedFactoryGraphQuery.data?.data,
            graphIsLoading: runCanvas.isLoading,
          }),
    [
      inspectorArtifactResource,
      runCanvas.isLoading,
      selectedFactoryCanvas,
      selectedFactoryGraphQuery.data?.data,
      selectedRunId,
    ],
  );
  const serverConnection: ServerConnectionState = {
    runConsole,
    selectedRun: selectedConsoleRun,
    selectedRunArtifactEvidence,
  };
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
    setIsReplayPlaying(false);
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

  function toggleReplayPlayback() {
    if (isReplayPlaying) {
      setIsReplayPlaying(false);
      return;
    }

    if (replayState.steps.length <= 1) {
      return;
    }

    if (replayState.currentIndex >= replayState.steps.length - 1) {
      selectReplayIndex(0);
    }

    setIsReplayPlaying(true);
  }

  React.useEffect(() => {
    if (commandMode !== "replay") {
      setIsReplayPlaying(false);
    }
  }, [commandMode]);

  React.useEffect(() => {
    if (!isReplayPlaying) {
      return;
    }

    if (
      replayState.steps.length <= 1 ||
      replayState.currentIndex >= replayState.steps.length - 1
    ) {
      setIsReplayPlaying(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const nextIndex = replayState.currentIndex + 1;
      selectReplayIndex(nextIndex);

      if (nextIndex >= replayState.steps.length - 1) {
        setIsReplayPlaying(false);
      }
    }, 1200);

    return () => window.clearTimeout(timeoutId);
  }, [isReplayPlaying, replayState.currentIndex, replayState.steps.length]);

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
          <section
            className="relative min-h-0 flex-1 overflow-hidden"
            data-testid="workspace-shell"
          >
            <DesktopWorkspace
              factoryCanvas={selectedFactoryCanvas}
              runCanvas={runCanvas}
              selectedFactoryNode={selectedFactoryNode}
              onSelectNode={setSelectedNodeId}
            />
            <MobileWorkspace
              factoryCanvas={selectedFactoryCanvas}
              runCanvas={runCanvas}
              selectedFactoryNode={selectedFactoryNode}
              onSelectNode={setSelectedNodeId}
            />
            <EvidenceStudioSheet
              inspector={selectedNodeInspector}
              replayState={replayState}
              runCompare={runCompare}
              selectedRun={selectedRun}
              serverUrl={serverUrl}
              onClose={() => setSelectedNodeId(undefined)}
            />
            <SecondaryCommandPanel
              commandMode={commandMode}
              comparisonRunId={comparisonRunId}
              comparisonRunIsLoading={
                comparisonRunId !== undefined &&
                (comparisonRunDetailQuery.isPending ||
                  comparisonRunEventsQuery.isPending)
              }
              isReplayPlaying={isReplayPlaying}
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
              onToggleReplayPlayback={toggleReplayPlayback}
            />
          </section>
        </main>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function RunReplayScrubber({
  isPlaying,
  replayState,
  onClose,
  onSelectReplayIndex,
  onTogglePlayback,
}: {
  readonly isPlaying: boolean;
  readonly replayState: RunReplayState;
  readonly onClose: () => void;
  readonly onSelectReplayIndex: (index: number) => void;
  readonly onTogglePlayback: () => void;
}) {
  const currentStep = replayState.currentStep;
  const previousIndex = Math.max(replayState.currentIndex - 1, 0);
  const nextIndex = Math.min(
    replayState.currentIndex + 1,
    Math.max(replayState.steps.length - 1, 0),
  );
  const isDisabled = replayState.steps.length === 0;
  const canPlay = replayState.steps.length > 1;
  const playbackLabel = isPlaying
    ? "Pause replay"
    : replayState.currentIndex >= replayState.steps.length - 1
      ? "Play replay from beginning"
      : "Play replay";
  const currentEventPosition =
    currentStep === undefined
      ? "Select a run with public events."
      : `Event #${currentStep.event.sequence}`;
  const handleReplayRangeInput = (
    event: React.FormEvent<HTMLInputElement>,
  ) => onSelectReplayIndex(Number(event.currentTarget.value));

  return (
    <section
      className="shrink-0 border-b bg-background px-3 py-2"
      data-testid="run-replay-scrubber"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {currentStep?.event.label ?? "No ordered events"}
            </p>
            <span
              className="block truncate text-xs text-muted-foreground"
              data-testid="run-replay-current-event"
              title={currentStep?.event.timestamp}
            >
              {currentEventPosition}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant={isDisabled ? "outline" : "secondary"}>
              {currentStep?.progressLabel ?? "Idle"}
            </Badge>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Close replay"
                    onClick={onClose}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipContent>Close replay</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={playbackLabel}
                  aria-pressed={isPlaying}
                  data-testid="run-replay-playback-toggle"
                  disabled={!canPlay}
                  onClick={onTogglePlayback}
                  size="icon"
                  variant={isPlaying ? "secondary" : "outline"}
                />
              }
            >
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </TooltipTrigger>
            <TooltipContent>{playbackLabel}</TooltipContent>
          </Tooltip>
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
            className="h-3 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
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
  onClose,
  onSelectComparisonRun,
  onSelectPrimaryRun,
}: {
  readonly comparisonRunId: string | undefined;
  readonly comparisonRunIsLoading: boolean;
  readonly primaryRunId: string | undefined;
  readonly runCompare: RunCompareModel;
  readonly runs: ReadonlyArray<RunConsoleRun>;
  readonly onClose: () => void;
  readonly onSelectComparisonRun: (runId: string | undefined) => void;
  readonly onSelectPrimaryRun: (runId: string) => void;
}) {
  const canCompare = runs.length >= 2;
  const comparisonOptions = runs.filter((run) => run.id !== primaryRunId);

  return (
    <section
      className="shrink-0 bg-background px-3 py-2"
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
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start xl:min-w-[37rem]">
            <div className="grid flex-1 gap-2 sm:grid-cols-2">
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Close compare"
                    onClick={onClose}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipContent>Close compare</TooltipContent>
            </Tooltip>
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
  const [createRunDialogOpen, setCreateRunDialogOpen] = React.useState(false);
  const runConsole = serverConnection.runConsole;
  const visibleRuns = React.useMemo(() => {
    const normalizedFilter = filter.trim().toLowerCase();
    if (normalizedFilter.length === 0) {
      return runConsole.runs;
    }

    return runConsole.runs.filter((run) =>
      [
        run.id,
        run.latestEventLabel,
        run.specHint ?? "",
        run.stateLabel,
        run.status,
        run.statusLabel,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedFilter),
    );
  }, [filter, runConsole.runs]);

  return (
    <Sidebar
      collapsible="offcanvas"
      className="run-console-sidebar h-full shrink-0 overflow-hidden border-r max-lg:h-auto max-lg:w-full max-lg:overflow-y-auto max-lg:border-r-0 max-lg:border-b"
    >
      <SidebarHeader className="gap-3 border-b">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="gaia-logo-wordmark truncate">GAIA</h1>
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
          <SearchIcon
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            data-testid="run-console-search-icon"
          />
          <Input
            aria-label="Search runs"
            className="h-8 pl-8"
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search local runs"
            value={filter}
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Runs</SidebarGroupLabel>
          <SidebarGroupContent>
            <Dialog
              onOpenChange={setCreateRunDialogOpen}
              open={createRunDialogOpen}
            >
              <Button
                className="w-full justify-start"
                onClick={() => setCreateRunDialogOpen(true)}
                variant="outline"
              >
                <CirclePlusIcon data-icon="inline-start" />
                New run
              </Button>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New run</DialogTitle>
                  <DialogDescription>
                    Issue-delivery only. Gaia creates the root issue work item.
                  </DialogDescription>
                </DialogHeader>
                <IssueDeliveryIntake
                  error={createRunError}
                  isPending={createRunIsPending}
                  runConsole={runConsole}
                  onCreateIssueDeliveryRun={async (input) => {
                    await onCreateIssueDeliveryRun(input);
                    setCreateRunDialogOpen(false);
                  }}
                />
              </DialogContent>
            </Dialog>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Local runs</SidebarGroupLabel>
          <SidebarGroupContent>
            <RunConsoleRuns
              runs={visibleRuns}
              selectedRunArtifactEvidence={
                serverConnection.selectedRunArtifactEvidence
              }
              selectedRunId={selectedRunId}
              state={runConsole}
              onSelectRun={onSelectRun}
            />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t" data-testid="command-rail-footer">
        <div className="flex flex-col gap-2">
          <div
            className={cn(
              "flex items-center justify-between gap-3 rounded-md border px-2 py-1.5",
              serverStatusPillClassName(runConsole.health),
            )}
            data-testid="run-console-server-status"
          >
            <div className="flex min-w-0 items-center gap-2">
              <ServerIcon className="shrink-0" />
              <span className="truncate text-xs font-medium">
                {runConsole.serverUrl}
              </span>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge
                    aria-label={serverStatusAccessibleLabel(runConsole)}
                    aria-live="polite"
                    className={cn(
                      "size-5 gap-0 rounded-full px-0",
                      serverStatusBadgeClassName(runConsole.health),
                    )}
                    role="status"
                    tabIndex={0}
                    variant="outline"
                  />
                }
              >
                {runConsole.health === "checking" ||
                runConsole.health === "reconnecting" ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-current"
                  />
                )}
              </TooltipTrigger>
              <TooltipContent>{serverStatusTooltip(runConsole)}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </SidebarFooter>
      <SidebarRail />
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
      className="flex flex-col gap-3"
      data-testid="issue-delivery-intake-form"
      onSubmit={handleSubmit}
    >
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
  selectedRunArtifactEvidence,
  selectedRunId,
  state,
  onSelectRun,
}: {
  readonly runs: ReadonlyArray<RunConsoleRun>;
  readonly selectedRunArtifactEvidence: SelectedRunArtifactEvidence | undefined;
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
      {state.hasStaleData ? <RunConsoleStaleDataNotice /> : null}
      <SidebarMenu>
        {runs.map((run) => {
          const artifactCountLabel = runArtifactCountLabel({
            evidence:
              run.id === selectedRunId ? selectedRunArtifactEvidence : undefined,
            run,
          });

          return (
            <SidebarMenuItem key={run.id}>
              <SidebarMenuButton
                className="h-auto items-start gap-2.5 px-2 py-1.5"
                data-testid={`run-console-row-${run.id}`}
                isActive={run.id === selectedRunId}
                onClick={() => onSelectRun(run.id)}
              >
                <WorkflowIcon />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{run.title}</span>
                  {run.specHint === undefined ? null : (
                    <span className="block truncate text-xs text-muted-foreground">
                      {run.specHint}
                    </span>
                  )}
                  <span className="mt-0.5 flex flex-wrap gap-1 text-xs text-muted-foreground">
                    <span>{run.statusLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span>{run.latestEventLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span>{runEventCountLabel(run.eventCount)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{artifactCountLabel}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    Updated {run.updatedAtLabel}
                  </span>
                </span>
              </SidebarMenuButton>
              <SidebarMenuBadge>{run.statusLabel}</SidebarMenuBadge>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </div>
  );
}

function RunConsoleDurabilityNotices({
  state,
}: {
  readonly state: RunConsoleState;
}) {
  if (state.diagnostics.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 px-2" data-testid="run-console-notices">
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
    </div>
  );
}

function RunConsoleStaleDataNotice() {
  return (
    <div
      className="mx-2 flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      data-testid="run-console-stale-data"
    >
      <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">
        Cached run data is being preserved while the latest refresh is
        unavailable. Treat timestamps and active state as stale until the API
        reconnects.
      </span>
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
    selectedConsoleRun?.statusLabel ?? statusLabels[selectedRun.status];

  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger aria-label="Toggle run console sidebar" size="icon" />
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
  isReplayPlaying,
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
  onToggleReplayPlayback,
}: {
  readonly commandMode: CommandMode;
  readonly comparisonRunId: string | undefined;
  readonly comparisonRunIsLoading: boolean;
  readonly isReplayPlaying: boolean;
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
  readonly onToggleReplayPlayback: () => void;
}) {
  if (commandMode === "inspect") {
    return null;
  }

  return (
    <section
      aria-label={`${secondaryCommandTitle(commandMode)} panel`}
      className="absolute inset-x-0 top-0 z-30 max-h-[min(28rem,52svh)] overflow-y-auto border-b bg-background shadow-lg animate-in fade-in-0 slide-in-from-top-2 duration-200 motion-reduce:animate-none"
      data-testid={`secondary-command-panel-${commandMode}`}
    >
      {commandMode === "replay" ? (
        <div className="flex flex-col">
          <RunReplayScrubber
            isPlaying={isReplayPlaying}
            replayState={replayState}
            onClose={() => onSelectCommandMode("inspect")}
            onSelectReplayIndex={onSelectReplayIndex}
            onTogglePlayback={onToggleReplayPlayback}
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
          onClose={() => onSelectCommandMode("inspect")}
          onSelectComparisonRun={onSelectComparisonRun}
          onSelectPrimaryRun={onSelectPrimaryRun}
        />
      ) : (
        <div className="h-40">
          <EventStrip
            replayState={replayState}
            selectedConsoleRun={selectedConsoleRun}
            selectedRun={selectedRun}
            streamState={runEventStream}
            onClose={() => onSelectCommandMode("inspect")}
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

  return "Run activity";
}

function DesktopWorkspace({
  factoryCanvas,
  runCanvas,
  selectedFactoryNode,
  onSelectNode,
}: {
  readonly factoryCanvas: FactoryCanvasModel | undefined;
  readonly runCanvas: RunCanvasQueryState;
  readonly selectedFactoryNode: FactoryCanvasNode | undefined;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="relative hidden size-full min-h-0 overflow-hidden lg:block">
      <RunCanvas
        factoryCanvas={factoryCanvas}
        queryState={runCanvas}
        selectedNode={selectedFactoryNode}
        onSelectNode={onSelectNode}
      />
    </section>
  );
}

function MobileWorkspace({
  factoryCanvas,
  runCanvas,
  selectedFactoryNode,
  onSelectNode,
}: {
  readonly factoryCanvas: FactoryCanvasModel | undefined;
  readonly runCanvas: RunCanvasQueryState;
  readonly selectedFactoryNode: FactoryCanvasNode | undefined;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="flex size-full min-h-0 flex-col overflow-y-auto lg:hidden">
      <div className="h-[22rem] shrink-0 border-b">
        <RunCanvas
          factoryCanvas={factoryCanvas}
          queryState={runCanvas}
          selectedNode={selectedFactoryNode}
          onSelectNode={onSelectNode}
        />
      </div>
    </section>
  );
}

function EvidenceStudioSheet({
  inspector,
  replayState,
  runCompare,
  selectedRun,
  serverUrl,
  onClose,
}: {
  readonly inspector: SelectedNodeInspectorModel;
  readonly replayState: RunReplayState;
  readonly runCompare: RunCompareModel;
  readonly selectedRun: DashboardRun;
  readonly serverUrl: string;
  readonly onClose: () => void;
}) {
  const isOpen = inspector.kind !== "empty";

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      {isOpen ? (
        <SheetContent
          className="gap-0 p-0 data-[side=right]:w-[min(30rem,calc(100vw-1rem))] data-[side=right]:sm:max-w-[30rem]"
          data-testid="evidence-studio-panel"
          showCloseButton={false}
          side="right"
        >
          <EvidenceStudio
            inspector={inspector}
            replayState={replayState}
            runCompare={runCompare}
            selectedRun={selectedRun}
            serverUrl={serverUrl}
            onClose={onClose}
          />
        </SheetContent>
      ) : null}
    </Sheet>
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
  const handleNodeSelect = React.useCallback(
    (nodeId: string) => onSelectNode(nodeId),
    [onSelectNode],
  );
  const nodes = React.useMemo(
    () =>
      factoryCanvas === undefined
        ? []
        : toFactoryFlowNodes(factoryCanvas, selectedNode?.id, handleNodeSelect),
    [factoryCanvas, handleNodeSelect, selectedNode?.id],
  );
  const edges = React.useMemo(
    () =>
      factoryCanvas === undefined
        ? []
        : toFactoryFlowEdges(factoryCanvas, selectedNode?.id),
    [factoryCanvas, selectedNode?.id],
  );
  const handleNodeClick = React.useCallback<NodeMouseHandler>(
    (_event, node) => handleNodeSelect(node.id),
    [handleNodeSelect],
  );

  return (
    <section
      aria-label="FactoryGraph canvas"
      className="flex size-full min-h-0 flex-col"
    >
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
            fitViewOptions={factoryFlowFitViewOptions}
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
  onClose,
}: {
  readonly inspector: SelectedNodeInspectorModel;
  readonly replayState: RunReplayState;
  readonly runCompare: RunCompareModel;
  readonly selectedRun: DashboardRun;
  readonly serverUrl: string;
  readonly onClose: () => void;
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
    return null;
  }

  const selectedNode = inspector.node;
  const roleVisual = factoryAgentRoleVisual(selectedNode.role);

  return (
    <div className="flex size-full min-h-0 flex-col">
      <SheetHeader className="flex-row items-center justify-between gap-3 border-b px-3 py-3">
        <div className="min-w-0">
          <SheetTitle>Evidence Studio</SheetTitle>
          <SheetDescription className="truncate">
            {selectedNode.label}
          </SheetDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline">
            {selectedNode.kind === "agent" ? roleVisual.label : "Work item"}
          </Badge>
          <Badge variant={factoryAgentStateBadgeVariant(selectedNode.state)}>
            {factoryAgentStateLabel(selectedNode.state)}
          </Badge>
          <Button
            aria-label="Close Evidence Studio"
            size="icon-sm"
            type="button"
            variant="ghost"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
      </SheetHeader>
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
        <div className="overflow-x-auto border-b px-3 py-2">
          <TabsList className="min-w-max" variant="line">
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
    </div>
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
  const summaryFacts =
    inspector.kind === "agent"
      ? [
          inspector.agent.subState === undefined
            ? undefined
            : {
                label: "Operator note",
                value: inspector.agent.subState,
              },
          {
            label: "Activity",
            value: countLabel(inspector.activity.length, "entry", "entries"),
          },
          {
            label: "Artifacts",
            value: countLabel(
              inspector.artifacts.length,
              "artifact",
              "artifacts",
            ),
          },
          {
            label: "Query",
            value: "Unavailable in this prototype",
          },
        ]
      : [
          inspector.workItem.description === undefined
            ? undefined
            : {
                label: "Description",
                value: inspector.workItem.description,
              },
          {
            label: "Linked agents",
            value: countLabel(inspector.agents.length, "agent", "agents"),
          },
          {
            label: "Artifacts",
            value: countLabel(
              inspector.artifacts.length,
              "artifact",
              "artifacts",
            ),
          },
          {
            label: "Query",
            value: "Unavailable in this prototype",
          },
        ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div
          className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground"
          data-slot="factory-evidence-summary-icon"
        >
          <RoleIcon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-muted-foreground">
            Selected {selectedNode.kind === "agent" ? "agent" : "work item"}
          </p>
          <h3 className="mt-1 text-lg font-semibold">{selectedNode.label}</h3>
        </div>
      </div>
      <SummaryFacts facts={summaryFacts.filter(isPresent)} />
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
      <EvidenceSummarySection
        emptyText="No public activity entries yet."
        items={inspector.activity.slice(0, 4).map((activity) => activity.label)}
        title="Recent activity"
      />
      <EvidenceSummarySection
        emptyText="No public artifacts linked yet."
        items={inspector.artifacts.map((artifact) => artifact.label)}
        title="Linked artifacts"
      />
      <EvidenceSummarySection
        emptyText="No additional FactoryGraph references."
        items={[
          selectedNode.latestActivityId === undefined
            ? undefined
            : `Latest activity: ${selectedNode.latestActivityId}`,
          selectedNode.artifactIds.length === 0
            ? undefined
            : `Linked artifacts: ${selectedNode.artifactIds.join(", ")}`,
        ].filter(isPresent)}
        title="Graph references"
      />
    </div>
  );
}

function SummaryFacts({
  facts,
}: {
  readonly facts: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
  }>;
}) {
  if (facts.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
        No additional public context.
      </p>
    );
  }

  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {facts.map((fact) => (
        <div
          className="min-w-0 rounded-md border bg-muted/20 px-3 py-2"
          key={`${fact.label}:${fact.value}`}
        >
          <dt className="text-xs font-medium uppercase text-muted-foreground">
            {fact.label}
          </dt>
          <dd className="mt-1 truncate text-sm">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EvidenceSummarySection({
  emptyText,
  items,
  title,
}: {
  readonly emptyText: string;
  readonly items: ReadonlyArray<string>;
  readonly title: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase text-muted-foreground">
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li className="flex items-center gap-2 text-sm" key={item}>
              <CircleDotIcon className="size-3 text-muted-foreground" />
              <span className="min-w-0 truncate">{item}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
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
    <div className="flex flex-col">
      {activities.map((activity) => (
        <section
          className="border-b py-3 last:border-b-0"
          data-testid={`evidence-activity-${activity.sequence}`}
          key={activity.activityId}
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">
              #{activity.sequence}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <p className="truncate text-sm font-medium">{activity.label}</p>
                <Badge
                  className="shrink-0"
                  variant={factoryAgentStateBadgeVariant(activity.state)}
                >
                  {factoryAgentStateLabel(activity.state)}
                </Badge>
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {activity.timestamp} · {activity.kind}
              </p>
              {activity.subState === undefined ? null : (
                <p className="mt-2 text-xs text-muted-foreground">
                  {activity.subState}
                </p>
              )}
              {activity.artifactIds.length === 0 ? null : (
                <p className="mt-2 truncate text-xs text-muted-foreground">
                  Artifacts:{" "}
                  {activity.artifactIds
                    .map((artifactId) => factoryArtifactLabel(String(artifactId)))
                    .join(", ")}
                </p>
              )}
            </div>
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

function EventStrip({
  onClose,
  replayState,
  selectedConsoleRun,
  selectedRun,
  streamState,
}: {
  readonly onClose?: () => void;
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
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={streamDisplay.variant}>{streamDisplay.label}</Badge>
          {onClose === undefined ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Close activity"
                    onClick={onClose}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipContent>Close activity</TooltipContent>
            </Tooltip>
          )}
        </div>
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
                aria-label={eventStripEventLabel(event, replayState)}
                className={cn(
                  "flex w-56 shrink-0 flex-col gap-1.5 rounded-md border bg-background p-3",
                  event.id === replayState.activeEventId &&
                    "ring-2 ring-ring",
                  replayState.futureEventIds.includes(event.id) &&
                    "opacity-55",
                )}
                data-testid={`event-strip-event-${event.sequence}`}
                key={event.id}
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono text-foreground">
                    #{event.sequence}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">
                    {event.time}
                  </span>
                </div>
                <p className="truncate text-sm font-medium">{event.label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {statusLabels[event.tone]}
                  {event.id === replayState.activeEventId ? (
                    <span className="font-medium text-foreground">
                      {" "}
                      · Replay
                    </span>
                  ) : null}
                </p>
                {event.artifactHints.length === 0 ? null : (
                  <p className="truncate text-xs text-muted-foreground">
                    Artifacts: {eventArtifactSummary(event.artifactHints)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}

function eventStripEventLabel(
  event: DashboardRun["events"][number],
  replayState: RunReplayState,
) {
  const artifactText =
    event.artifactHints.length === 0
      ? "No artifact hints."
      : `Artifacts: ${eventArtifactSummary(event.artifactHints)}.`;
  const replayText =
    event.id === replayState.activeEventId ? " Replay position." : "";

  return `Event ${event.sequence}: ${event.label}. ${statusLabels[event.tone]}. ${artifactText}${replayText}`;
}

function eventArtifactSummary(artifactHints: ReadonlyArray<string>) {
  const visibleArtifacts = artifactHints.slice(0, 2).map(artifactLabel);
  const hiddenCount = artifactHints.length - visibleArtifacts.length;

  return hiddenCount > 0
    ? `${visibleArtifacts.join(", ")} +${hiddenCount} artifacts`
    : visibleArtifacts.join(", ");
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
  onSelectNode: (nodeId: string) => void,
): Array<Node<{ label: React.ReactNode }>> {
  return model.nodes.map((node) => {
    const roleVisual = factoryAgentRoleVisual(node.role);
    const RoleIcon = roleVisual.Icon;
    const metric = factoryNodeMetric(node);

    return {
      className: cn(
        "factory-flow-node h-36 w-80 rounded-xl border-0 bg-transparent p-0 shadow-none",
        node.id === selectedNodeId && "ring-2 ring-ring",
      ),
      data: {
        label: (
          <button
            aria-label={`Inspect ${node.label}`}
            className="nodrag nopan size-full cursor-pointer overflow-hidden rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSelectNode(node.id);
            }}
          >
            <Card className="size-full gap-0 border border-border py-0 shadow-none ring-0 [--card-spacing:--spacing(3)]">
              <CardHeader className="flex min-h-24 flex-row items-center gap-3 px-4 py-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground">
                  <RoleIcon className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <CardTitle className="truncate text-base font-semibold leading-tight">
                    {node.label}
                  </CardTitle>
                  <CardDescription className="truncate">
                    {roleVisual.description}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardFooter className="mt-auto h-12 justify-between gap-3 px-4 py-0">
                <span className="min-w-0 truncate font-mono text-xs uppercase tracking-[0.08em] text-muted-foreground">
                  {factoryNodeFooterLabel(node)}
                </span>
                {metric === undefined ? null : (
                  <Badge
                    aria-label={metric.accessibleLabel}
                    className="min-w-7 justify-center rounded-md px-2 font-mono tabular-nums"
                    title={metric.accessibleLabel}
                    variant="secondary"
                  >
                    {metric.value}
                  </Badge>
                )}
              </CardFooter>
            </Card>
          </button>
        ),
      },
      id: node.id,
      position: node.position,
      sourcePosition: Position.Bottom,
      style: factoryFlowNodeStyle,
      targetPosition: Position.Top,
      type: "default",
    };
  });
}

function factoryNodeFooterLabel(node: FactoryCanvasNode) {
  return factoryAgentStateLabel(node.state);
}

function factoryNodeMetric(node: FactoryCanvasNode):
  | {
      readonly accessibleLabel: string;
      readonly value: number;
    }
  | undefined {
  if (node.artifactCount > 0) {
    return {
      accessibleLabel: countLabel(node.artifactCount, "artifact", "artifacts"),
      value: node.artifactCount,
    };
  }

  if (node.activityCount > 0) {
    return {
      accessibleLabel: countLabel(node.activityCount, "activity", "activities"),
      value: node.activityCount,
    };
  }

  return undefined;
}

const factoryFlowNodeStyle = {
  backgroundColor: "transparent",
  border: 0,
  boxShadow: "none",
  height: 144,
  padding: 0,
  width: 320,
} satisfies React.CSSProperties;

const factoryFlowFitViewOptions = {
  maxZoom: 1,
  minZoom: 0.4,
  padding: 0.16,
} satisfies FitViewOptions;

function toFactoryFlowEdges(
  model: FactoryCanvasModel,
  selectedNodeId: string | undefined,
): Array<Edge> {
  const stateByNodeId = new Map(model.nodes.map((node) => [node.id, node.state]));

  return model.edges.map((edge) => {
    const sourceState = stateByNodeId.get(edge.source);
    const targetState = stateByNodeId.get(edge.target);
    const animated = shouldAnimateFactoryEdge(sourceState, targetState);
    const selectedPath =
      selectedNodeId !== undefined &&
      (edge.source === selectedNodeId || edge.target === selectedNodeId);

    return {
      animated,
      className: factoryFlowEdgeClassName({
        animated,
        hasSelectedNode: selectedNodeId !== undefined,
        selectedPath,
      }),
      id: edge.id,
      interactionWidth: 28,
      pathOptions: {
        borderRadius: 10,
        offset: 24,
      },
      selectable: false,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
    };
  });
}

type FactoryCanvasNodeState = FactoryCanvasModel["nodes"][number]["state"];

export function shouldAnimateFactoryEdge(
  sourceState: FactoryCanvasNodeState | undefined,
  targetState: FactoryCanvasNodeState | undefined,
) {
  return sourceState === "running" || targetState === "running";
}

export function factoryFlowEdgeClassName(input: {
  readonly animated: boolean;
  readonly hasSelectedNode: boolean;
  readonly selectedPath: boolean;
}) {
  return cn(
    "factory-flow-edge",
    input.animated && "factory-flow-edge-active",
    input.selectedPath && "factory-flow-edge-selected",
    input.hasSelectedNode &&
      !input.selectedPath &&
      "factory-flow-edge-unselected",
  );
}

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function serverStatusPillClassName(health: RunConsoleState["health"]) {
  if (health === "online") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-950";
  }

  if (health === "offline") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }

  return "border-amber-500/30 bg-amber-500/10 text-amber-950";
}

function serverStatusBadgeClassName(health: RunConsoleState["health"]) {
  if (health === "online") {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-900";
  }

  if (health === "offline") {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }

  return "border-amber-500/40 bg-amber-500/10 text-amber-900";
}

function serverStatusLabel(health: RunConsoleState["health"]) {
  if (health === "online") {
    return "online";
  }

  if (health === "offline") {
    return "offline";
  }

  if (health === "stale") {
    return "stale";
  }

  if (health === "reconnecting") {
    return "reconnecting";
  }

  return "checking";
}

function serverStatusAccessibleLabel(runConsole: RunConsoleState) {
  return `Server status: ${runConsole.serverUrl} ${serverStatusLabel(runConsole.health)}`;
}

function serverStatusTooltip(runConsole: RunConsoleState) {
  const label = serverStatusLabel(runConsole.health);
  return `${runConsole.serverUrl} is ${label}`;
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
