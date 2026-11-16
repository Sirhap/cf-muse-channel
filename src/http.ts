export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function validBearerKey(key: string): boolean {
  return /^[!-~]{32,512}$/.test(key);
}

export async function authorized(request: Request, key: string): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return matchesKey(header.slice(7), key);
}

export async function matchesKey(candidate: string, key: string): Promise<boolean> {
  if (key.length < 32 || key.length > 512 || !candidate || candidate.length > 512
      || /\s/.test(key) || /\s/.test(candidate)) return false;
  // Reuse the old channel's bounded, fixed-length hash comparison.
  const encoder = new TextEncoder();
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(key)),
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
  ]);
  return crypto.subtle.timingSafeEqual(expected, actual);
}
