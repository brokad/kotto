import { colors, unicodeWidth } from "./deps.ts";
import { Exit, Feedback, Interrupt } from "./errors.ts";

/**
 * The log level.
 *
 * "trace": logs every interaction with the LLM backend
 * "quiet": do not log anything
 */
export type LogLevel = "trace" | "quiet";

type Color = "red" | "magenta" | "green" | "cyan" | "yellow";

function toColorFn(color: Color): (_: string) => string {
  switch (color) {
    case "red":
      return colors.red;
    case "magenta":
      return colors.magenta;
    case "green":
      return colors.green;
    case "cyan":
      return colors.cyan;
    case "yellow":
      return colors.yellow;
  }
}

/**
 * Set the log level.
 * @param level
 */
export function setLogLevel(level: LogLevel) {
  logger.log_level = level;
}

/**
 * Get the current log level.
 */
export function getLogLevel(): LogLevel {
  return logger.log_level;
}

class Logger {
  stringified_max_length = 76;
  header_width = 5;
  log_level: LogLevel = "quiet";

  toLogLevelNum(): number {
    switch (this.log_level) {
      case "trace":
        return 0;
      case "quiet":
        return 1;
    }
  }

  trace(header = "", message = "") {
    const width = unicodeWidth(colors.stripColor(header));
    const pad = this.header_width - width;
    header = " ".repeat(pad >= 0 ? pad : 0) + header;

    if (this.toLogLevelNum() <= 0) {
      console.error(
        `${colors.dim("trace:")} ${colors.bold(header) || ""} ${message}`,
      );
    }
  }

  arrowed(color: Color, header: string, message: string) {
    const color_fn = toColorFn(color);
    this.trace(color_fn("⮑"), ` ${colors.bold(color_fn(header))} ${message}`);
  }

  calls(name: string, args: any[]) {
    const pretty_fn = colors.cyan(colors.bold(name));
    const pretty_args = args.map((arg) => colors.dim(JSON.stringify(arg))).join(
      ", ",
    );
    this.trace("call", `${pretty_fn}(${pretty_args})`);
  }

  stringify(value: any): string {
    if (value === undefined) {
      return "null";
    }

    let output_str = JSON.stringify(value);

    if (output_str.length > this.stringified_max_length) {
      output_str = output_str.slice(0, this.stringified_max_length).trimEnd() +
        "...";
    }

    return output_str;
  }

  returns(value: any) {
    const pretty_output = colors.dim(this.stringify(value));
    this.arrowed("magenta", "returns", pretty_output);
  }

  feedback(err: Feedback) {
    this.arrowed("green", "feedback", err.message);
  }

  interrupt(err: Interrupt) {
    const pretty_value = colors.dim(this.stringify(err.inner_error));
    this.trace(colors.yellow("throw"), pretty_value);
  }

  error(err: Error) {
    this.trace(colors.red("error"), err.message);
  }

  exit(err: Exit) {
    const pretty_value = colors.dim(this.stringify(err.value));
    this.trace(colors.green("exit"), pretty_value);
  }

  thought(msg: string) {
    this.trace(colors.gray("╭"), colors.gray(msg));
  }

  eprint(msg?: string, header = "kotto", color: Color = "cyan") {
    if (color == undefined) {
      color = "cyan";
    }

    if (header === undefined) {
      header = "kotto";
    }

    const color_fn = toColorFn(color);

    console.error(`${color_fn(header)}: ${msg || ""}`);
  }
}

export const logger = new Logger();

export const eprint = (msg: string, header?: string, color?: Color) =>
  logger.eprint(msg, header, color);

export const error = (msg: string) => eprint(msg, colors.bold("error"), "red");

export const warn = (msg: string) =>
  eprint(msg, colors.bold("warning"), "yellow");

export const info = (msg: string) => eprint(msg, "info");
