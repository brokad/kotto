import { ChatCompletionRequestMessage, CreateChatCompletionRequest, Configuration, OpenAIApi } from "npm:openai@^3.3.0"

import { parse as parsePath, join as joinPath, ParsedPath, fromFileUrl } from "https://deno.land/std@0.198.0/path/mod.ts"
import * as colors from "https://deno.land/std@0.198.0/fmt/colors.ts"

import { doRun } from "./bootstrap.ts"

export class Interrupt extends Error {
    constructor(...args) {
        super(...args)
    }
}

export type FunctionCall = {
    name: string,
    reasoning?: string,
    arguments: any[]
}

function blockQuote(s: string, type?: string): string {
    return `\`\`\`${type || "TypeScript"}\n${s}\n\`\`\``
}

class LLM {
    #openai: OpenAIApi
    #messages: ChatCompletionRequestMessage[] = []
    #base: CreateChatCompletionRequest

    get messages(): ChatCompletionRequestMessage[] {
        return this.#messages
    }

    constructor() {
        const configuration = new Configuration({
            apiKey: Deno.env.get("OPENAI_KEY")
        });

        this.#openai = new OpenAIApi(configuration)

        this.#base = {
            "model": "gpt-3.5-turbo",
            "messages": []
        }
    }

    async send(messages: ChatCompletionRequestMessage[]): Promise<ChatCompletionRequestMessage> {
        let req: CreateChatCompletionRequest = {
            ...this.#base,
            "messages": this.#messages.concat(messages)
        }

        const resp = await this.#openai.createChatCompletion(req)
        const resp_msg = resp.data.choices[0].message
        if (resp_msg === undefined) {
            throw new Error("TODO")
        } else {
            this.#messages.push(...messages, resp_msg)
            return resp_msg
        }
    }

    async call(messages: ChatCompletionRequestMessage[]): Promise<FunctionCall> {
        const resp = await this.send(messages)
        console.log(colors.blue(`response: ${resp.content}`))
        return JSON.parse(resp.content)
    }
}

export type ExportDescriptor = {
    property_key: string,
    description?: string
}

export class ExportsMap {
    #inner: Map<string, ExportDescriptor> = new Map()

    get(property_key: string): ExportDescriptor | undefined {
        return this.#inner.get(propertyKey)
    }

    insert(property_key: string, descriptor: ExportDescriptor) {
        this.#inner.set(propertyKey, descriptor)
    }
}

type ConstructorDecorator = <T extends { new (...args: any[]): {} } >(constructor: T) => any

type MethodDecorator = (target: any, property_key: string, descriptor: PropertyDescriptor) => void

const description_decorator = (task: string) => {
    return <T extends { new (...args: any[]): {} } >(constructor: T) => {
        constructor.prototype.task = task
    }
}

const prompts_decorator = (prompts: string) => {
    return <T extends { new (...args: any[]): {} } >(constructor: T) => {
        constructor.prototype.prompts = prompts
    }
}

const use_decorator: () => MethodDecorator = () => {
    return (target: any, property_key: string, descriptor?: PropertyDescriptor) => {
        if (target.exports === undefined) {
            target.exports = new Map()
        }
        target.exports.set(property_key, {
            property_key
        })
    }
}

export class Agent {
    resolved?: any = undefined
    is_done: boolean = false
    description?: string

    resolve(value: any) {
        this.is_done = true
        this.resolved = value
    }

    then(onResolve, onReject) {
        return (new AgentController(this)).then(onResolve, onReject)
    }
}

type PromptDescriptor = {
    ty: "plain_text" | "ts"
    fmt: string
    id: string
    context: string[]
}

export class Prompts {
    #source_path: string
    #prompts

    constructor(path: string) {
        this.#source_path = path
    }

    async load() {
        const source_path = this.#source_path
        const parsed_path = parsePath(source_path)
        const source_path_file = fromFileUrl(source_path)

        const proc = await doRun({
            args: [source_path_file]
        })

        if (!(await proc.status).success) {
            throw new Error("tc exited unsuccessfully")
        }

        const output_path = joinPath(parsed_path.dir, `${parsed_path.name}.prompts.js`)
        this.#prompts = await import(output_path)
    }

