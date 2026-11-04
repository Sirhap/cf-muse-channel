import { authorize } from "./auth.js";
export { ChannelRoom } from "./room.js";

export default {
  /** Route authenticated WebSockets, fixed health checks and the same-origin UI. */
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true, service: "cf-muse-channel", version: "0.2.0" });
      if (url.pathname.startsWith("/ws/") || url.pathname.startsWith("/api/")) {
        const auth = await authorize(request, env);
        if (!auth) return new Response("Unauthorized", { status: 401 });
        return env.CHANNEL_ROOMS.getByName(auth.room).fetch(request);
      }
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss: ws:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      return response;
    } catch {
      return Response.json({ error: "service_unavailable" }, { status: 503 });
    }
  },
};
