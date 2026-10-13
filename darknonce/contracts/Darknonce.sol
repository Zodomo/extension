// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.26;

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

interface IDarknonceSafe {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function enableModule(address module) external;
    function setGuard(address guard) external;
    function execTransactionFromModule(address to, uint256 value, bytes memory data, uint8 operation) external returns (bool);
}

/// @dev Only ordinary CALLs are accepted. A failed call rolls back the application batch.
contract DarknonceBatch {
    struct Call { address to; uint256 value; bytes data; }

    function execute(Call[] calldata calls, address module) external payable {
        require(address(this) != module, "Invalid batch context");
        for (uint256 i; i < calls.length; ++i) {
            require(calls[i].to != address(this) && calls[i].to != module, "Reserved destination");
            (bool success, bytes memory result) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!success) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
    }
}

/// @dev Darknonce operations exclusively enter through the enabled module.
contract DarknonceGuard {
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0xe6d7a83a || interfaceId == 0x01ffc9a7;
    }

    function checkTransaction(address, uint256, bytes calldata, uint8, uint256, uint256, uint256, address, address payable, bytes calldata, address) external pure {
        revert("Use a Darknonce operation");
    }

    function checkAfterExecution(bytes32, bool) external pure {}
}

/// @dev Invoked by delegatecall during Safe.setup. Setup is atomic with deployment.
contract DarknonceSetup {
    function setup(address module, address guard, bytes32 root, uint32 treeSize, address signer, address messageSigner) external {
        IDarknonceSafe safe = IDarknonceSafe(address(this));
        safe.enableModule(module);
        safe.setGuard(guard);
        DarknonceModule(module).initialize(root, treeSize, signer, messageSigner);
    }
}

