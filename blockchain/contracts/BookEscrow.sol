// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BookEscrow
 * @notice Trust-minimized escrow for "A Multiverse of Love" by Interstellar Psychology.
 *
 * Flow:
 *   1. Buyer approves this contract on the token, then calls createOrder(), passing their
 *      X25519 public key (from MetaMask eth_getEncryptionPublicKey) so the author can
 *      encrypt the shipping tracking number for them.
 *   2. Author calls fulfillOrder() with a shipping-proof hash and the tracking number
 *      encrypted with the buyer's public key → cost released immediately.
 *   3. Buyer calls eth_decrypt in their browser to reveal the tracking number.
 *   4. Buyer has DISPUTE_WINDOW days after fulfillment to call claimProfitRefund().
 *      If they do nothing, anyone can call releaseProfit() after the window.
 *   5. If the author never fulfills within FULFILLMENT_DEADLINE, buyer can emergencyRefund().
 *
 * Accepted payment tokens are fixed at deployment time (tokenA and tokenB, both immutable).
 * On BSC mainnet these must be set to the DOGE and PEPE BEP-20 addresses.
 */
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract BookEscrow {
    /* ─── Constants ─────────────────────────────────────────────────── */
    uint64 public constant DISPUTE_WINDOW       = 99 days;
    uint64 public constant FULFILLMENT_DEADLINE = 30 days;

    /* ─── Immutables ─────────────────────────────────────────────────── */
    address public immutable author;
    // Two whitelisted payment tokens, set once at deployment and never changeable.
    // On BSC mainnet: tokenA = DOGE, tokenB = PEPE.
    address public immutable tokenA;
    address public immutable tokenB;

    /* ─── State ──────────────────────────────────────────────────────── */
    enum Status { Paid, Fulfilled, Released, Refunded }

    struct Order {
        address buyer;
        address token;
        uint256 cost;           // released to author on fulfillOrder
        uint256 profit;         // refundable to buyer within window
        uint64  createdAt;
        uint64  fulfilledAt;    // 0 until fulfilled
        bytes32 shippingHash;   // SHA-256 of tracking number (verifiable off-chain)
        bytes32 buyerPubKey;    // buyer's X25519 public key (from MetaMask), raw 32 bytes
        Status  status;
    }

    mapping(bytes32 => Order) public orders;

    // Encrypted tracking numbers stored separately (dynamic bytes, cheaper than struct)
    mapping(bytes32 => bytes) public encryptedTrackings;

    /* ─── Events ─────────────────────────────────────────────────────── */
    event OrderCreated   (bytes32 indexed id, address indexed buyer, address token, uint256 cost, uint256 profit, bytes32 buyerPubKey);
    event OrderFulfilled (bytes32 indexed id, bytes32 shippingHash, uint64 fulfilledAt);
    event ProfitRefunded (bytes32 indexed id, address indexed buyer, uint256 amount);
    event ProfitReleased (bytes32 indexed id, address indexed author, uint256 amount);
    event EmergencyRefund(bytes32 indexed id, address indexed buyer, uint256 amount);

    /* ─── Errors ─────────────────────────────────────────────────────── */
    error OrderExists();
    error OrderNotFound();
    error NotBuyer();
    error NotAuthor();
    error WrongStatus(Status current, Status required);
    error WindowOpen();
    error WindowClosed();
    error DeadlineNotReached();
    error TransferFailed();
    error ZeroAmount();
    error TokenNotAllowed();

    constructor(address _author, address _tokenA, address _tokenB) {
        require(_author  != address(0), "Zero author");
        require(_tokenA  != address(0), "Zero tokenA");
        require(_tokenB  != address(0), "Zero tokenB");
        require(_tokenA  != _tokenB,    "Duplicate token");
        author = _author;
        tokenA = _tokenA;
        tokenB = _tokenB;
    }

    /* ─── Buyer: create order ─────────────────────────────────────────── */

    /**
     * @param id           Unique order ID (random bytes32).
     * @param token        Must be tokenA (DOGE) or tokenB (PEPE).
     * @param cost         Amount covering production + shipping (released on fulfillment).
     * @param profit       Amount locked for the dispute window.
     * @param buyerPubKey  Buyer's X25519 public key from MetaMask eth_getEncryptionPublicKey,
     *                     base64-decoded to raw 32 bytes. Zero is allowed (opt-out of encryption).
     */
    function createOrder(
        bytes32 id,
        address token,
        uint256 cost,
        uint256 profit,
        bytes32 buyerPubKey
    ) external {
        if (token != tokenA && token != tokenB) revert TokenNotAllowed();
        if (orders[id].buyer != address(0)) revert OrderExists();
        if (cost == 0 && profit == 0) revert ZeroAmount();

        uint256 total = cost + profit;

        // Write state before the external call (CEI pattern — prevents reentrancy)
        orders[id] = Order({
            buyer:        msg.sender,
            token:        token,
            cost:         cost,
            profit:       profit,
            createdAt:    uint64(block.timestamp),
            fulfilledAt:  0,
            shippingHash: bytes32(0),
            buyerPubKey:  buyerPubKey,
            status:       Status.Paid
        });

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        bool ok = IERC20(token).transferFrom(msg.sender, address(this), total);
        if (!ok) revert TransferFailed();
        // Guard against fee-on-transfer tokens — contract must receive the full declared amount
        if (IERC20(token).balanceOf(address(this)) - balanceBefore < total) revert TransferFailed();

        emit OrderCreated(id, msg.sender, token, cost, profit, buyerPubKey);
    }

    /* ─── Author: fulfill ─────────────────────────────────────────────── */

    /**
     * @param id                 Order ID.
     * @param shippingHash       SHA-256 of the tracking number (verifiable by buyer).
     * @param encryptedTracking  Tracking number encrypted with buyer's X25519 key,
     *                           encoded as JSON bytes (x25519-xsalsa20-poly1305 format).
     *                           May be empty if buyer opted out of encryption.
     */
    function fulfillOrder(
        bytes32 id,
        bytes32 shippingHash,
        bytes calldata encryptedTracking
    ) external {
        if (msg.sender != author) revert NotAuthor();
        Order storage o = orders[id];
        if (o.buyer == address(0)) revert OrderNotFound();
        if (o.status != Status.Paid) revert WrongStatus(o.status, Status.Paid);

        o.status       = Status.Fulfilled;
        o.fulfilledAt  = uint64(block.timestamp);
        o.shippingHash = shippingHash;

        if (encryptedTracking.length > 0) {
            encryptedTrackings[id] = encryptedTracking;
        }

        if (o.cost > 0) {
            bool ok = IERC20(o.token).transfer(author, o.cost);
            if (!ok) revert TransferFailed();
        }

        emit OrderFulfilled(id, shippingHash, o.fulfilledAt);
    }

    /* ─── Buyer: claim profit refund during window ─────────────────────── */

    function claimProfitRefund(bytes32 id) external {
        Order storage o = orders[id];
        if (o.buyer == address(0)) revert OrderNotFound();
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != Status.Fulfilled) revert WrongStatus(o.status, Status.Fulfilled);
        if (block.timestamp > o.fulfilledAt + DISPUTE_WINDOW) revert WindowClosed();

        o.status = Status.Refunded;
        uint256 amount = o.profit;
        if (amount > 0) {
            bool ok = IERC20(o.token).transfer(o.buyer, amount);
            if (!ok) revert TransferFailed();
        }

        emit ProfitRefunded(id, o.buyer, amount);
    }

    /* ─── Anyone: release profit after window ──────────────────────────── */

    function releaseProfit(bytes32 id) external {
        Order storage o = orders[id];
        if (o.buyer == address(0)) revert OrderNotFound();
        if (o.status != Status.Fulfilled) revert WrongStatus(o.status, Status.Fulfilled);
        if (block.timestamp <= o.fulfilledAt + DISPUTE_WINDOW) revert WindowOpen();

        o.status = Status.Released;
        uint256 amount = o.profit;
        if (amount > 0) {
            bool ok = IERC20(o.token).transfer(author, amount);
            if (!ok) revert TransferFailed();
        }

        emit ProfitReleased(id, author, amount);
    }

    /* ─── Buyer: emergency refund if author never fulfills ─────────────── */

    function emergencyRefund(bytes32 id) external {
        Order storage o = orders[id];
        if (o.buyer == address(0)) revert OrderNotFound();
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != Status.Paid) revert WrongStatus(o.status, Status.Paid);
        if (block.timestamp <= o.createdAt + FULFILLMENT_DEADLINE) revert DeadlineNotReached();

        o.status = Status.Refunded;
        uint256 total = o.cost + o.profit;
        if (total > 0) {
            bool ok = IERC20(o.token).transfer(o.buyer, total);
            if (!ok) revert TransferFailed();
        }

        emit EmergencyRefund(id, o.buyer, total);
    }

    /* ─── Author: update tracking after fulfillment ───────────────────── */

    /**
     * @notice Allows the author to store or replace the encrypted tracking bytes
     *         after fulfillOrder has already been called.  Useful when the buyer's
     *         pubkey was absent at fulfillment time and tracking needs to be added.
     * @param id       Order ID.
     * @param tracking Encrypted (or plaintext JSON) tracking bytes — same format as
     *                 the third argument to fulfillOrder.
     */
    function updateTracking(bytes32 id, bytes calldata tracking) external {
        if (msg.sender != author) revert NotAuthor();
        Order storage o = orders[id];
        if (o.buyer == address(0)) revert OrderNotFound();
        if (o.status != Status.Fulfilled) revert WrongStatus(o.status, Status.Fulfilled);
        encryptedTrackings[id] = tracking;
    }

    /* ─── Views ──────────────────────────────────────────────────────── */

    function getOrder(bytes32 id) external view returns (Order memory) {
        return orders[id];
    }

    function isAllowedToken(address token) external view returns (bool) {
        return token == tokenA || token == tokenB;
    }

    function disputeWindowEnd(bytes32 id) external view returns (uint64) {
        Order storage o = orders[id];
        if (o.fulfilledAt == 0) return 0;
        return o.fulfilledAt + DISPUTE_WINDOW;
    }

    function canClaimRefund(bytes32 id) external view returns (bool) {
        Order storage o = orders[id];
        return o.status == Status.Fulfilled &&
               block.timestamp <= o.fulfilledAt + DISPUTE_WINDOW;
    }

    function canReleaseProfit(bytes32 id) external view returns (bool) {
        Order storage o = orders[id];
        return o.status == Status.Fulfilled &&
               block.timestamp > o.fulfilledAt + DISPUTE_WINDOW;
    }
}
