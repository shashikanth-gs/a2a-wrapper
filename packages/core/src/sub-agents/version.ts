/**
 * Pinned `a2a-mcp-skillmap` Version
 *
 * The synthesized MCP entry that spawns the sub-agent bridge invokes
 * `npx -y a2a-mcp-skillmap@<SKILLMAP_PACKAGE_VERSION>` rather than the
 * unpinned package name. Pinning ensures bridge behavior is reproducible
 * across deployments and that a future skillmap release cannot silently
 * change semantics for parents that depend on this package.
 *
 * Bumping this constant is a deliberate change. Reviewers SHOULD verify in
 * PR that the new version:
 *   - is a published, known-good release of `a2a-mcp-skillmap`
 *   - supports the `--config` flag and stdio transport
 *   - does not introduce breaking changes to the bridge config schema
 *     consumed by `buildBridgeConfig` (or that this package is updated
 *     to match)
 *
 * @see https://www.npmjs.com/package/a2a-mcp-skillmap
 * @see https://github.com/shashikanth-gs/a2a-mcp-skillmap
 * @module sub-agents/version
 */

/**
 * The pinned `a2a-mcp-skillmap` version invoked via `npx`.
 *
 * Bumping this is a deliberate change reviewed in PRs — see the module
 * docstring for the review checklist.
 */
export const SKILLMAP_PACKAGE_VERSION = "0.2.1";
