// PDF identity comes from detection, never from arbitrary page source type alone.
export function isPdfImport(url, evidence) {
  if (!/^https?:\/\//i.test(url || '')) return false;
  return /\.pdf(?:[?#]|$)/i.test(url) || [
    'citation_pdf_url', 'pdf_link', 'pdf_content_type', 'arxiv_abstract',
    'arxiv_pdf', 'arxiv_html', 'arxiv_link', 'publisher_pdf',
  ].includes(evidence);
}

export function isConfirmedImportRejection(error) {
  return error?.code === 'SOURCE_IMPORT_REJECTED';
}

export function canFallback(state) {
  return state?.status === 'running' && state.importMethod === 'url' &&
    !state.fallbackAttempted && isPdfImport(state.originalPdfUrl, state.pdfEvidence);
}

// Claim each transition before external work. No PDF bytes are persisted in state.
export function createPdfFallback({ getState, transition, download, upload, poll, fail }) {
  return async function fallback(runId, { resume = false, file = null } = {}) {
    const state = await getState();
    const steps = resume ? ['wait_pdf_access'] : ['add_source', 'wait_source'];
    const claimed = await transition(runId, {
      step: 'download_pdf',
      fallbackAttempted: true,
      failedUrlSourceId: state.sourceId || null,
      stepDetail: file ? 'Preparing the selected PDF...' : 'URL import failed. Downloading the PDF for this notebook...',
    }, {
      expectedSteps: steps,
      condition: current => resume
        ? current.importMethod === 'url' && current.fallbackAttempted && !current.fallbackUploadStarted
        : canFallback(current),
    });
    if (!claimed) return false;
    try {
      const payload = file || await download(state.originalPdfUrl, state.pageUrl);
      const uploading = await transition(runId, {
        step: 'upload_pdf', fallbackUploadStarted: true,
        stepDetail: 'Uploading the PDF into the same notebook. Any failed URL source is kept.',
      }, { expectedSteps: ['download_pdf'] });
      if (!uploading) return false;
      const source = await upload(state.notebookId, payload);
      if (!source?.id) throw new Error('Upload returned no source ID. Open the notebook before retrying.');
      const waiting = await transition(runId, {
        importMethod: 'file', sourceId: source.id, replacementSourceId: source.id,
        step: 'wait_source', stepStartedAt: new Date().toISOString(),
        stepDetail: 'Replacement PDF uploaded. Waiting for processing...',
      }, { expectedSteps: ['upload_pdf'] });
      if (waiting) await poll();
      return !!waiting;
    } catch (error) {
      if (error?.code === 'PIPELINE_STALE_RUN') return false;
      const current = await getState();
      if (current.runId !== runId || current.status !== 'running') return false;
      if (current.step === 'download_pdf') {
        await transition(runId, {
          step: 'wait_pdf_access',
          stepDetail: `${error.message} Open the popup to grant access or select the PDF.`,
        }, { expectedSteps: ['download_pdf'] });
      } else {
        await fail(runId, `${error.message} The upload was not repeated. Check the existing notebook.`, state.notebookId);
      }
      return false;
    }
  };
}
