import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import { useQuery } from "@tanstack/react-query";
import { RunEvent, type LocalRunArtifactDto } from "@gaia/core";
import { Option, Schema } from "effect";
import {
  ActivityIcon,
  AlertCircleIcon,
  BoxIcon,
  BracesIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDotIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
  HelpCircleIcon,
  InspectIcon,
  LinkIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  WorkflowIcon,
} from "lucide-react";
import * as React from "react";

import {
  type DashboardArtifactId,
  type DashboardEvent,
  type DashboardRun,
  type EvidenceTab,
  type RunReplayState,
  type RunNode,
  type RunStatus,
  buildRunCanvasModel,
  buildRunReplayState,
  eventTypeLabel,
  eventsForNode,
  getInitialNode,
  isTerminalRunEvent,
  mergeRunEvents,
  stateLabel,
} from "@/run-canvas-model";
import {
  buildRunCompareModel,
  type RunCompareModel,
  type RunCompareSignal,
} from "@/run-compare-model";
import {
  buildEvidenceProvenanceModel,
  type EvidenceProvenanceModel,
  type ProvenanceAvailability,
  type ProvenanceSource,
} from "@/provenance-model";
import { defaultLocalGaiaServerUrl } from "@/lib/local-gaia-client";
import {
  localGaiaHealthQueryOptions,
  localGaiaRunArtifactQueryOptions,
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

function roleLabel(node: RunNode) {
  return `${node.role[0]?.toUpperCase() ?? ""}${node.role.slice(1)}`;
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

export function DashboardShell() {
  const serverUrl = defaultLocalGaiaServerUrl;
  const healthQuery = useQuery(localGaiaHealthQueryOptions({ serverUrl }));
  const runsQuery = useQuery(localGaiaRunsQueryOptions({ serverUrl }));
  const runConsole = React.useMemo(
    () =>
      buildRunConsoleState({
        healthError: healthQuery.error,
        healthPending: healthQuery.isPending,
        healthStatus: healthQuery.data?.status,
        runs: runsQuery.data?.data.runs ?? [],
        runsDiagnostics: runsQuery.data?.data.diagnostics ?? [],
        runsError: runsQuery.error,
        runsPending: runsQuery.isPending,
        serverUrl,
      }),
    [
      healthQuery.data?.status,
      healthQuery.error,
      healthQuery.isPending,
      runsQuery.data?.data.diagnostics,
      runsQuery.data?.data.runs,
      runsQuery.error,
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
  const [provenanceModeEnabled, setProvenanceModeEnabled] =
    React.useState(false);
  const comparisonRunId = reconcileComparisonRunId({
    primaryRunId: selectedRunId,
    requestedComparisonRunId,
    runs: runConsole.runs,
  });
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
  const selectedRunEventsQuery = useQuery(
    localGaiaRunEventsQueryOptions({
      runId: selectedRunId ?? "",
      serverUrl,
    }),
  );
  const comparisonRunDetailQuery = useQuery(
    localGaiaRunQueryOptions({
      runId: comparisonRunId ?? "",
      serverUrl,
    }),
  );
  const comparisonRunEventsQuery = useQuery(
    localGaiaRunEventsQueryOptions({
      runId: comparisonRunId ?? "",
      serverUrl,
    }),
  );
  const runEventStream = useRunEventStream({
    enabled:
      selectedRunId !== undefined && selectedConsoleRun?.isTerminal === false,
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
  const selectedNode =
    selectedRun.nodes.find((node) => node.id === selectedNodeId) ??
    getInitialNode(selectedRun);
  const runCanvas = {
    detailError: dashboardQueryFailure(selectedRunDetailQuery.error),
    eventsError: dashboardQueryFailure(selectedRunEventsQuery.error),
    isLoading:
      selectedRunId !== undefined &&
      (selectedRunDetailQuery.isPending || selectedRunEventsQuery.isPending),
  };
  const terminalStreamEventKey =
    runEventStream.terminalEvent === undefined
      ? undefined
      : `${runEventStream.terminalEvent.sequence}:${runEventStream.terminalEvent.type}`;
  const refetchRuns = runsQuery.refetch;
  const refetchSelectedRunDetail = selectedRunDetailQuery.refetch;
  const refetchSelectedRunEvents = selectedRunEventsQuery.refetch;

  React.useEffect(() => {
    if (terminalStreamEventKey === undefined) {
      return;
    }

    void refetchRuns();
    void refetchSelectedRunDetail();
    void refetchSelectedRunEvents();
  }, [
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
      <SidebarProvider className="h-svh min-h-0 flex-col overflow-y-auto bg-background text-sm lg:flex-row lg:overflow-hidden">
        <RunConsole
          selectedRunId={selectedRunId}
          serverConnection={serverConnection}
          onRefresh={refreshRunConsole}
          onSelectRun={selectRun}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-hidden">
          <TopBar
            provenanceModeEnabled={provenanceModeEnabled}
            selectedRun={selectedRun}
            serverConnection={serverConnection}
            onToggleProvenanceMode={() =>
              setProvenanceModeEnabled((enabled) => !enabled)
            }
          />
          <RunReplayScrubber
            replayState={replayState}
            selectedRun={selectedRun}
            onSelectReplayIndex={selectReplayIndex}
          />
          <RunComparePanel
            comparisonRunId={comparisonRunId}
            comparisonRunIsLoading={
              comparisonRunId !== undefined &&
              (comparisonRunDetailQuery.isPending ||
                comparisonRunEventsQuery.isPending)
            }
            primaryRunId={selectedRunId}
            provenanceModeEnabled={provenanceModeEnabled}
            runCompare={runCompare}
            runs={runConsole.runs}
            onSelectComparisonRun={setRequestedComparisonRunId}
            onSelectPrimaryRun={selectRun}
          />
          <DesktopWorkspace
            runCanvas={runCanvas}
            runEventStream={runEventStream}
            provenanceModeEnabled={provenanceModeEnabled}
            replayState={replayState}
            runCompare={runCompare}
            selectedConsoleRun={selectedConsoleRun}
            selectedNode={selectedNode}
            selectedRun={selectedRun}
            serverUrl={serverUrl}
            onSelectNode={setSelectedNodeId}
          />
          <MobileWorkspace
            runCanvas={runCanvas}
            runEventStream={runEventStream}
            provenanceModeEnabled={provenanceModeEnabled}
            replayState={replayState}
            runCompare={runCompare}
            selectedConsoleRun={selectedConsoleRun}
            selectedNode={selectedNode}
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
  provenanceModeEnabled,
  runCompare,
  runs,
  onSelectComparisonRun,
  onSelectPrimaryRun,
}: {
  readonly comparisonRunId: string | undefined;
  readonly comparisonRunIsLoading: boolean;
  readonly primaryRunId: string | undefined;
  readonly provenanceModeEnabled: boolean;
  readonly runCompare: RunCompareModel;
  readonly runs: ReadonlyArray<RunConsoleRun>;
  readonly onSelectComparisonRun: (runId: string | undefined) => void;
  readonly onSelectPrimaryRun: (runId: string) => void;
}) {
  const canCompare = runs.length >= 2;
  const comparisonOptions = runs.filter((run) => run.id !== primaryRunId);

  return (
    <section
      className="shrink-0 border-b bg-background px-3 py-2"
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
        {provenanceModeEnabled ? (
          <div
            className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
            data-testid="run-compare-provenance-callout"
          >
            <HelpCircleIcon className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              Compare claims are derived from public run summaries, loaded event
              lists, and allowlisted artifact names. Missing rows are labelled
              unavailable instead of inferred.
            </span>
          </div>
        ) : null}
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
  selectedRunId,
  serverConnection,
  onRefresh,
  onSelectRun,
}: {
  readonly selectedRunId: string | undefined;
  readonly serverConnection: ServerConnectionState;
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
      className="run-console-sidebar h-full shrink-0 overflow-hidden border-r max-lg:overflow-y-auto max-lg:border-r-0 max-lg:border-b"
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
          <SidebarGroupLabel>Server</SidebarGroupLabel>
          <SidebarGroupContent>
            <div className="flex flex-col gap-2 rounded-md border bg-sidebar-accent/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">
                    {runConsole.serverUrl}
                  </span>
                </div>
                <Badge variant={serverBadgeVariant(runConsole.health)}>
                  {runConsole.health}
                </Badge>
              </div>
              <p
                className="text-xs text-muted-foreground"
                data-testid="run-console-server-message"
              >
                {runConsole.message}
              </p>
            </div>
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
      <SidebarFooter className="border-t">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">Server state</span>
          <Badge variant={serverBadgeVariant(runConsole.health)}>
            {runConsole.runs.length} runs
          </Badge>
        </div>
      </SidebarFooter>
    </Sidebar>
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
  );
}

function TopBar({
  provenanceModeEnabled,
  selectedRun,
  serverConnection,
  onToggleProvenanceMode,
}: {
  readonly provenanceModeEnabled: boolean;
  readonly selectedRun: DashboardRun;
  readonly serverConnection: ServerConnectionState;
  readonly onToggleProvenanceMode: () => void;
}) {
  const selectedConsoleRun = serverConnection.selectedRun;

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3">
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
      <div className="flex shrink-0 items-center gap-2">
        <Button
          aria-pressed={provenanceModeEnabled}
          data-testid="provenance-mode-toggle"
          onClick={onToggleProvenanceMode}
          size="sm"
          variant={provenanceModeEnabled ? "default" : "outline"}
        >
          <HelpCircleIcon data-icon="inline-start" />
          Provenance
        </Button>
        <Badge variant={serverBadgeVariant(serverConnection.runConsole.health)}>
          API {serverConnection.runConsole.health}
        </Badge>
        <Badge
          variant={
            selectedConsoleRun === undefined
              ? statusBadgeVariant(selectedRun.status)
              : localRunBadgeVariant(selectedConsoleRun.status)
          }
        >
          {selectedConsoleRun?.terminalLabel ??
            statusLabels[selectedRun.status]}
        </Badge>
        <Button size="sm" variant="outline">
          <GitBranchIcon data-icon="inline-start" />
          Draft PR
        </Button>
      </div>
    </header>
  );
}

function DesktopWorkspace({
  runCanvas,
  runEventStream,
  provenanceModeEnabled,
  replayState,
  runCompare,
  selectedConsoleRun,
  selectedRun,
  selectedNode,
  serverUrl,
  onSelectNode,
}: {
  readonly runCanvas: RunCanvasQueryState;
  readonly runEventStream: RunEventStreamState;
  readonly provenanceModeEnabled: boolean;
  readonly replayState: RunReplayState;
  readonly runCompare: RunCompareModel;
  readonly selectedConsoleRun: RunConsoleRun | undefined;
  readonly selectedRun: DashboardRun;
  readonly selectedNode: RunNode | undefined;
  readonly serverUrl: string;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="hidden min-h-0 flex-1 lg:block">
      <ResizablePanelGroup orientation="vertical">
        <ResizablePanel defaultSize="76%" minSize="52%">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize="68%" minSize="44%">
              <RunCanvas
                provenanceModeEnabled={provenanceModeEnabled}
                queryState={runCanvas}
                replayState={replayState}
                selectedNode={selectedNode}
                selectedRun={selectedRun}
                onSelectNode={onSelectNode}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="32%" minSize="24%">
              <EvidenceStudio
                provenanceModeEnabled={provenanceModeEnabled}
                replayState={replayState}
                runCompare={runCompare}
                selectedNode={selectedNode}
                selectedRun={selectedRun}
                serverUrl={serverUrl}
                onSelectNode={onSelectNode}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="24%" minSize="16%" maxSize="34%">
          <EventStrip
            replayState={replayState}
            selectedConsoleRun={selectedConsoleRun}
            selectedRun={selectedRun}
            streamState={runEventStream}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}

function MobileWorkspace({
  runCanvas,
  runEventStream,
  provenanceModeEnabled,
  replayState,
  runCompare,
  selectedConsoleRun,
  selectedRun,
  selectedNode,
  serverUrl,
  onSelectNode,
}: {
  readonly runCanvas: RunCanvasQueryState;
  readonly runEventStream: RunEventStreamState;
  readonly provenanceModeEnabled: boolean;
  readonly replayState: RunReplayState;
  readonly runCompare: RunCompareModel;
  readonly selectedConsoleRun: RunConsoleRun | undefined;
  readonly selectedRun: DashboardRun;
  readonly selectedNode: RunNode | undefined;
  readonly serverUrl: string;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="flex min-h-0 flex-col lg:hidden">
      <div className="min-h-[22rem] shrink-0 border-b">
        <RunCanvas
          provenanceModeEnabled={provenanceModeEnabled}
          queryState={runCanvas}
          replayState={replayState}
          selectedNode={selectedNode}
          selectedRun={selectedRun}
          onSelectNode={onSelectNode}
        />
      </div>
      <div className="min-h-[24rem] shrink-0 border-b">
        <EvidenceStudio
          provenanceModeEnabled={provenanceModeEnabled}
          replayState={replayState}
          runCompare={runCompare}
          selectedNode={selectedNode}
          selectedRun={selectedRun}
          serverUrl={serverUrl}
          onSelectNode={onSelectNode}
        />
      </div>
      <div className="h-40 shrink-0">
        <EventStrip
          replayState={replayState}
          selectedConsoleRun={selectedConsoleRun}
          selectedRun={selectedRun}
          streamState={runEventStream}
        />
      </div>
    </section>
  );
}

function RunCanvas({
  provenanceModeEnabled,
  queryState,
  replayState,
  selectedRun,
  selectedNode,
  onSelectNode,
}: {
  readonly provenanceModeEnabled: boolean;
  readonly queryState: RunCanvasQueryState;
  readonly replayState: RunReplayState;
  readonly selectedRun: DashboardRun;
  readonly selectedNode: RunNode | undefined;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  const nodes = React.useMemo(
    () =>
      toFlowNodes(
        selectedRun,
        selectedNode?.id,
        replayState,
        provenanceModeEnabled,
      ),
    [provenanceModeEnabled, replayState, selectedRun, selectedNode?.id],
  );
  const edges = React.useMemo(() => toFlowEdges(selectedRun), [selectedRun]);
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
            Thread and evidence relationships for the selected run
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {provenanceModeEnabled ? (
            <Badge variant="secondary">Provenance</Badge>
          ) : null}
          <Badge variant="outline">{selectedRun.nodes.length} nodes</Badge>
        </div>
      </div>
      {provenanceModeEnabled && selectedRun.nodes.length > 0 ? (
        <div
          className="flex shrink-0 items-start gap-2 border-b bg-background px-3 py-2 text-xs text-muted-foreground"
          data-testid="run-canvas-provenance-callout"
        >
          <HelpCircleIcon className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            Select any canvas claim, then use Evidence Studio provenance links
            to jump to supporting events, artifacts, reports, or raw public API
            fields.
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden bg-muted/20">
        {queryState.detailError !== undefined ||
        queryState.eventsError !== undefined ? (
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
        ) : selectedRun.nodes.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyTitle>No run selected</EmptyTitle>
              <EmptyDescription>
                Select a local run to populate the canvas from public run data.
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

function EvidenceStudio({
  provenanceModeEnabled,
  replayState,
  runCompare,
  selectedNode,
  selectedRun,
  serverUrl,
  onSelectNode,
}: {
  readonly provenanceModeEnabled: boolean;
  readonly replayState: RunReplayState;
  readonly runCompare: RunCompareModel;
  readonly selectedNode: RunNode | undefined;
  readonly selectedRun: DashboardRun;
  readonly serverUrl: string;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  const [tab, setTab] = React.useState<EvidenceTab>("summary");
  const artifactIds = selectedNode?.artifacts ?? [];
  const artifactKey = artifactIds.join("|");
  const [requestedArtifactId, setRequestedArtifactId] = React.useState<
    DashboardArtifactId | undefined
  >();
  const selectedArtifactId =
    requestedArtifactId !== undefined &&
    artifactIds.includes(requestedArtifactId)
      ? requestedArtifactId
      : artifactIds[0];
  const selectedRunId =
    selectedRun.id === "no-run-selected" ? "" : selectedRun.id;
  const artifactQuery = useQuery(
    localGaiaRunArtifactQueryOptions({
      artifactId: selectedArtifactId ?? "",
      runId: selectedRunId,
      serverUrl,
    }),
  );

  React.useEffect(() => {
    setRequestedArtifactId((current) =>
      current !== undefined && artifactIds.includes(current)
        ? current
        : artifactIds[0],
    );
  }, [artifactKey, selectedNode?.id]);

  if (selectedNode === undefined) {
    return (
      <aside className="flex size-full min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b px-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">Evidence Studio</h2>
            <p className="truncate text-xs text-muted-foreground">
              Select a canvas node
            </p>
          </div>
          <Badge variant="outline">Idle</Badge>
        </div>
        <Empty className="min-h-0 flex-1" data-testid="evidence-studio-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InspectIcon />
            </EmptyMedia>
            <EmptyTitle>No node selected</EmptyTitle>
            <EmptyDescription>
              Select a run canvas node to inspect its public evidence.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </aside>
    );
  }

  const relatedEvents = eventsForNode(selectedRun, selectedNode);
  const provenance = buildEvidenceProvenanceModel({
    relatedEvents,
    replayState,
    runCompare,
    selectedNode,
    selectedRun,
  });

  function selectProvenanceSource(source: ProvenanceSource) {
    const target = source.target;
    if (target === undefined) {
      return;
    }

    if (target.type === "event") {
      onSelectNode(target.eventId);
      setTab("events");
      return;
    }

    if (target.type === "artifact") {
      onSelectNode(`artifact:${target.artifactId}`);
      setRequestedArtifactId(target.artifactId);
      setTab("artifacts");
      return;
    }

    setTab("raw");
  }

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
          <Badge variant="outline">{roleLabel(selectedNode)}</Badge>
          <Badge variant={statusBadgeVariant(selectedNode.status)}>
            {statusLabels[selectedNode.status]}
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
              Events
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
            <EvidenceSummary
              provenance={provenance}
              provenanceModeEnabled={provenanceModeEnabled}
              replayState={replayState}
              relatedEvents={relatedEvents}
              selectedNode={selectedNode}
              onSelectProvenanceSource={selectProvenanceSource}
            />
          </TabsContent>
          <TabsContent className="m-0 p-3" value="events">
            <EvidenceEvents
              events={relatedEvents}
              replayState={replayState}
              selectedNode={selectedNode}
            />
          </TabsContent>
          <TabsContent className="m-0 p-3" value="artifacts">
            <EvidenceArtifacts
              artifact={artifactQuery.data?.data}
              artifactFailure={dashboardQueryFailure(artifactQuery.error)}
              artifactIds={artifactIds}
              isLoading={
                artifactQuery.isPending && selectedArtifactId !== undefined
              }
              selectedArtifactId={selectedArtifactId}
              onSelectArtifact={setRequestedArtifactId}
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
                relatedEvents,
                provenance: provenanceModeEnabled ? provenance : undefined,
                runId: selectedRun.id,
              })}
            </pre>
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </aside>
  );
}

function EvidenceSummary({
  provenance,
  provenanceModeEnabled,
  replayState,
  relatedEvents,
  selectedNode,
  onSelectProvenanceSource,
}: {
  readonly provenance: EvidenceProvenanceModel;
  readonly provenanceModeEnabled: boolean;
  readonly replayState: RunReplayState;
  readonly relatedEvents: ReadonlyArray<DashboardEvent>;
  readonly selectedNode: RunNode;
  readonly onSelectProvenanceSource: (source: ProvenanceSource) => void;
}) {
  const visibleRelatedEvents = relatedEvents.filter((event) =>
    replayState.visibleEventIds.includes(event.id),
  );
  const isSelectedNodeReached =
    relatedEvents.length === 0 || visibleRelatedEvents.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs font-medium uppercase text-muted-foreground">
          Selected node
        </p>
        <h3 className="mt-1 text-lg font-semibold">{selectedNode.label}</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {selectedNode.summary}
        </p>
      </div>
      <Separator />
      {provenanceModeEnabled ? (
        <>
          <ProvenancePanel
            provenance={provenance}
            onSelectSource={onSelectProvenanceSource}
          />
          <Separator />
        </>
      ) : null}
      <div
        className="rounded-md border bg-background p-3"
        data-testid="evidence-replay-context"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Replay context
            </p>
            <p className="mt-1 truncate text-sm font-medium">
              {replayState.currentStep?.event.label ?? "No active replay event"}
            </p>
          </div>
          <Badge variant={isSelectedNodeReached ? "secondary" : "outline"}>
            {isSelectedNodeReached ? "Reached" : "Ahead"}
          </Badge>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {visibleRelatedEvents.length} of {relatedEvents.length} related events
          are visible at the selected replay point.
        </p>
      </div>
      <Separator />
      <div className="grid grid-cols-2 gap-3">
        <Metric label="Role" value={roleLabel(selectedNode)} />
        <Metric label="Status" value={statusLabels[selectedNode.status]} />
        <Metric label="Events" value={String(relatedEvents.length)} />
        <Metric
          label="Artifacts"
          value={String(selectedNode.artifacts.length)}
        />
      </div>
      <Separator />
      <EvidenceList
        emptyDescription="This node has no additional public evidence strings."
        emptyTitle="No evidence notes"
        items={selectedNode.evidence}
      />
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

function ProvenancePanel({
  provenance,
  onSelectSource,
}: {
  readonly provenance: EvidenceProvenanceModel;
  readonly onSelectSource: (source: ProvenanceSource) => void;
}) {
  return (
    <section
      className="flex flex-col gap-3"
      data-testid="evidence-provenance-panel"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-muted-foreground">
            Provenance
          </p>
          <p className="mt-1 truncate text-sm font-medium">
            Why the dashboard says this
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <Badge variant="secondary">{provenance.supportedCount} proven</Badge>
          <Badge variant="outline">
            {provenance.unavailableCount} unavailable
          </Badge>
          <Badge variant="outline">
            {provenance.unsupportedCount} unsupported
          </Badge>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {provenance.claims.map((claim) => (
          <section
            className="rounded-md border bg-background p-3"
            data-testid={`provenance-claim-${claim.id}`}
            key={claim.id}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{claim.label}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {claim.value}
                </p>
              </div>
              <Badge variant={provenanceBadgeVariant(claim.availability)}>
                {provenanceAvailabilityLabel(claim.availability)}
              </Badge>
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {claim.sources.map((source, index) => (
                <div
                  className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-2 py-2"
                  key={`${source.kind}:${source.label}:${index}`}
                >
                  <Badge variant="outline">{sourceKindLabel(source.kind)}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">
                      {source.label}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {source.detail}
                    </p>
                  </div>
                  <Button
                    aria-label={`Show ${source.label}`}
                    disabled={source.target === undefined}
                    onClick={() => onSelectSource(source)}
                    size="sm"
                    variant="outline"
                  >
                    <LinkIcon data-icon="inline-start" />
                    Source
                  </Button>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function EvidenceEvents({
  events,
  replayState,
  selectedNode,
}: {
  readonly events: ReadonlyArray<DashboardEvent>;
  readonly replayState: RunReplayState;
  readonly selectedNode: RunNode;
}) {
  if (events.length === 0) {
    return (
      <Empty className="min-h-48 border" data-testid="evidence-events-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ActivityIcon />
          </EmptyMedia>
          <EmptyTitle>No related events</EmptyTitle>
          <EmptyDescription>
            {selectedNode.label} has no ordered public events attached.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {events.map((event) => (
        <section
          className={cn(
            "rounded-md border bg-background p-3",
            event.id === replayState.activeEventId && "ring-2 ring-ring",
            replayState.futureEventIds.includes(event.id) && "opacity-55",
          )}
          data-testid={`evidence-event-${event.sequence}`}
          key={event.id}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{event.label}</p>
              <p className="truncate text-xs text-muted-foreground">
                Sequence {event.sequence} · {event.timestamp}
              </p>
            </div>
            <Badge variant={statusBadgeVariant(event.tone)}>
              {statusLabels[event.tone]}
            </Badge>
          </div>
          <Separator className="my-3" />
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{event.type}</Badge>
            {event.id === replayState.activeEventId ? (
              <Badge variant="secondary">Replay point</Badge>
            ) : null}
            {replayState.futureEventIds.includes(event.id) ? (
              <Badge variant="outline">Not reached</Badge>
            ) : null}
            {event.artifactHints.map((artifactId) => (
              <Badge key={artifactId} variant="secondary">
                {artifactLabel(artifactId)}
              </Badge>
            ))}
          </div>
          <pre className="mt-3 max-h-44 overflow-auto rounded-md bg-muted p-3 text-xs">
            {stringifyJson(event.payload)}
          </pre>
        </section>
      ))}
    </div>
  );
}

function EvidenceArtifacts({
  artifact,
  artifactFailure,
  artifactIds,
  isLoading,
  selectedArtifactId,
  onSelectArtifact,
}: {
  readonly artifact: typeof LocalRunArtifactDto.Type | undefined;
  readonly artifactFailure: ReturnType<typeof dashboardQueryFailure>;
  readonly artifactIds: ReadonlyArray<DashboardArtifactId>;
  readonly isLoading: boolean;
  readonly selectedArtifactId: DashboardArtifactId | undefined;
  readonly onSelectArtifact: (artifactId: DashboardArtifactId) => void;
}) {
  if (artifactIds.length === 0) {
    return (
      <Empty className="min-h-48 border" data-testid="evidence-artifacts-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BoxIcon />
          </EmptyMedia>
          <EmptyTitle>No artifacts exposed</EmptyTitle>
          <EmptyDescription>
            This node has no allowlisted artifacts in the public run detail.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {artifactIds.map((artifactId) => (
          <Button
            key={artifactId}
            size="sm"
            variant={artifactId === selectedArtifactId ? "default" : "outline"}
            onClick={() => onSelectArtifact(artifactId)}
          >
            <BoxIcon data-icon="inline-start" />
            {artifactLabel(artifactId)}
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
              Choose an allowlisted artifact to read it through the Gaia API.
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
                {artifactLabel(artifact.artifactName)}
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

function Metric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="rounded-md border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium">{value}</p>
    </div>
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

function toFlowNodes(
  run: DashboardRun,
  selectedNodeId: string | undefined,
  replayState: RunReplayState,
  provenanceModeEnabled: boolean,
): Array<Node<{ label: React.ReactNode }>> {
  const futureEventIds = new Set(replayState.futureEventIds);
  const visibleEventIds = new Set(replayState.visibleEventIds);

  return run.nodes.map((node) => {
    const sourceCount = Math.max(
      node.eventIds.length + node.artifacts.length + node.evidence.length,
      1,
    );

    return {
      id: node.id,
      position: node.position,
      data: {
        label: (
          <div className="flex min-w-52 max-w-64 flex-col gap-2 text-left">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-sm font-semibold">
                {node.label}
              </span>
              <Badge variant={statusBadgeVariant(node.status)}>
                {statusLabels[node.status]}
              </Badge>
            </div>
            <span className="text-xs text-muted-foreground">
              {roleLabel(node)}
            </span>
            {provenanceModeEnabled ? (
              <Badge variant="outline">Why: {sourceCount} sources</Badge>
            ) : null}
          </div>
        ),
      },
      type: node.role === "orchestrator" ? "input" : "default",
      className: cn(
        "rounded-lg border bg-background px-2 py-1 shadow-sm",
        node.id === replayState.activeEventId && "ring-2 ring-primary",
        node.eventIds.length > 0 &&
          !node.eventIds.some((eventId) => visibleEventIds.has(eventId)) &&
          "opacity-50",
        node.role === "event" && futureEventIds.has(node.id) && "opacity-50",
        node.id === selectedNodeId && "ring-2 ring-ring",
      ),
    };
  });
}

function toFlowEdges(run: DashboardRun): Array<Edge> {
  return run.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: "smoothstep",
    animated: edge.label === "then",
  }));
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

function provenanceBadgeVariant(
  availability: ProvenanceAvailability,
): "destructive" | "outline" | "secondary" {
  if (availability === "supported") {
    return "secondary";
  }

  if (availability === "unsupported") {
    return "destructive";
  }

  return "outline";
}

function provenanceAvailabilityLabel(availability: ProvenanceAvailability) {
  if (availability === "supported") {
    return "Proven";
  }

  if (availability === "unsupported") {
    return "Unsupported";
  }

  return "Unavailable";
}

function sourceKindLabel(kind: ProvenanceSource["kind"]) {
  return kind
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

type RunCanvasQueryState = {
  readonly detailError: ReturnType<typeof dashboardQueryFailure>;
  readonly eventsError: ReturnType<typeof dashboardQueryFailure>;
  readonly isLoading: boolean;
};

function runCanvasErrorMessage(state: RunCanvasQueryState) {
  const failure = state.detailError ?? state.eventsError;

  return dashboardFailureMessage(
    failure,
    "The selected run could not be loaded.",
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
