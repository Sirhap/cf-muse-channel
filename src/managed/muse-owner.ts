import type { MuseRpc } from "../noise";

export const PRIMARY_ACCOUNT_ID = "primary-account";
export const MANAGED_MUSE_SOCKET = "/internal/managed/ws";
export const MUSE_ACCOUNT_HEADER = "X-Muse-Account";
export const MUSE_VM_HEADER = "X-Muse-Managed-Vm";

export interface MuseOwner {
  account: string;
  vm: string;
}

export type MuseTarget = MuseOwner | { account: string };
export type OwnedRpc = <T>(
  operation: (client: MuseRpc, owner: MuseOwner) => Promise<T>,
  target?: MuseTarget,
) => Promise<T>;

export class MuseOwnerUnavailable extends Error {}
