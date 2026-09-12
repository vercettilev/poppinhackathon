import { describe, expect, it } from 'vitest';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { refreshBlockhash } from './blockhash';

/**
 * The mechanic, against a real VersionedTransaction rather than a fixture
 * of one. The bug this fixes cost every buy on the product, and it was
 * invisible to every existing test because none of them ever broadcast.
 */
const ORIGINAL = '11111111111111111111111111111111';
const FRESH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

function unsignedTx(blockhash: string): string {
  const payer = Keypair.generate().publicKey;
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: new PublicKey('So11111111111111111111111111111111111111112'),
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

const rpcReturning = (blockhash: string) =>
  (async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: { blockhash } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

describe('refreshBlockhash', () => {
  it('replaces the blockhash the router baked in', async () => {
    const before = unsignedTx(ORIGINAL);
    const after = await refreshBlockhash('https://rpc.test', before, {
      fetchFn: rpcReturning(FRESH),
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(after, 'base64'));
    expect(tx.message.recentBlockhash).toBe(FRESH);
    expect(after).not.toBe(before);
  });

  it('changes NOTHING else about the transaction', async () => {
    // The whole safety argument rests on this: the build path verified these
    // instructions, and a blockhash swap must not disturb them.
    const before = unsignedTx(ORIGINAL);
    const after = await refreshBlockhash('https://rpc.test', before, {
      fetchFn: rpcReturning(FRESH),
    });
    const a = VersionedTransaction.deserialize(Buffer.from(before, 'base64')).message;
    const b = VersionedTransaction.deserialize(Buffer.from(after, 'base64')).message;
    expect(b.compiledInstructions).toEqual(a.compiledInstructions);
    expect(b.staticAccountKeys.map(String)).toEqual(a.staticAccountKeys.map(String));
    expect(b.header).toEqual(a.header);
  });

  it('throws rather than returning a transaction the node will refuse', async () => {
    // Silently sending the stale one is exactly the failure being fixed.
    const rpcError = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'node down' } }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(
      refreshBlockhash('https://rpc.test', unsignedTx(ORIGINAL), { fetchFn: rpcError }),
    ).rejects.toThrow(/node down/);
  });
});

describe('the commitment is not a detail', () => {
  it('asks for a FINALIZED blockhash, because the endpoint is a pool', async () => {
    // The first version asked for 'confirmed' and production still refused
    // the transaction: a just-confirmed blockhash may not have reached the
    // node that runs preflight. Finalized is the one every caught-up node
    // already has.
    let sentBody: unknown = null;
    const spy = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: { blockhash: FRESH } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await refreshBlockhash('https://rpc.test', unsignedTx(ORIGINAL), { fetchFn: spy });
    expect((sentBody as { params: [{ commitment: string }] }).params[0].commitment).toBe(
      'finalized',
    );
  });
});
