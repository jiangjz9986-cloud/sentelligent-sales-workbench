import { stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { hashPassword } from "../src/auth/password.js";

export async function readPasswordLine({ input = stdin, promptOutput = stderr } = {}) {
  const terminal = Boolean(input.isTTY);
  let mutedOutput;
  if (terminal) {
    promptOutput.write("Password: ");
    mutedOutput = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    mutedOutput.isTTY = true;
  }
  const reader = createInterface({
    input,
    ...(terminal ? { output: mutedOutput, terminal: true } : { terminal: false }),
  });
  try {
    return await reader.question("");
  } finally {
    reader.close();
    if (terminal) promptOutput.write("\n");
  }
}

export async function runHashPasswordCommand({
  args = process.argv.slice(2),
  input = stdin,
  output = stdout,
  promptOutput = stderr,
} = {}) {
  if (args.length > 0) {
    throw new Error("Password must be provided through standard input, not command-line arguments");
  }
  const password = await readPasswordLine({ input, promptOutput });
  if (!password) throw new Error("Password is required");
  output.write(`${await hashPassword(password)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runHashPasswordCommand();
}