/// @notice Safe 1.5.0 module and fallback handler for the Darknonce MVP.
contract DarknonceModule {
    struct State {
        bytes32 root;
        uint32 treeSize;
        uint32 index;
        uint32 treeNumber;
        uint64 signerEpoch;
        uint64 messageEpoch;
        address signer;
        address messageSigner;
        bytes32 executionHash;
    }
    struct Operation {
        DarknonceBatch.Call[] calls;
        address nextSigner;
        bytes32[] proof;
        bytes32 newRoot;
        uint32 newTreeSize;
        address nextMessageSigner;
    }

    address public immutable entryPoint;
    address public immutable batch;
    mapping(address => State) public states;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant OP_TYPEHASH = keccak256("Operation(bytes32 userOpHash)");
    bytes32 private constant MESSAGE_TYPEHASH = keccak256("Message(bytes32 hash,uint64 epoch)");
    bytes32 private constant NAME_HASH = keccak256("Darknonce");
    bytes32 private constant VERSION_HASH = keccak256("1");

    event SignerRotated(address indexed safe, uint64 epoch, address signer, uint32 treeNumber, uint32 index);
    event TreeRenewed(address indexed safe, uint32 treeNumber, bytes32 root, uint32 treeSize);
    event MessageSignerRotated(address indexed safe, uint64 epoch, address signer);

    constructor(address entryPoint_, address batch_) {
        require(entryPoint_ != address(0) && batch_ != address(0), "Invalid infrastructure");
        entryPoint = entryPoint_;
        batch = batch_;
    }

    function initialize(bytes32 root, uint32 treeSize, address signer, address messageSigner) external {
        require(states[msg.sender].treeSize == 0, "Already initialized");
        require(root != bytes32(0) && treeSize >= 2 && signer != address(0) && messageSigner != address(0), "Invalid configuration");
        address[] memory owners = IDarknonceSafe(msg.sender).getOwners();
        require(owners.length == 1 && owners[0] == signer && IDarknonceSafe(msg.sender).getThreshold() == 1, "Invalid Safe owners");
        states[msg.sender] = State(root, treeSize, 0, 0, 0, 0, signer, messageSigner, bytes32(0));
    }

    function domainSeparator(address safe) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, safe));
    }

    function operationDigest(address safe, bytes32 userOpHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(safe), keccak256(abi.encode(OP_TYPEHASH, userOpHash))));
    }

    function messageDigest(address safe, bytes32 hash, uint64 epoch) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(safe), keccak256(abi.encode(MESSAGE_TYPEHASH, hash, epoch))));
    }

    function leaf(uint32 treeNumber, uint32 index, address signer) public pure returns (bytes32) {
        return keccak256(abi.encode(treeNumber, index, signer));
    }

    function _verify(bytes32 root, bytes32 value, bytes32[] memory proof) private pure returns (bool) {
        for (uint256 i; i < proof.length; ++i) {
            value = value < proof[i] ? keccak256(abi.encodePacked(value, proof[i])) : keccak256(abi.encodePacked(proof[i], value));
        }
        return value == root;
    }

    function _recover(bytes32 digest, bytes memory signature) private pure returns (address signer) {
        if (signature.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly ("memory-safe") { r := mload(add(signature, 32)) s := mload(add(signature, 64)) v := byte(0, mload(add(signature, 96))) }
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 || (v != 27 && v != 28)) return address(0);
        return ecrecover(digest, v, r, s);
    }

    function _caller() private pure returns (address originalCaller) {
        assembly ("memory-safe") { originalCaller := shr(96, calldataload(sub(calldatasize(), 20))) }
    }

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds) external returns (uint256) {
        require(_caller() == entryPoint && msg.sender == userOp.sender, "Invalid EntryPoint caller");
        require(bytes4(userOp.callData) == this.execute.selector, "Invalid execution method");
        State storage state = states[msg.sender];
        require(state.treeSize != 0, "Unknown Darknonce account");
        Operation memory operation = abi.decode(userOp.callData[4:], (Operation));
        bool renewing = operation.newRoot != bytes32(0);
        uint32 nextTree = renewing ? state.treeNumber + 1 : state.treeNumber;
        uint32 nextIndex = renewing ? 0 : state.index + 1;
        bytes32 root = renewing ? operation.newRoot : state.root;
        uint32 size = renewing ? operation.newTreeSize : state.treeSize;
        require(size >= 2 && nextIndex < size && operation.nextSigner != address(0), "Signer tree exhausted");
        require(operation.proof.length <= 32 && _verify(root, leaf(nextTree, nextIndex, operation.nextSigner), operation.proof), "Invalid next signer proof");
        // Simulate the same rotation for estimation signatures. EntryPoint rolls all
        // validation changes back if the signature failure flag is returned onchain.
        bool valid = _recover(operationDigest(msg.sender, userOpHash), userOp.signature) == state.signer;
        {
            address previousSigner = state.signer;
            state.signer = operation.nextSigner;
            state.index = nextIndex;
            state.signerEpoch++;
            state.executionHash = keccak256(userOp.callData);
            if (renewing) {
                state.root = root;
                state.treeSize = size;
                state.treeNumber = nextTree;
                emit TreeRenewed(msg.sender, nextTree, root, size);
            }
            if (operation.nextMessageSigner != address(0)) {
                state.messageSigner = operation.nextMessageSigner;
                state.messageEpoch++;
                emit MessageSignerRotated(msg.sender, state.messageEpoch, state.messageSigner);
            }
            require(IDarknonceSafe(msg.sender).execTransactionFromModule(msg.sender, 0, abi.encodeWithSignature("swapOwner(address,address,address)", address(1), previousSigner, operation.nextSigner), 0), "Owner rotation failed");
            emit SignerRotated(msg.sender, state.signerEpoch, operation.nextSigner, nextTree, nextIndex);
        }
        if (missingAccountFunds != 0) IDarknonceSafe(msg.sender).execTransactionFromModule(entryPoint, missingAccountFunds, "", 0);
        return valid ? 0 : 1;
    }

    function execute(Operation calldata operation) external {
        require(_caller() == entryPoint, "Invalid EntryPoint caller");
        State storage state = states[msg.sender];
        require(state.treeSize != 0 && state.executionHash == keccak256(abi.encodeWithSelector(this.execute.selector, operation)), "Operation not validated");
        delete state.executionHash;
        if (operation.calls.length != 0) {
            require(IDarknonceSafe(msg.sender).execTransactionFromModule(batch, 0, abi.encodeCall(DarknonceBatch.execute, (operation.calls, address(this))), 1), "Application call failed");
        }
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        State storage state = states[msg.sender];
        if (state.treeSize == 0 || signature.length < 128) return 0xffffffff;
        (uint64 epoch, bytes memory raw) = abi.decode(signature, (uint64, bytes));
        return epoch == state.messageEpoch && _recover(messageDigest(msg.sender, hash, epoch), raw) == state.messageSigner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { return 0x150b7a02; }
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return 0xf23a6e61; }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) { return 0xbc197c81; }
    function supportsInterface(bytes4 id) external pure returns (bool) { return id == 0x01ffc9a7 || id == 0x4e2312e0; }
}
