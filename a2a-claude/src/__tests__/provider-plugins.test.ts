import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeProvider } from "../claude/provider.js";
import { FakeClaudeClient, type FakeTurnScript } from "./helpers/fake-client.js";
import { DEFAULTS } from "../config/defaults.js";
import type { AgentConfig } from "../config/types.js";

let ws: string;
let config: Required<AgentConfig>;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "a2a-claude-plugins-"));
  config = JSON.parse(JSON.stringify({ ...DEFAULTS, configDir: ws })) as Required<AgentConfig>;
  config.claude.workingDirectory = ws;
  config.events = { enabled: false } as Required<AgentConfig>["events"];
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function withSuperpowers(): void {
  config.claude.marketplaces = {
    "superpowers-marketplace": {
      source: { source: "github", repo: "obra/superpowers-marketplace", ref: "v6.1.1" },
    },
  };
  config.claude.enabledPlugins = { "superpowers@superpowers-marketplace": true };
}

/** An init message reporting the given loaded plugins, as the SDK emits it. */
function initWith(plugins: Array<Record<string, unknown>>): FakeTurnScript {
  return {
    messages: [
      { type: "system", subtype: "init", session_id: "probe", model: "claude-test", plugins },
    ],
  };
}

describe("plugin preflight", () => {
  it("issues no probe when no marketplaces are configured", async () => {
    const client = new FakeClaudeClient([initWith([])]);
    await new ClaudeProvider(config, { clientFactory: () => client }).initialize();
    expect(client.calls).toHaveLength(0);
  });

  it("passes when the enabled plugin loads, matching on source", async () => {
    withSuperpowers();
    const client = new FakeClaudeClient([
      initWith([
        { name: "superpowers", path: "/cache/superpowers", source: "superpowers@superpowers-marketplace" },
      ]),
    ]);
    await new ClaudeProvider(config, { clientFactory: () => client }).initialize();
    expect(client.calls).toHaveLength(1);
  });

  it("falls back to the bare plugin name when init omits source", async () => {
    withSuperpowers();
    const client = new FakeClaudeClient([initWith([{ name: "superpowers", path: "/cache/superpowers" }])]);
    await expect(new ClaudeProvider(config, { clientFactory: () => client }).initialize()).resolves.toBeUndefined();
  });

  it("sends the marketplaces as flag-tier settings and forces a synchronous install", async () => {
    withSuperpowers();
    const client = new FakeClaudeClient([
      initWith([{ name: "superpowers", source: "superpowers@superpowers-marketplace" }]),
    ]);
    await new ClaudeProvider(config, { clientFactory: () => client }).initialize();

    const settings = client.calls[0]!.options.settings as Record<string, unknown>;
    expect(settings.extraKnownMarketplaces).toEqual(config.claude.marketplaces);
    expect(settings.enabledPlugins).toEqual({ "superpowers@superpowers-marketplace": true });
    expect(client.calls[0]!.options.env?.["CLAUDE_CODE_SYNC_PLUGIN_INSTALL"]).toBe("1");
  });

  // The regression that motivates the whole preflight: a marketplace that clones
  // cleanly but has no plugin by that name reports install success and loads
  // nothing. Only the init message's plugin list exposes it.
  it("fails when install events report success but the plugin did not load", async () => {
    withSuperpowers();
    const client = new FakeClaudeClient([
      {
        messages: [
          { type: "system", subtype: "plugin_install", status: "started" },
          { type: "system", subtype: "plugin_install", status: "installed", name: "superpowers-marketplace" },
          { type: "system", subtype: "plugin_install", status: "completed" },
          { type: "system", subtype: "init", session_id: "probe", model: "claude-test", plugins: [] },
        ],
      },
    ]);

    await expect(new ClaudeProvider(config, { clientFactory: () => client }).initialize()).rejects.toThrow(
      /did not load: superpowers@superpowers-marketplace/,
    );
  });

  it("ignores plugins explicitly disabled in enabledPlugins", async () => {
    withSuperpowers();
    config.claude.enabledPlugins["unused@superpowers-marketplace"] = false;
    const client = new FakeClaudeClient([
      initWith([{ name: "superpowers", source: "superpowers@superpowers-marketplace" }]),
    ]);
    await expect(new ClaudeProvider(config, { clientFactory: () => client }).initialize()).resolves.toBeUndefined();
  });

  it("fails when the probe ends without an init message", async () => {
    withSuperpowers();
    const client = new FakeClaudeClient([{ messages: [] }]);

    await expect(new ClaudeProvider(config, { clientFactory: () => client }).initialize()).rejects.toThrow(
      /without a session init message/,
    );
  });
});
