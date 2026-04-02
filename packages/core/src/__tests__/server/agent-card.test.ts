import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { buildAgentCard } from "../../server/agent-card.js";

/**
 * Property-based tests for the Agent Card Builder module.
 *
 * Validates Requirements 7.1, 7.2, 7.3 via Property 10,
 * Requirement 7.4 via Property 11,
 * and Requirement 7.5 via Property 12.
 */

// ─── Shared Arbitraries ─────────────────────────────────────────────────────

const arbProtocol = fc.constantFrom("http" as const, "https" as const);
const arbHost = fc.stringMatching(/^[a-z][a-z0-9.-]*$/).filter((s) => s.length > 0);
const arbPort = fc.integer({ min: 1, max: 65535 });
const arbName = fc.string({ minLength: 1 });
const arbDesc = fc.string({ minLength: 1 });

// Feature: shared-core-package, Property 10: Agent card construction from config
// Validates: Requirements 7.1, 7.2, 7.3
describe("Property 10: Agent card construction from config", () => {
  it("url, additionalInterfaces, name, description, and capabilities match input config", () => {
    fc.assert(
      fc.property(
        arbProtocol,
        arbHost,
        arbPort,
        arbName,
        arbDesc,
        fc.boolean(),
        fc.boolean(),
        (protocol, host, port, name, description, streaming, pushNotifications) => {
          const card = buildAgentCard({
            agentCard: { name, description, streaming, pushNotifications },
            server: { advertiseProtocol: protocol, advertiseHost: host, port },
          });

          const expectedBase = `${protocol}://${host}:${port}`;
          const expectedJsonRpcUrl = `${expectedBase}/a2a/jsonrpc`;
          const expectedRestUrl = `${expectedBase}/a2a/rest`;

          // url equals {advertiseProtocol}://{advertiseHost}:{port}/a2a/jsonrpc
          expect(card.url).toBe(expectedJsonRpcUrl);

          // additionalInterfaces contains JSONRPC and REST entries with correct URLs
          expect(card.additionalInterfaces).toBeDefined();
          const interfaces = card.additionalInterfaces!;
          const jsonrpcEntry = interfaces.find((i: any) => i.transport === "JSONRPC");
          const restEntry = interfaces.find((i: any) => i.transport === "REST");
          expect(jsonrpcEntry).toBeDefined();
          expect(restEntry).toBeDefined();
          expect(jsonrpcEntry!.url).toBe(expectedJsonRpcUrl);
          expect(restEntry!.url).toBe(expectedRestUrl);

          // name and description match input
          expect(card.name).toBe(name);
          expect(card.description).toBe(description);

          // capabilities.streaming and capabilities.pushNotifications reflect config values
          expect(card.capabilities!.streaming).toBe(streaming);
          expect(card.capabilities!.pushNotifications).toBe(pushNotifications);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// Feature: shared-core-package, Property 11: stateTransitionHistory invariant
// Validates: Requirements 7.4
describe("Property 11: stateTransitionHistory invariant", () => {
  it("capabilities.stateTransitionHistory is always false regardless of input", () => {
    fc.assert(
      fc.property(
        arbProtocol,
        arbHost,
        arbPort,
        arbName,
        arbDesc,
        fc.boolean(),
        (protocol, host, port, name, description, stateTransitionHistory) => {
          const card = buildAgentCard({
            agentCard: { name, description, stateTransitionHistory },
            server: { advertiseProtocol: protocol, advertiseHost: host, port },
          });

          expect(card.capabilities!.stateTransitionHistory).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: shared-core-package, Property 12: Skill mapping preserves data
// Validates: Requirements 7.5
describe("Property 12: Skill mapping preserves data", () => {
  /** Arbitrary for a single SkillConfig. */
  const arbSkill = fc.record({
    id: fc.string({ minLength: 1 }),
    name: fc.string({ minLength: 1 }),
    description: fc.string({ minLength: 1 }),
    tags: fc.option(fc.array(fc.string(), { minLength: 0, maxLength: 5 }), { nil: undefined }),
    examples: fc.option(fc.array(fc.string({ minLength: 1 }), { minLength: 0, maxLength: 5 }), { nil: undefined }),
  });

  const arbSkills = fc.array(arbSkill, { minLength: 0, maxLength: 10 });

  it("skills array preserves id, name, description, tags; examples present iff non-empty in input", () => {
    fc.assert(
      fc.property(
        arbProtocol,
        arbHost,
        arbPort,
        arbName,
        arbDesc,
        arbSkills,
        (protocol, host, port, name, description, skills) => {
          const card = buildAgentCard({
            agentCard: { name, description, skills },
            server: { advertiseProtocol: protocol, advertiseHost: host, port },
          });

          // Same length
          expect(card.skills).toHaveLength(skills.length);

          for (let i = 0; i < skills.length; i++) {
            const input = skills[i];
            const output = card.skills[i];

            // Preserves id, name, description
            expect(output.id).toBe(input.id);
            expect(output.name).toBe(input.name);
            expect(output.description).toBe(input.description);

            // Preserves tags (defaults to [] when undefined)
            expect(output.tags).toEqual(input.tags ?? []);

            // examples present iff non-empty in input
            if (input.examples && input.examples.length > 0) {
              expect(output.examples).toEqual(input.examples);
            } else {
              expect(output.examples).toBeUndefined();
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
