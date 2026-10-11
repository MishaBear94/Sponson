/**
 * The person at the keyboard, for `sponson init --setup`: hidden input for a token and yes/no questions. The real one
 * reads the process's own terminal; tests and embedders pass their own through `RunIO.terminal`.
 *
 * A token typed here is never echoed, never written to a file and never put in argv or an environment variable of a
 * process Sponson starts: it lives in this process's memory, registered with the command's redactor before any
 * request carries it.
 */

/** A person who can answer questions, or nobody (`interactive: false`: CI, an agent, a pipe). */
export interface Terminal {
  /** Whether a person can answer: stdin and stderr are a TTY. Without one nothing is ever asked. */
  readonly interactive: boolean;
  /** Ask for a secret. The answer is not echoed; an empty answer means "skip". */
  secret(question: string): Promise<string>;
  /** Ask a yes/no question; anything but y/yes is no. */
  confirm(question: string): Promise<boolean>;
}

/** The terminal for nobody: never interactive, never asked. */
export const NO_TERMINAL: Terminal = {
  interactive: false,
  secret: () => Promise.reject(new Error("no terminal to ask")),
  confirm: () => Promise.reject(new Error("no terminal to ask")),
};

/** The streams the process terminal reads and writes; `process.stdin` / `process.stderr` by default. */
export interface TtyStreams {
  stdin: NodeJS.ReadStream;
  /** Questions go to stderr so that `--json` keeps stdout one document. */
  stderr: NodeJS.WriteStream;
}

/** Ctrl-C, Ctrl-D, Enter, Backspace and Delete as raw mode delivers them. */
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = ["\u0008", "\u007f"];

/** The process's own terminal: interactive only when both stdin and stderr are TTYs. */
export function processTerminal(streams: TtyStreams = { stdin: process.stdin, stderr: process.stderr }): Terminal {
  const { stdin, stderr } = streams;
  const interactive = Boolean(stdin.isTTY && stderr.isTTY && typeof stdin.setRawMode === "function");
  return {
    interactive,
    secret: (question) => readHidden(stdin, stderr, question),
    confirm: async (question) => /^y(es)?$/i.test((await readLine(stdin, stderr, `${question} [y/N] `)).trim()),
  };
}

/** One line typed with echo off. Ctrl-C aborts (rejects); Ctrl-D or Enter ends the line. */
function readHidden(stdin: NodeJS.ReadStream, stderr: NodeJS.WriteStream, question: string): Promise<string> {
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === CTRL_C) return done(new Error("cancelled"));
        if (ch === "\r" || ch === "\n" || ch === CTRL_D) return done();
        if (BACKSPACE.includes(ch)) value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** One line typed with echo on (a yes/no answer). */
function readLine(stdin: NodeJS.ReadStream, stderr: NodeJS.WriteStream, question: string): Promise<string> {
  stderr.write(question);
  return new Promise((resolve) => {
    let line = "";
    const onData = (chunk: Buffer | string) => {
      line += chunk.toString("utf8");
      const end = line.search(/[\r\n]/);
      if (end < 0) return;
      stdin.off("data", onData);
      stdin.pause();
      resolve(line.slice(0, end));
    };
    stdin.resume();
    stdin.on("data", onData);
  });
}
