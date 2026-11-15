export interface ApprovalRule { host: string; port: 443; methods: string[]; thread_ids?: string[] }
export function parsePolicy(value: string | undefined): ApprovalRule[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { rules?: unknown }).rules)) throw new Error('invalid_approval_policy');
  const rules = (parsed as { rules: unknown[] }).rules;
  if (rules.length > 30) throw new Error('approval_policy_limit');
  return rules.map((item) => {
    const rule = item as Record<string, unknown>;
    if (!rule || typeof rule.host !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(rule.host)
      || rule.host.includes('..') || rule.host.length > 253 || rule.port !== 443 || rule.scheme !== 'https'
      || !Array.isArray(rule.methods) || !rule.methods.length || rule.methods.some((m) => !['GET', 'HEAD', 'CONNECT', 'POST'].includes(m))
      || (rule.thread_ids !== undefined && (!Array.isArray(rule.thread_ids) || !rule.thread_ids.length || rule.thread_ids.some((id) => typeof id !== 'string' || !id)))) {
      throw new Error('invalid_approval_policy');
    }
    return { host: rule.host, port: 443, methods: rule.methods as string[], thread_ids: rule.thread_ids as string[] | undefined };
  });
}
export function unwrapRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const inner = record.approval ?? record.record;
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner as Record<string, unknown> : record;
}
export function approvalMatch(record: Record<string, unknown>, rules: ApprovalRule[], now = Date.now()): boolean {
  if (typeof record.approval_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(record.approval_id)
    || (record.status !== undefined && !['pending', 'awaiting_approval'].includes(String(record.status)))
    || typeof record.request_expires_at_ms !== 'number' || !Number.isFinite(record.request_expires_at_ms) || record.request_expires_at_ms <= now
    || typeof record.host !== 'string' || record.host !== record.host.trim() || /[/@%?#:]/.test(record.host)) return false;
  const host = record.host.toLowerCase().replace(/\.$/, '');
  const port = typeof record.port === 'string' && /^\d+$/.test(record.port) ? Number(record.port) : record.port;
  const scheme = typeof record.scheme === 'string' ? record.scheme.toLowerCase() : '';
  const method = typeof record.method === 'string' ? record.method.toUpperCase() : '';
  if (!(scheme === 'https' || scheme === 'wss' || scheme === 'tls'
    || (['tcp', 'connect'].includes(scheme) && method === 'CONNECT' && port === 443))) return false;
  const trace = record.runtime_request_trace as { thread_id?: unknown } | undefined;
  return rules.some((rule) => host === rule.host && port === rule.port && rule.methods.includes(method)
    && (!rule.thread_ids || (typeof trace?.thread_id === 'string' && rule.thread_ids.includes(trace.thread_id))));
}
export interface ApprovalRpc { call(path: string, service?: number, method?: string, body?: unknown): Promise<unknown> }
export interface DecisionAudit {
  claim(id: string, host: string, port: number): boolean;
  accepted(id: string): void;
}
/** Fresh detail, exact rule, durable unknown-before-send. There is deliberately no replay branch. */
export async function pollApprovals(rpc: ApprovalRpc, rules: ApprovalRule[], audit: DecisionAudit) {
  const response = unwrapRecord(await rpc.call('/approvals', 1));
  const rows = response.pending_approvals ?? response.pending ?? [];
  if (!Array.isArray(rows)) throw new Error('invalid_approval_response');
  const outcome = { pending: rows.length, approved: 0, held: 0, unknown: 0 };
  const deadline = Date.now() + 40000;
  for (const row of rows.slice(0, 10)) {
    if (Date.now() > deadline) break;
    const id = unwrapRecord(row).approval_id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) { outcome.held++; continue; }
    const detail = unwrapRecord(await rpc.call(`/approvals/${encodeURIComponent(id)}`, 1));
    if (detail.approval_id !== id || !approvalMatch(detail, rules)) { outcome.held++; continue; }
    if (!audit.claim(id, String(detail.host), Number(detail.port))) { outcome.held++; continue; }
    try {
      const result = await rpc.call(`/approvals/${encodeURIComponent(id)}/decide`, 1, 'POST', { decision: 'allow_once' });
      if (!result || typeof result !== 'object' || Array.isArray(result) || (result as { ok?: boolean }).ok === false) throw new Error('unconfirmed_approval');
      audit.accepted(id); outcome.approved++;
    } catch { outcome.unknown++; }
  }
  return outcome;
}
