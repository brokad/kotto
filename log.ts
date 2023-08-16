import * as colors from "https://deno.land/std@0.198.0/fmt/colors.ts"
import { unicodeWidth } from "https://deno.land/std@0.198.0/console/mod.ts";

export type LogLevel = "trace" | undefined

export function setLogLevel(level: LogLevel) {
    logger.log_level = level
}

export function getLogLevel(): LogLevel {
    return logger.log_level
}

class Logger {
    stringified_max_length: number = 76
    header_width: number = 8
    log_level: LogLevel = "trace"

    toLogLevelNum(): number {
        switch (this.log_level) {
            case "trace":
                return 0
            case undefined:
                return 1
        }
    }
    
    trace(header: string, message: string) {
        const width = unicodeWidth(colors.stripColor(header))
        const pad = this.header_width - width
        header = ' '.repeat(pad >= 0 ? pad : 0) + header

        if (this.toLogLevelNum() <= 0)
            console.error(`${colors.dim("trace:")} ${colors.bold(header) || ""} ${message}`)
    }

    arrowed(color: string, header: string, message: string) {
        const color_fn = colors[color]!
        this.trace(color_fn("⮑"), ` ${colors.bold(color_fn(header))} ${message}`)
    }

    calls(name: string, args: any[]) {
        const pretty_fn = colors.cyan(colors.bold(name))
        const pretty_args = args.map(arg => colors.dim(JSON.stringify(arg))).join(", ")
        this.trace("call", `${pretty_fn}(${pretty_args})`)
    }

    stringify(value: any): string {
        let output_str = JSON.stringify(value)
                    
        if (output_str.length > this.stringified_max_length)
            output_str = output_str.slice(0, this.stringified_max_length).trimEnd() + '...'
        
        return output_str
    }

    returns(value: any) {
        const pretty_output = colors.dim(this.stringify(value))
        this.arrowed("magenta", "returns", pretty_output)
    }

    feedback(err: Feedback) {
        this.arrowed("green", "feedback", err.message)
    }

    interrupt(err: Interrupt) {
        const pretty_value = colors.dim(this.stringify(err.value))
        this.arrowed("yellow", "interrupt", pretty_value)
    }

    error(err: Error) {
        this.trace(colors.red("error"), err.message)
    }

    exit(err: Exit) {
        const pretty_value = colors.dim(this.stringify(err.value))
        this.trace("✅", pretty_value)
    }

    thought(msg: string) {
        this.trace(colors.gray("thought"), colors.gray(msg))
    }
    
    eprint(msg: string, header?: string = "trackway", color?: string = "cyan") {
        if (color == undefined)
            color = "cyan"

        if (header === undefined)
            header = "trackway"

        const color_fn = colors[color]

        console.error(`${color_fn(header + ":")} ${msg}`)
    }
}

const logger = new Logger()

export const eprint = (msg: string, header?: string, color?: string) => logger.eprint(msg, header, color)

export const error = (msg: string) => eprint(msg, colors.bold("error"), "red")

export const info = (msg: string) => eprint(msg)

export default logger
