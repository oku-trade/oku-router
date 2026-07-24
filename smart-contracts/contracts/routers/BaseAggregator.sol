//SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../libraries/PermitHelper.sol";
import "../libraries/SafeTransferLib.sol";
import "../libraries/CanoeHelper.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Rainbow base aggregator contract
contract BaseAggregator is EIP712, Pausable {
    /// @dev Permit2 contract address for this chain (set once at deploy time)
    address public immutable permit2;

    /// @dev Used to prevent re-entrancy
    uint256 internal status;

    /// @dev Set of allowed swapTargets.
    mapping(address => bool) public swapTargets;

    // @dev set of valid signers
    mapping(address => bool) public validSigners;

    /// @dev Tracks used warrant nonces per verifying signer to prevent replays
    mapping(address => mapping(uint160 => bool)) public usedWarrantNonces;

    /// @dev Maximum allowed duration (in seconds) between validAfter and validBefore
    /// in a warrant. 0 = no limit (disabled). Set via setMaxWarrantDuration().
    uint256 public maxWarrantDuration;

    /// @dev Emitted when an order is filled
    event OrderFilled(
        address indexed sender,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount,
        address target
    );

    /// @dev Emitted when maxWarrantDuration is updated
    event MaxWarrantDurationUpdated(uint256 oldDuration, uint256 newDuration);

    /// @dev Internal helper to emit OrderFilled event (reduces stack depth in callers)
    function _emitOrderFilled(
        address recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount,
        address target
    ) internal {
        emit OrderFilled(
            msg.sender,
            recipient,
            tokenIn,
            tokenOut,
            amountIn,
            amountOut,
            feeAmount,
            target
        );
    }

    /// @dev Validates the recipient address. Reverts on nonsensical values.
    /// address(0) is allowed (burn). msg.sender is allowed (self-send).
    /// address(this), target, and approvalTarget are rejected.
    /// @param recipient The requested recipient address
    /// @param target The swap target (DEX aggregator)
    /// @param approvalTarget The approval target (may differ from target)
    function _validateRecipient(
        address recipient,
        address target,
        address approvalTarget
    ) internal view {
        require(recipient != address(this), "RECIPIENT_IS_THIS");
        require(recipient != target, "RECIPIENT_IS_TARGET");
        require(
            approvalTarget == address(0) || recipient != approvalTarget,
            "RECIPIENT_IS_APPROVAL_TARGET"
        );
    }

    /// @dev Consumes a warrant nonce to prevent replay attacks
    /// @param warrant The warrant containing the nonce to consume
    /// @notice Skips nonce tracking when verifyingSigner is address(0) (warrant bypass mode)
    function _consumeWarrantNonce(
        CanoeHelper.Warrant calldata warrant
    ) internal {
        // Optimization: Skip storage operations entirely when warrant is bypassed
        if (warrant.verifyingSigner == address(0)) {
            return;
        }

        // Check if nonce has already been used
        require(
            !usedWarrantNonces[warrant.verifyingSigner][warrant.nonce],
            "WARRANT_NONCE_USED"
        );

        // Mark nonce as consumed
        usedWarrantNonces[warrant.verifyingSigner][warrant.nonce] = true;
    }

    /// @dev Validates the warrant duration if maxWarrantDuration is set.
    /// Only enforced when warrant is not bypassed (verifyingSigner != address(0)).
    /// @param warrant The warrant to check
    function _validateWarrantDuration(
        CanoeHelper.Warrant calldata warrant
    ) internal view {
        if (maxWarrantDuration == 0) return; // disabled
        if (warrant.verifyingSigner == address(0)) return; // bypass mode
        require(
            uint256(warrant.validBefore) - uint256(warrant.validAfter) <= maxWarrantDuration,
            "WARRANT_DURATION_EXCEEDED"
        );
    }

    /// @dev modifier that prevents reentrancy attacks on specific methods
    modifier nonReentrant() {
        // On the first call to nonReentrant, status will be 1
        require(status != 2, "NON_REENTRANT");

        // Any calls to nonReentrant after this point will fail
        status = 2;

        _;

        // By storing the original value once again, a refund is triggered (see
        // https://eips.ethereum.org/EIPS/eip-2200)
        status = 1;
    }

    /// @dev modifier that ensures only approved targets can be called
    modifier onlyApprovedTarget(address target) {
        require(swapTargets[target], "TARGET_NOT_AUTH");
        _;
    }

    /// @dev modifier that ensures only approved signers can be used
    modifier onlyApprovedSigner(address signer) {
        require(validSigners[signer], "INVALID_SIGNER");
        _;
    }

    constructor(
        string memory _name,
        string memory _version,
        address _permit2
    ) EIP712(_name, _version) {
        permit2 = _permit2;
    }

    /** EXTERNAL **/

    /// @param buyTokenAddress the address of token that the user should receive
    /// @param target the address of the aggregator contract that will exec the swap
    /// @param swapCallData the calldata that will be passed to the aggregator contract
    /// @param feeAmount the amount of ETH that we will take as a fee
    /// @param recipient the address that should receive the output tokens (use msg.sender for self)
    ///
    function fillQuoteEthToToken(
        address buyTokenAddress,
        address payable target,
        bytes calldata swapCallData,
        uint256 feeAmount,
        address recipient,
        CanoeHelper.Warrant calldata warrant
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyApprovedTarget(target)
        onlyApprovedSigner(warrant.verifyingSigner)
    {
        require(msg.value > feeAmount, "INSUFFICIENT_ETH");

        // 0 - Validate recipient
        _validateRecipient(recipient, target, address(0));

        // 0.1 - Enforce warrant when sending to a different recipient
        require(
            recipient == msg.sender || warrant.verifyingSigner != address(0),
            "WARRANT_REQUIRED_FOR_RECIPIENT"
        );

        // 0.2 - Validate warrant duration
        _validateWarrantDuration(warrant);

        // 0.3 - verify the canoe warrant
        _consumeWarrantNonce(warrant);
        CanoeHelper.verifyWarrant(
            _domainSeparatorV4(),
            keccak256(
                abi.encode(
                    buyTokenAddress,
                    target,
                    keccak256(swapCallData),
                    feeAmount,
                    recipient
                )
            ),
            warrant
        );

        // 1 - Get the initial balances
        uint256 initialTokenBalance = IERC20(buyTokenAddress).balanceOf(
            address(this)
        );
        uint256 initialEthAmount = address(this).balance - msg.value;

        // 2 - Call the encoded swap function call on the contract at `target`,
        // passing along any ETH attached to this function call to cover protocol fees
        // minus our fees, which are kept in this contract
        (bool success, bytes memory res) = target.call{
            value: msg.value - feeAmount
        }(swapCallData);

        // Get the revert message of the call and revert with it if the call failed
        if (!success) {
            assembly ("memory-safe") {
                let returndata_size := mload(res)
                revert(add(32, res), returndata_size)
            }
        }

        // 3 - Make sure we received the tokens, send to recipient, and emit event
        {
            uint256 finalTokenBalance = IERC20(buyTokenAddress).balanceOf(
                address(this)
            );
            require(initialTokenBalance < finalTokenBalance, "NO_TOKENS");
            uint256 tokensReceived = finalTokenBalance - initialTokenBalance;

            // 4 - Send the received tokens to the recipient
            SafeERC20.safeTransfer(
                IERC20(buyTokenAddress),
                recipient,
                tokensReceived
            );

            // 5 - Emit OrderFilled event
            _emitOrderFilled(
                recipient,
                address(0),
                buyTokenAddress,
                msg.value,
                tokensReceived,
                feeAmount,
                target
            );
        }

        // 6 - Return the remaining ETH to the user (if any)
        {
            uint256 finalEthAmount = address(this).balance - feeAmount;
            if (finalEthAmount > initialEthAmount) {
                SafeTransferLib.safeTransferETH(
                    msg.sender,
                    finalEthAmount - initialEthAmount
                );
            }
        }
    }

    /// @param sellTokenAddress the address of token that the user is selling
    /// @param buyTokenAddress the address of token that the user should receive
    /// @param target the address of the aggregator contract that will exec the swap
    /// @param approvalTarget the address that needs token approval (may differ from target for transfer proxy patterns)
    /// @param swapCallData the calldata that will be passed to the aggregator contract
    /// @param sellAmount the amount of tokens that the user is selling
    /// @param feeAmount the amount of the tokens to sell that we will take as a fee
    /// @param recipient the address that should receive the output tokens (use msg.sender for self)
    function fillQuoteTokenToToken(
        address sellTokenAddress,
        address buyTokenAddress,
        address payable target,
        address approvalTarget,
        bytes calldata swapCallData,
        uint256 sellAmount,
        uint256 feeAmount,
        address recipient,
        CanoeHelper.Warrant calldata warrant
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyApprovedTarget(target)
        onlyApprovedTarget(approvalTarget)
        onlyApprovedSigner(warrant.verifyingSigner)
    {
        _fillQuoteTokenToToken(
            sellTokenAddress,
            buyTokenAddress,
            target,
            approvalTarget,
            swapCallData,
            sellAmount,
            feeAmount,
            recipient,
            warrant,
            false // Tokens not yet transferred, must pull from user
        );
    }

    /// @dev method that executes ERC20 to ERC20 token swaps with the ability to take a fee from the input
    // and accepts a signature to use permit, so the user doesn't have to make an previous approval transaction
    /// @param sellTokenAddress the address of token that the user is selling
    /// @param buyTokenAddress the address of token that the user should receive
    /// @param target the address of the aggregator contract that will exec the swap
    /// @param approvalTarget the address that needs token approval (may differ from target for transfer proxy patterns)
    /// @param swapCallData the calldata that will be passed to the aggregator contract
    /// @param sellAmount the amount of tokens that the user is selling
    /// @param feeAmount the amount of the tokens to sell that we will take as a fee
    /// @param recipient the address that should receive the output tokens (use msg.sender for self)
    /// @param permitData struct containing the value, nonce, deadline, v, r and s values of the permit data
    function fillQuoteTokenToTokenWithPermit(
        address sellTokenAddress,
        address buyTokenAddress,
        address payable target,
        address approvalTarget,
        bytes calldata swapCallData,
        uint256 sellAmount,
        uint256 feeAmount,
        address recipient,
        PermitHelper.Permit calldata permitData,
        CanoeHelper.Warrant calldata warrant
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyApprovedTarget(target)
        onlyApprovedTarget(approvalTarget)
        onlyApprovedSigner(warrant.verifyingSigner)
    {
        // 0 - Verify permit amount matches sell amount
        require(permitData.value == sellAmount, "PERMIT_AMOUNT_MISMATCH");

        // 1 - Apply permit
        PermitHelper.permit(
            permitData,
            sellTokenAddress,
            msg.sender,
            address(this),
            permit2
        );

        // 2 - Call fillQuoteTokenToToken
        bool skipTransferFrom = (permitData.permitStyle ==
            PermitHelper.PermitStyle.PERMIT_2);
        _fillQuoteTokenToToken(
            sellTokenAddress,
            buyTokenAddress,
            target,
            approvalTarget,
            swapCallData,
            sellAmount,
            feeAmount,
            recipient,
            warrant,
            skipTransferFrom
        );
    }

    /// @dev method that executes ERC20 to ETH token swaps with the ability to take a fee from the output
    /// @param sellTokenAddress the address of token that the user is selling
    /// @param target the address of the aggregator contract that will exec the swap
    /// @param approvalTarget the address that needs token approval (may differ from target for transfer proxy patterns)
    /// @param swapCallData the calldata that will be passed to the aggregator contract
    /// @param sellAmount the amount of tokens that the user is selling
    /// @param feePercentageBasisPoints the amount of ETH that we will take as a fee in 1e18 basis points
    /// @param recipient the address that should receive the output ETH (use msg.sender for self)
    function fillQuoteTokenToEth(
        address sellTokenAddress,
        address payable target,
        address approvalTarget,
        bytes calldata swapCallData,
        uint256 sellAmount,
        uint256 feePercentageBasisPoints,
        address recipient,
        CanoeHelper.Warrant calldata warrant
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyApprovedTarget(target)
        onlyApprovedTarget(approvalTarget)
        onlyApprovedSigner(warrant.verifyingSigner)
    {
        _fillQuoteTokenToEth(
            sellTokenAddress,
            target,
            approvalTarget,
            swapCallData,
            sellAmount,
            feePercentageBasisPoints,
            recipient,
            warrant,
            false // Tokens not yet transferred, must pull from user
        );
    }

    /// @dev method that executes ERC20 to ETH token swaps with the ability to take a fee from the output
    // and accepts a signature to use permit, so the user doesn't have to make an previous approval transaction
    /// @param sellTokenAddress the address of token that the user is selling
    /// @param target the address of the aggregator contract that will exec the swap
    /// @param approvalTarget the address that needs token approval (may differ from target for transfer proxy patterns)
    /// @param swapCallData the calldata that will be passed to the aggregator contract
    /// @param sellAmount the amount of tokens that the user is selling
    /// @param feePercentageBasisPoints the amount of ETH that we will take as a fee in 1e18 basis points
    /// @param recipient the address that should receive the output ETH (use msg.sender for self)
    /// @param permitData struct containing the amount, nonce, deadline, v, r and s values of the permit data
    function fillQuoteTokenToEthWithPermit(
        address sellTokenAddress,
        address payable target,
        address approvalTarget,
        bytes calldata swapCallData,
        uint256 sellAmount,
        uint256 feePercentageBasisPoints,
        address recipient,
        PermitHelper.Permit calldata permitData,
        CanoeHelper.Warrant calldata warrant
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyApprovedTarget(target)
        onlyApprovedTarget(approvalTarget)
        onlyApprovedSigner(warrant.verifyingSigner)
    {
        // 0 - Verify permit amount matches sell amount
        require(permitData.value == sellAmount, "PERMIT_AMOUNT_MISMATCH");

        // 1 - Apply permit
        PermitHelper.permit(
            permitData,
            sellTokenAddress,
            msg.sender,
            address(this),
            permit2
        );

        // 2 - Call fillQuoteTokenToEth
        bool skipTransferFrom = (permitData.permitStyle ==
            PermitHelper.PermitStyle.PERMIT_2);
        _fillQuoteTokenToEth(
            sellTokenAddress,
            target,
            approvalTarget,
            swapCallData,
            sellAmount,
            feePercentageBasisPoints,
            recipient,
            warrant,
            skipTransferFrom
        );
    }

    /** INTERNAL **/

    /// @dev internal method that executes ERC20 to ETH token swaps with the ability to take a fee from the output
    /// @param recipient the address that should receive the output ETH
    /// @param skipTransferFrom if true, assumes tokens are already in contract
    function _fillQuoteTokenToEth(
        address sellTokenAddress,
        address payable target,
        address approvalTarget,
        bytes calldata swapCallData,
        uint256 sellAmount,
        uint256 feePercentageBasisPoints,
        address recipient,
        CanoeHelper.Warrant calldata warrant,
        bool skipTransferFrom
    ) internal {
        // 0 - Validate recipient
        _validateRecipient(recipient, target, approvalTarget);

        // 0.1 - Enforce warrant when sending to a different recipient
        require(
            recipient == msg.sender || warrant.verifyingSigner != address(0),
            "WARRANT_REQUIRED_FOR_RECIPIENT"
        );

        // 0.2 - Validate warrant duration
        _validateWarrantDuration(warrant);

        // 0.3 - verify the canoe warrant
        _consumeWarrantNonce(warrant);
        CanoeHelper.verifyWarrant(
            _domainSeparatorV4(),
            keccak256(
                abi.encode(
                    sellTokenAddress,
                    target,
                    approvalTarget,
                    keccak256(swapCallData),
                    sellAmount,
                    feePercentageBasisPoints,
                    recipient
                )
            ),
            warrant
        );

        // 1 - Get the initial ETH amount
        uint256 initialEthAmount = address(this).balance - msg.value;

        // 2 - Move the tokens to this contract
        if (!skipTransferFrom) {
            SafeERC20.safeTransferFrom(
                IERC20(sellTokenAddress),
                msg.sender,
                address(this),
                sellAmount
            );
        }

        // 3 - Approve the aggregator's approval target to swap the tokens
        SafeERC20.safeIncreaseAllowance(
            IERC20(sellTokenAddress),
            approvalTarget,
            sellAmount
        );

        // 4 - Call the encoded swap function call on the contract at `target`
        (bool success, bytes memory res) = target.call{value: msg.value}(
            swapCallData
        );

        if (!success) {
            assembly ("memory-safe") {
                let returndata_size := mload(res)
                revert(add(32, res), returndata_size)
            }
        }

        // 5 - Check that the tokens were fully spent during the swap
        uint256 allowance = IERC20(sellTokenAddress).allowance(
            address(this),
            approvalTarget
        );
        require(allowance == 0, "ALLOWANCE_NOT_ZERO");

        // 6 - Subtract the fees and send the rest to the recipient
        uint256 finalEthAmount = address(this).balance;
        uint256 ethDiff = finalEthAmount - initialEthAmount;

        require(ethDiff > 0, "NO_ETH_BACK");

        uint256 fees = 0;
        uint256 amountToUser = ethDiff;

        if (feePercentageBasisPoints > 0) {
            fees = (ethDiff * feePercentageBasisPoints) / 1e18;
            amountToUser = ethDiff - fees;
            SafeTransferLib.safeTransferETH(recipient, amountToUser);
        } else if (ethDiff > 0) {
            SafeTransferLib.safeTransferETH(recipient, ethDiff);
        }

        // 7 - Emit OrderFilled event
        _emitOrderFilled(
            recipient,
            sellTokenAddress,
            address(0),
            sellAmount,
            amountToUser,
            fees,
            target
        );
    }

    /// @dev internal method that executes ERC20 to ERC20 token swaps with the ability to take a fee from the input
    /// @param recipient the address that should receive the output tokens
    /// @param skipTransferFrom if true, assumes tokens are already in contract
    function _fillQuoteTokenToToken(
        address sellTokenAddress,
        address buyTokenAddress,
        address payable target,
        address approvalTarget,
        bytes calldata swapCallData,
        uint256 sellAmount,
        uint256 feeAmount,
        address recipient,
        CanoeHelper.Warrant calldata warrant,
        bool skipTransferFrom
    ) internal {
        // 0 - Validate recipient
        _validateRecipient(recipient, target, approvalTarget);

        // 0.1 - Enforce warrant when sending to a different recipient
        require(
            recipient == msg.sender || warrant.verifyingSigner != address(0),
            "WARRANT_REQUIRED_FOR_RECIPIENT"
        );

        // 0.2 - Validate warrant duration
        _validateWarrantDuration(warrant);

        // 0.3 - verify the canoe warrant
        _consumeWarrantNonce(warrant);
        CanoeHelper.verifyWarrant(
            _domainSeparatorV4(),
            keccak256(
                abi.encode(
                    sellTokenAddress,
                    buyTokenAddress,
                    target,
                    approvalTarget,
                    keccak256(swapCallData),
                    sellAmount,
                    feeAmount,
                    recipient
                )
            ),
            warrant
        );

        // 1 - Get the initial output token balance
        uint256 initialOutputTokenAmount = IERC20(buyTokenAddress).balanceOf(
            address(this)
        );

        // 2 - Move the tokens to this contract (which includes our fees)
        if (!skipTransferFrom) {
            SafeERC20.safeTransferFrom(
                IERC20(sellTokenAddress),
                msg.sender,
                address(this),
                sellAmount
            );
        }

        // 3 - Approve the aggregator's approval target to swap the tokens if needed
        SafeERC20.safeIncreaseAllowance(
            IERC20(sellTokenAddress),
            approvalTarget,
            sellAmount - feeAmount
        );

        // 4 - Call the encoded swap function call on the contract at `target`
        (bool success, bytes memory res) = target.call{value: msg.value}(
            swapCallData
        );

        if (!success) {
            assembly ("memory-safe") {
                let returndata_size := mload(res)
                revert(add(32, res), returndata_size)
            }
        }

        // 5 - Check that the tokens were fully spent during the swap
        uint256 allowance = IERC20(sellTokenAddress).allowance(
            address(this),
            approvalTarget
        );
        require(allowance == 0, "ALLOWANCE_NOT_ZERO");

        // 6 - Make sure we received the tokens
        uint256 finalOutputTokenAmount = IERC20(buyTokenAddress).balanceOf(
            address(this)
        );

        require(initialOutputTokenAmount < finalOutputTokenAmount, "NO_TOKENS");

        uint256 tokensReceived = finalOutputTokenAmount -
            initialOutputTokenAmount;

        // 7 - Send tokens to the recipient
        SafeERC20.safeTransfer(
            IERC20(buyTokenAddress),
            recipient,
            tokensReceived
        );

        // 8 - Emit OrderFilled event
        _emitOrderFilled(
            recipient,
            sellTokenAddress,
            buyTokenAddress,
            sellAmount,
            tokensReceived,
            feeAmount,
            target
        );
    }
}
