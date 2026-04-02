# Implementation Plan: Monorepo Restructure

## Overview

Restructure the a2a-wrapper project into a proper npm workspaces + Turborepo monorepo with Changesets for independent versioning. All changes are repository-level configuration — no runtime code changes. The implementation proceeds in phases: remove duplicates, create root configs, create CI/CD, consolidate docs, update packages, verify, test.

## Tasks

- [x] 1. Remove per-package duplicate artifacts
  - [x] 1.1 Delete per-package community docs from `a2a-copilot/`
    - Remove `a2a-copilot/CONTRIBUTING.md`, `a2a-copilot/CODE_OF_CONDUCT.md`, `a2a-copilot/SECURITY.md`, `a2a-copilot/LICENSE`
    - _Requirements: 3.5, 9.1_

  - [x] 1.2 Delete per-package community docs from `a2a-opencode/`
    - Remove `a2a-opencode/CONTRIBUTING.md`, `a2a-opencode/CODE_OF_CONDUCT.md`, `a2a-opencode/SECURITY.md`, `a2a-opencode/LICENSE`
    - _Requirements: 3.6, 9.2_

  - [x] 1.3 Delete per-package `.github/` directories
    - Remove `a2a-copilot/.github/` directory
    - Remove `a2a-opencode/.github/` directory
    - _Requirements: 5.8, 5.9, 9.1, 9.2_

  - [x] 1.4 Delete per-package `.gitignore` files
    - Remove `a2a-copilot/.gitignore`
    - Remove `a2a-opencode/.gitignore`
    - _Requirements: 6.6, 6.7, 9.1, 9.2_

  - [x] 1.5 Delete per-package `package-lock.json` files
    - Remove `a2a-copilot/package-lock.json`
    - Remove `a2a-opencode/package-lock.json`
    - Remove `packages/core/package-lock.json`
    - _Requirements: 7.2, 7.3, 7.4, 9.1, 9.2, 9.3_

  - [x] 1.6 Delete per-package `.git/` directories (manual step)
    - **MANUAL:** The user must remove `a2a-copilot/.git/` and `a2a-opencode/.git/` manually (e.g. `rm -rf a2a-copilot/.git a2a-opencode/.git`) since these are git internals that should be handled outside automated tooling
    - _Requirements: 6.2, 6.3, 9.1, 9.2_

- [x] 2. Create root configuration files
  - [x] 2.1 Create root `package.json`
    - Create `package.json` at repository root with `name: "a2a-wrapper"`, `private: true`, `workspaces: ["packages/*", "a2a-*"]`, scripts delegating to `turbo run`, `devDependencies` for `turbo` and `@changesets/cli`, `engines.node: ">=18.0.0"`
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 10.1, 10.6_

  - [x] 2.2 Create `turbo.json`
    - Create `turbo.json` at repository root with `build` task (`dependsOn: ["^build"]`, `outputs: ["dist/**"]`), `typecheck` task (`dependsOn: ["^build"]`), `test` task (`dependsOn: ["^build"]`), and `clean` task (`cache: false`)
    - _Requirements: 10.2, 10.3, 10.4, 10.5_

  - [x] 2.3 Create `.changeset/config.json`
    - Create `.changeset/` directory and `config.json` with `fixed: []` (independent versioning), `access: "public"`, `baseBranch: "main"`, `updateInternalDependencies: "patch"`, `commit: false`
    - _Requirements: 13.1, 13.2, 13.8_

  - [x] 2.4 Create root `.gitignore`
    - Create `.gitignore` at repository root combining patterns from existing per-package `.gitignore` files plus `.turbo/` entry for Turborepo cache
    - _Requirements: 6.4, 6.5, 10.8_

- [x] 3. Create unified CI/CD workflows
  - [x] 3.1 Create `.github/workflows/ci.yml`
    - Create CI workflow that runs on push to `main` and PRs to `main`, uses Node.js matrix (18.x, 20.x, 22.x), runs `npm ci` at root, then `npx turbo run build typecheck test`
    - Include concurrency group to cancel in-progress runs
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 10.7, 12.3_

  - [x] 3.2 Create `.github/workflows/publish.yml`
    - Create publish workflow that runs on push to `main`, uses `changesets/action@v1` to create Changeset PRs or publish to npm, enables npm provenance via `NPM_CONFIG_PROVENANCE: true`
    - Set permissions for `contents: write`, `pull-requests: write`, `id-token: write`
    - _Requirements: 5.5, 5.6, 5.7, 8.3, 12.4, 13.6, 13.7_

- [x] 4. Create consolidated community docs at root
  - [x] 4.1 Create root `CONTRIBUTING.md`
    - Write monorepo-aware contributing guide referencing Turborepo commands (`npx turbo run build`, `npx turbo run test`), changeset workflow (`npx changeset`), workspace structure, and how to add a new wrapper
    - _Requirements: 3.1, 3.7_

  - [x] 4.2 Create root `CODE_OF_CONDUCT.md`
    - Copy Contributor Covenant v2.1 content (identical across existing packages) to repository root
    - _Requirements: 3.2_

  - [x] 4.3 Create root `SECURITY.md`
    - Adapt existing security policy to cover all workspace packages in the monorepo, update repository URL references
    - _Requirements: 3.3, 3.8_

  - [x] 4.4 Create root `LICENSE`
    - Copy MIT license to repository root (identical across existing packages)
    - _Requirements: 3.4_

