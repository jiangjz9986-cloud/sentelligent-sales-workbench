import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fullBlock = "\u2588";
const lowerBlock = "\u2584";
const upperBlock = "\u2580";

function backendRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function extractTerminalQrLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.includes(fullBlock) || line.includes(lowerBlock) || line.includes(upperBlock));
}

export function terminalQrToSvg(text, { scale = 8, quiet = 4 } = {}) {
  const lines = extractTerminalQrLines(text);
  if (lines.length === 0) return "";

  const width = Math.max(...lines.map((line) => line.length));
  const height = lines.length * 2;
  const svgWidth = (width + quiet * 2) * scale;
  const svgHeight = (height + quiet * 2) * scale;
  const rects = [];

  for (let y = 0; y < lines.length; y += 1) {
    const line = lines[y].padEnd(width, " ");
    for (let x = 0; x < line.length; x += 1) {
      const char = line[x];
      const top = char === fullBlock || char === upperBlock;
      const bottom = char === fullBlock || char === lowerBlock;
      if (top) rects.push(`<rect x="${(x + quiet) * scale}" y="${(y * 2 + quiet) * scale}" width="${scale}" height="${scale}"/>`);
      if (bottom) rects.push(`<rect x="${(x + quiet) * scale}" y="${(y * 2 + quiet + 1) * scale}" width="${scale}" height="${scale}"/>`);
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}" role="img" aria-label="微信绑定二维码">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<g fill="#0f172a">${rects.join("")}</g>`,
    `</svg>`,
  ].join("");
}

function defaultSpawnLoginProcess({ env }) {
  return spawn(process.execPath, ["src/weixin/worker.js", "login-start"], {
    cwd: backendRoot(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function publicState(state) {
  return {
    status: state.status,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    finishedAt: state.finishedAt,
    pid: state.pid ?? null,
    qrSvg: state.qrSvg ?? "",
    message: state.message ?? "",
  };
}

export function createWeixinLoginBinding({
  config,
  spawnLoginProcess = defaultSpawnLoginProcess,
  now = () => new Date(),
} = {}) {
  let child = null;
  let output = "";
  let stopping = false;
  let state = {
    status: "idle",
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    pid: null,
    qrSvg: "",
    message: "尚未生成二维码",
  };

  function updateFromOutput(chunk) {
    output += String(chunk ?? "");
    const qrSvg = terminalQrToSvg(output);
    if (qrSvg) {
      state = {
        ...state,
        status: state.status === "logged_in" ? "logged_in" : "waiting_scan",
        updatedAt: now().toISOString(),
        qrSvg,
        message: "二维码已生成，请尽快扫码",
      };
    }
    if (/login completed|登录完成|扫码成功|connected/i.test(output)) {
      state = {
        ...state,
        status: "logged_in",
        updatedAt: now().toISOString(),
        finishedAt: null,
        message: "微信已绑定，机器人正在运行",
      };
    }
  }

  function start() {
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }

    output = "";
    stopping = false;
    const sessionHome = config.weixinAgentSessionHome || process.env.HOME;
    if (sessionHome) mkdirSync(sessionHome, { recursive: true, mode: 0o700 });

    state = {
      status: "starting",
      startedAt: now().toISOString(),
      updatedAt: now().toISOString(),
      finishedAt: null,
      pid: null,
      qrSvg: "",
      message: "正在生成微信绑定二维码",
    };

    child = spawnLoginProcess({
      env: {
        ...process.env,
        HOME: sessionHome || process.env.HOME || "",
      },
    });
    state = { ...state, pid: child.pid ?? null };

    child.stdout?.on("data", (chunk) => updateFromOutput(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => updateFromOutput(chunk.toString("utf8")));
    child.on?.("error", (error) => {
      state = {
        ...state,
        status: "error",
        updatedAt: now().toISOString(),
        finishedAt: now().toISOString(),
        message: error.message,
      };
    });
    child.on?.("exit", (code) => {
      if (stopping) return;
      if (state.status === "logged_in") {
        state = {
          ...state,
          status: "stopped",
          updatedAt: now().toISOString(),
          finishedAt: now().toISOString(),
          message: "机器人进程已停止，可重新生成二维码",
        };
        return;
      }
      state = {
        ...state,
        status: code === 0 && /login completed|登录完成|扫码成功|connected/i.test(output) ? "logged_in" : "expired",
        updatedAt: now().toISOString(),
        finishedAt: now().toISOString(),
        message: code === 0 ? "登录流程已结束" : "二维码已失效，请重新生成",
      };
    });

    return publicState(state);
  }

  function current() {
    return publicState(state);
  }

  function stop() {
    stopping = true;
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
    state = {
      ...state,
      status: "idle",
      updatedAt: now().toISOString(),
      finishedAt: now().toISOString(),
      message: "已停止当前绑定流程",
    };
    return publicState(state);
  }

  return { start, current, stop };
}
