/**
 * The Agents framework logs through its own pino logger, which must exist before any framework class is used.
 * The runtime initialises it once at `warn` (DATA-01: the framework's info and debug records can carry room names,
 * participant identities and SIP attributes such as the caller number); production log shipping drops anything the
 * framework writes below warn.
 */
import { initializeLogger, loggerOptions } from "@livekit/agents";

export type FrameworkLogLevel = "error" | "warn";

export function ensureFrameworkLogger(level: FrameworkLogLevel = "warn"): void {
  if (!loggerOptions()) initializeLogger({ pretty: false, level });
}
