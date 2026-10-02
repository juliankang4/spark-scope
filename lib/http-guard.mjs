// Request checks and response headers that keep other web pages away from the dashboard. Without a Host check,
// a page on another site could point its own domain at this machine (DNS rebinding) and read /api/state from the
// browser of anyone who can reach the dashboard.
import { isIP } from "node:net";
import { hostname as machineHostname } from "node:os";

// The names a browser may use: localhost, any IP address, this machine's hostname (also with .local and as the
// first label of a Tailscale MagicDNS name, <hostname>.<tailnet>.ts.net), the bind address, and the comma-separated
// SPARK_SCOPE_ALLOWED_HOSTS list. An entry starting with "." allows that domain's subdomains; "*" turns the check off.
export function hostRules({ bindHost = "127.0.0.1", allowed = "", machine = machineHostname() } = {}) {
  const extra = String(allowed ?? "").split(",").map((entry) => entry.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  const short = String(machine).split(".")[0].toLowerCase();
  return {
    any: extra.includes("*"),
    short,
    names: new Set(["localhost", short, `${short}.local`, String(machine).toLowerCase(), String(bindHost).toLowerCase(), ...extra.filter((entry) => !entry.startsWith("."))]),
    suffixes: extra.filter((entry) => entry.startsWith(".")),
  };
}

// The host name from a Host header ("example.local:8787", "[::1]:8787"), lower case, without a trailing dot; null
// when the header is not a plain host[:port].
export function hostName(header) {
  const value = String(header).trim().toLowerCase();
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) return bracketed[1];
  const plain = /^([a-z0-9_.-]+?)\.?(?::\d{1,5})?$/.exec(value);
  return plain ? plain[1] : null;
}

export function hostAllowed(header, rules) {
  // Browsers always send Host; a request without one (an old HTTP/1.0 tool) cannot come from a rebinding page.
  if (rules.any || header == null || header === "") return true;
  const name = hostName(header);
  if (name === null) return false;
  if (isIP(name) || name.endsWith(".localhost") || rules.names.has(name)) return true;
  if (name.endsWith(".ts.net") && name.split(".")[0] === rules.short) return true;
  return rules.suffixes.some((suffix) => name.endsWith(suffix));
}

// Sent with every response. The pages load only their own scripts, styles and fonts and fetch only this server;
// inline styles stay allowed because the pages set widths and colours in generated markup. No framing.
export const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
