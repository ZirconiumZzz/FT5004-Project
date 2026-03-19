// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ReviewerRegistry.sol";
import "./DisputeManager.sol";

contract ProductMarket {
    ReviewerRegistry public registry;
    DisputeManager public disputeManager;

    uint256 public constant LISTING_DEADLINE = 7 days;  // 商品上架有效期
    uint256 public constant MIN_DEPOSIT = 1 ether;
    uint256 public constant DISPUTE_STAKE = 0.5 ether;

    uint256 private productCounter;

    enum ProductStatus {
        Listed,      // 卖家已上架，等待买家
        Sold,        // 买家已下单，资金锁定
        Shipped,     // 卖家已发货
        Completed,   // 买家确认收货，交易完成
        Disputed,    // 争议中
        Resolved     // 争议已解决
    }

    struct Product {
        uint256 id;
        address seller;
        address buyer;
        string ipfsHash;         // 商品描述（存IPFS）
        string deliveryIpfsHash; // 发货凭证（存IPFS，如快递单号等）
        uint256 price;           // 卖家定价
        uint256 listedAt;        // 上架时间
        ProductStatus status;
    }

    mapping(uint256 => Product) public products;
    mapping(address => uint256[]) private partyDisputes;
    mapping(address => uint256) public depositBalance;
    mapping(address => uint256) public activeDisputeCount;

    event ProductListed(uint256 indexed id, address indexed seller, string ipfsHash, uint256 price);
    event ProductPurchased(uint256 indexed id, address indexed buyer);
    event ProductShipped(uint256 indexed id, string deliveryIpfsHash);
    event ProductCompleted(uint256 indexed id);
    event ProductDisputed(uint256 indexed id, address raisedBy);
    event ProductDelisted(uint256 indexed id);
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

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

    // ── 押金系统 ──────────────────────────────────────────────────

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

    // ── 商品流程 ───────────────────────────────────────────────────

    // 卖家上架商品
    function listProduct(
        string calldata ipfsHash,
        uint256 price
    ) external returns (uint256) {
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

    // 买家下单购买（附带 ETH = price）
    function purchaseProduct(uint256 productId) external payable {
        Product storage p = products[productId];
        require(p.status == ProductStatus.Listed, "Not available");
        require(p.seller != msg.sender, "Seller cannot buy own product");
        require(msg.value == p.price, "Must send exact price");
        require(depositBalance[msg.sender] >= MIN_DEPOSIT, "Insufficient deposit: need 1 ETH");

        p.buyer = msg.sender;
        p.status = ProductStatus.Sold;

        emit ProductPurchased(productId, msg.sender);
    }

    // 卖家确认发货
    function confirmShipment(uint256 productId, string calldata deliveryIpfsHash) external {
        Product storage p = products[productId];
        require(msg.sender == p.seller, "Not the seller");
        require(p.status == ProductStatus.Sold, "Wrong status");

        p.deliveryIpfsHash = deliveryIpfsHash;
        p.status = ProductStatus.Shipped;

        emit ProductShipped(productId, deliveryIpfsHash);
    }

    // 买家确认收货，资金释放给卖家
    function confirmReceipt(uint256 productId) external {
        Product storage p = products[productId];
        require(msg.sender == p.buyer, "Not the buyer");
        require(p.status == ProductStatus.Shipped, "Not shipped yet");

        p.status = ProductStatus.Completed;
        registry.recordSale(p.seller);

        payable(p.seller).transfer(p.price);
        emit ProductCompleted(productId);
    }

    // 卖家下架（仅 Listed 状态可以）
    function delistProduct(uint256 productId) external {
        Product storage p = products[productId];
        require(msg.sender == p.seller, "Not the seller");
        require(p.status == ProductStatus.Listed, "Cannot delist after purchase");

        // 复用 Resolved 状态标记下架（或可单独加 Delisted 状态，为简单起见复用）
        p.status = ProductStatus.Resolved;
        emit ProductDelisted(productId);
    }

    // 发起争议（买卖双方均可，Sold 或 Shipped 状态）
    function raiseDispute(uint256 productId) external {
        Product storage p = products[productId];
        require(
            msg.sender == p.buyer || msg.sender == p.seller,
            "Not involved in this product"
        );
        require(
            p.status == ProductStatus.Sold || p.status == ProductStatus.Shipped,
            "Can only dispute after purchase"
        );

        require(depositBalance[p.buyer] >= DISPUTE_STAKE, "Buyer insufficient deposit for dispute");
        require(depositBalance[p.seller] >= DISPUTE_STAKE, "Seller insufficient deposit for dispute");

        depositBalance[p.buyer] -= DISPUTE_STAKE;
        depositBalance[p.seller] -= DISPUTE_STAKE;

        activeDisputeCount[p.buyer]++;
        activeDisputeCount[p.seller]++;

        p.status = ProductStatus.Disputed;
        partyDisputes[p.buyer].push(productId);
        partyDisputes[p.seller].push(productId);

        (bool sent, ) = address(disputeManager).call{value: DISPUTE_STAKE * 2}("");
        require(sent, "Failed to send stakes to DisputeManager");

        // aiUsageAllowed 在商品场景不适用，传 false 即可
        disputeManager.openDispute(productId, p.buyer, p.seller, false);

        emit ProductDisputed(productId, msg.sender);
    }

    // 由 DisputeManager 在争议解决后调用
    function resolveByDispute(
        uint256 productId,
        bool buyerWins,
        uint256 buyerStakeReturn,
        uint256 sellerStakeReturn
    ) external {
        require(msg.sender == address(disputeManager), "Only dispute manager");
        Product storage p = products[productId];
        require(p.status == ProductStatus.Disputed, "Not in dispute");

        p.status = ProductStatus.Resolved;

        activeDisputeCount[p.buyer]--;
        activeDisputeCount[p.seller]--;

        if (buyerWins) {
            // 买家：退回商品款 + 退回质押
            payable(p.buyer).transfer(p.price + buyerStakeReturn);
            if (sellerStakeReturn > 0) {
                payable(p.seller).transfer(sellerStakeReturn);
            }
        } else {
            // 卖家：收到商品款 + 退回质押
            registry.recordSale(p.seller);
            payable(p.seller).transfer(p.price + sellerStakeReturn);
            if (buyerStakeReturn > 0) {
                payable(p.buyer).transfer(buyerStakeReturn);
            }
        }
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
