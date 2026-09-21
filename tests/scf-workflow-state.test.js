import { describe, expect, it } from "vitest";
import {
  checkpointWorkflow,
  createWorkflow,
  failWorkflow,
  startWorkflow,
  transitionWorkflow,
  workflowKey,
} from "../scf-runtime/shared/workflow-state.js";

function memoryStore() {
  const values = new Map();
  return {
    values,
    async getJson(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    async putJson(key, value) { values.set(key, value); },
  };
}

describe("durable workflow state", () => {
  it("persists ordered checkpoints and correlation metadata", async () => {
    const store = memoryStore();
    let workflow = await startWorkflow(store, {
      id: "photo:message-1",
      type: "photo",
      localDate: "2026-07-31",
      sourceEventId: "message-1",
      recipientKey: "ou_user",
      correlationId: "message-1",
      nowIso: "2026-07-31T01:00:00.000Z",
    });
    workflow = await checkpointWorkflow(store, workflow, "planning", { subject: "窗边的花" }, "2026-07-31T01:00:01.000Z");
    workflow = await checkpointWorkflow(store, workflow, "generating", {}, "2026-07-31T01:00:02.000Z");
    expect(workflow.status).toBe("generating");
    expect(workflow.correlation_id).toBe("message-1");
    expect(store.values.get(workflow.storage_key).checkpoints.map((item) => item.state)).toEqual([
      "received", "planning", "generating",
    ]);
    expect(workflow.storage_key).toBe(workflowKey("photo", "2026-07-31", "photomessage-1"));
  });

  it("rejects backward transitions and keeps failure diagnostic data", async () => {
    const store = memoryStore();
    let workflow = createWorkflow({ id: "a1", type: "autonomy", localDate: "2026-07-31" });
    workflow = transitionWorkflow(workflow, "deciding");
    workflow = transitionWorkflow(workflow, "decided");
    expect(() => transitionWorkflow(workflow, "deciding")).toThrow(/cannot move backward/);
    const failed = await failWorkflow(store, workflow, new Error("provider timeout"), { stage: "deciding" });
    expect(failed).toMatchObject({ status: "failed", terminal: true });
    expect(failed.error).toMatchObject({ message: "provider timeout", stage: "deciding" });
  });

  it("persists an autonomy event before entering notification delivery", () => {
    let workflow = createWorkflow({ id: "heartbeat-1", type: "autonomy", localDate: "2026-08-09" });
    workflow = transitionWorkflow(workflow, "deciding");
    workflow = transitionWorkflow(workflow, "decided");
    workflow = transitionWorkflow(workflow, "persisting");
    workflow = transitionWorkflow(workflow, "notifying");
    expect(workflow.checkpoints.map((item) => item.state)).toEqual([
      "received", "deciding", "decided", "persisting", "notifying",
    ]);
  });

  it("restarts a failed workflow as a new retained attempt", async () => {
    const store = memoryStore();
    let workflow = await startWorkflow(store, { id: "chat-1", type: "chat", localDate: "2026-07-31" });
    workflow = await checkpointWorkflow(store, workflow, "processing");
    await failWorkflow(store, workflow, "network error");
    const restarted = await startWorkflow(store, { id: "chat-1", type: "chat", localDate: "2026-07-31" });
    expect(restarted).toMatchObject({ status: "received", terminal: false, attempt: 2 });
    expect(restarted.previous_attempts[0]).toMatchObject({ attempt: 1, status: "failed" });
  });

  it("returns the same terminal autonomy workflow for a duplicate heartbeat", async () => {
    const store = memoryStore();
    const identity = {
      id: "heartbeat-agent-heartbeat-202608090230",
      type: "autonomy",
      localDate: "2026-08-09",
    };
    let workflow = await startWorkflow(store, identity);
    workflow = await checkpointWorkflow(store, workflow, "deciding");
    workflow = await checkpointWorkflow(store, workflow, "decided");
    workflow = await checkpointWorkflow(store, workflow, "persisting");
    workflow = await checkpointWorkflow(store, workflow, "completed", {
      event_id: "autonomy-agent-heartbeat-202608090230",
    });

    const duplicate = await startWorkflow(store, identity);
    expect(duplicate).toMatchObject({
      status: "completed",
      terminal: true,
      attempt: 1,
      output: { event_id: "autonomy-agent-heartbeat-202608090230" },
    });
  });
});
