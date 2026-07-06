# Examples Intent

`examples/*` contains portable fixtures and smoke-test inputs. Examples should
make Gaia easy to demo without requiring live GitHub, Linear, Codex, or browser
state.

## Example Rules

- Keep examples static, deterministic, and safe to run locally.
- Do not put real secrets, credentials, private repository data, or user
  workspace state in examples.
- Use synthetic IDs, URLs, and issue data unless the user explicitly asks for a
  real integration fixture.
- Example specs should be small enough for smoke tests and demos. They are not
  product requirements documents.
- Example JSON should match the current parser-owned shape. If a schema changes,
  update the fixture and the parser/test together.
