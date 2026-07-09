"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function CanvasInspectorSheet({
  children,
  className,
  open,
  ...props
}: React.ComponentProps<"div"> & {
  readonly open: boolean
}) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        "absolute inset-y-0 right-0 z-20 flex w-[min(26rem,42vw)] flex-col border-l bg-background text-foreground shadow-lg transition-transform duration-200 ease-out data-[state=closed]:pointer-events-none data-[state=closed]:translate-x-full data-[state=open]:translate-x-0 motion-reduce:transition-none",
        className,
      )}
      data-slot="canvas-inspector-sheet"
      data-state={open ? "open" : "closed"}
      {...props}
    >
      {children}
    </div>
  )
}

function CanvasInspectorSheetContent({
  className,
  ...props
}: React.ComponentProps<"aside">) {
  return (
    <aside
      className={cn("flex size-full min-h-0 flex-col", className)}
      data-slot="canvas-inspector-sheet-content"
      {...props}
    />
  )
}

function CanvasInspectorSheetHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-11 shrink-0 items-center justify-between gap-3 border-b px-3",
        className,
      )}
      data-slot="canvas-inspector-sheet-header"
      {...props}
    />
  )
}

function CanvasInspectorSheetTitle({
  className,
  ...props
}: React.ComponentProps<"h2">) {
  return (
    <h2
      className={cn("truncate text-sm font-semibold", className)}
      data-slot="canvas-inspector-sheet-title"
      {...props}
    />
  )
}

function CanvasInspectorSheetDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("truncate text-xs text-muted-foreground", className)}
      data-slot="canvas-inspector-sheet-description"
      {...props}
    />
  )
}

export {
  CanvasInspectorSheet,
  CanvasInspectorSheetContent,
  CanvasInspectorSheetDescription,
  CanvasInspectorSheetHeader,
  CanvasInspectorSheetTitle,
}
