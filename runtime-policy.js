export const PIPELINE_ALARM_NAME = 'pipeline-poll';
export const PIPELINE_POLL_PERIOD_MINUTES = 0.5;

const RECOVERABLE_POLLING_STEPS = new Set(['wait_source', 'wait_artifacts']);
const NON_IDEMPOTENT_STEPS = new Set([
  'auth',
  'create_notebook',
  'add_source',
  'upload_pdf',
  'generate_artifacts',
]);
const STOPPABLE_STEPS = new Set(['wait_source', 'wait_artifacts', 'wait_pdf_access', 'download_pdf']);

export function isActivePipelineRun(state, runId) {
  return !!runId && state?.status === 'running' && state.runId === runId;
}

export function canStopPipeline(state, runId = state?.runId) {
  return isActivePipelineRun(state, runId) && STOPPABLE_STEPS.has(state.step);
}

export function createPipelineStateCoordinator({ readState, writeState }) {
  if (typeof readState !== 'function' || typeof writeState !== 'function') {
    throw new TypeError('readState and writeState functions are required');
  }

  let queue = Promise.resolve();

  const transact = operation => {
    const apply = async () => {
      const current = await readState();
      const result = await operation(current);
      if (!result) return { applied: false, state: current };

      const next = result.replace ? result.state : { ...current, ...result.updates };
      if (result.beforeWrite) await result.beforeWrite(current, next);
      await writeState(next);
      let effectError = null;
      if (result.afterWrite) {
        try {
          await result.afterWrite(current, next);
        } catch (error) {
          effectError = error;
        }
      }
      return { applied: true, state: next, effectError };
    };
    queue = queue.then(apply, apply);
    return queue;
  };

  return {
    update(updates, effects = {}) {
      return transact(current => ({
        updates: typeof updates === 'function' ? updates(current) : updates,
        ...effects,
      }));
    },

    replace(state, effects = {}) {
      return transact(() => ({ replace: true, state, ...effects }));
    },

    reset(state, effects = {}) {
      return transact(current => {
        if (current?.status === 'running') return null;
        return { replace: true, state, ...effects };
      });
    },

    effectWhen(predicate, effect) {
      return transact(current => {
        if (!predicate(current)) return null;
        return { updates: {}, afterWrite: effect };
      });
    },

    claim(runId, initialState, effects = {}) {
      return transact(current => {
        if (!runId || current?.status !== 'idle') return null;
        return {
          replace: true,
          state: { ...initialState, status: 'running', runId },
          ...effects,
        };
      });
    },

    transition(runId, updates, { expectedSteps = null, condition = null, ...effects } = {}) {
      return transact(current => {
        if (!isActivePipelineRun(current, runId)) return null;
        if (expectedSteps && !expectedSteps.includes(current.step)) return null;
        if (condition && !condition(current)) return null;
        return {
          updates: typeof updates === 'function' ? updates(current) : updates,
          ...effects,
        };
      });
    },

    invalidate(runId, replacement, { expectedSteps = null, ...effects } = {}) {
      return transact(current => {
        if (!isActivePipelineRun(current, runId)) return null;
        if (expectedSteps && !expectedSteps.includes(current.step)) return null;
        return {
          replace: true,
          state: typeof replacement === 'function' ? replacement(current) : replacement,
          ...effects,
        };
      });
    },
  };
}

export function runtimeRecoveryAction(state, hasAlarm) {
  if (!state || state.status !== 'running') {
    return hasAlarm ? 'clear_alarm' : 'none';
  }

  if (RECOVERABLE_POLLING_STEPS.has(state.step)) {
    return hasAlarm ? 'none' : 'create_alarm';
  }

  if (state.step === 'wait_pdf_access' || state.step === 'download_pdf') {
    return 'wait_pdf_access';
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