    regexFor(kind: string, name: string | string[]) {
        let regex = `^${kind}`

        let names
        if (typeof name === "string") {
            names = [name]
        } else {
            names = name
        }

        regex = regex.concat(...names.map((n) => `\\.${n}#\\d+`), "$")

        return new RegExp(regex)
    }

    iterFor(kind: string, name: string) {
        const regex = this.regexFor(kind, name)
        return this.#prompts.ast.filter((node) => regex.test(node.id))
    }

    getTypeAliasDecls(): string[] {
        return this.iterFor("type_alias_decl", "\\w+").map((m) => m.fmt)
    }

    getClassDecl(of: string): string | undefined {
        return this.iterFor("class_decl", of).pop()?.fmt
    }

    getMethodDecls(of_class: string): string[] {
        return this.iterFor("method_decl", [of_class, "\\w+"]).map((m) => m.fmt)
    }
}

type Action = {
    call: FunctionCall,
    output?: any
}

export class AgentController {
    agent: Agent
    llm: LLM
    prompts: Prompts
    do_init: Promise<void>
    history: Action[] = []

    constructor(agent: Agent) {
        this.agent = agent
        this.llm = new LLM()
        this.prompts = new Prompts(agent.prompts)
        this.do_init = new Promise((onResolve, onReject) => this.doInit().then(onResolve, onReject))
    }

    async doInit() {
        await this.prompts.load()
    }

    outputTemplate(): string {
        return blockQuote(`{
   "name": "the name of the function you want to call",
   "reasoning": "the reasoning that you've used to arrive to the conclusion you should use this function",
   "arguments": [
        // ... the arguments of the function you want to call
   ] 
}
`, "json")
    }

    initialPrompt(): string {
        const exports = this.agent.exports
        const class_name = this.agent.constructor.name
        const method_decls = this.prompts.getMethodDecls(class_name).join("\n\n")
        const type_alias_decls = this.prompts.getTypeAliasDecls().join("\n\n")
        const all_code = [type_alias_decls, method_decls].join("\n\n")

        return `
You are the runtime of a JavaScript program, you decide which functions to call.

Here is the abbreviated code of the program:

${blockQuote(all_code)}

I am going to feed this discussion to an API. So do not be verbose, just tell me which function you want 
to call, with what argument, and I will tell you what the returned value is. Each of your prompts must 
be of the following JSON form:

${this.outputTemplate()}

You must make sure that the function you are calling accepts the arguments you give it. This includes
checking the arguments have the correct type for that function (refer to the types defined above, and the 
built-in type definitions that are part of JavaScript/TypeScript's specification).

Let's begin!
`
    }

    async doAction(action: Action) {
        const output = await (this.agent[action.call.name])(...action.call.arguments)
        action.output = output
        this.history.push(action)
    }

    async doNext(prompt?: string, role?: string): Promise<any> {
        if (this.agent.is_done) {
            throw new Error("agent is done")
        }

        if (prompt === undefined) {
            if (this.llm.messages.length == 0) {
                prompt = this.initialPrompt()
            } else {
                const last = this.history[this.history.length - 1]
                prompt = blockQuote(JSON.stringify(last.output), "json")
            }
        }

        if (role === undefined) {
            role = "system"
        }

        console.log(colors.yellow(`prompt: ${prompt}`))

        const response = await this.llm.call([{
            "role": role,
            "content": prompt
        }])

        console.error(colors.gray(`llm: ${response.reasoning}`))

        await this.doAction({ call: response })

        return this.agent.resolved
    }

    async runToCompletion(): any {
        await this.do_init

        let resolved
        do {
            try {
                resolved = await this.doNext()
            } catch (e) {
                if (!(e instanceof Interrupt)) {
                    console.log(colors.red(`llm: exception thrown: ${e}, retrying`))
                    resolved = await this.doNext(`
error: ${e}. 

Remember, your answers must be valid JSON objects, conforming to the following format:

${this.outputTemplate()}
`)
                } else {
                    throw e
                }
            }
        } while (!this.agent.is_done)
        return resolved
    }

    then(onResolve, onReject) {
        return this.runToCompletion().then(onResolve, onReject)
    }
}

export default {
    Agent,
    use: use_decorator(),
    task: description_decorator,
    prompts: prompts_decorator,
    Interrupt
}