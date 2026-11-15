import { describe, expect, it } from "vitest";
import { applySetCookies, cookieHeader, initialCookies } from "../src/cookies";

describe("Cookie syntax, scope and expiration boundaries", () => {
  it("keeps values containing equals signs and ignores malformed names", () => {
    expect(cookieHeader(initialCookies(" a=base64== ; missing; bad name=x; =x; b=2 "), 0)).toBe("a=base64==; b=2");
  });

  it("uses the final duplicate value without modifying unrelated cookies", () => {
    expect(cookieHeader(initialCookies("a=1; b=keep; a=2"), 0)).toBe("a=2; b=keep");
  });

  it("treats prototype-looking names as plain data", () => {
    const jar = applySetCookies(initialCookies("__proto__=one; constructor=two"), ["__proto__=three; Path=/"], 0);
    expect(cookieHeader(jar, 1)).toBe("__proto__=three; constructor=two");
    expect(Object.getPrototypeOf(jar)).toBeNull();
  });

  it.each([
    ["a=new; Max-Age=0; Path=/", ""],
    ["a=new; Max-Age=-1; Path=/", ""],
    ["a=new; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/", ""],
    ["a=new; Max-Age=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/", "a=new"],
    ["a=new; Max-Age=0; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/", ""],
    ["a=; Path=/", "a="],
    ["a=new; Max-Age=invalid; Path=/", "a=new"],
    ["a=new; Secure; HttpOnly; SameSite=Lax; Path=/", "a=new"],
  ])("applies browser expiration semantics for %s", (header, expected) => {
    expect(cookieHeader(applySetCookies(initialCookies("a=old"), [header], 1000), 1001)).toBe(expected);
  });

  it("expires exactly at the boundary while retaining session cookies", () => {
    const jar = applySetCookies(initialCookies("session=keep"), ["a=new; Max-Age=2; Path=/"], 1000);
    expect(cookieHeader(jar, 2999)).toBe("session=keep; a=new");
    expect(cookieHeader(jar, 3000)).toBe("session=keep");
  });

  it.each(["Domain=other.test", "Domain=api.muse.ai", "Domain=muse.ai.evil.test", "Path=/private"])(
    "does not broaden a Cookie scoped by %s", (scope) => {
      expect(cookieHeader(applySetCookies(initialCookies("a=old"), [`a=bad; ${scope}`], 0), 1)).toBe("a=old");
    },
  );

  it("accepts case-insensitive domain attributes with surrounding whitespace", () => {
    const jar = applySetCookies(initialCookies("a=old"), ["a=new; DOMAIN= .Muse.AI ; Path= / "], 0);
    expect(cookieHeader(jar, 1)).toBe("a=new");
  });

  it("does not mutate the saved jar when preparing a rotation", () => {
    const previous = initialCookies("a=old");
    const next = applySetCookies(previous, ["a=new; Path=/"], 0);
    expect(cookieHeader(previous, 1)).toBe("a=old");
    expect(cookieHeader(next, 1)).toBe("a=new");
  });

  it("does not turn an overflowing Max-Age into a permanent cookie after JSON persistence", () => {
    const jar = applySetCookies(initialCookies("a=old"), [
      `a=new; Max-Age=${"9".repeat(400)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`,
    ], 1000);
    expect(cookieHeader(JSON.parse(JSON.stringify(jar)), 1001)).toBe("");
  });

  it.each(["bad\rvalue", "bad\nvalue", "bad\u0000value", "bad\u007fvalue"])(
    "rejects control characters in a rotated value", (value) => {
      expect(cookieHeader(applySetCookies(initialCookies("a=old"), [`a=${value}; Path=/`], 0), 1)).toBe("a=old");
    },
  );
});
