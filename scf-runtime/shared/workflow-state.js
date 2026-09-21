const WORKFLOW_STATES = {
  chat: ["received", "processing", "replied", "persisting", "completed", "failed"],
  autonomy: ["received", "deciding", "decided", "persisting", "notifying", "completed", "failed"],
  photo: ["received", "planning", "generating", "reviewing", "ready", "delivering", "completed", "failed"],
};

function cleanId(value) {
  return String(value || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120) || String(Date.now());
}

export function workflowKey(type, localDate, id) {
  return `workflows/${type}/${localDate}/${cleanId(id)}.json`;
}

export function createWorkflow({ id, type, localDate, sourceEventId = null, recipientKey = null, correlationId = null, nowIso = new Date().toISOString(), input = {} }) {
  if (!WORKFLOW_STATES[type]) throw new Error(`Unsupported workflow type: ${type}`);
  const workflowId = cleanId(id);
  return {
    schema_version: 1,
    workflow_id: workflowId,
    workflow_type: type,
    correlation_id: cleanId(correlationId || workflowId),
    source_event_id: sourceEventId,
    recipient_key: recipientKey,
    status: "received",
    terminal: false,
    input,
    output: null,
    error: null,
    attempt: 1,
    previous_attempts: [],
    checkpoints: [{ state: "received", at: nowIso, data: {} }],
    created_at: nowIso,
    updated_at: nowIso,
    storage_key: workflowKey(type, localDate, workflowId),
  };
}

export function transitionWorkflow(workflow, nextState, data = {}, nowIso = new Date().toISOString()) {
  const states = WORKFLOW_STATES[workflow?.workflow_type] || [];
  if (!states.includes(nextState)) throw new Error(`Invalid ${workflow?.workflow_type || "unknown"} workflow state: ${nextState}`);
  if (workflow.terminal && workflow.status !== nextState) {
    throw new Error(`Workflow ${workflow.workflow_id} is already terminal (${workflow.status})`);
  }
  const currentIndex = states.indexOf(workflow.status);
  const nextIndex = states.indexOf(nextState);
  if (nextState !== "failed" && nextState !== workflow.status && nextIndex < currentIndex) {
    throw new Error(`Workflow ${workflow.workflow_id} cannot move backward from ${workflow.status} to ${nextState}`);
  }
  return {
    ...workflow,
    status: nextState,
    terminal: nextState === "completed" || nextState === "failed",
    output: nextState === "completed" ? data : workflow.output,
    error: nextState === "failed" ? data : workflow.error,
    checkpoints: [
      ...(Array.isArray(workflow.checkpoints) ? workflow.checkpoints : []),
      { state: nextState, at: nowIso, data },
    ].slice(-24),
    updated_at: nowIso,
  };
}

export async function saveWorkflow(store, workflow) {
  await store.putJson(workflow.storage_key, workflow);
  return workflow;
}

export async function startWorkflow(store, definition) {
  const fresh = createWorkflow(definition);
  const existing = await store.getJson(fresh.storage_key, null);
  if (existing?.workflow_id === fresh.workflow_id) {
    if (existing.status !== "failed") return existing;
    const restarted = {
      ...fresh,
      attempt: Number(existing.attempt || 1) + 1,
      previous_attempts: [
        ...(Array.isArray(existing.previous_attempts) ? existing.previous_attempts : []),
        {
          attempt: Number(existing.attempt || 1),
          status: existing.status,
          error: existing.error || null,
          created_at: existing.created_at,
          updated_at: existing.updated_at,
        },
      ].slice(-5),
    };
    return saveWorkflow(store, restarted);
  }
  return saveWorkflow(store, fresh);
}

export async function checkpointWorkflow(store, workflow, nextState, data = {}, nowIso = new Date().toISOString()) {
  return saveWorkflow(store, transitionWorkflow(workflow, nextState, data, nowIso));
}

export async function failWorkflow(store, workflow, error, data = {}, nowIso = new Date().toISOString()) {
  const message = error instanceof Error ? error.message : String(error || "Unknown workflow failure");
  return checkpointWorkflow(store, workflow, "failed", { ...data, message }, nowIso);
}

export function workflowStates(type) {
  return [...(WORKFLOW_STATES[type] || [])];
}
