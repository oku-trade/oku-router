// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

library CanoeHelper {
    using ECDSA for bytes32;

    struct Warrant {
        uint160 nonce;
        uint48 validBefore;
        uint48 validAfter;
        address verifyingSigner;
        bytes signature;
    }

    string constant public EIP712_CANOE_WARRANT_TYPE = "CanoeWarrant(uint256 packedValidationData,bytes32 dataHash)";
    bytes32 constant public TYPEHASH_CANOE_WARRANT = keccak256(bytes(EIP712_CANOE_WARRANT_TYPE));

    function _packValidationData(
        uint160 nonce,
        uint48 validBefore,
        uint48 validAfter
    ) internal pure returns (uint256) {
        return
            uint256(nonce) |
            (uint256(validBefore) << 160) |
            (uint256(validAfter) << (160 + 48));
    }

    // --- Core Verification Logic ---
    function verifyWarrant(
        bytes32 domainSeparator, 
        bytes32 dataHash,
        Warrant memory warrant
    ) internal view {
        // If the verifyingSigner is 0, the warrant system is disabled.
        if (warrant.verifyingSigner == address(0)) {
            return;
        }

        // Time validity checks
        require(block.timestamp <= warrant.validBefore, "CANOE: EXPIRED");
        require(block.timestamp >= warrant.validAfter, "CANOE: NOT_YET");
        require(warrant.validAfter <= warrant.validBefore, "CANOE: INVALID_TIMESTAMPS");

        // 1. Pack the warrant-specific validation data
        uint256 packedValidationData = _packValidationData(
            warrant.nonce,
            warrant.validBefore,
            warrant.validAfter
        );

        // 2. Calculate the EIP-712 struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                TYPEHASH_CANOE_WARRANT,
                packedValidationData,
                dataHash
            )
        );

        // 3. Calculate the EIP-712 digest manually 
        // Structure: keccak256("\x19\x01" + domainSeparator + structHash)
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",        // EIP-712 prefix
            domainSeparator,   // Domain separator hash provided by caller
            structHash         // Struct hash calculated above
        ));

        // 4. Recover the signer
        address recoveredSigner = ECDSA.recover(
            digest,
            warrant.signature
        );

        // 5. Validate the signer
        require(
            recoveredSigner == warrant.verifyingSigner,
            "CANOE: INVALID_SIGNATURE"
        );
    }
}