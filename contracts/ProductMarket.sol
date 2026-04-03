// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ReviewerRegistry.sol";
import "./DisputeManager.sol";

contract ProductMarket {
    ReviewerRegistry public registry;
    DisputeManager public disputeManager;

    uint256 public constant MIN_DEPOSIT = 1 ether;
    uint256 public constant DISPUTE_STAKE = 0.5 ether;

    uint256 private productCounter;

    enum ProductStatus {
        Listed, Sold, Shipped, Completed, Disputed, Resolved
    }

    struct Product {
        uint256 id;
        address seller;
        address buyer;
        string ipfsHash;
        string deliveryIpfsHash;
        uint256 price;
        uint256 listedAt;
        ProductStatus status;
    }

    mapping(uint256 => Product) public products;
    mapping(address => uint256[]) private partyDisputes;
    mapping(address => uint256) public depositBalance;
    mapping(address => uint256) public walletBalance;
    mapping(address => uint256) public activeDisputeCount;
    mapping(address => uint256) public reviewerEarnings;
    uint256 public platformBalance;

    event ProductListed(uint256 indexed id, address indexed seller, string ipfsHash, uint256 price);
    event ProductPurchased(uint256 indexed id, address indexed buyer);
    event ProductShipped(uint256 indexed id, string deliveryIpfsHash);
    event ProductCompleted(uint256 indexed id);
    event ProductDisputed(uint256 indexed id, address raisedBy);
    event ProductDelisted(uint256 indexed id);
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event WalletDeposited(address indexed user, uint256 amount);
    event WalletWithdrawn(address indexed user, uint256 amount);

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

    // ── 保证金 ────────────────────────────────────────────────────

    function deposit() external payable {
        require(msg.value > 0, "Must send ETH");
        depositBalance[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdrawDeposit(uint256 amount) external {
        require(activeDisputeCount[msg.sender] == 0, "Cannot withdraw during active dispute");
        require(depositBalance[msg.sender] >= amount, "Insufficient deposit balance");
        depositBalance[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ── 站内钱包 ──────────────────────────────────────────────────

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

    // ── DisputeManager 调用的纯记账函数（ETH 始终留在 market）────

    function deductWalletForStake(address user, uint256 amount) external onlyDisputeManager {
        require(walletBalance[user] >= amount, "Insufficient wallet balance for stake");
        walletBalance[user] -= amount;
    }

    function refundStake(address user, uint256 amount) external onlyDisputeManager {
        walletBalance[user] += amount;
    }

    function rewardJuror(address user, uint256 stakeAmount, uint256 rewardAmount) external onlyDisputeManager {
        reviewerEarnings[user] += rewardAmount;
        walletBalance[user] += stakeAmount + rewardAmount;
    }

    function creditPlatformFee(uint256 amount) external onlyDisputeManager {
        platformBalance += amount;
    }

    // ── 商品流程 ───────────────────────────────────────────────────

    function listProduct(string calldata ipfsHash, uint256 price) external returns (uint256) {
        require(price > 0, "Price must be greater than 0");
        require(depositBalance[msg.sender] >= MIN_DEPOSIT, "Insufficient deposit: need 1 ETH");

        productCounter++;
        products[productCounter] = Product({
            id: productCounter,
            seller: msg.sender,
            buyer: address(0),
            ipfsHash: ipfsHash,
            deliveryIpfsHash: "",
            price: price,
            listedAt: block.timestamp,
            status: ProductStatus.Listed
        });

        emit ProductListed(productCounter, msg.sender, ipfsHash, price);
        return productCounter;
    }

    function purchaseProduct(uint256 productId) external {
        Product storage p = products[productId];
        require(p.status == ProductStatus.Listed, "Not available");
        require(p.seller != msg.sender, "Seller cannot buy own product");
        require(walletBalance[msg.sender] >= p.price, "Insufficient wallet balance");

        walletBalance[msg.sender] -= p.price;
        p.buyer = msg.sender;
        p.status = ProductStatus.Sold;

        emit ProductPurchased(productId, msg.sender);
    }

    function confirmShipment(uint256 productId, string calldata deliveryIpfsHash) external {
        Product storage p = products[productId];
        require(msg.sender == p.seller, "Not the seller");
        require(p.status == ProductStatus.Sold, "Wrong status");

        p.deliveryIpfsHash = deliveryIpfsHash;
        p.status = ProductStatus.Shipped;

        emit ProductShipped(productId, deliveryIpfsHash);
    }

    function confirmReceipt(uint256 productId) external {
        Product storage p = products[productId];
        require(msg.sender == p.buyer, "Not the buyer");
        require(p.status == ProductStatus.Shipped, "Not shipped yet");

        p.status = ProductStatus.Completed;
        registry.recordSale(p.seller);
        walletBalance[p.seller] += p.price;

        emit ProductCompleted(productId);
    }

    function delistProduct(uint256 productId) external {
        Product storage p = products[productId];
        require(msg.sender == p.seller, "Not the seller");
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
        require(depositBalance[p.buyer] >= DISPUTE_STAKE, "Buyer insufficient deposit");
        require(depositBalance[p.seller] >= DISPUTE_STAKE, "Seller insufficient deposit");

        depositBalance[p.buyer] -= DISPUTE_STAKE;
        depositBalance[p.seller] -= DISPUTE_STAKE;
        activeDisputeCount[p.buyer]++;
        activeDisputeCount[p.seller]++;

        p.status = ProductStatus.Disputed;
        partyDisputes[p.buyer].push(productId);
        partyDisputes[p.seller].push(productId);

        // ETH 留在 market，只通知 DisputeManager 开启仲裁
        disputeManager.openDispute(productId, p.buyer, p.seller, false);

        emit ProductDisputed(productId, msg.sender);
    }

    function resolveByDispute(
        uint256 productId,
        bool buyerWins,
        uint256 buyerStakeReturn,
        uint256 sellerStakeReturn
    ) external onlyDisputeManager {
        Product storage p = products[productId];
        require(p.status == ProductStatus.Disputed, "Not in dispute");

        p.status = ProductStatus.Resolved;
        activeDisputeCount[p.buyer]--;
        activeDisputeCount[p.seller]--;

        if (buyerWins) {
            walletBalance[p.buyer] += p.price + buyerStakeReturn;
            if (sellerStakeReturn > 0) walletBalance[p.seller] += sellerStakeReturn;
        } else {
            registry.recordSale(p.seller);
            walletBalance[p.seller] += p.price + sellerStakeReturn;
            if (buyerStakeReturn > 0) walletBalance[p.buyer] += buyerStakeReturn;
        }
    }

    function withdrawPlatformFee(address to) external {
        uint256 amount = platformBalance;
        platformBalance = 0;
        payable(to).transfer(amount);
    }

    // ── 查询函数 ──────────────────────────────────────────────────

    function getProduct(uint256 productId) external view returns (Product memory) {
        return products[productId];
    }

    function getLatestProductId() external view returns (uint256) {
        return productCounter;
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

    receive() external payable {}
}
