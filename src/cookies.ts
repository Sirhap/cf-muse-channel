/** A small host-scoped cookie jar; credential values never appear in diagnostics. */
export type CookieJar = Record<string, { value: string; expiresAt: number | null }>;
const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function initialCookies(header: string): CookieJar {
  const jar: CookieJar = Object.create(null);
  for (const pair of header.split(";")) {
    const equals = pair.indexOf("=");
    if (equals < 1) continue;
    const name = pair.slice(0, equals).trim();
    if (!NAME.test(name)) continue;
    jar[name] = { value: pair.slice(equals + 1).trim(), expiresAt: null };
  }
  return jar;
}

export function cookieHeader(jar: CookieJar, now = Date.now()): string {
  return Object.entries(jar).filter(([, item]) => item.expiresAt === null || item.expiresAt > now)
    .map(([name, item]) => `${name}=${item.value}`).join("; ");
}

/** Apply each real Set-Cookie in order, including delete-then-set rotations. */
export function applySetCookies(current: CookieJar, headers: string[], now = Date.now()): CookieJar {
  const next: CookieJar = Object.assign(Object.create(null), current);
  for (const raw of headers) {
    const [pair, ...attributes] = raw.split(";").map((part) => part.trim());
    const equals = pair.indexOf("=");
    if (equals < 1) continue;
    const name = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    if (!NAME.test(name) || /[\x00-\x1f\x7f]/.test(value)) continue;
    let expiresAt: number | null = null;
    let maxAge: number | undefined;
    let allowed = true;
    for (const attribute of attributes) {
      const separator = attribute.indexOf("=");
      const key = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
      const argument = separator < 0 ? "" : attribute.slice(separator + 1).trim();
      if (key === "domain" && argument.replace(/^\./, "").toLowerCase() !== "muse.ai") allowed = false;
      // This client uses the jar for several Muse API paths. Do not broaden a scoped cookie.
      if (key === "path" && argument !== "/") allowed = false;
      if (key === "max-age" && /^-?\d+$/.test(argument)) {
        const age = Number(argument);
        // Infinity serializes as null, which would incorrectly make an expiring cookie permanent.
        if (Number.isSafeInteger(age) && Number.isSafeInteger(now + age * 1000)) maxAge = age;
      }
      if (key === "expires" && Number.isFinite(Date.parse(argument))) expiresAt = Date.parse(argument);
    }
    if (!allowed) continue;
    if (maxAge !== undefined) expiresAt = now + maxAge * 1000;
    if (expiresAt !== null && expiresAt <= now) delete next[name];
    else next[name] = { value, expiresAt };
  }
  return next;
}
