import { describe, it, expect } from "vitest";
import { buildAgentCard } from "../agent-card.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";

describe("buildAgentCard", () => {
  it("builds a card from config with name, skills, and streaming capability", () => {
    const config = {
      ...DEFAULTS,
      agentCard: {
        ...DEFAULTS.agentCard,
        name: "Claude Workspace Engineer",
        description: "desc",
        skills: [{ id: "ws", name: "Workspace Engineering", description: "d", tags: ["code"] }],
      },
    } as Required<AgentConfig>;
    const card = buildAgentCard(config);
    expect(card.name).toBe("Claude Workspace Engineer");
    expect(card.skills.length).toBe(1);
    expect(card.capabilities?.streaming).toBe(true);
  });
});
