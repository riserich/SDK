// The nine user-facing Rise Pro instruction builders — ported verbatim from
// the backend (account orders proven by devnet simulation). Each returns
// { ix, ixs, pdas }: use `ixs` (it carries the WSOL wrap/unwrap legs when the
// collateral is native SOL).
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { DISC } from "../constants";
import {
  vaultPda, collateralVaultPda, creatorClaimPda, positionPda,
  reflectionVaultPda, teamVaultPda,
} from "../pda";
import {
  RW, RO, eventCpi, ixOf, cashAta, tokenAta, u64le, u128le,
  wrapNativeIxs, unwrapNativeIxs,
} from "./core";

export function buildBuy(
  buyer: PublicKey,
  market: PublicKey,
  mintToken: PublicKey,
  mintMain: PublicKey,
  cashIn: BN | number | string,
  minTokenOut: BN | number | string,
  tokenProgramMain = TOKEN_PROGRAM_ID,
) {
  const buyerCash = cashAta(mintMain, buyer, tokenProgramMain);
  const buyerToken = tokenAta(mintToken, buyer);
  const ix = ixOf(
    [
      RW(buyer, true),
      RW(market),
      RW(vaultPda(market)),
      RW(creatorClaimPda(market)),
      RW(teamVaultPda(mintMain)),
      RW(reflectionVaultPda(market)),
      RW(mintToken),
      RO(mintMain),
      RW(buyerCash),
      RW(buyerToken),
      RO(tokenProgramMain),
      RO(TOKEN_2022_PROGRAM_ID),
      RO(ASSOCIATED_TOKEN_PROGRAM_ID),
      RO(SystemProgram.programId),
      ...eventCpi(),
    ],
    Buffer.concat([DISC.buy, u64le(cashIn), u64le(minTokenOut)]),
  );
  return {
    ix,
    ixs: [...wrapNativeIxs(buyer, mintMain, cashIn, tokenProgramMain), ix],
    pdas: { buyerCash: buyerCash.toBase58(), buyerToken: buyerToken.toBase58() },
  };
}

export function buildSell(
  seller: PublicKey,
  market: PublicKey,
  mintToken: PublicKey,
  mintMain: PublicKey,
  tokenIn: BN | number | string,
  minCashOut: BN | number | string,
  tokenProgramMain = TOKEN_PROGRAM_ID,
) {
  const sellerCash = cashAta(mintMain, seller, tokenProgramMain);
  const sellerToken = tokenAta(mintToken, seller);
  const ix = ixOf(
    [
      RW(seller, true),
      RW(market),
      RW(vaultPda(market)),
      RW(creatorClaimPda(market)),
      RW(teamVaultPda(mintMain)),
      RW(reflectionVaultPda(market)),
      RW(mintToken),
      RO(mintMain),
      RW(sellerCash),
      RW(sellerToken),
      RO(tokenProgramMain),
      RO(TOKEN_2022_PROGRAM_ID),
      RO(ASSOCIATED_TOKEN_PROGRAM_ID),
      RO(SystemProgram.programId),
      ...eventCpi(),
    ],
    Buffer.concat([DISC.sell, u64le(tokenIn), u64le(minCashOut)]),
  );
  return {
    ix,
    ixs: [ix, ...unwrapNativeIxs(seller, mintMain, tokenProgramMain)],
    pdas: { sellerCash: sellerCash.toBase58(), sellerToken: sellerToken.toBase58() },
  };
}

export function buildDeposit(
  owner: PublicKey,
  market: PublicKey,
  mintToken: PublicKey,
  amount: BN | number | string,
) {
  const position = positionPda(market, owner);
  const ownerToken = tokenAta(mintToken, owner);
  const ix = ixOf(
    [
      RW(owner, true),
      RW(market),
      RW(position),
      RW(collateralVaultPda(market)),
      RO(mintToken),
      RW(ownerToken),
      RO(TOKEN_2022_PROGRAM_ID),
      RO(SystemProgram.programId),
      ...eventCpi(),
    ],
    Buffer.concat([DISC.deposit, u64le(amount)]),
  );
  return { ix, pdas: { position: position.toBase58() } };
}

export function buildWithdraw(
  owner: PublicKey,
  market: PublicKey,
  mintToken: PublicKey,
  amount: BN | number | string,
) {
  const position = positionPda(market, owner);
  const ownerToken = tokenAta(mintToken, owner);
  const ix = ixOf(
    [
      RW(owner, true),
      RW(market),
      RW(position),
      RW(collateralVaultPda(market)),
      RO(mintToken),
      RW(ownerToken),
      RO(TOKEN_2022_PROGRAM_ID),
      ...eventCpi(),
    ],
    Buffer.concat([DISC.withdraw, u64le(amount)]),
  );
  return { ix, pdas: { position: position.toBase58() } };
}

