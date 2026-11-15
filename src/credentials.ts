import { DurableObject } from "cloudflare:workers";
import { CookieController, type CredentialState, type CredentialStore } from "./muse";

/** One coordinator owns this personal account's rotating Cookie and renewal requests. */
export class MuseCredentials extends DurableObject<Env> {
  private readonly controller: CookieController;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS credential_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    const store: CredentialStore = {
      load: () => {
        const row = ctx.storage.sql.exec<{ value: string }>("SELECT value FROM credential_state WHERE id=1").toArray()[0];
        return row ? JSON.parse(row.value) as CredentialState : undefined;
      },
      save: (state) => {
        ctx.storage.sql.exec("INSERT INTO credential_state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", JSON.stringify(state));
      },
    };
    this.controller = new CookieController(env, store);
  }

  fetch(request: Request): Promise<Response> {
    return this.controller.fetch(request);
  }

  /** Cron invokes only renewal; no chat or user task is submitted. */
  refresh() {
    return this.controller.refresh();
  }
}
