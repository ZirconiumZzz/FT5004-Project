// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ReviewerRegistry.sol";
import "./DisputeManager.sol";

/**
 * @title ProductMarket
 * @notice Core marketplace contract and sole ETH custodian for DeTrust Market.
 *
 * Architecture note: All ETH remains locked inside this contract at all times.
 * DisputeManager communicates outcomes via accounting callbacks (no cross-contract
 * ETH transfers), which eliminates reentrancy risk during dispute resolution.
 *
 * Two-balance model per user:
 *  - depositBalance : mandatory security bond (>= 1 ETH to list or purchase)
 *  - walletBalance  : active trading wallet used for purchases and juror staking
 *
 * Tiered structure (based on product price):
 *  Tier 1: 5–20 ETH   → deposit 1 ETH, dispute stake 0.5 ETH, juror stake 0.1 ETH, platform fee 0.1 ETH
 *  Tier 2: 20–100 ETH → deposit 3 ETH, dispute stake 1.0 ETH, juror stake 0.2 ETH, platform fee 0.15 ETH
 *  Tier 3: >100 ETH   → deposit 8 ETH, dispute stake 3.0 ETH, juror stake 0.6 ETH, platform fee 0.25 ETH
 *
 * Conservation invariant:
 *   sum(depositBalance) + sum(walletBalance) + platformBalance == address(this).balance
 */
