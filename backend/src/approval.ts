
import { randomUUID } from "crypto";
import { Incident, Conflict, AgentEvent } from "./pipeline";
import { buildResponsePlan } from "./planner";

export type PlanStatus = "PROPOSED" | "APPROVED";

export type TrackedPlan = {
  id: string;
  status: PlanStatus;
  generatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  approvalNote?: string;
  plan: ReturnType<typeof buildResponsePlan>;
};

export function createTrackedPlan(
  incidents: Incident[],
  resources: any[],
  conflicts: Conflict[]
): TrackedPlan {
  return {
    id: randomUUID(),
    status: "PROPOSED",
    generatedAt: new Date().toISOString(),
    plan: buildResponsePlan(incidents, resources, conflicts)
  };
}

export function approveTrackedPlan(
  trackedPlan: TrackedPlan,
  approver: string,
  note: string,
  events: AgentEvent[]
): TrackedPlan {
  if (trackedPlan.status === "APPROVED") {
    throw new Error("This plan has already been approved.");
  }

  const now = new Date().toISOString();

  trackedPlan.status = "APPROVED";
  trackedPlan.approvedAt = now;
  trackedPlan.approvedBy = approver;
  trackedPlan.approvalNote = note;

  events.push({
    id: randomUUID(),
    agent: "Human Approval",
    message: `Plan ${trackedPlan.id} approved by ${approver}. Note: ${note || "No note provided"}. No automatic dispatch performed.`,
    timestamp: now
  });

  return trackedPlan;
}
