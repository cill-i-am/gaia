import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import { useQuery } from "@tanstack/react-query";
import {
  ActivityIcon,
  AlertCircleIcon,
  BoxIcon,
  BracesIcon,
  CircleDotIcon,
  GitBranchIcon,
  InspectIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  WorkflowIcon,
} from "lucide-react";
import * as React from "react";

import {
  type DashboardRun,
  type EvidenceTab,
  type RunNode,
  type RunStatus,
  buildRunCanvasModel,
  eventTypeLabel,
  getInitialNode,
  stateLabel,
} from "@/run-canvas-model";
import { defaultLocalGaiaServerUrl } from "@/lib/local-gaia-client";
import {
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

function roleLabel(node: RunNode) {
  return `${node.role[0]?.toUpperCase() ?? ""}${node.role.slice(1)}`;
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
  const selectedConsoleRun = selectedRunFromConsoleState(
    selectedRunId,
    runConsole.runs,
  );
  const selectedRunSummaryFromList = runsQuery.data?.data.runs.find(
    (run) => run.runId === selectedRunId,
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
  const selectedRunSummary =
    selectedRunDetailQuery.data?.data ?? selectedRunSummaryFromList;
  const selectedRun = React.useMemo(
    () =>
      buildRunCanvasModel({
        events: selectedRunEventsQuery.data?.data.events ?? [],
        run: selectedRunSummary,
      }),
    [selectedRunEventsQuery.data?.data.events, selectedRunSummary],
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

    void Promise.all(refreshes);
  }

  function selectRun(runId: string) {
    setRequestedSelectedRunId(runId);
    setSelectedNodeId(undefined);
  }

  return (
    <TooltipProvider delayDuration={250}>
      <SidebarProvider
        className="h-svh min-h-0 flex-col overflow-hidden bg-background text-sm lg:flex-row"
      >
        <RunConsole
          selectedRunId={selectedRunId}
          serverConnection={serverConnection}
          onRefresh={refreshRunConsole}
          onSelectRun={selectRun}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TopBar
            selectedRun={selectedRun}
            serverConnection={serverConnection}
          />
          <DesktopWorkspace
            runCanvas={runCanvas}
            selectedNode={selectedNode}
            selectedRun={selectedRun}
            onSelectNode={setSelectedNodeId}
          />
          <MobileWorkspace
            runCanvas={runCanvas}
            selectedNode={selectedNode}
            selectedRun={selectedRun}
            onSelectNode={setSelectedNodeId}
          />
        </main>
      </SidebarProvider>
    </TooltipProvider>
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
      className="run-console-sidebar h-full shrink-0 border-r max-lg:border-r-0 max-lg:border-b"
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
            <TooltipTrigger asChild>
              <Button
                aria-label="Refresh local runs"
                disabled={runConsole.isLoading}
                onClick={onRefresh}
                size="icon"
                variant="outline"
              >
                <RefreshCwIcon
                  className={cn(runConsole.isLoading && "animate-spin")}
                />
              </Button>
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
  selectedRun,
  serverConnection,
}: {
  readonly selectedRun: DashboardRun;
  readonly serverConnection: ServerConnectionState;
}) {
  const selectedConsoleRun = serverConnection.selectedRun;

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="lg:hidden" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" data-testid="selected-run-title">
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
          {selectedConsoleRun?.terminalLabel ?? statusLabels[selectedRun.status]}
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
  selectedRun,
  selectedNode,
  onSelectNode,
}: {
  readonly runCanvas: RunCanvasQueryState;
  readonly selectedRun: DashboardRun;
  readonly selectedNode: RunNode | undefined;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="hidden min-h-0 flex-1 lg:block">
      <ResizablePanelGroup orientation="vertical">
        <ResizablePanel defaultSize="76%" minSize="52%">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize="68%" minSize="44%">
              <RunCanvas
                queryState={runCanvas}
                selectedNode={selectedNode}
                selectedRun={selectedRun}
                onSelectNode={onSelectNode}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="32%" minSize="24%">
              <EvidenceStudio selectedNode={selectedNode} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="24%" minSize="16%" maxSize="34%">
          <EventStrip selectedRun={selectedRun} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}

function MobileWorkspace({
  runCanvas,
  selectedRun,
  selectedNode,
  onSelectNode,
}: {
  readonly runCanvas: RunCanvasQueryState;
  readonly selectedRun: DashboardRun;
  readonly selectedNode: RunNode | undefined;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col lg:hidden">
      <div className="min-h-[22rem] flex-1 border-b">
        <RunCanvas
          queryState={runCanvas}
          selectedNode={selectedNode}
          selectedRun={selectedRun}
          onSelectNode={onSelectNode}
        />
      </div>
      <div className="min-h-0 flex-1 border-b">
        <EvidenceStudio selectedNode={selectedNode} />
      </div>
      <div className="h-40 shrink-0">
        <EventStrip selectedRun={selectedRun} />
      </div>
    </section>
  );
}

function RunCanvas({
  queryState,
  selectedRun,
  selectedNode,
  onSelectNode,
}: {
  readonly queryState: RunCanvasQueryState;
  readonly selectedRun: DashboardRun;
  readonly selectedNode: RunNode | undefined;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  const nodes = React.useMemo(
    () => toFlowNodes(selectedRun, selectedNode?.id),
    [selectedRun, selectedNode?.id],
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
        <Badge variant="outline">{selectedRun.nodes.length} nodes</Badge>
      </div>
      <div className="min-h-0 flex-1 bg-muted/20">
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
  selectedNode,
}: {
  readonly selectedNode: RunNode | undefined;
}) {
  const [tab, setTab] = React.useState<EvidenceTab>("summary");

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

  return (
    <aside className="flex size-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b px-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">Evidence Studio</h2>
          <p className="truncate text-xs text-muted-foreground">
            {selectedNode.label}
          </p>
        </div>
        <Badge variant={statusBadgeVariant(selectedNode.status)}>
          {statusLabels[selectedNode.status]}
        </Badge>
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
            <EvidenceSummary selectedNode={selectedNode} />
          </TabsContent>
          <TabsContent className="m-0 p-3" value="events">
            <EvidenceList items={selectedNode.evidence} />
          </TabsContent>
          <TabsContent className="m-0 p-3" value="artifacts">
            <EvidenceList items={selectedNode.artifacts} />
          </TabsContent>
          <TabsContent className="m-0 p-3" value="raw">
            <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(selectedNode, null, 2)}
            </pre>
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </aside>
  );
}

function EvidenceSummary({ selectedNode }: { readonly selectedNode: RunNode }) {
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
      <div className="grid grid-cols-2 gap-3">
        <Metric label="Role" value={roleLabel(selectedNode)} />
        <Metric label="Status" value={statusLabels[selectedNode.status]} />
      </div>
    </div>
  );
}

function EvidenceList({ items }: { readonly items: ReadonlyArray<string> }) {
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

function EventStrip({ selectedRun }: { readonly selectedRun: DashboardRun }) {
  return (
    <section className="flex size-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3">
        <h2 className="truncate text-sm font-semibold">Live Event Strip</h2>
        <Badge variant="outline">Static</Badge>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex min-w-max gap-2 p-3">
          {selectedRun.events.map((event) => (
            <div
              className="flex w-72 shrink-0 flex-col gap-2 rounded-md border bg-background p-3"
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
              <p className="text-sm font-medium">{event.label}</p>
            </div>
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}

function toFlowNodes(
  run: DashboardRun,
  selectedNodeId: string | undefined,
): Array<Node<{ label: React.ReactNode }>> {
  return run.nodes.map((node) => ({
    id: node.id,
    position: node.position,
    data: {
      label: (
        <div className="flex min-w-52 max-w-64 flex-col gap-2 text-left">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate text-sm font-semibold">{node.label}</span>
            <Badge variant={statusBadgeVariant(node.status)}>
              {statusLabels[node.status]}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">
            {roleLabel(node)}
          </span>
        </div>
      ),
    },
    type: node.role === "orchestrator" ? "input" : "default",
    className: cn(
      "rounded-lg border bg-background px-2 py-1 shadow-sm",
      node.id === selectedNodeId && "ring-2 ring-ring",
    ),
  }));
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

type RunCanvasQueryState = {
  readonly detailError: ReturnType<typeof dashboardQueryFailure>;
  readonly eventsError: ReturnType<typeof dashboardQueryFailure>;
  readonly isLoading: boolean;
};

function runCanvasErrorMessage(state: RunCanvasQueryState) {
  const failure = state.detailError ?? state.eventsError;

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

  return "The selected run could not be loaded.";
}
