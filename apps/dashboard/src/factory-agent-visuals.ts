import type { FactoryAgentRole, FactoryAgentState } from "@gaia/core";
import type { LucideIcon } from "lucide-react";
import {
  BotIcon,
  FlaskConicalIcon,
  HelpCircleIcon,
  RadarIcon,
  SearchIcon,
  ShieldCheckIcon,
  WorkflowIcon,
} from "lucide-react";

export type FactoryAgentRoleVisual = {
  readonly accentClassName: string;
  readonly description: string;
  readonly Icon: LucideIcon;
  readonly label: string;
};

type FactoryAgentStateVisual = {
  readonly label: string;
  readonly variant: "destructive" | "outline" | "secondary";
};

export const factoryAgentRoleVisuals = {
  ciWatcher: {
    accentClassName: "border-cyan-500/40 bg-cyan-500/10 text-cyan-900",
    description: "monitors & self-heals",
    Icon: RadarIcon,
    label: "CI watcher",
  },
  orchestrator: {
    accentClassName: "border-emerald-500/40 bg-emerald-500/10 text-emerald-900",
    description: "plans & coordinates",
    Icon: WorkflowIcon,
    label: "Orchestrator",
  },
  researcher: {
    accentClassName: "border-indigo-500/40 bg-indigo-500/10 text-indigo-900",
    description: "gathers context",
    Icon: SearchIcon,
    label: "Researcher",
  },
  reviewer: {
    accentClassName: "border-amber-500/40 bg-amber-500/10 text-amber-900",
    description: "checks spec adherence",
    Icon: ShieldCheckIcon,
    label: "Reviewer",
  },
  tester: {
    accentClassName: "border-sky-500/40 bg-sky-500/10 text-sky-900",
    description: "verifies behavior",
    Icon: FlaskConicalIcon,
    label: "Tester",
  },
  unknown: {
    accentClassName: "border-muted bg-muted/30 text-muted-foreground",
    description: "role unavailable",
    Icon: HelpCircleIcon,
    label: "Unknown",
  },
  worker: {
    accentClassName: "border-rose-500/40 bg-rose-500/10 text-rose-900",
    description: "implements changes",
    Icon: BotIcon,
    label: "Worker",
  },
} satisfies Record<FactoryAgentRole, FactoryAgentRoleVisual>;

const factoryAgentStateVisuals = {
  blocked: { label: "Blocked", variant: "destructive" },
  canceled: { label: "Canceled", variant: "destructive" },
  failed: { label: "Failed", variant: "destructive" },
  pending: { label: "Pending", variant: "outline" },
  running: { label: "Running", variant: "outline" },
  succeeded: { label: "Succeeded", variant: "secondary" },
  unknown: { label: "Unknown", variant: "outline" },
} satisfies Record<FactoryAgentState, FactoryAgentStateVisual>;

export function factoryAgentRoleVisual(
  role: FactoryAgentRole | undefined
): FactoryAgentRoleVisual {
  return factoryAgentRoleVisuals[role ?? "unknown"];
}

export function factoryAgentStateLabel(state: FactoryAgentState | undefined) {
  if (state === undefined) {
    return "Unknown";
  }

  return factoryAgentStateVisuals[state].label;
}

export function factoryAgentStateBadgeVariant(
  state: FactoryAgentState | undefined
): "destructive" | "outline" | "secondary" {
  return state === undefined
    ? "outline"
    : factoryAgentStateVisuals[state].variant;
}
