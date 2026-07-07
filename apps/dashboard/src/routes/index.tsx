import { createFileRoute } from "@tanstack/react-router";

import { DashboardShell } from "@/components/dashboard-shell";

export const Route = createFileRoute("/")({
  component: DashboardRoute,
});

function DashboardRoute() {
  return <DashboardShell />;
}
