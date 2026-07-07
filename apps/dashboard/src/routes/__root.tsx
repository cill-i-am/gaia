import type { ReactNode } from "react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";

import "@xyflow/react/dist/style.css";
import "../styles.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Gaia Dashboard" },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div id="root">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}

function NotFoundComponent() {
  return (
    <main className="flex h-svh items-center justify-center bg-background p-6 text-center">
      <div className="flex max-w-sm flex-col gap-2">
        <h1 className="text-lg font-semibold">Dashboard route not found</h1>
        <p className="text-sm text-muted-foreground">
          The GAIA-38 shell exposes the root operator surface only.
        </p>
      </div>
    </main>
  );
}
