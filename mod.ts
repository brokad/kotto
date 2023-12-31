import { toFileUrl, resolve } from "./deps.ts"

import { Prompts, Scope } from "./prompts.ts";
export { Prompts }

import { Naive, Template } from "./const.ts";

import * as log from "./log.ts";
import * as llm from "./llm.ts";

import { Exit, Feedback, Interrupt, Internal } from "./errors.ts";
export { Exit, Feedback, Interrupt, Internal } from "./errors.ts";

export type AgentOptions = {
  argv: string[];
};

/**
 * Set the log level.
 */
export const setLogLevel = log.setLogLevel;

/**
 * Get the current log level.
 */
export const getLogLevel = log.getLogLevel;

const logger = log.logger;

export type FunctionCall = {
  name: string;
  reasoning?: string;
  arguments: any[];
};

type ExportDescriptor = {
  property_key: string;
  adder: (scope: Scope) => void;
  description?: string;
};

class ExportsMap {
  #inner: Map<string, ExportDescriptor> = new Map();

  get(property_key: string): ExportDescriptor | undefined {
    return this.#inner.get(property_key);
  }

  insert(property_key: string, descriptor: ExportDescriptor) {
    this.#inner.set(property_key, descriptor);
  }

  forEach(fn: (_: ExportDescriptor) => void) {
    this.#inner.forEach(fn);
  }
}

type ConstructorDecorator = <T extends { new (...args: any[]): {} }>(
  constructor: T,
) => any;

type MethodDecorator = (
  target: any,
  property_key: string,
  descriptor: PropertyDescriptor,
) => void;

const description = (task: string) => {
  return <T extends { new (...args: any[]): {} }>(constructor: T) => {
    constructor.prototype.task = task;
  };
};

const prompts = (prompts: string) => {
  return <T extends { new (...args: any[]): {} }>(constructor: T) => {
    constructor.prototype.prompts = prompts;
  };
};

export const use: MethodDecorator = (
  target: any,
  property_key: string,
  _descriptor?: PropertyDescriptor,
) => {
  if (target.exports === undefined) {
    target.exports = new Map();
  }
  target.exports.set(property_key, {
    property_key,
    adder: (scope: Scope) =>
      scope.addFromId(
        "method_decl",
        Scope.ident(target.constructor.name),
        Scope.ident(property_key),
      ),
  });
};

type Action = {
  call: FunctionCall;
  output?: object;
};

/**
 * An agent is a class that has at least one @use decorated method.
 *
 * You can run agents with [[run]] or [[runOnce]].
 */
export interface Agent {
  [functions: string]: any;
}

export type Exited = {
  output: any;
};

export function isExited(pending: Exited | Pending): pending is Exited {
  return "output" in pending;
}

export type Pending = {
  role: "user" | "system";
  prompt?: string;
};

export function isPending(exited: Exited | Pending): exited is Pending {
  return "prompt" in exited;
}

export type AgentControllerOpts = {
  allow_exit?: boolean;
};

/**
 * An agent controller is a class that manages the execution of an agent.
 *
 * You can run agents with [[run]] or [[runOnce]].
 */
export class AgentController {
  agent: Agent;

  prompts: Prompts;

  exports: ExportsMap;

  llm: llm.LLM;

  template: Template;

  history: Action[] = [];

  opts: AgentControllerOpts;

  retries = 0;
  max_retries = 5;

  constructor(
    agent: Agent,
    prompts: Prompts,
    llm: llm.LLM,
    opts: AgentControllerOpts = {},
  ) {
    this.agent = agent;

    this.prompts = prompts;

    this.exports = agent.exports || new ExportsMap();

    this.llm = llm;

    this.template = agent.template || Naive;

    this.opts = opts;
  }

  renderContext(): string {
    const scope = this.prompts.newScope();

    this.exports.forEach(({ property_key, adder }) => {
      logger.trace("prompts", `adding '${property_key}' to scope`);
      adder(scope);
    });

    if (this.opts.allow_exit ?? true) {
      scope.addNode({
        type: "ts",
        fmt: "builtins.exit",
        id: "builtins.exit",
        ast_ty: "fn_decl",
      });
    }

    return this.template.renderContext(scope);
  }

  handleBuiltin(action: Action) {
    const builtin = action.call.name.split(".")[1];

    if (builtin === "exit") {
      if (action.call.arguments.length === 0) {
        throw new Exit();
      } else {
        throw new Exit(action.call.arguments[0]);
      }
    } else {
      throw new Internal(`unknown builtin '${builtin}'`);
    }
  }