contract ProductMarket {
    ReviewerRegistry public registry;
    DisputeManager   public disputeManager;

    // ── Tier thresholds ───────────────────────────────────────────────────────
    uint256 public constant TIER2_THRESHOLD = 20 ether;
    uint256 public constant TIER3_THRESHOLD = 100 ether;

    // ── Tier 1 parameters (default / prototype) ───────────────────────────────
    uint256 public constant TIER1_MIN_DEPOSIT   = 1 ether;
    uint256 public constant TIER1_DISPUTE_STAKE = 0.5 ether;
    uint256 public constant TIER1_JUROR_STAKE   = 0.1 ether;
    uint256 public constant TIER1_PLATFORM_FEE  = 0.1 ether;

    // ── Tier 2 parameters ─────────────────────────────────────────────────────
    uint256 public constant TIER2_MIN_DEPOSIT   = 3 ether;
    uint256 public constant TIER2_DISPUTE_STAKE = 1 ether;
    uint256 public constant TIER2_JUROR_STAKE   = 0.2 ether;
    uint256 public constant TIER2_PLATFORM_FEE  = 0.15 ether;

    // ── Tier 3 parameters ─────────────────────────────────────────────────────
    uint256 public constant TIER3_MIN_DEPOSIT   = 8 ether;
    uint256 public constant TIER3_DISPUTE_STAKE = 3 ether;
    uint256 public constant TIER3_JUROR_STAKE   = 0.6 ether;
    uint256 public constant TIER3_PLATFORM_FEE  = 0.25 ether;

    uint256 private productCounter;

    enum ProductStatus { Listed, Sold, Shipped, Completed, Disputed, Resolved }

    struct Product {
        uint256       id;
        address       seller;
        address       buyer;
        string        ipfsHash;          // stores JSON component metadata
        string        deliveryIpfsHash;  // shipment tracking reference
        uint256       price;
        uint256       listedAt;
        ProductStatus status;
    }

    mapping(uint256 => Product)   public  products;
    mapping(address => uint256[]) private partyDisputes;   // dispute product IDs per party
    mapping(address => uint256)   public  depositBalance;
    mapping(address => uint256)   public  walletBalance;
    mapping(address => uint256)   public  activeDisputeCount;
    mapping(address => uint256)   public  reviewerEarnings;
    uint256                       public  platformBalance;

    event ProductListed   (uint256 indexed id, address indexed seller, string ipfsHash, uint256 price, uint8 tier);
    event ProductPurchased(uint256 indexed id, address indexed buyer);
    event ProductShipped  (uint256 indexed id, string deliveryIpfsHash);
    event ProductCompleted(uint256 indexed id);
    event ProductDisputed (uint256 indexed id, address raisedBy, uint8 tier);
    event ProductDelisted (uint256 indexed id);
    event Deposited       (address indexed user, uint256 amount);
    event Withdrawn       (address indexed user, uint256 amount);
    event WalletDeposited (address indexed user, uint256 amount);
    event WalletWithdrawn (address indexed user, uint256 amount);

    constructor(address _registry) {
        if (_registry != address(0)) {
            registry = ReviewerRegistry(_registry);
        }
    }

    function setRegistry(address _registry) external {
        registry = ReviewerRegistry(_registry);
    }

    function setDisputeManager(address _dm) external {
        require(address(disputeManager) == address(0), "Already set");
        disputeManager = DisputeManager(payable(_dm));
    }

    modifier onlyDisputeManager() {
        require(msg.sender == address(disputeManager), "Only dispute manager");
        _;
    }

    // ── Tier helpers ──────────────────────────────────────────────────────────

    /// @notice Returns the tier (1, 2, or 3) for a given product price.
    function getTier(uint256 price) public pure returns (uint8) {
        if (price >= TIER3_THRESHOLD) return 3;
        if (price >= TIER2_THRESHOLD) return 2;
        return 1;
    }

    /// @notice Minimum security deposit required to list or buy at a given tier.
    function minDeposit(uint8 tier) public pure returns (uint256) {
        if (tier == 3) return TIER3_MIN_DEPOSIT;
        if (tier == 2) return TIER2_MIN_DEPOSIT;
        return TIER1_MIN_DEPOSIT;
    }

    /// @notice Dispute stake deducted from each party's deposit when a dispute is raised.
    function disputeStake(uint8 tier) public pure returns (uint256) {
        if (tier == 3) return TIER3_DISPUTE_STAKE;
        if (tier == 2) return TIER2_DISPUTE_STAKE;
        return TIER1_DISPUTE_STAKE;
    }

    /// @notice Juror stake required per case at a given tier.
    function jurorStake(uint8 tier) public pure returns (uint256) {
        if (tier == 3) return TIER3_JUROR_STAKE;
        if (tier == 2) return TIER2_JUROR_STAKE;
        return TIER1_JUROR_STAKE;
    }

    /// @notice Platform fee deducted from the prize pool at a given tier.
    function platformFee(uint8 tier) public pure returns (uint256) {
        if (tier == 3) return TIER3_PLATFORM_FEE;
        if (tier == 2) return TIER2_PLATFORM_FEE;
        return TIER1_PLATFORM_FEE;
    }

    // ── Security deposit ──────────────────────────────────────────────────────

    function deposit() external payable {
        require(msg.value > 0, "Must send ETH");
        depositBalance[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdrawDeposit(uint256 amount) external {
        require(activeDisputeCount[msg.sender] == 0, "Cannot withdraw during active dispute");
        require(depositBalance[msg.sender] >= amount,  "Insufficient deposit balance");
        depositBalance[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ── Trading wallet ────────────────────────────────────────────────────────

    function walletDeposit() external payable {
        require(msg.value > 0, "Must send ETH");
        walletBalance[msg.sender] += msg.value;
        emit WalletDeposited(msg.sender, msg.value);
    }

    function walletWithdraw(uint256 amount) external {
        require(walletBalance[msg.sender] >= amount, "Insufficient wallet balance");
        walletBalance[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
        emit WalletWithdrawn(msg.sender, amount);
    }

    // ── DisputeManager accounting callbacks (no ETH transferred between contracts) ──

    /// @dev Deduct juror stake from in-app wallet; ETH stays in this vault.
    function deductWalletForStake(address user, uint256 amount) external onlyDisputeManager {
        require(walletBalance[user] >= amount, "Insufficient wallet balance for stake");
        walletBalance[user] -= amount;
    }

    /// @dev Return a stake to in-app wallet (juror exit or abstention).
    function refundStake(address user, uint256 amount) external onlyDisputeManager {
        walletBalance[user] += amount;
    }

    /// @dev Credit winning juror: return stake and add reward.
    function rewardJuror(address user, uint256 stakeAmount, uint256 rewardAmount) external onlyDisputeManager {
        reviewerEarnings[user] += rewardAmount;
        walletBalance[user]    += stakeAmount + rewardAmount;
    }

    /// @dev Accumulate platform fee into platformBalance.
    function creditPlatformFee(uint256 amount) external onlyDisputeManager {
        platformBalance += amount;
    }

    // ── Product lifecycle ─────────────────────────────────────────────────────

    function listProduct(string calldata ipfsHash, uint256 price) external returns (uint256) {
        require(price > 0, "Price must be greater than 0");

        uint8   tier = getTier(price);
        uint256 minDep = minDeposit(tier);
        require(depositBalance[msg.sender] >= minDep,
            string(abi.encodePacked("Insufficient deposit for Tier ", _tierStr(tier))));

        productCounter++;
        products[productCounter] = Product({
            id:               productCounter,
            seller:           msg.sender,
            buyer:            address(0),
            ipfsHash:         ipfsHash,
            deliveryIpfsHash: "",
            price:            price,
            listedAt:         block.timestamp,
            status:           ProductStatus.Listed
        });

        emit ProductListed(productCounter, msg.sender, ipfsHash, price, tier);
        return productCounter;
    }

    function purchaseProduct(uint256 productId) external {
        Product storage p = products[productId];
        require(p.status == ProductStatus.Listed,     "Not available");
        require(p.seller != msg.sender,               "Seller cannot buy own product");
        require(walletBalance[msg.sender] >= p.price, "Insufficient wallet balance");

        uint8   tier   = getTier(p.price);
        uint256 minDep = minDeposit(tier);
        require(depositBalance[msg.sender] >= minDep,
            string(abi.encodePacked("Insufficient deposit for Tier ", _tierStr(tier))));

        walletBalance[msg.sender] -= p.price;
        p.buyer  = msg.sender;
        p.status = ProductStatus.Sold;

        emit ProductPurchased(productId, msg.sender);
    }

    function confirmShipment(uint256 productId, string calldata deliveryIpfsHash) external {
        Product storage p = products[productId];
        require(msg.sender == p.seller,         "Not the seller");
        require(p.status == ProductStatus.Sold, "Wrong status");

        p.deliveryIpfsHash = deliveryIpfsHash;
        p.status           = ProductStatus.Shipped;

        emit ProductShipped(productId, deliveryIpfsHash);
    }

    function confirmReceipt(uint256 productId) external {
        Product storage p = products[productId];
        require(msg.sender == p.buyer,             "Not the buyer");
        require(p.status == ProductStatus.Shipped, "Not shipped yet");

        p.status = ProductStatus.Completed;
        registry.recordSale(p.seller);
        walletBalance[p.seller] += p.price;

        emit ProductCompleted(productId);
    }

    function delistProduct(uint256 productId) external {
        Product storage p = products[productId];
        require(msg.sender == p.seller,           "Not the seller");
        require(p.status == ProductStatus.Listed, "Cannot delist after purchase");

        p.status = ProductStatus.Resolved;
        emit ProductDelisted(productId);
    }

    function raiseDispute(uint256 productId) external {
        Product storage p = products[productId];
        require(msg.sender == p.buyer || msg.sender == p.seller, "Not involved");
        require(
            p.status == ProductStatus.Sold || p.status == ProductStatus.Shipped,
            "Can only dispute after purchase"
        );

        uint8   tier  = getTier(p.price);
        uint256 stake = disputeStake(tier);

        require(depositBalance[p.buyer]  >= stake,
            string(abi.encodePacked("Buyer insufficient deposit for Tier ", _tierStr(tier))));
        require(depositBalance[p.seller] >= stake,
            string(abi.encodePacked("Seller insufficient deposit for Tier ", _tierStr(tier))));

        depositBalance[p.buyer]   -= stake;
        depositBalance[p.seller]  -= stake;
        activeDisputeCount[p.buyer]++;
        activeDisputeCount[p.seller]++;

        p.status = ProductStatus.Disputed;
        partyDisputes[p.buyer].push(productId);
        partyDisputes[p.seller].push(productId);

        // ETH stays in this contract; notify DisputeManager to begin arbitration
        // Pass the tier so DisputeManager uses the correct stake / fee constants
        disputeManager.openDispute(productId, p.buyer, p.seller, false, tier);

        emit ProductDisputed(productId, msg.sender, tier);
    }

    /// @dev Called by DisputeManager once voting is final.
    function resolveByDispute(
        uint256 productId,
        bool    buyerWins,
        uint256 buyerStakeReturn,
        uint256 sellerStakeReturn
    ) external onlyDisputeManager {
        Product storage p = products[productId];
        require(p.status == ProductStatus.Disputed, "Not in dispute");

        p.status = ProductStatus.Resolved;
        activeDisputeCount[p.buyer]--;
        activeDisputeCount[p.seller]--;

        if (buyerWins) {
            walletBalance[p.buyer]  += p.price + buyerStakeReturn;
            if (sellerStakeReturn > 0) walletBalance[p.seller] += sellerStakeReturn;
        } else {
            registry.recordSale(p.seller);
            walletBalance[p.seller] += p.price + sellerStakeReturn;
            if (buyerStakeReturn > 0) walletBalance[p.buyer]  += buyerStakeReturn;
        }
    }

    function withdrawPlatformFee(address to) external {
        uint256 amount  = platformBalance;
        platformBalance = 0;
        payable(to).transfer(amount);
    }

    // ── View functions ────────────────────────────────────────────────────────

    function getProduct(uint256 productId) external view returns (Product memory) {
        return products[productId];
    }

    function getLatestProductId() external view returns (uint256) {
        return productCounter;
    }

    /// @notice Returns the tier for a product (convenience for frontend).
    function getProductTier(uint256 productId) external view returns (uint8) {
        return getTier(products[productId].price);
    }

    function getListedProducts() external view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 1; i <= productCounter; i++) {
            if (products[i].status == ProductStatus.Listed) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 1; i <= productCounter; i++) {
            if (products[i].status == ProductStatus.Listed) result[idx++] = i;
        }
        return result;
    }

    function getProductsBySeller(address seller) external view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 1; i <= productCounter; i++) {
            if (products[i].seller == seller) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 1; i <= productCounter; i++) {
            if (products[i].seller == seller) result[idx++] = i;
        }
        return result;
    }

    function getProductsByBuyer(address buyer) external view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 1; i <= productCounter; i++) {
            if (products[i].buyer == buyer) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 1; i <= productCounter; i++) {
            if (products[i].buyer == buyer) result[idx++] = i;
        }
        return result;
    }

    function getMyDisputes(address party) external view returns (uint256[] memory) {
        return partyDisputes[party];
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _tierStr(uint8 tier) internal pure returns (string memory) {
        if (tier == 3) return "3 (need 8 ETH deposit)";
        if (tier == 2) return "2 (need 3 ETH deposit)";
        return "1 (need 1 ETH deposit)";
    }

    receive() external payable {}
}
