import { vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import type { OutcomeRecord } from "../domain/types.js";
import { registerOutcomeFirstPackageMethods } from "./methods.js";

type GatewayCall = {
  client: { authenticatedUserProfile?: { profileId: string } };
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
};
type RegisteredHandler = (call: GatewayCall) => Promise<void>;

export const owner = { authenticatedUserProfile: { profileId: "manager-a" } };
export const criterionId = "123e4567-e89b-42d3-a456-426614174001";
export const secondaryCriterionId = "123e4567-e89b-42d3-a456-426614174002";
export const outcomeIds = [
  "123e4567-e89b-42d3-a456-426614174010",
  "123e4567-e89b-42d3-a456-426614174011",
  "123e4567-e89b-42d3-a456-426614174012",
];

export function createHarness(
  options: {
    registerDelayMs?: number;
    registerError?: Error;
    workboardCards?: unknown[];
    workboardError?: Error;
  } = {},
) {
  const records = new Map<string, OutcomeRecord>();
  let writes = 0;
  const storeCalls = { deleteIf: 0, entries: 0, lookup: 0, registerIfAbsent: 0, update: 0 };
  const handlers = new Map<string, RegisteredHandler>();
  const store = {
    registerIfAbsent: async (id: string, record: OutcomeRecord) => {
      storeCalls.registerIfAbsent += 1;
      if (options.registerError !== undefined) {
        throw options.registerError;
      }
      if (options.registerDelayMs !== undefined) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, options.registerDelayMs);
        });
      }
      if (records.has(id)) {
        return false;
      }
      records.set(id, record);
      writes += 1;
      return true;
    },
    lookup: async (id: string) => {
      storeCalls.lookup += 1;
      return records.get(id);
    },
    entries: async () => {
      storeCalls.entries += 1;
      return [...records].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    update: async (
      id: string,
      decide: (current: OutcomeRecord | undefined) => OutcomeRecord | undefined,
    ) => {
      storeCalls.update += 1;
      const next = decide(records.get(id));
      if (!next) {
        return false;
      }
      records.set(id, next);
      writes += 1;
      return true;
    },
    deleteIf: async () => {
      storeCalls.deleteIf += 1;
      return false;
    },
  };
  const gatewayRequest = vi.fn(async () => {
    if (options.workboardError !== undefined) {
      throw options.workboardError;
    }
    return {
      cards: options.workboardCards ?? [
        {
          id: "card-a",
          status: "done",
          createdAt: 1,
          updatedAt: 2,
          metadata: { automation: { boardId: "board-a" }, proof: [], artifacts: [] },
        },
      ],
    };
  });
  const logger = { warn: vi.fn() };
  const api = {
    logger,
    runtime: { state: { openKeyedStore: () => store }, gateway: { request: gatewayRequest } },
    registerGatewayMethod: (method: string, handler: unknown) => {
      handlers.set(method, handler as RegisteredHandler);
    },
  } as unknown as OpenClawPluginApi;
  registerOutcomeFirstPackageMethods(api);
  async function call(method: string, params: Record<string, unknown>, client = owner) {
    const respond = vi.fn();
    const handler = handlers.get(method);
    if (!handler) {
      throw new Error(`missing handler: ${method}`);
    }
    await handler({ client, params, respond });
    return respond.mock.calls[0]!;
  }
  return {
    call,
    entryReads: () => storeCalls.entries,
    gatewayRequest,
    logger,
    records,
    storeCalls,
    writes: () => writes,
  };
}

export function createParams(id: string, title = "Outcome title") {
  return {
    id,
    title,
    objective: "Outcome objective",
    criteria: [{ id: criterionId, text: "Required criterion", required: true }],
  };
}

export const defaultLinkParams = (id: string) => ({
  id,
  expectedRevision: 1,
  criterionId,
  cardId: "card-a",
});

export async function createOutcome(
  harness: ReturnType<typeof createHarness>,
  id = outcomeIds[0]!,
) {
  await harness.call("outcomes.create", createParams(id));
  return { id, record: harness.records.get(id)! };
}

export async function createLinkedOutcome(
  harness: ReturnType<typeof createHarness>,
  id = outcomeIds[0]!,
) {
  await createOutcome(harness, id);
  await harness.call("outcomes.linkWorkboard", defaultLinkParams(id));
  return id;
}
