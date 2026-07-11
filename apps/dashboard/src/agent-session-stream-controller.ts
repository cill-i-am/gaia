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
  readonly rearmSequence?: number;
  readonly runId: string | undefined;
  readonly sessionId?: string;
  readonly snapshotSequence?: number;
};

type OpenStreamTarget = {
  readonly agentId: string;
  readonly isOpen: true;
  readonly runId: string;
  readonly sessionId: string;
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
  let generation = 0;

  const closeCurrent = () => {
    if (current === undefined) return;
    const closing = current;
    current = undefined;
    generation += 1;
    closing.close();
  };

  const canOpen = (
    nextTarget: StreamTarget | undefined,
  ): nextTarget is OpenStreamTarget =>
    nextTarget?.isOpen === true &&
    nextTarget.runId !== undefined &&
    nextTarget.agentId !== undefined &&
    nextTarget.sessionId !== undefined &&
    !terminal;

  const openCurrent = (connection: AgentSessionStreamConnection) => {
    const currentTarget = target;
    if (!canOpen(currentTarget)) return;
    const openingGeneration = generation + 1;
    generation = openingGeneration;
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
          onError: (error) => handleGenerationError(openingGeneration, error),
          onUpdate: (update) =>
            handleGenerationUpdate(openingGeneration, update),
        },
      );
      input.onConnectionChange("connected");
    } catch (error) {
      current = undefined;
      input.onError(error);
      input.onConnectionChange("unavailable");
    }
  };

  function handleGenerationUpdate(
    updateGeneration: number,
    update: typeof AgentSessionUpdateDto.Type,
  ) {
    if (updateGeneration !== generation) return;

    const currentTarget = target;
    if (
      currentTarget?.runId !== update.runId ||
      currentTarget.agentId !== update.agentId ||
      (currentTarget.sessionId !== undefined &&
        currentTarget.sessionId !== update.sessionId)
    ) {
      input.onError(new Error("Agent session stream identity changed"));
      terminal = true;
      closeCurrent();
      input.onConnectionChange("unavailable");
      return;
    }

    if (lastSequence !== undefined && update.eventSequence <= lastSequence) return;

    lastSequence = update.eventSequence;
    input.onUpdate(update);

    if (update.terminal) {
      terminal = true;
      closeCurrent();
    }
  }

  function handleGenerationError(errorGeneration: number, error: unknown) {
    if (errorGeneration !== generation) return;
    input.onError(error);
    closeCurrent();
    if (canOpen(target)) {
      openCurrent("reconnecting");
      return;
    }
    input.onConnectionChange("unavailable");
  }

  const targetKey = (streamTarget: StreamTarget | undefined) => {
    if (
      streamTarget?.runId === undefined ||
      streamTarget.agentId === undefined ||
      streamTarget.sessionId === undefined
    ) {
      return undefined;
    }
    return `${streamTarget.runId}:${streamTarget.agentId}:${streamTarget.sessionId}`;
  };

  return {
    dispose: () => {
      target = undefined;
      closeCurrent();
    },
    handleError: (error: unknown) => handleGenerationError(generation, error),
    handleUpdate: (update: typeof AgentSessionUpdateDto.Type) =>
      handleGenerationUpdate(generation, update),
    sync: (nextTarget: StreamTarget) => {
      const previousKey = targetKey(target);
      const previousRearmSequence = target?.rearmSequence;
      const nextKey = targetKey(nextTarget);
      const changed = previousKey !== nextKey;
      const rearmed =
        !changed &&
        nextTarget.rearmSequence !== undefined &&
        (previousRearmSequence === undefined ||
          nextTarget.rearmSequence > previousRearmSequence);

      target = nextTarget;
      if (!nextTarget.isOpen || nextKey === undefined) {
        closeCurrent();
        return;
      }

      if (changed) {
        terminal = false;
        lastSequence = nextTarget.snapshotSequence;
        closeCurrent();
      } else {
        lastSequence = maximumDefined(
          lastSequence,
          nextTarget.snapshotSequence,
        );
      }

      if (rearmed) {
        terminal = false;
        lastSequence = Math.max(
          lastSequence ?? 0,
          nextTarget.rearmSequence ?? 0,
        );
        closeCurrent();
      }

      if (current === undefined && !terminal) {
        openCurrent("connecting");
      }
    },
  };
}

function maximumDefined(
  left: number | undefined,
  right: number | undefined,
) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}
