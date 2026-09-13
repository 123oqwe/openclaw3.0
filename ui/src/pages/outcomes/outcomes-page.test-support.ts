import type { OutcomeDetail, OutcomeSummary } from "@openclaw/outcomes-contract";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";

export type OutcomesPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
};

export type MutableGateway = {
  connectionRevision: number;
  snapshot: ApplicationGatewaySnapshot;
  subscribe: ApplicationContext["gateway"]["subscribe"];
};

export function outcomeSummary(id: string, title: string): OutcomeSummary {
  return {
    acceptanceValidity: "none",
    id,
    phase: "draft",
    readiness: "incomplete",
    revision: 1,
    title,
    updatedAt: 1,
  };
}

export function outcomeDetail(id: string, title: string): OutcomeDetail {
  const workRef = {
    boardIdAtLink: "board-1",
    cardCreatedAt: 1,
    cardId: "card-1",
    owner: "workboard" as const,
  };
  return {
    ...outcomeSummary(id, title),
    acceptance: { acceptanceValidity: "none" },
    attention: [{ code: "blocked", criterionId: "criterion-1" }],
    closureHash: null,
    contractRevision: 1,
    createdAt: 1,
    criteria: [
      {
        evidenceSetHash: null,
        id: "criterion-1",
        required: true,
        sourcesVisibility: "complete",
        text: "Verify the release evidence",
        workRefs: [workRef],
      },
    ],
    evidence: [],
    nextActions: ["refresh"],
    objective: `${title} objective`,
    observedAt: 1,
    planGeneration: 0,
    planHash: null,
    recheckAfter: null,
    sourceIssues: [],
    work: [
      {
        currentBoardId: "board-1",
        observedAt: 1,
        ref: workRef,
        status: "blocked",
        upstreamStale: false,
      },
    ],
  };
}

export function createGateway(client: GatewayBrowserClient): ApplicationContext["gateway"] {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(["outcomes.list", "outcomes.get"], ["operator.read"]),
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
    selfUser: { id: "profile-a" },
  };
  return {
    snapshot,
    connection: { gatewayUrl: "", token: "", password: "" },
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
}

export function createGatewayWithSnapshotListener(client: GatewayBrowserClient) {
  const gateway = createGateway(client);
  const mutableGateway = gateway as unknown as MutableGateway;
  let receiveSnapshot: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
  mutableGateway.connectionRevision = 1;
  mutableGateway.subscribe = (listener) => {
    receiveSnapshot = listener;
    return () => undefined;
  };
  const updateSnapshot = (patch: Partial<ApplicationGatewaySnapshot>) => {
    mutableGateway.snapshot = { ...mutableGateway.snapshot, ...patch };
    receiveSnapshot?.(mutableGateway.snapshot);
  };
  return { gateway, mutableGateway, updateSnapshot };
}
