export function bindDetectionToTab(detection, tab) {
  if (!detection || !Number.isInteger(tab?.id) || typeof tab?.url !== 'string') return null;
  return {
    ...detection,
    tabId: tab.id,
    tabUrl: tab.url,
    detectedAt: new Date().toISOString(),
  };
}

export function detectionMatchesTab(detection, tab) {
  return !!detection &&
    Number.isInteger(detection.tabId) &&
    Number.isInteger(tab?.id) &&
    detection.tabId === tab.id &&
    typeof detection.tabUrl === 'string' &&
    typeof tab?.url === 'string' &&
    detection.tabUrl === tab.url &&
    detection.pageUrl === tab.url;
}

export function directDetectionMatchesTab(detection, tab) {
  return !!detection &&
    typeof detection.pageUrl === 'string' &&
    typeof tab?.url === 'string' &&
    detection.pageUrl === tab.url;
}
