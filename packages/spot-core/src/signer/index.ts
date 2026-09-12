/**
 * The custody seam. Two implementations, one interface, and the interface is
 * the point.
 *
 *   CustodialSigner   (apps/backend) decrypts the user's stored key and signs
 *                     server-side. What commentin does today.
 *   WalletSigner      (Phase 1.5) hands the transaction to Phantom and gets it
 *                     back signed. What poppin-v2 does.
 *
 * The engine never learns which it has. It builds an UNSIGNED transaction,
 * verifies it, hands it to a `Signer`, and gets it back signed — so moving from
 * custodial to self-custody is a different object behind this interface, not a
 * rewrite of the routing path.
 *
 * ORDERING MATTERS AND IS NOT INCIDENTAL. `route/verify` runs on the unsigned
 * transaction, BEFORE this interface is touched. Under self-custody that check
 * protects the user from a tampered Jupiter response they would otherwise sign
 * blind. Under custody it protects US: the server is about to sign with a key
 * it holds on someone's behalf, and it should know exactly what it is signing
 * before it does. Same check, same position, opposite beneficiary.
 *
 * The interface stays deliberately narrow. Anything wider — a "wallet" object,
 * a userId, a balance read — lets custodial assumptions leak into the engine
 * and makes the Phase 1.5 swap a rewrite instead of a substitution.
 *
 * NOTE this package never holds a key. `CustodialSigner` lives in the backend,
 * next to the crypto service, because a framework-free routing package has no
 * business being able to decrypt anything.
 */

/** A base64-encoded serialized transaction, exactly as Jupiter returns it. */
export type SerializedTransaction = string;

export interface Signer {
  /**
   * The public key the transaction is built for. The engine needs this at
   * BUILD time (Jupiter's /swap call takes `userPublicKey`), which is why it
   * is on the signer rather than passed alongside it — a transaction built for
   * one key and signed by another is a class of bug worth making unspellable.
   */
  publicKey(): Promise<string>;

  /**
   * Sign and return the signed transaction. Implementations must not
   * broadcast: broadcasting is the caller's step, so a signed-but-unsent
   * transaction stays an observable state (v1's dry run relied on exactly
   * that boundary).
   */
  signTransaction(tx: SerializedTransaction): Promise<SerializedTransaction>;
}

/**
 * A signer that refuses to sign. Used wherever the engine must be exercised
 * without a wallet attached — the port's equivalent of v1's dry run, but
 * enforced by the type rather than by an env flag that could be flipped.
 */
export class UnsignedOnlySigner implements Signer {
  constructor(private readonly pubkey: string) {}

  publicKey(): Promise<string> {
    return Promise.resolve(this.pubkey);
  }

  signTransaction(): Promise<SerializedTransaction> {
    return Promise.reject(
      new Error('UnsignedOnlySigner cannot sign — build-only path'),
    );
  }
}
