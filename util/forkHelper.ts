import { network } from "hardhat";

interface ForkConfig {
    rpcUrl: string | undefined;
    blockNumber: number | undefined; // undefined = use latest block
    chainName: string;
}

/**
 * Attempts to fork a network at a specific block.
 * Returns true if successful, false if the RPC doesn't support archive data.
 *
 * Usage in tests:
 *   before(async function() {
 *       const success = await tryFork({ rpcUrl: process.env.OP_URL, blockNumber: 143608382, chainName: "Optimism" });
 *       if (!success) {
 *           console.log("    ⚠️  Skipping: Archive RPC required");
 *           this.skip();
 *       }
 *   });
 */
export async function tryFork(config: ForkConfig): Promise<boolean> {
    const { rpcUrl, blockNumber, chainName } = config;

    // Check if RPC URL is configured
    if (!rpcUrl || rpcUrl === "0000000000000000000000000000000000000000000000000000000000000000") {
        console.log(`    ⚠️  ${chainName}: No RPC URL configured (set env var)`);
        return false;
    }

    try {
        const forkingConfig: { jsonRpcUrl: string; blockNumber?: number } = {
            jsonRpcUrl: rpcUrl,
        };

        // Only set blockNumber if specified (otherwise use latest)
        if (blockNumber !== undefined) {
            forkingConfig.blockNumber = blockNumber;
        }

        await network.provider.request({
            method: "hardhat_reset",
            params: [
                {
                    forking: forkingConfig,
                },
            ],
        });

        // Verify the fork worked by checking we're at a valid block
        const blockHex = await network.provider.request({
            method: "eth_blockNumber",
            params: [],
        });
        const currentBlock = parseInt(blockHex as string, 16);

        // If specific block requested, verify it matches
        if (blockNumber !== undefined && currentBlock !== blockNumber) {
            console.log(`    ⚠️  ${chainName}: Fork block mismatch (expected ${blockNumber}, got ${currentBlock})`);
            return false;
        }

        // For latest block, just verify we got a valid block
        if (currentBlock <= 0) {
            console.log(`    ⚠️  ${chainName}: Invalid block number returned`);
            return false;
        }

        return true;
    } catch (error: any) {
        const message = error?.message || String(error);

        // Common error patterns for archive data unavailable
        if (message.includes("historical state") && message.includes("not available")) {
            console.log(`    ⚠️  ${chainName}: RPC doesn't support archive data at block ${blockNumber}`);
        } else if (message.includes("net_version does not exist")) {
            console.log(`    ⚠️  ${chainName}: RPC endpoint not responding correctly`);
        } else if (message.includes("missing trie node")) {
            console.log(`    ⚠️  ${chainName}: RPC missing historical state (archive node required)`);
        } else {
            console.log(`    ⚠️  ${chainName}: Fork failed - ${message.slice(0, 100)}`);
        }

        return false;
    }
}

/**
 * Standard fork configurations for common test scenarios
 */
export const FORK_CONFIGS = {
    OPTIMISM: {
        rpcUrl: process.env.OP_URL,
        blockNumber: 143608382,
        chainName: "Optimism",
    },
    OPTIMISM_EARLIER: {
        rpcUrl: process.env.OP_URL,
        blockNumber: 130000000,
        chainName: "Optimism",
    },
    // Latest block - doesn't require archive RPC
    OPTIMISM_LATEST: {
        rpcUrl: process.env.OP_URL,
        blockNumber: undefined as unknown as number, // Use latest block
        chainName: "Optimism (latest)",
    },
    ARBITRUM: {
        rpcUrl: process.env.ARB_URL,
        blockNumber: 300000000,
        chainName: "Arbitrum",
    },
} as const;
