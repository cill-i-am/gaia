# Oxlint Compatibility Profile

Gaia uses Ultracite's current Oxlint presets through an explicit compatibility
profile. This file explains why the green `pnpm lint` gate is not a claim of
full preset compliance and records every inherited rule family that remains
non-gating.

## Ownership and commands

Gaia-owned JavaScript and TypeScript source is under `apps/`, `packages/`,
`examples/`, and `scripts/`. The compatibility lint also checks the three
root Oxc config files.

The following paths are excluded by ownership or because they are generated:

- `.agents/skills/**` is tracked, vendored agent tooling rather than Gaia
  product source.
- `.gaia/**` is generated local run state.
- Ultracite's canonical generated/dependency/VCS exclusions cover
  `**/*.gen.*` (including `apps/dashboard/src/routeTree.gen.ts`), `dist/**`,
  `.turbo/**`, coverage, lockfiles, dependencies, and VCS output.

`pnpm lint` runs the green compatibility profile. `pnpm lint:audit` runs the
unmodified Ultracite core, React, TanStack, and Vitest presets over the owned
product directories. The audit intentionally exits non-zero while inherited
findings remain and is not part of `pnpm check`. It is not wrapped in a
success-forcing shell fallback.

There is no category, path, file, line, snapshot, or diagnostic-count baseline.
Each override below is a named rule severity. The audit keeps every finding
visible.

## Measurement

The untouched base at
`d482c4d41b71e2a5b3cc4d3f624547519f7ce266` contained 11,894 diagnostics
across 200 existing product files and 116 rule families.

The approved commit-1 fixes remove eight findings and six rule families:

- `no-unsafe-optional-chaining`
- `react/button-has-type`
- `no-duplicate-imports`
- `import/no-duplicates`
- `no-promise-executor-return`
- `no-new`

The new sorting verifier is audit-clean and increases the owned source count to
201 files. Before the mechanical migration, the unsoftened audit reports 11,886
diagnostics across 110 rule families. The stable Oxfmt projection reports
11,888 diagnostics across the same 110 rule families; Oxfmt's stable output
causes two additional `unicorn/no-nested-ternary` reports without adding a new
rule family.

The final compatibility config contains 93 root rule entries and 17 entries
merged only into Ultracite's existing all-test-files Vitest override. The
Vitest merge preserves upstream file scope and is not a per-file diagnostic
allowlist.

## Rule removal policy

A rule stays disabled only while the unsoftened owned-source audit reports a
non-zero count and the rationale below still applies. When a migration reaches
zero, remove the override instead of retaining a stale exception. Adding a new
override requires a fresh review decision; it is not ordinary lint cleanup.

The single `vitest/valid-expect` finding is a verified tool compatibility false
positive. Gaia uses Vitest 4.1.9's supported `expect(actual, message)` form;
Vitest declares the second argument as `message?: string`.

## Final measured profile