- [x] 5. Checkpoint - Verify file structure
  - Ensure all duplicate files are removed, all root config files exist, and CI/CD workflows are in place. Ask the user if questions arise.

- [x] 6. Update wrapper `package.json` files for monorepo
  - [x] 6.1 Update `a2a-copilot/package.json`
    - Remove `prepublishOnly` script (Turborepo + Changesets handles build-before-publish)
    - Add `@a2a-wrapper/core` as a dependency with `"workspace:*"` protocol
    - Verify `repository.directory`, `homepage`, `bugs` URLs reference the monorepo
    - Verify `publishConfig.access` is `"public"`, `files` field includes `dist`, `agents`, `LICENSE`
    - _Requirements: 2.1, 2.4, 2.7, 8.1, 8.2, 8.5_

  - [x] 6.2 Update `a2a-opencode/package.json`
    - Remove `prepublishOnly` script (Turborepo + Changesets handles build-before-publish)
    - Add `@a2a-wrapper/core` as a dependency with `"workspace:*"` protocol
    - Verify `repository.directory`, `homepage`, `bugs` URLs reference the monorepo
    - Verify `publishConfig.access` is `"public"`, `files` field includes `dist`, `agents`, `LICENSE`
    - _Requirements: 2.2, 2.5, 2.8, 8.1, 8.2, 8.6_

  - [x] 6.3 Verify `packages/core/package.json`
    - Confirm `exports` field has `types` and `import` conditions
    - Confirm `publishConfig.access` is `"public"`, `files` field includes `dist`
    - Confirm `version` field exists with valid semver
    - _Requirements: 2.3, 2.6, 8.1, 8.2, 8.4, 11.1, 11.6_

- [x] 7. Generate root lock file and verify builds
  - [x] 7.1 Run `npm install` at repository root
    - This generates the single root `package-lock.json` and hoists shared dependencies
    - **MANUAL:** User should run `npm install` in their terminal at the repository root
    - _Requirements: 1.3, 7.1, 7.5_

  - [x] 7.2 Verify Turborepo build pipeline
    - **MANUAL:** User should run `npx turbo run build` to verify core builds first, then wrappers build in parallel
    - _Requirements: 10.3, 10.5, 12.2_

  - [x] 7.3 Verify Turborepo test and typecheck
    - **MANUAL:** User should run `npx turbo run test typecheck` to verify all packages pass
    - _Requirements: 10.4, 10.6_

- [x] 8. Checkpoint - Verify monorepo functionality
  - Ensure `npm install`, `turbo build`, `turbo test`, and `turbo typecheck` all pass. Ask the user if questions arise.

- [x] 9. Write property tests for monorepo invariants
  - [x] 9.1 Write property test for TypeScript configuration consistency
    - **Property 1: TypeScript configuration consistency across all workspace packages**
    - Discover all workspace packages via root `package.json` workspaces globs, then assert each `tsconfig.json` uses `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `target: "ES2022"`, `declaration: true`, `declarationMap: true`, `sourceMap: true`
    - Place test in `packages/core/src/__tests__/monorepo/tsconfig-consistency.test.ts`
    - **Validates: Requirements 11.2, 11.3, 11.4, 11.5**

  - [x] 9.2 Write property test for workspace package publish configuration
    - **Property 2: Workspace package publish configuration consistency**
    - For all discovered workspace packages, assert `package.json` has `version` (valid semver), `publishConfig.access: "public"`, and a `files` array
    - Place test in `packages/core/src/__tests__/monorepo/publish-config.test.ts`
    - **Validates: Requirements 8.1, 8.2, 8.4, 8.5, 8.6**

  - [x] 9.3 Write property test for no duplicate artifacts in wrappers
    - **Property 3: No duplicate artifacts in wrapper directories**
    - For all `a2a-*` directories, assert none contain `.git/`, `.github/`, `.gitignore`, `package-lock.json`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, or `LICENSE`
    - Place test in `packages/core/src/__tests__/monorepo/no-duplicates.test.ts`
    - **Validates: Requirements 9.1, 9.2, 3.5, 3.6, 5.8, 5.9, 6.2, 6.3, 6.6, 6.7, 7.2, 7.3**

- [x] 10. Update root README with "Adding a New Wrapper" guide
  - Update the existing `README.md` to include a section documenting the steps to add a new wrapper project: create `a2a-<name>/` directory, implement `A2AExecutor`, define config defaults, wire up with `createCli()`, and run `npx changeset` for versioning
  - Also update the Development section to reference Turborepo commands (`npx turbo run build`, `npx turbo run test`) and changeset workflow
  - _Requirements: 12.1, 12.5_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Task 1.6 (removing `.git/` directories) and tasks 7.1-7.3 (npm install, turbo build/test) are manual steps the user performs in their terminal
- Each task references specific requirements for traceability
- Property tests validate universal invariants across all workspace packages — adding a new `a2a-*` wrapper automatically gets covered
- No runtime code changes are needed; this is purely repository configuration
