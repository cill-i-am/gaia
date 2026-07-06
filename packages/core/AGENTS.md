# Core Intent

`packages/core` owns pure Gaia contracts: schemas, branded values, run IDs, spec
parsing, XState lifecycle, event replay, snapshots, and report models.

## Core Rules

- Keep core deterministic and side-effect free. Do not import Node platform
  APIs, filesystem services, GitHub/browser clients, or runtime adapters here.
- Core owns the event vocabulary and lifecycle transitions. Runtime may append
  events, but core decides how those events replay into state.
- Parse and brand domain values here when they are part of Gaia's durable
  contract, such as run IDs, spec metadata, event payloads, snapshots, and
  reports.
- Keep persisted event payloads plain and serializable. If a value cannot
  survive JSON round-tripping, it does not belong in a core event schema.
- Add replay tests whenever event shape, lifecycle status, or snapshot behavior
  changes.
