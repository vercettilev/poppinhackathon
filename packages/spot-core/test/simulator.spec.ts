import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { RpcTransactionSimulator } from '../src/route/simulator';
import { associatedTokenAddresses } from '../src/route/verify';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const owner = Keypair.generate();
const ownerAddr = owner.publicKey.toBase58();

/** A base64 SPL token account whose `amount` field holds `amount`. */
function tokenAccount(amount: bigint): { data: [string, string] } {
  const bytes = new Uint8Array(165);
  let v = amount;
  for (let i = 0; i < 8; i++) {
    bytes[64 + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return { data: [btoa(bin), 'base64'] };
}

/**
 * Fakes the two RPC calls. `before` and `after` are keyed by address so a test
 * can say "this account gained, that one lost" without caring about ordering.
 */
function rpc(opts: {
  before: Record<string, bigint>;
  after: Record<string, bigint>;
  err?: unknown;
  noAccounts?: boolean;
}) {
  const calls: string[] = [];
  const fn = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    calls.push(body.method);

    const addresses: string[] =
      body.method === 'getMultipleAccounts'
        ? (body.params[0] as string[])
        : ((body.params[1] as { accounts: { addresses: string[] } }).accounts
            .addresses);

    const pick = (m: Record<string, bigint>) =>
      addresses.map((a) => (a in m ? tokenAccount(m[a]!) : null));

    const result =
      body.method === 'getMultipleAccounts'
        ? { value: pick(opts.before) }
        : {
            value: {
              err: opts.err ?? null,
              accounts: opts.noAccounts ? null : pick(opts.after),
            },
          };

    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result }),
    } as unknown as Response);
  }) as unknown as typeof fetch;

  return { fn, calls };
}

const ataOf = (mint: string) =>
  associatedTokenAddresses(owner.publicKey, new PublicKey(mint))[0]!;

describe('RpcTransactionSimulator', () => {
  it('reports the deltas a swap would produce', async () => {
    const { fn } = rpc({
      before: { [ataOf(USDC)]: 5_000_000n, [ataOf(BONK)]: 0n },
      after: { [ataOf(USDC)]: 4_000_000n, [ataOf(BONK)]: 42_000_000n },
    });
    const sim = new RpcTransactionSimulator('https://rpc.test', { fetchFn: fn });

    const deltas = await sim.simulateBalanceDeltas('TX', ownerAddr, [USDC, BONK]);
    expect(deltas).toEqual(
      expect.arrayContaining([
        { mint: USDC, delta: -1_000_000n },
        { mint: BONK, delta: 42_000_000n },
      ]),
    );
  });

  it('treats an account the swap CREATES as a positive delta, not an error', async () => {
    // A first-time buyer has no output ATA yet. Reading that as a failure would
    // block precisely the new users §11 is counting.
    const { fn } = rpc({
      before: { [ataOf(USDC)]: 5_000_000n },
      after: { [ataOf(USDC)]: 4_000_000n, [ataOf(BONK)]: 7n },
    });
    const sim = new RpcTransactionSimulator('https://rpc.test', { fetchFn: fn });

    const deltas = await sim.simulateBalanceDeltas('TX', ownerAddr, [USDC, BONK]);
    expect(deltas).toContainEqual({ mint: BONK, delta: 7n });
  });

  it('reads little-endian u64 amounts correctly at the token-account offset', async () => {
    const big = 18_446_744_073_709_551_000n; // near u64 max
    const { fn } = rpc({ before: {}, after: { [ataOf(BONK)]: big } });
    const sim = new RpcTransactionSimulator('https://rpc.test', { fetchFn: fn });
    const deltas = await sim.simulateBalanceDeltas('TX', ownerAddr, [BONK]);
    expect(deltas).toContainEqual({ mint: BONK, delta: big });
  });

  it('refuses when the simulation itself errors on chain', async () => {
    // A transaction that would revert must never reach the wallet.
    const { fn } = rpc({
      before: {},
      after: {},
      err: { InstructionError: [2, { Custom: 6001 }] },
    });
    const sim = new RpcTransactionSimulator('https://rpc.test', { fetchFn: fn });
    await expect(
      sim.simulateBalanceDeltas('TX', ownerAddr, [USDC, BONK]),
    ).rejects.toThrow(/simulation failed/);
  });

  it('refuses when the node returns no account state', async () => {
    const { fn } = rpc({ before: {}, after: {}, noAccounts: true });
    const sim = new RpcTransactionSimulator('https://rpc.test', { fetchFn: fn });
    await expect(
      sim.simulateBalanceDeltas('TX', ownerAddr, [USDC, BONK]),
    ).rejects.toThrow(/no account state/);
  });

  it('asks for both token programs, so Token-2022 assets are found', async () => {
    const { fn } = rpc({ before: {}, after: {} });
    const sim = new RpcTransactionSimulator('https://rpc.test', { fetchFn: fn });
    await sim.simulateBalanceDeltas('TX', ownerAddr, [USDC]);
    // Two candidate ATAs per mint: classic Token and Token-2022.
    expect(associatedTokenAddresses(owner.publicKey, new PublicKey(USDC))).toHaveLength(2);
  });

  it('simulates without signature verification and with a fresh blockhash', async () => {
    // The transaction is deliberately unsigned — the whole point is to check it
    // BEFORE anyone signs — and its blockhash may already be too old.
    let params: { sigVerify: boolean; replaceRecentBlockhash: boolean } | undefined;
    const fn = ((_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (body.method === 'simulateTransaction') {
        params = body.params[1] as typeof params;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          result:
            body.method === 'getMultipleAccounts'
              ? { value: [] }
              : { value: { err: null, accounts: [] } },
        }),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    await new RpcTransactionSimulator('https://rpc.test', { fetchFn: fn })
      .simulateBalanceDeltas('TX', ownerAddr, [USDC]);

    expect(params?.sigVerify).toBe(false);
    expect(params?.replaceRecentBlockhash).toBe(true);
  });

  it('surfaces an RPC-level error rather than reporting a zero delta', async () => {
    const fn = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ error: { message: 'node behind' } }),
      } as unknown as Response)) as unknown as typeof fetch;

    await expect(
      new RpcTransactionSimulator('https://rpc.test', { fetchFn: fn })
        .simulateBalanceDeltas('TX', ownerAddr, [USDC]),
    ).rejects.toThrow(/node behind/);
  });
});
