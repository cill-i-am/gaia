import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import {
  ActivityIcon,
  BoxIcon,
  BracesIcon,
  CircleDotIcon,
  GitBranchIcon,
  InspectIcon,
  SearchIcon,
  WorkflowIcon,
} from "lucide-react";
import * as React from "react";

import {
  dashboardRuns,
  getInitialNode,
  getInitialRun,
  type DashboardRun,
  type EvidenceTab,
  type RunNode,
  type RunStatus,
} from "@/dashboard-model";
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

export function DashboardShell() {
  const initialRun = getInitialRun();
  const [selectedRunId, setSelectedRunId] = React.useState<string>(
    initialRun.id,
  );
  const selectedRun =
    dashboardRuns.find((run) => run.id === selectedRunId) ?? initialRun;
  const [selectedNodeId, setSelectedNodeId] = React.useState(
    getInitialNode(selectedRun).id,
  );
  const selectedNode =
    selectedRun.nodes.find((node) => node.id === selectedNodeId) ??
    getInitialNode(selectedRun);

  function selectRun(run: DashboardRun) {
    setSelectedRunId(run.id);
    setSelectedNodeId(getInitialNode(run).id);
  }

  return (
    <TooltipProvider delayDuration={250}>
      <SidebarProvider
        className="h-svh min-h-0 flex-col overflow-hidden bg-background text-sm lg:flex-row"
      >
        <RunConsole selectedRun={selectedRun} onSelectRun={selectRun} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TopBar selectedRun={selectedRun} />
          <DesktopWorkspace
            selectedNode={selectedNode}
            selectedRun={selectedRun}
            onSelectNode={setSelectedNodeId}
          />
          <MobileWorkspace
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
  selectedRun,
  onSelectRun,
}: {
  readonly selectedRun: DashboardRun;
  readonly onSelectRun: (run: DashboardRun) => void;
}) {
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
              <Button size="icon" variant="outline" aria-label="Filter runs">
                <SearchIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Filter runs</TooltipContent>
          </Tooltip>
        </div>
        <Input aria-label="Search runs" placeholder="Search local runs" />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Local runs</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {dashboardRuns.map((run) => (
                <SidebarMenuItem key={run.id}>
                  <SidebarMenuButton
                    className="h-auto items-start gap-3 py-2"
                    isActive={run.id === selectedRun.id}
                    onClick={() => onSelectRun(run)}
                  >
                    <WorkflowIcon />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {run.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {run.branch}
                      </span>
                    </span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge>{run.updatedAt}</SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">Server state</span>
          <Badge variant="outline">Placeholder</Badge>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function TopBar({ selectedRun }: { readonly selectedRun: DashboardRun }) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="lg:hidden" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{selectedRun.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {selectedRun.id} · {selectedRun.branch}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant={statusBadgeVariant(selectedRun.status)}>
          {statusLabels[selectedRun.status]}
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
  selectedRun,
  selectedNode,
  onSelectNode,
}: {
  readonly selectedRun: DashboardRun;
  readonly selectedNode: RunNode;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="hidden min-h-0 flex-1 lg:block">
      <ResizablePanelGroup orientation="vertical">
        <ResizablePanel defaultSize="76%" minSize="52%">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize="68%" minSize="44%">
              <RunCanvas
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
  selectedRun,
  selectedNode,
  onSelectNode,
}: {
  readonly selectedRun: DashboardRun;
  readonly selectedNode: RunNode;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col lg:hidden">
      <div className="min-h-[22rem] flex-1 border-b">
        <RunCanvas
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
  selectedRun,
  selectedNode,
  onSelectNode,
}: {
  readonly selectedRun: DashboardRun;
  readonly selectedNode: RunNode;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  const nodes = React.useMemo(
    () => toFlowNodes(selectedRun, selectedNode.id),
    [selectedRun, selectedNode.id],
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
        {selectedRun.nodes.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyTitle>No run graph</EmptyTitle>
              <EmptyDescription>
                Select a run with recorded events to populate the canvas.
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

function EvidenceStudio({ selectedNode }: { readonly selectedNode: RunNode }) {
  const [tab, setTab] = React.useState<EvidenceTab>("summary");

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
  selectedNodeId: string,
): Array<Node<{ label: React.ReactNode }>> {
  return run.nodes.map((node) => ({
    id: node.id,
    position: node.position,
    data: {
      label: (
        <div className="flex min-w-48 flex-col gap-2 text-left">
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
    animated: edge.target === "browser",
  }));
}
