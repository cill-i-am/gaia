# Packages Intent

`packages/*` contains reusable Gaia libraries. Packages define the control
plane contracts and runtime behavior that apps consume.

## Package Rules

- Build packages with `tsdown`; do not edit generated `dist/*` output.
- Keep each package's public surface intentional through `src/index.ts` and
  `package.json` exports.
- Prefer package-local tests for package behavior. Use temp directories and fake
  seams instead of mutating the repo.
- Preserve dependency direction: app -> runtime -> core. Do not introduce
  runtime-to-app, core-to-runtime, or package cycles.
- Boundary schemas, branded values, typed errors, and serializable artifacts
  should live in the package that owns the boundary.