export function buildBorrow(
  owner: PublicKey,
  market: PublicKey,
  mintMain: PublicKey,
  amount: BN | number | string,
  tokenProgramMain = TOKEN_PROGRAM_ID,
) {
  const position = positionPda(market, owner);
  const ownerCash = cashAta(mintMain, owner, tokenProgramMain);
  const ix = ixOf(
    [
      RW(owner, true),
      RW(market),
      RW(position),
      RW(vaultPda(market)),
      RW(creatorClaimPda(market)),
      RW(teamVaultPda(mintMain)),
      RO(mintMain),
      RW(ownerCash),
      RO(tokenProgramMain),
      RO(ASSOCIATED_TOKEN_PROGRAM_ID),
      RO(SystemProgram.programId),
      ...eventCpi(),
    ],
    Buffer.concat([DISC.borrow, u64le(amount)]),
  );
  return {
    ix,
    ixs: [ix, ...unwrapNativeIxs(owner, mintMain, tokenProgramMain)],
    pdas: { position: position.toBase58(), ownerCash: ownerCash.toBase58() },
  };
}

export function buildRepay(
  owner: PublicKey,
  market: PublicKey,
  mintMain: PublicKey,
  amount: BN | number | string,
  tokenProgramMain = TOKEN_PROGRAM_ID,
) {
  const position = positionPda(market, owner);
  const ownerCash = cashAta(mintMain, owner, tokenProgramMain);
  const ix = ixOf(
    [
      RW(owner, true),
      RW(market),
      RW(position),
      RW(vaultPda(market)),
      RO(mintMain),
      RW(ownerCash),
      RO(tokenProgramMain),
      ...eventCpi(),
    ],
    Buffer.concat([DISC.repay, u64le(amount)]),
  );
  return {
    ix,
    ixs: [
      ...wrapNativeIxs(owner, mintMain, amount, tokenProgramMain),
      ix,
      ...unwrapNativeIxs(owner, mintMain, tokenProgramMain),
    ],
    pdas: { position: position.toBase58() },
  };
}

export function buildLeverageBuy(
  buyer: PublicKey,
  market: PublicKey,
  mintToken: PublicKey,
  mintMain: PublicKey,
  cashIn: BN | number | string,
  borrowAmount: BN | number | string,
  minTokenOut: BN | number | string,
  tokenProgramMain = TOKEN_PROGRAM_ID,
) {
  const position = positionPda(market, buyer);
  const buyerCash = cashAta(mintMain, buyer, tokenProgramMain);
  const ix = ixOf(
    [
      RW(buyer, true),
      RW(market),
      RW(position),
      RW(vaultPda(market)),
      RW(collateralVaultPda(market)),
      RW(creatorClaimPda(market)),
      RW(teamVaultPda(mintMain)),
      RW(reflectionVaultPda(market)),
      RW(mintToken),
      RO(mintMain),
      RW(buyerCash),
      RO(tokenProgramMain),
      RO(TOKEN_2022_PROGRAM_ID),
      RO(SystemProgram.programId),
      ...eventCpi(),
    ],
    Buffer.concat([DISC.leverage_buy, u64le(cashIn), u64le(borrowAmount), u64le(minTokenOut)]),
  );
  return {
    ix,
    ixs: [...wrapNativeIxs(buyer, mintMain, cashIn, tokenProgramMain), ix],
    pdas: { position: position.toBase58() },
  };
}

export function buildLeverageSell(
  owner: PublicKey,
  market: PublicKey,
  mintToken: PublicKey,
  mintMain: PublicKey,
  collateralIn: BN | number | string,
  decreaseDebtBy: BN | number | string,
  minCashOut: BN | number | string,
  tokenProgramMain = TOKEN_PROGRAM_ID,
) {
  const position = positionPda(market, owner);
  const ownerCash = cashAta(mintMain, owner, tokenProgramMain);
  const ix = ixOf(
    [
      RW(owner, true),
      RW(market),
      RW(position),
      RW(vaultPda(market)),
      RW(collateralVaultPda(market)),
      RW(creatorClaimPda(market)),
      RW(teamVaultPda(mintMain)),
      RW(reflectionVaultPda(market)),
      RW(mintToken),
      RO(mintMain),
      RW(ownerCash),
      RO(tokenProgramMain),
      RO(TOKEN_2022_PROGRAM_ID),
      RO(ASSOCIATED_TOKEN_PROGRAM_ID),
      RO(SystemProgram.programId),
      ...eventCpi(),
    ],
    Buffer.concat([
      DISC.leverage_sell,
      u64le(collateralIn),
      u64le(decreaseDebtBy),
      u64le(minCashOut),
    ]),
  );
  return {
    ix,
    ixs: [ix, ...unwrapNativeIxs(owner, mintMain, tokenProgramMain)],
    pdas: { position: position.toBase58() },
  };
}

export function buildClaimCreatorFees(
  creator: PublicKey,
  market: PublicKey,
  mintMain: PublicKey,
  tokenProgramMain = TOKEN_PROGRAM_ID,
) {
  const destination = cashAta(mintMain, creator, tokenProgramMain);
  const ix = ixOf(
    [
      RW(creator, true),
      RO(market),
      RW(creatorClaimPda(market)),
      RO(mintMain),
      RW(destination),
      RO(tokenProgramMain),
      RO(ASSOCIATED_TOKEN_PROGRAM_ID),
      RO(SystemProgram.programId),
      ...eventCpi(),
    ],
    Buffer.from(DISC.claim_creator_fees),
  );
  return {
    ix,
    ixs: [ix, ...unwrapNativeIxs(creator, mintMain, tokenProgramMain)],
    pdas: { creatorClaim: creatorClaimPda(market).toBase58(), destination: destination.toBase58() },
  };
}
