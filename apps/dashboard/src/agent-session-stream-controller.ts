import type { AgentSessionUpdateDto } from "@gaia/core";

import {
  openAgentSessionEventSource,
  type DashboardGaiaClientConfig,
} from "@/lib/local-gaia-client";

export type AgentSessionStreamConnection =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "unavailable";

type StreamTarget = {
  readonly agentId: string | undefined;
  readonly isOpen: boolean;
  readonly runId: string | undefined;
};

type OpenStreamTarget = {
  readonly agentId: string;
  readonly isOpen: true;
  readonly runId: string;
};

type StreamHandle = {
  readonly close: () => void;
};

export function createAgentSessionStreamController(input: {
  readonly onConnectionChange: (state: AgentSessionStreamConnection) => void;
  readonly onError: (error: unknown) => void;
  readonly onUpdate: (update: typeof AgentSessionUpdateDto.Type) => void;
  readonly openSource?: (
    config: DashboardGaiaClientConfig & {
      readonly afterSequence?: number;
      readonly agentId: string;
      readonly runId: string;
    },
    handlers: {
      readonly onError: (error: unknown) => void;
      readonly onUpdate: (update: typeof AgentSessionUpdateDto.Type) => void;
    },
  ) => StreamHandle;
  readonly serverUrl: string;
}) {
  const openSource =
    input.openSource ??
    ((config, handlers) => openAgentSessionEventSource(config, handlers));
  let current: StreamHandle | undefined;
  let lastSequence: number | undefined;
  let target: StreamTarget | undefined;
  let terminal = false;

  const closeCurrent = () => {
    if (current === undefined) return;
    const closing = current;
    current = undefined;
    closing.close();
  };

  const canOpen = (
    nextTarget: StreamTarget | undefined,
  ): nextTarget is OpenStreamTarget =>
    nextTarget?.isOpen === true &&
    nextTarget.runId !== undefined &&
    nextTarget.agentId !== undefined &&
    !terminal;

  const openCurrent = (connection: AgentSessionStreamConnection) => {
    const currentTarget = target;
    if (!canOpen(currentTarget)) return;
    input.onConnectionChange(connection);
    try {
      current = openSource(
        {
          agentId: currentTarget.agentId,
          runId: currentTarget.runId,
          serverUrl: input.serverUrl,
          ...(lastSequence === undefined ? {} : { afterSequence: lastSequence }),
        },
        {
          onError: handleError,
          onUpdate: handleUpdate,
        },
      );
      input.onConnectionChange("connected");
    } catch (error) {
      current = undefined;
      input.onError(error);
      input.onConnectionChange("unavailable");
    }
  };

  function handleUpdate(update: typeof AgentSessionUpdateDto.Type) {
    if (
      lastSequence !== undefined &&
      update.eventSequence <= lastSequence &&
      !update.terminal
    ) {
      return;
    }

    lastSequence = update.eventSequence;
    input.onUpdate(update);

    if (update.terminal) {
      terminal = true;
      closeCurrent();
    }
  }

  function handleError(error: unknown) {
    input.onError(error);
    closeCurrent();
    if (canOpen(target)) {
      openCurrent("reconnecting");
      return;
    }
    input.onConnectionChange("unavailable");
  }

  return {
    dispose: () => {
      target = undefined;
      closeCurrent();
    },
    handleError,
    handleUpdate,
    sync: (nextTarget: StreamTarget) => {
      const previousKey =
        target?.runId === undefined || target.agentId === undefined
          ? undefined
          : `${target.runId}:${target.agentId}`;
      const nextKey =
        nextTarget.runId === undefined || nextTarget.agentId === undefined
          ? undefined
          : `${nextTarget.runId}:${nextTarget.agentId}`;
      const changed = previousKey !== nextKey;

      target = nextTarget;
      if (!nextTarget.isOpen || nextKey === undefined) {
        closeCurrent();
        return;
      }

      if (changed) {
        terminal = false;
        lastSequence = undefined;
        closeCurrent();
      }

      if (current === undefined && !terminal) {
        openCurrent("connecting");
      }
    },
  };
}
