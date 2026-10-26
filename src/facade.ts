// Version-agnostic facade over the v1 (RiseSDK) and v2 (RiseProSDK) clients.
//
// Dispatch rule (user contract): pass `version` when you know it — the build
// is then direct (and, for v2, fully offline). When omitted, ONE
// getAccountInfo decides: a market account owned by the v1 program is v1,
// anything else resolves as v2.
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { RiseSDK } from "./index";
import { RISE_PROGRAM_ID } from "./constants";
import { RiseProSDK, MarketV2 } from "./v2";

export type RiseVersion = 1 | 2;

export interface RiseFacadeConfig {
  connection?: Connection;
  rpcUrl?: string;
  v2ProgramId?: PublicKey;
}

type Amount = bigint | number | string;

export class Rise {
  readonly connection: Connection;
  readonly v1: RiseSDK;
  readonly v2: RiseProSDK;

  constructor(cfg: RiseFacadeConfig) {
    if (cfg.connection) this.connection = cfg.connection;
    else if (cfg.rpcUrl) this.connection = new Connection(cfg.rpcUrl, "confirmed");
    else throw new Error("Rise: connection or rpcUrl required");
    this.v1 = new RiseSDK({ connection: this.connection });
    this.v2 = new RiseProSDK({
      connection: this.connection,
      programId: cfg.v2ProgramId,
    });
  }

  /** One getAccountInfo: v1 when the account is owned by the v1 Rise program
   *  (market address given), or when a mint's market PDA doesn't exist under
   *  the v2 program; v2 otherwise. */
  async detectVersion(marketOrMint: PublicKey): Promise<RiseVersion> {
    const info = await this.connection.getAccountInfo(marketOrMint);
    if (info?.owner.equals(RISE_PROGRAM_ID)) return 1;
    // Not a v1 market account. Either a v2 market or a mint — try the v2
    // market derivation; if it exists the market is v2.
    try {
      await this.v2.getMarket(marketOrMint);
      return 2;
    } catch {
      return 1;
    }
  }

  /** Fetch + decode a market of either version; the result carries `version`. */
  async getMarket(
    marketOrMint: PublicKey,
    version?: RiseVersion,
  ): Promise<MarketV2 | ({ version: 1 } & Awaited<ReturnType<RiseSDK["getMarket"]>>)> {
    const v = version ?? (await this.detectVersion(marketOrMint));
    if (v === 2) return this.v2.getMarket(marketOrMint);
    const m = await this.v1.getMarket(marketOrMint);
    return { ...m, version: 1 as const };
  }

  async buildBuyTransaction(p: {
    wallet: PublicKey;
    market: PublicKey;
    cashIn: Amount;
    minTokenOut?: Amount;
    version?: RiseVersion;
  }): Promise<VersionedTransaction> {
    const v = p.version ?? (await this.detectVersion(p.market));
    if (v === 2) {
      const m = await this.v2.getMarket(p.market);
      return this.v2.buildBuyTransaction(m, p.wallet, p.cashIn, p.minTokenOut ?? 0n);
    }
    return this.v1.buildBuyTransaction(
      p.market, p.wallet, toV1Amount(p.cashIn), toV1Amount(p.minTokenOut ?? 0),
    );
  }

  async buildSellTransaction(p: {
    wallet: PublicKey;
    market: PublicKey;
    tokenIn: Amount;
    minCashOut?: Amount;
    version?: RiseVersion;
  }): Promise<VersionedTransaction> {
    const v = p.version ?? (await this.detectVersion(p.market));
    if (v === 2) {
      const m = await this.v2.getMarket(p.market);
      return this.v2.buildSellTransaction(m, p.wallet, p.tokenIn, p.minCashOut ?? 0n);
    }
    return this.v1.buildSellTransaction(
      p.market, p.wallet, toV1Amount(p.tokenIn), toV1Amount(p.minCashOut ?? 0),
    );
  }
}

function toV1Amount(v: Amount): number | bigint {
  return typeof v === "string" ? BigInt(v) : v;
}
