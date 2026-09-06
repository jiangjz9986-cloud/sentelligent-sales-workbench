export function createAiSuggestionRequestFence() {
  let generation = 0;
  let current = null;
  let disposed = false;

  function cancel() {
    generation += 1;
    if (current?.timer) clearTimeout(current.timer);
    current?.controller.abort();
    current = null;
  }

  return {
    resume() {
      disposed = false;
    },
    start(sourceKey, timeoutMs) {
      cancel();
      const request = {
        controller: new AbortController(),
        generation,
        sourceKey,
        timedOut: false,
        timer: null,
      };
      request.timer = setTimeout(() => {
        request.timedOut = true;
        request.controller.abort();
      }, timeoutMs);
      current = request;
      return request;
    },
    owns(request, sourceKey) {
      return !disposed
        && current === request
        && request?.generation === generation
        && request?.sourceKey === sourceKey;
    },
    isCurrent(request, sourceKey) {
      return this.owns(request, sourceKey)
        && request?.timedOut !== true
        && request?.controller.signal.aborted !== true;
    },
    finish(request) {
      if (request?.timer) clearTimeout(request.timer);
      if (current === request) current = null;
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
