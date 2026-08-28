type Address = `0x${string}`;
type Hex = `0x${string}`;

export interface MessageParam {
  nonce: number;
  spender: Address;
  holder?: Address;
  allowed?: boolean;
  expiry?: number;
  value?: string;
  deadline?: number;
  owner?: Address;
}

export interface DomainParam {
  chainId: number;
  name: string;
  verifyingContract: Address;
  version?: string;
}

export enum Sources {
  Aggregator0x = "0x",
  Aggregotor1inch = "1inch",
}

export interface QuoteParams {
  source?: Sources;
  chainId?: number;
  fromAddress?: Address;
  inputAsset: Address;
  outputAsset: Address;
  inputAmount?: bigint;
  outputAmount?: bigint;
  destReceiver?: Address;
  feePercentageBasisPoints?: bigint;
  slippage?: number;
}

export interface ProtocolShare {
  name: string;
  part: number;
}

export interface Quote {
  source?: Sources;
  from: Address;
  to?: Address;
  data?: Hex;
  value?: bigint;
  allowanceTarget?: Address;
  sellAmount: bigint;
  sellAmountDisplay: bigint;
  sellAmountMinusFees: bigint;
  sellTokenAddress: Address;
  buyTokenAddress: Address;
  buyAmount: bigint;
  buyAmountDisplay: bigint;
  fee: bigint;
  feeInEth: bigint;
  feePercentageBasisPoints: number;
  protocols?: ProtocolShare[];
  inputTokenDecimals?: number;
  outputTokenDecimals?: number;
}

export interface TransactionOptions {
  gasLimit?: string | number;
  gasPrice?: string;
  nonce?: number;
  value?: number | bigint;
  from?: Address;
}

export interface QuoteExecutionDetails {
  method: any;
  methodArgs: (string | number | bigint)[];
  params: TransactionOptions;
}
