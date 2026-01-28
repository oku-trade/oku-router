//SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.27;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./routers/BaseAggregator.sol";
import "./libraries/SafeTransferLib.sol";


/// @title Oku swap aggregator contract
contract OkuRouter is BaseAggregator, Ownable2Step {
    string public name;
    string public version;

    /// @dev Event emitted when a swap target gets added
    event SwapTargetAdded(address indexed target);

    /// @dev Event emitted when a swap target gets removed
    event SwapTargetRemoved(address indexed target);

    /// @dev Event emitted when token fees are withdrawn
    event TokenWithdrawn(
        address indexed token,
        address indexed target,
        uint256 amount
    );

    /// @dev Event emitted when ETH fees are withdrawn
    event EthWithdrawn(address indexed target, uint256 amount);

    /// @dev Event emitted when a valid signer gets added
    event ValidSignerAdded(address indexed target);

    /// @dev Event emitted when a valid signer gets removed
    event ValidSignerRemoved(address indexed target);

    /// @dev Event emitted when the contract is paused
    event ContractPaused(address indexed account);

    /// @dev Event emitted when the contract is unpaused
    event ContractUnpaused(address indexed account);

    constructor(string memory _name, string memory _version, address _owner) BaseAggregator(_name, _version) Ownable(_owner) {
        status = 1;
        name = _name;
        version = _version;
    }

    /// @dev We don't want to accept any ETH, except refunds from aggregators
    /// or the owner (for testing purposes), which can also withdraw
    /// This is done by evaluating the value of status, which is set to 2
    /// only during swaps due to the "nonReentrant" modifier
    receive() external payable {
        require(status == 2 || msg.sender == owner(), "NO_RECEIVE");
    }

    /// @dev method to add or remove swap targets from swapTargets
    /// This is required so we only approve "trusted" swap targets
    /// to transfer tokens out of this contract
    /// @param target address of the swap target to add
    /// @param add flag to add or remove the swap target
    function updateSwapTargets(address target, bool add) external onlyOwner {
        swapTargets[target] = add;
        if (add) {
            emit SwapTargetAdded(target);
        } else {
            emit SwapTargetRemoved(target);
        }
    }

    /// @dev method to add or remove valid signers from validSigners
    /// This is required so we only approve "trusted" signers
    /// to sign transactions for this contrract
    /// @param target address of the signer to add
    /// @param add flag to add or remove the swap target
    function updateValidSigner(address target, bool add) external onlyOwner {
        validSigners[target] = add;
        if (add) {
            emit ValidSignerAdded(target);
        } else {
            emit ValidSignerRemoved(target);
        }
    }

    /// @dev Pauses all swap operations on the contract
    /// Only the owner can call this function
    /// Emits a Paused event from the Pausable contract
    function pause() external onlyOwner {
        _pause();
        emit ContractPaused(msg.sender);
    }

    /// @dev Unpauses all swap operations on the contract
    /// Only the owner can call this function
    /// Emits an Unpaused event from the Pausable contract
    function unpause() external onlyOwner whenPaused{
        _unpause();
        emit ContractUnpaused(msg.sender);
    }

    /// @dev method to withdraw ERC20 tokens (from the fees)
    /// @param token address of the token to withdraw
    /// @param to address that's receiving the tokens
    /// @param amount amount of tokens to withdraw
    function withdrawToken(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        require(to != address(0), "ZERO_ADDRESS");
        SafeERC20.safeTransfer(IERC20(token), to, amount);
        emit TokenWithdrawn(token, to, amount);
    }

    /// @dev method to withdraw ETH (from the fees)
    /// @param to address that's receiving the ETH
    /// @param amount amount of ETH to withdraw
    function withdrawEth(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "ZERO_ADDRESS");
        SafeTransferLib.safeTransferETH(to, amount);
        emit EthWithdrawn(to, amount);
    }
}
