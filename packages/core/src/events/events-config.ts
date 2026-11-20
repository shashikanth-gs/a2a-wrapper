/**
 * Resolution of `events.*` settings: environment overrides and `${VAR}`
 * substitution, so collector URLs and tokens can stay out of config files.
 *
 * @module events/events-config
 */

import type { EventsConfig } from "../config/types.js";

const VAR_TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const warned = new Set<string>();

/** Test hook: forget which variables have already been warned about. */
export function _resetEventsConfigWarnings(): void {
  warned.clear();
}

/**
 * Replace `${VAR}` with `env[VAR]`. An unset variable is left as written and a
 * warning naming the variable (never a value) is printed once per variable.
 */
export function substituteEnv(
  value: string,
  where: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return value.replace(VAR_TOKEN, (token, name: string) => {
    const found = env[name];
    if (found === undefined) {
      if (!warned.has(name)) {
        warned.add(name);
        console.warn(`[a2a-wrapper/events] ${where} references unset environment variable ${name}`);
      }
      return token;
    }
    return found;
  });
}

const TRANSPORTS = ["a2a", "http", "both"] as const;

/**
 * Apply environment overrides and `${VAR}` substitution to an events config.
 *
 * Precedence: environment > JSON. Variables:
 * - `A2A_EVENTS_TRANSPORT`: `a2a` | `http` | `both`
 * - `A2A_EVENTS_HTTP_URL`: collector URL
 *
 * `${VAR}` is resolved in `httpUrl` and in every `httpHeaders` value.
 */
export function resolveEventsConfig(
  cfg: EventsConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): EventsConfig {
  const out: EventsConfig = { ...(cfg ?? {}) };

  const t = env["A2A_EVENTS_TRANSPORT"]?.trim().toLowerCase();
  if (t) {
    if ((TRANSPORTS as readonly string[]).includes(t)) {
      out.transport = t as EventsConfig["transport"];
    } else {
      console.warn(`[a2a-wrapper/events] ignoring invalid A2A_EVENTS_TRANSPORT "${t}" (expected a2a | http | both)`);
    }
  }

  const url = env["A2A_EVENTS_HTTP_URL"]?.trim();
  if (url) out.httpUrl = url;

  if (out.httpUrl) out.httpUrl = substituteEnv(out.httpUrl, "events.httpUrl", env);
  if (out.httpHeaders) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(out.httpHeaders)) {
      headers[name] = substituteEnv(String(value), `events.httpHeaders["${name}"]`, env);
    }
    out.httpHeaders = headers;
  }
  return out;
}