  async doAction(action: Action) {
    const exports = this.agent.exports;

    // if action.call.name is a builtin, call handleBuiltin
    if (action.call.name.startsWith("builtins.")) {
      return this.handleBuiltin(action);
    }

    const export_descriptor = exports.get(action.call.name);

    if (export_descriptor === undefined) {
      throw new TypeError(`${action.call.name} is not a function`);
    }

    const call_name = export_descriptor.property_key;

    if (typeof this.agent[call_name] !== "function") {
      throw new TypeError(`${action.call.name} is not a function`);
    }

    const args = action.call.arguments;

    logger.calls(call_name, args);
    const output = await (this.agent[call_name])(...args);
    logger.returns(output);

    action.output = output;
    this.history.push(action);
    return;
  }

  async tick(
    { prompt, role }: Pending = { role: "user" },
  ): Promise<Exited | Pending> {
    try {
      await this.complete(prompt, role);

      // On success, reset the retry counter
      this.retries = 0;

      return {
        role: "user",
      };
    } catch (err) {
      if (this.retries >= this.max_retries) {
        throw err
      }

      if (err instanceof Feedback) {
        logger.feedback(err);

        // Increase the retry counter as the starting tick
        // was rejected by the user
        this.retries += 1;

        return {
          prompt: err.message,
          role: "system",
        };
      } else if (err instanceof Interrupt) {
        logger.interrupt(err);
        throw err.inner_error;
      } else if (err instanceof Internal) {
        throw err;
      } else if (err instanceof Exit) {
        logger.exit(err);
        return {
          output: err.output,
        };
      } else {
        logger.error(err);

        // Increase the retry counter as the starting tick
        // failed to run successfully
        this.retries += 1;

        return {
          role: "system",
          prompt: this.template.renderError(err),
        };
      }
    }
  }

  async complete(prompt?: string, role: "user" | "system" = "system") {
    if (prompt === undefined) {
      if (this.history.length == 0) {
        prompt = this.renderContext();
      } else {
        const last = this.history[this.history.length - 1];
        prompt = this.template.renderOutput(last.output);
      }
    }

    const completion = await this.llm.complete([{
      "role": role,
      "content": prompt,
    }]);

    let response;
    try {
      response = this.template.parseResponse(completion);
    } catch (_) {
      throw new Feedback(
        `could not extract JSON from your response: ${completion}`,
      );
    }

    logger.thought(response.reasoning || "(no reasoning given)");

    await this.doAction({ call: response });
  }

  async runToCompletion(): Promise<any> {
    let tick = undefined;
    while (true) {
      tick = await this.tick(tick);
      if (isExited(tick)) {
        return tick.output;
      }
    }
  }
}

export function urlFromModuleSpecifier(module_specifier: string): URL {
  try {
    return new URL(module_specifier);
  } catch (_) {
    return toFileUrl(resolve(module_specifier));
  }
}

export type BuildFlags = {
  // URL to the module to build into prompts
  source_url: URL;
  // Local directory where the output (prompts) will be written
  work_dir?: string;
}

export function buildPrompts({ source_url, work_dir }: BuildFlags): Promise<URL> {
  return Prompts.build(source_url, { work_dir });
}

export type ControllerFlags<O> = {
  // The module to run
  source_url: URL;
  // The prompts to use
  prompts: Prompts;
  // The OpenAI key to use
  openai_key: string;
  // The options to pass to the agent
  agent_options: O;
  // Whether to expose `builtins.exit` to the agent
  allow_exit?: boolean;
};

export async function makeController<O>(opts: ControllerFlags<O>): Promise<AgentController> {
  const mod = await import(opts.source_url.href);

  if (mod.default === undefined) {
    throw new Internal(`module does not have a default export

try adding:

  export default () => new MyAgent()`);
  }

  const agent = await mod.default(opts.agent_options);

  const model = new llm.OpenAIChatCompletion(opts.openai_key);

  return new AgentController(agent, opts.prompts, model, {
    allow_exit: opts.allow_exit,
  });
}

export type RunFlags<A> = {
  agent: A;
  // The prompts to use
  prompts: Prompts | Promise<Prompts>;
  // The OpenAI key to use
  openai_key: string;
  // Whether to expose `builtins.exit` to the agent
  allow_exit?: boolean;
}

export async function run<A extends Agent, O>(opts: RunFlags<A>): Promise<O> {
  const model = new llm.OpenAIChatCompletion(opts.openai_key);

  const controller = new AgentController(opts.agent, await opts.prompts, model);

  return await controller.runToCompletion();
}

export type HandlerFlags<A> = {
  agent: (_: Request) => A;
  // The prompts to use
  prompts: Prompts | Promise<Prompts>;
  // The OpenAI key to use
  openai_key: string;
  // Whether to expose `builtins.exit` to the agent
  allow_exit?: boolean;
}

export function handler<A extends Agent>(opts: HandlerFlags<A>): (_: Request) => Promise<Response> {
  return (req: Request) => {
    const agent = opts.agent(req);
    return run<A, Response>({ ...opts, agent });
  }
}