| Scope | Rule | Final probe count | Rationale and re-enable condition |
|---|---|---:|---|
| Root | `no-use-before-define` | 4148 | Declaration reordering crosses Effect generators, schemas, and route registration; defer to reviewed module-by-module migration. |
| Root | `func-style` | 1895 | Converting declarations to expressions is broad and can alter hoisting; defer to a dedicated semantic cleanup. |
| Root | `func-names` | 801 | Anonymous generator callbacks are common at Effect/runtime seams; naming changes stack and trace shape, so review separately. |
| Root | `typescript/array-type` | 770 | ReadonlyArray versus readonly-array syntax is a project-wide type-style migration, not formatter work. |
| Root | `unicorn/switch-case-braces` | 582 | Adding case blocks is mechanical-looking but changes lexical scope; migrate with targeted checks. |
| Root | `import/consistent-type-specifier-style` | 447 | Oxfmt owns ordering, not type-import syntax; migrate import contracts separately. |
| Root | `curly` | 427 | Control-flow bracing touches executable source broadly; keep visible until a behavior-gated cleanup. |
| Root | `sort-keys` | 356 | Key order can be meaningful in schemas, fixtures, serialized evidence, and UI metadata; never auto-sort semantically. |
| Vitest override | `vitest/prefer-strict-equal` | 235 | Existing prefer strict equal test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Vitest override | `vitest/max-expects` | 222 | Existing max expects test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Vitest override | `vitest/no-standalone-expect` | 191 | Existing no standalone expect test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Root | `typescript/consistent-type-definitions` | 169 | Type-to-interface conversion changes declaration semantics and augmentation behavior; review per contract. |
| Root | `no-shadow` | 158 | Renaming shadowed bindings can affect closures and Effect generator readability; migrate per module. |
| Root | `unicorn/no-useless-undefined` | 144 | Explicit undefined can be contract-significant in Effect/schema calls; never apply the preset fix broadly. |
| Root | `unicorn/numeric-separators-style` | 91 | Existing numeric separators style idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `prefer-destructuring` | 100 | Existing prefer destructuring violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `unicorn/text-encoding-identifier-case` | 73 | Existing text encoding identifier case idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `default-case` | 67 | Existing default case violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `no-nested-ternary` | 67 | Existing no nested ternary violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `prefer-named-capture-group` | 64 | Existing prefer named capture group violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `complexity` | 54 | Existing complexity violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `typescript/no-non-null-assertion` | 54 | This is real type-safety debt; fix with refinement and tests in a dedicated correctness migration. |
| Root | `unicorn/no-nested-ternary` | 47 | The stable Oxfmt projection reports 47 existing nested-ternary diagnostics. Rewriting them changes executable control flow; defer to a scoped, behavior-checked cleanup. |
| Root | `max-classes-per-file` | 42 | Existing max classes per file violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `unicorn/no-array-sort` | 39 | Existing no array sort idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `no-unused-vars` | 35 | Unused symbols need ownership review before deletion; keep audit-visible for a focused cleanup. |
| Vitest override | `vitest/prefer-to-be-truthy` | 34 | Existing prefer to be truthy test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Root | `no-template-curly-in-string` | 32 | Literal template markers occur in protocol/fixture text; review intent before changing strings. |
| Root | `unicorn/prefer-string-replace-all` | 32 | Existing prefer string replace all idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `typescript/consistent-type-imports` | 30 | Existing consistent type imports TypeScript contracts need semantic/typecheck review; re-enable after a scoped type migration. |
| Vitest override | `vitest/prefer-to-be-falsy` | 29 | Existing prefer to be falsy test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Vitest override | `vitest/require-to-throw-message` | 26 | Existing require to throw message test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Root | `no-plusplus` | 25 | Existing no plusplus violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Vitest override | `vitest/prefer-importing-vitest-globals` | 25 | Existing prefer importing vitest globals test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Root | `unicorn/no-array-reverse` | 23 | Existing no array reverse idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Vitest override | `vitest/prefer-expect-resolves` | 17 | Existing prefer expect resolves test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Root | `unicorn/consistent-function-scoping` | 14 | Existing consistent function scoping idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `no-negated-condition` | 13 | Existing no negated condition violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `unicorn/catch-error-name` | 13 | Existing catch error name idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/no-negated-condition` | 13 | Existing no negated condition idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `promise/avoid-new` | 12 | Manual Promise bridges wrap callback/process APIs; rewrite must preserve cancellation and errors. |
| Root | `unicorn/consistent-existence-index-check` | 12 | Existing consistent existence index check idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Vitest override | `vitest/prefer-each` | 12 | Existing prefer each test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Root | `no-case-declarations` | 11 | Lexical declarations in switch cases need scoped control-flow fixes, not formatting. |
| Root | `react/react-compiler` | 10 | Reported state synchronization can change render behavior; requires focused React verification. |
| Root | `typescript/no-invalid-void-type` | 10 | Void unions are public callback contracts; migrate call sites together. |
| Root | `promise/prefer-await-to-callbacks` | 9 | Callbacks are used at host/process seams; async conversion needs boundary verification. |
| Root | `unicorn/prefer-export-from` | 9 | Existing prefer export from idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/no-array-method-this-argument` | 8 | Existing no array method this argument idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/no-await-expression-member` | 8 | Existing no await expression member idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Vitest override | `vitest/require-top-level-describe` | 8 | Existing require top level describe test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Root | `no-control-regex` | 6 | Control-character regexes may parse protocols; validate fixtures before changing patterns. |
| Root | `prefer-promise-reject-errors` | 6 | Rejection payloads are boundary behavior; convert with typed error/caller compatibility tests. |
| Root | `require-unicode-regexp` | 6 | Existing require unicode regexp violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `typescript/method-signature-style` | 6 | Existing method signature style TypeScript contracts need semantic/typecheck review; re-enable after a scoped type migration. |
| Root | `unicorn/escape-case` | 6 | Existing escape case idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/no-useless-switch-case` | 6 | Existing no useless switch case idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/prefer-spread` | 6 | Existing prefer spread idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Vitest override | `vitest/no-conditional-expect` | 6 | Existing no conditional expect test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Root | `class-methods-use-this` | 5 | Methods may intentionally satisfy adapter interfaces; static conversion changes the contract. |
| Root | `no-bitwise` | 5 | Bitwise operations may encode protocol/byte logic; review the owning boundary. |
| Root | `no-useless-escape` | 5 | Existing no useless escape violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `no-useless-return` | 5 | Existing no useless return violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `promise/prefer-await-to-then` | 5 | Promise-chain rewrites alter control flow and rejection handling; review separately. |
| Root | `require-await` | 5 | Async signatures may satisfy host interfaces; removing async can alter promise timing. |
| Root | `unicorn/prefer-add-event-listener` | 5 | Event API replacement affects listener ownership and cleanup; review runtime lifecycle. |
| Root | `unicorn/prefer-single-call` | 5 | Existing prefer single call idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/prefer-structured-clone` | 5 | Clone semantics differ for prototypes and unsupported values; inspect data ownership first. |
| Root | `no-await-in-loop` | 4 | Loops may require sequencing/backpressure; parallelization needs explicit runtime proof. |
| Root | `prefer-template` | 4 | Existing prefer template violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `arrow-body-style` | 3 | Existing arrow body style violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `react-hooks/exhaustive-deps` | 3 | Adding hook dependencies can change render/effect timing; requires component behavior review. |
| Root | `react/hook-use-state` | 3 | Existing tuple naming and partial destructuring need component-level review, not tooling autofix. |
| Root | `unicorn/import-style` | 3 | Existing import style idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/no-useless-spread` | 3 | Existing no useless spread idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/prefer-native-coercion-functions` | 3 | Existing prefer native coercion functions idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/prefer-set-has` | 3 | Existing prefer set has idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Vitest override | `vitest/prefer-expect-type-of` | 3 | Existing prefer expect type of test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Vitest override | `vitest/require-mock-type-parameters` | 3 | Existing require mock type parameters test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Root | `eqeqeq` | 2 | Loose equality may encode nullish compatibility; inspect and test before replacement. |
| Root | `jsx-a11y/prefer-tag-over-role` | 2 | Semantic-element replacement can affect styling and accessibility behavior; review in UI scope. |
| Root | `no-eq-null` | 2 | Loose null checks may intentionally cover null and undefined; migrate only with boundary tests. |
| Root | `prefer-const` | 2 | Existing prefer const violations require source edits outside tooling/config; re-enable after a dedicated behavior-checked cleanup. |
| Root | `promise/param-names` | 2 | Existing param names findings sit on async boundaries; re-enable after failure, ordering, and cancellation tests. |
| Root | `promise/prefer-catch` | 2 | Two-argument then handlers encode rejection behavior; migrate with failure-path tests. |
| Root | `typescript/no-dynamic-delete` | 2 | Dynamic deletion is projection/state behavior; replace with explicit shapes per owner. |
| Root | `typescript/no-import-type-side-effects` | 2 | Changing import form can alter module side effects; migrate with build/runtime proof. |
| Root | `unicorn/no-array-for-each` | 2 | Existing no array for each idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/no-immediate-mutation` | 2 | Existing no immediate mutation idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/prefer-dom-node-dataset` | 2 | Existing prefer dom node dataset idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/prefer-number-coercion` | 2 | Existing prefer number coercion idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/prefer-response-static-json` | 2 | Response construction is an HTTP boundary contract; migrate with API tests. |
| Root | `unicorn/prefer-ternary` | 2 | Existing prefer ternary idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/relative-url-style` | 2 | Existing relative url style idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Vitest override | `vitest/prefer-describe-function-title` | 2 | Existing prefer describe function title test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Root | `import/first` | 1 | Final root-config probe still reports one case in `apps/server/src/main.ts`: an export remains between import groups. Reordering the module boundary is outside formatter-only scope; migrate deliberately, then re-enable. |
| Root | `import/newline-after-import` | 1 | Final root-config probe still reports one case in `apps/server/src/main.ts`: an export remains between import groups. Reordering the module boundary is outside formatter-only scope; migrate deliberately, then re-enable. |
| Root | `jsx-a11y/label-has-associated-control` | 1 | Accessibility relationship needs a real UI fix and component/browser proof. |
| Root | `no-param-reassign` | 1 | The single mutation is an owned builder/adapter case; review ownership before refactor. |
| Root | `typescript/parameter-properties` | 1 | Constructor-property expansion changes class surface; defer to class-contract cleanup. |
| Root | `unicorn/no-array-reduce` | 1 | Existing no array reduce idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/no-document-cookie` | 1 | Direct cookie access is a security/API concern; prioritize a dedicated browser-boundary fix. |
| Root | `unicorn/no-lonely-if` | 1 | Existing no lonely if idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/no-object-as-default-parameter` | 1 | Existing no object as default parameter idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/no-useless-promise-resolve-reject` | 1 | Promise wrapping participates in rejection translation; verify typed failure behavior first. |
| Root | `unicorn/prefer-array-find` | 1 | Existing prefer array find idiom is not formatter-owned; re-enable after a scoped, behavior-checked cleanup. |
| Root | `unicorn/prefer-import-meta-properties` | 1 | Node runtime compatibility must be verified before changing filename resolution. |
| Vitest override | `vitest/prefer-called-once` | 1 | Existing prefer called once test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Vitest override | `vitest/prefer-import-in-mock` | 1 | Existing prefer import in mock test structure or matcher usage is behavior-facing; re-enable after a focused test-quality migration. |
| Vitest override | `vitest/valid-expect` | 1 | Oxlint 1.73.0 false-positive against installed Vitest 4.1.9: `expect(actual, message)` is valid and Vitest declares `message?: string`. Preserve the valid assertion and re-enable when tool compatibility is fixed. |
