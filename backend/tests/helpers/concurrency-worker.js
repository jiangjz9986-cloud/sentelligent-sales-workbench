import { once } from "node:events";
import {
  isMainThread,
  parentPort,
  threadId,
  Worker,
  workerData,
} from "node:worker_threads";

import { createServer } from "../../src/server.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function jsonRequest(baseUrl, request) {
  const response = await fetch(`${baseUrl}${request.path}`, {
    ...(request.options ?? {}),
    headers: {
      "Content-Type": "application/json",
      ...(request.options?.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function serializedError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  };
}

async function runWorker() {
  let server;
  try {
    server = createServer({
      databaseUrl: workerData.databaseUrl,
      seed: false,
      nodeEnv: "test",
      aiAnalysisMode: "mock",
      modelApiKey: "",
      authRequired: false,
      authAccount: "",
      authPassword: "",
    });
    const baseUrl = await listen(server);
    parentPort.postMessage({ type: "ready", threadId });
    const [message] = await once(parentPort, "message");
    if (message?.type !== "arm") throw new Error("Concurrency worker was not armed");

    const barrier = new Int32Array(workerData.barrier);
    Atomics.add(barrier, 0, 1);
    parentPort.postMessage({ type: "armed", threadId });
    const waitResult = Atomics.wait(barrier, 1, 0, workerData.timeoutMs);
    if (waitResult === "timed-out") throw new Error("Concurrency worker start barrier timed out");

    const startedAt = Date.now();
    const results = await Promise.all(
      workerData.requests.map((request) => jsonRequest(baseUrl, request)),
    );
    const finishedAt = Date.now();
    await closeServer(server);
    server = null;
    parentPort.postMessage({
      type: "result",
      threadId,
      startedAt,
      finishedAt,
      results,
    });
  } catch (error) {
    try {
      await closeServer(server);
    } catch (closeError) {
      parentPort.postMessage({
        type: "error",
        error: serializedError(new AggregateError([error, closeError], "Worker failed and could not close")),
      });
      return;
    }
    parentPort.postMessage({ type: "error", error: serializedError(error) });
  }
}

function waitForMessage(worker, expectedType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for worker ${expectedType}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message) => {
      if (message?.type === "error") {
        cleanup();
        const error = new Error(message.error?.message ?? "Concurrency worker failed");
        if (message.error?.stack) error.stack = message.error.stack;
        reject(error);
        return;
      }
      if (message?.type !== expectedType) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Concurrency worker exited before ${expectedType} with code ${code}`));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

export async function runConcurrentWorkerRequests({ databaseUrl, batches, timeoutMs = 30_000 }) {
  if (!isMainThread) throw new Error("Worker orchestration must run on the main thread");
  if (!Array.isArray(batches) || batches.length < 2 || batches.some((batch) => !Array.isArray(batch))) {
    throw new TypeError("At least two worker request batches are required");
  }

  const barrierBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(barrierBuffer);
  const workers = batches.map((requests) => new Worker(new URL(import.meta.url), {
    execArgv: [],
    workerData: {
      databaseUrl,
      requests,
      barrier: barrierBuffer,
      timeoutMs,
    },
  }));

  try {
    await Promise.all(workers.map((worker) => waitForMessage(worker, "ready", timeoutMs)));
    const armed = workers.map((worker) => waitForMessage(worker, "armed", timeoutMs));
    for (const worker of workers) worker.postMessage({ type: "arm" });
    await Promise.all(armed);
    if (Atomics.load(barrier, 0) !== workers.length) {
      throw new Error("Not every concurrency worker reached the start barrier");
    }

    const results = workers.map((worker) => waitForMessage(worker, "result", timeoutMs));
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1, workers.length);
    return { batches: await Promise.all(results) };
  } finally {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1, workers.length);
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}

if (!isMainThread) {
  await runWorker();
}
