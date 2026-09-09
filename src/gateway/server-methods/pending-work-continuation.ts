import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
} from "../../process/gateway-work-admission.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./types.js";

export function runGatewayPendingWorkContinuation<T>(params: {
  method: string;
  client: GatewayRequestOptions["client"];
  requestParams: unknown;
  context: GatewayRequestContext;
  run: () => Promise<T>;
}): Promise<T> | null {
  if (!isRecord(params.requestParams)) {
    return null;
  }
  const request = params.requestParams;
  if (params.client?.connect.role === "node") {
    if (getGatewaySuspendAdmissionPhase() !== "draining" && !isGatewayRestartDraining()) {
      return null;
    }
    const invokeId =
      params.method === "node.invoke.progress"
        ? request.invokeId
        : params.method === "node.invoke.result"
          ? request.id
          : undefined;
    if (typeof invokeId !== "string" || typeof request.nodeId !== "string") {
      return null;
    }
    return params.context.nodeRegistry.runPendingInvokeContinuation({
      invokeId,
      nodeId: request.nodeId,
      connId: params.client.connId,
      run: params.run,
    });
  }
  if (
    getGatewaySuspendAdmissionPhase() !== "draining" ||
    params.client?.connect.role !== "operator" ||
    typeof request.id !== "string"
  ) {
    return null;
  }
  if (params.method === "question.resolve" || params.method === "question.get") {
    return params.context.questionManager?.runPendingContinuation(request.id, params.run) ?? null;
  }
  const manager =
    params.method === "exec.approval.resolve"
      ? params.context.execApprovalManager
      : params.method === "plugin.approval.resolve"
        ? params.context.pluginApprovalManager
        : params.method === "approval.resolve"
          ? request.kind === "exec"
            ? params.context.execApprovalManager
            : request.kind === "plugin"
              ? params.context.pluginApprovalManager
              : request.kind === "system-agent"
                ? params.context.systemAgentApprovalManager
                : undefined
          : undefined;
  return manager?.runPendingContinuation(request.id, params.run) ?? null;
}
