export const PIPELINE_ALARM_NAME = 'pipeline-poll';
export const PIPELINE_POLL_PERIOD_MINUTES = 0.5;

const RECOVERABLE_POLLING_STEPS = new Set(['wait_source', 'wait_artifacts']);
const NON_IDEMPOTENT_STEPS = new Set([
  'auth',
  'create_notebook',
  'add_source',
  'generate_artifacts',
]);

export function runtimeRecoveryAction(state, hasAlarm) {
  if (!state || state.status !== 'running') {
    return hasAlarm ? 'clear_alarm' : 'none';
  }

  if (RECOVERABLE_POLLING_STEPS.has(state.step)) {
    return hasAlarm ? 'none' : 'create_alarm';
  }

  if (NON_IDEMPOTENT_STEPS.has(state.step)) {
    return 'interrupt';
  }

  return hasAlarm ? 'clear_alarm' : 'interrupt';
}

export function interruptedPipelineUpdate(state) {
  const notebookHint = state?.notebookUrl
    ? ' Open the existing notebook to check its current state, or start a new run.'
    : ' Start a new run.';
  const message = `The browser interrupted the pipeline during ${state?.step || 'setup'}.` +
    ` Automatic retry was stopped to avoid duplicate notebooks or artifacts.${notebookHint}`;

  return {
    status: 'error',
    step: 'error',
    stepDetail: message,
    error: message,
    completedAt: new Date().toISOString(),
  };
}

export function pollingElapsedMs(stepStartedAt, now = Date.now()) {
  const startedAt = Date.parse(stepStartedAt);
  if (!Number.isFinite(startedAt)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - startedAt);
}

export function createExclusiveRunner() {
  let inFlight = false;

  return async function runExclusive(task) {
    if (inFlight) return false;
    inFlight = true;
    try {
      await task();
      return true;
    } finally {
      inFlight = false;
    }
  };
}
