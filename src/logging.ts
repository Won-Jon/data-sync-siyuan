enum LogLevel {
    INFO = "INFO",
    WARN = "WARN",
    ERROR = "ERROR"
}

let logs: string[] = [];

export class SessionLog {
    static log(message: string, level: LogLevel = LogLevel.INFO) {
        logs.push(`[${level}]: ${message}`);
    }

    static getLogs() {
        return logs;
    }

    static getLogsAsString() {
        return logs.join('\n');
    }

    static clear() {
        logs = [];
    }
}

/**
 * Serialize an arbitrary value for the session log.
 *
 * `JSON.stringify(new Error("boom"))` is `{}` — which turned every sync failure
 * into `[ERROR]: Error during sync: {}` and made the log useless. Errors now
 * print their message and stack, and circular objects no longer throw.
 */
function valueToString(value: any): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (value instanceof Error) {
        const cause = (value as any).cause;
        const causeText = cause ? `\n  caused by: ${valueToString(cause)}` : '';
        return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}${causeText}`;
    }
    const seen = new WeakSet();
    try {
        return JSON.stringify(value, (_key, val) => {
            if (typeof val === 'object' && val !== null) {
                if (seen.has(val)) return '[Circular]';
                seen.add(val);
            }
            return val;
        }) ?? String(value);
    } catch {
        return String(value);
    }
}

function convertArgsToString(args: any[]): string {
    return args.map(valueToString).join(' ');
}

export function consoleLog(...args: any[]) {
    console.log(...args);
    SessionLog.log(convertArgsToString(args), LogLevel.INFO);
}

export function consoleError(...args: any[]) {
    console.error(...args);
    SessionLog.log(convertArgsToString(args), LogLevel.ERROR);
}

export function consoleWarn(...args: any[]) {
    console.warn(...args);
    SessionLog.log(convertArgsToString(args), LogLevel.WARN);
}
