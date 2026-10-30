import { randomUUID } from "crypto";
import { buildResponsePlan } from "./planner";
export function createTrackedPlan(incidents, resources, conflicts) {
    return {
        id: randomUUID(),
        status: "PROPOSED",
        generatedAt: new Date().toISOString(),
        plan: buildResponsePlan(incidents, resources, conflicts)
    };
}
export function approveTrackedPlan(trackedPlan, approver, note, events) {
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
