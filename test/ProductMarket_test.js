const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("ProductMarket Full Flow", function () {
  let market, disputeManager, registry, dataFetcher;
  let buyer, seller, reviewer1, reviewer2, reviewer3, reviewer4, reviewer5;

  // 每个测试前重新部署，保证状态干净
  beforeEach(async function () {
    [buyer, seller, reviewer1, reviewer2, reviewer3, reviewer4, reviewer5] =
      await ethers.getSigners();

    const Market = await ethers.getContractFactory("ProductMarket");
    market = await Market.deploy(ethers.ZeroAddress);
    await market.waitForDeployment();

    const Registry = await ethers.getContractFactory("ReviewerRegistry");
    registry = await Registry.deploy(await market.getAddress());
    await registry.waitForDeployment();

    await market.setRegistry(await registry.getAddress());
    await registry.setMarketContract(await market.getAddress());

    const Dispute = await ethers.getContractFactory("DisputeManager");
    disputeManager = await Dispute.deploy(
      await registry.getAddress(),
      await market.getAddress()
    );
    await disputeManager.waitForDeployment();

    await market.setDisputeManager(await disputeManager.getAddress());

    const DataFetcher = await ethers.getContractFactory("DataFetcher");
    dataFetcher = await DataFetcher.deploy(
      await market.getAddress(),
      await disputeManager.getAddress()
    );
    await dataFetcher.waitForDeployment();

    // 给 DisputeManager 预充 ETH（用于退回质押）
    await reviewer1.sendTransaction({
      to: await disputeManager.getAddress(),
      value: ethers.parseEther("1.0"),
    });

    // 注册5个评审员（forceRegister 绕过 10 笔限制，仅 demo 用）
    for (const r of [reviewer1, reviewer2, reviewer3, reviewer4, reviewer5]) {
      await registry.forceRegister(r.address);
    }

    // 买卖双方各存 1 ETH 押金
    await market.connect(buyer).deposit({ value: ethers.parseEther("1.0") });
    await market.connect(seller).deposit({ value: ethers.parseEther("1.0") });
  });

  // ─────────────────────────────────────────────────────────────
  // 商品基本流程
  // ─────────────────────────────────────────────────────────────
  describe("Product lifecycle", function () {

    it("seller can list a product", async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      const product = await market.getProduct(1);
      expect(product.seller).to.equal(seller.address);
      expect(product.status).to.equal(0); // Listed
      expect(product.price).to.equal(ethers.parseEther("0.1"));
    });

    it("buyer can purchase a listed product", async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") });
      const product = await market.getProduct(1);
      expect(product.buyer).to.equal(buyer.address);
      expect(product.status).to.equal(1); // Sold
    });

    it("seller cannot buy their own product", async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await expect(
        market.connect(seller).purchaseProduct(1, { value: ethers.parseEther("0.1") })
      ).to.be.revertedWith("Seller cannot buy own product");
    });

    it("buyer must send exact price", async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await expect(
        market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.05") })
      ).to.be.revertedWith("Must send exact price");
    });

    it("seller can confirm shipment after purchase", async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") });
      await market.connect(seller).confirmShipment(1, "QmDeliveryHash");
      const product = await market.getProduct(1);
      expect(product.status).to.equal(2); // Shipped
      expect(product.deliveryIpfsHash).to.equal("QmDeliveryHash");
    });

    it("buyer confirms receipt and seller receives ETH", async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") });
      await market.connect(seller).confirmShipment(1, "QmDeliveryHash");

      const sellerBefore = await ethers.provider.getBalance(seller.address);
      await market.connect(buyer).confirmReceipt(1);
      const sellerAfter = await ethers.provider.getBalance(seller.address);

      expect(sellerAfter - sellerBefore).to.equal(ethers.parseEther("0.1"));
      const product = await market.getProduct(1);
      expect(product.status).to.equal(3); // Completed
    });

    it("completed sale increments seller completedSales", async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") });
      await market.connect(seller).confirmShipment(1, "QmDeliveryHash");
      await market.connect(buyer).confirmReceipt(1);

      const sales = await registry.completedSales(seller.address);
      expect(sales).to.equal(1);
    });

    it("seller can delist a product that has not been purchased", async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await market.connect(seller).delistProduct(1);
      const product = await market.getProduct(1);
      expect(product.status).to.equal(5); // Resolved (used as delisted marker)
    });

    it("seller cannot delist after buyer has purchased", async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") });
      await expect(
        market.connect(seller).delistProduct(1)
      ).to.be.revertedWith("Cannot delist after purchase");
    });

    it("seller cannot list product without sufficient deposit", async function () {
      const [,,,,,,,, poorSeller] = await ethers.getSigners();
      await expect(
        market.connect(poorSeller).listProduct("QmHash123", ethers.parseEther("0.1"))
      ).to.be.revertedWith("Insufficient deposit: need 1 ETH");
    });

    it("buyer cannot purchase without sufficient deposit", async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      const [,,,,,,,, poorBuyer] = await ethers.getSigners();
      await expect(
        market.connect(poorBuyer).purchaseProduct(1, { value: ethers.parseEther("0.1") })
      ).to.be.revertedWith("Insufficient deposit: need 1 ETH");
    });

    it("seller cannot list new product when deposit drops below minimum after dispute stake", async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") });

      // 发起争议，卖家押金从 1 ETH 扣到 0.5 ETH
      await market.connect(seller).raiseDispute(1);

      // 卖家押金不足，无法上架新商品
      await expect(
        market.connect(seller).listProduct("QmHash456", ethers.parseEther("0.1"))
      ).to.be.revertedWith("Insufficient deposit: need 1 ETH");

      // 补充押金后可以正常上架
      await market.connect(seller).deposit({ value: ethers.parseEther("0.5") });
      await market.connect(seller).listProduct("QmHash456", ethers.parseEther("0.1"));
      const product = await market.getProduct(2);
      expect(product.status).to.equal(0); // Listed
    });

    it("buyer cannot purchase when deposit drops below minimum after dispute stake", async function () {
      // 卖家上架两个商品
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await market.connect(seller).listProduct("QmHash456", ethers.parseEther("0.1"));

      // 买家购买第一个商品并发起争议
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") });
      await market.connect(buyer).raiseDispute(1);

      // 买家押金不足，无法购买第二个商品
      await expect(
        market.connect(buyer).purchaseProduct(2, { value: ethers.parseEther("0.1") })
      ).to.be.revertedWith("Insufficient deposit: need 1 ETH");

      // 补充押金后可以正常购买
      await market.connect(buyer).deposit({ value: ethers.parseEther("0.5") });
      await market.connect(buyer).purchaseProduct(2, { value: ethers.parseEther("0.1") });
      const product = await market.getProduct(2);
      expect(product.status).to.equal(1); // Sold
    });
  });

  // ─────────────────────────────────────────────────────────────
  // raiseDispute — Sold 和 Shipped 都可以
  // ─────────────────────────────────────────────────────────────
  describe("raiseDispute", function () {

    async function listAndPurchase() {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") });
    }

    it("buyer can raise dispute after purchase (Sold)", async function () {
      await listAndPurchase();
      await market.connect(buyer).raiseDispute(1);
      const product = await market.getProduct(1);
      expect(product.status).to.equal(4); // Disputed
    });

    it("seller can raise dispute after purchase (Sold)", async function () {
      await listAndPurchase();
      await market.connect(seller).raiseDispute(1);
      const product = await market.getProduct(1);
      expect(product.status).to.equal(4); // Disputed
    });

    it("buyer can raise dispute after shipment (Shipped)", async function () {
      await listAndPurchase();
      await market.connect(seller).confirmShipment(1, "QmDelivery");
      await market.connect(buyer).raiseDispute(1);
      const product = await market.getProduct(1);
      expect(product.status).to.equal(4); // Disputed
    });

    it("seller can raise dispute after shipment (Shipped)", async function () {
      await listAndPurchase();
      await market.connect(seller).confirmShipment(1, "QmDelivery");
      await market.connect(seller).raiseDispute(1);
      const product = await market.getProduct(1);
      expect(product.status).to.equal(4); // Disputed
    });

    it("stranger cannot raise dispute", async function () {
      await listAndPurchase();
      const [,,,,,,,, stranger] = await ethers.getSigners();
      await expect(
        market.connect(stranger).raiseDispute(1)
      ).to.be.revertedWith("Not involved in this product");
    });

    it("cannot raise dispute on Listed product (no buyer yet)", async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await expect(
        market.connect(seller).raiseDispute(1)
      ).to.be.revertedWith("Can only dispute after purchase");
    });

  });

  // ─────────────────────────────────────────────────────────────
  // Dispute 完整流程
  // ─────────────────────────────────────────────────────────────
  describe("Dispute flow", function () {

    beforeEach(async function () {
      await market.connect(seller).listProduct("QmHash123", ethers.parseEther("0.1"));
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") });
      await market.connect(buyer).raiseDispute(1);
    });

    it("dispute is opened with 5 assigned reviewers", async function () {
      const [assignedReviewers] = await disputeManager.getDisputeInfo(1);
      expect(assignedReviewers.length).to.equal(5);
    });

    it("assigned reviewer can stake and vote", async function () {
      const [assignedReviewers] = await disputeManager.getDisputeInfo(1);
      const r = await ethers.getSigner(assignedReviewers[0]);
      await disputeManager.connect(r).stakeToEnter(1, { value: ethers.parseEther("0.1") });
      await disputeManager.connect(r).castVote(1, 1); // BuyerWins
      const vote = await disputeManager.getReviewerVote(1, assignedReviewers[0]);
      expect(vote).to.equal(1);
    });

    it("non-assigned address cannot stake to enter", async function () {
      const [,,,,,,,, stranger] = await ethers.getSigners();
      await expect(
        disputeManager.connect(stranger).stakeToEnter(1, { value: ethers.parseEther("0.1") })
      ).to.be.revertedWith("Not assigned to this dispute");
    });

    it("reviewer cannot vote twice", async function () {
      const [assignedReviewers] = await disputeManager.getDisputeInfo(1);
      const r = await ethers.getSigner(assignedReviewers[0]);
      await disputeManager.connect(r).stakeToEnter(1, { value: ethers.parseEther("0.1") });
      await disputeManager.connect(r).castVote(1, 1);
      await expect(
        disputeManager.connect(r).castVote(1, 2)
      ).to.be.revertedWith("Already voted");
    });

    it("buyer wins: product price returned to buyer", async function () {
      const [assignedReviewers] = await disputeManager.getDisputeInfo(1);
      for (let i = 0; i < 3; i++) {
        const r = await ethers.getSigner(assignedReviewers[i]);
        await disputeManager.connect(r).stakeToEnter(1, { value: ethers.parseEther("0.1") });
        await disputeManager.connect(r).castVote(1, 1); // BuyerWins
      }
      for (let i = 3; i < 5; i++) {
        const r = await ethers.getSigner(assignedReviewers[i]);
        await disputeManager.connect(r).stakeToEnter(1, { value: ethers.parseEther("0.1") });
        await disputeManager.connect(r).castVote(1, 2); // SellerWins
      }

      await time.increase(24 * 60 * 60 + 1);

      const buyerBefore = await ethers.provider.getBalance(buyer.address);
      await disputeManager.connect(buyer).settleDispute(1);
      const buyerAfter = await ethers.provider.getBalance(buyer.address);

      // buyer 收到商品款退回 0.1 ETH + 质押退回 0.5 ETH ≈ 0.6 ETH
      expect(buyerAfter - buyerBefore).to.be.closeTo(
        ethers.parseEther("0.6"),
        ethers.parseEther("0.01")
      );
    });

    it("seller wins: product price sent to seller", async function () {
      const [assignedReviewers] = await disputeManager.getDisputeInfo(1);
      for (let i = 0; i < 4; i++) {
        const r = await ethers.getSigner(assignedReviewers[i]);
        await disputeManager.connect(r).stakeToEnter(1, { value: ethers.parseEther("0.1") });
        await disputeManager.connect(r).castVote(1, 2); // SellerWins
      }
      // 第5个只质押不投票：质押退回，不进奖金池
      const r4 = await ethers.getSigner(assignedReviewers[4]);
      await disputeManager.connect(r4).stakeToEnter(1, { value: ethers.parseEther("0.1") });

      await time.increase(24 * 60 * 60 + 1);

      const sellerBefore = await ethers.provider.getBalance(seller.address);
      const r4Before = await ethers.provider.getBalance(assignedReviewers[4]);

      await disputeManager.connect(seller).settleDispute(1);
      const sellerAfter = await ethers.provider.getBalance(seller.address);
      const r4After = await ethers.provider.getBalance(assignedReviewers[4]);

      // seller 收到商品款 0.1 ETH + 质押退回 0.5 ETH ≈ 0.6 ETH
      expect(sellerAfter - sellerBefore).to.be.closeTo(
        ethers.parseEther("0.6"),
        ethers.parseEther("0.01")
      );

      // 只质押不投票的评审员：质押退回（无惩罚）
      expect(r4After - r4Before).to.be.closeTo(
        ethers.parseEther("0.1"),
        ethers.parseEther("0.001")
      );
    });

    it("tie triggers re-assignment and resets votes", async function () {
      const [assignedReviewers] = await disputeManager.getDisputeInfo(1);

      for (let i = 0; i < 2; i++) {
        const r = await ethers.getSigner(assignedReviewers[i]);
        await disputeManager.connect(r).stakeToEnter(1, { value: ethers.parseEther("0.1") });
        await disputeManager.connect(r).castVote(1, 1); // BuyerWins
      }
      for (let i = 2; i < 4; i++) {
        const r = await ethers.getSigner(assignedReviewers[i]);
        await disputeManager.connect(r).stakeToEnter(1, { value: ethers.parseEther("0.1") });
        await disputeManager.connect(r).castVote(1, 2); // SellerWins
      }

      await time.increase(24 * 60 * 60 + 1);
      await expect(disputeManager.connect(buyer).settleDispute(1))
        .to.emit(disputeManager, "TieDetected");

      const info = await disputeManager.getDisputeInfo(1);
      expect(info[1]).to.equal(0); // buyerVotes reset to 0
      expect(info[2]).to.equal(0); // sellerVotes reset to 0
    });

    it("cannot settle before voting deadline", async function () {
      await expect(
        disputeManager.connect(buyer).settleDispute(1)
      ).to.be.revertedWith("Voting still ongoing");
    });

  });

  // ─────────────────────────────────────────────────────────────
  // DataFetcher dashboard queries
  // ─────────────────────────────────────────────────────────────
  describe("DataFetcher dashboards", function () {

    it("getBuyerDashboard returns purchases and disputes", async function () {
      await market.connect(seller).listProduct("QmHash1", ethers.parseEther("0.1"));
      await market.connect(seller).listProduct("QmHash2", ethers.parseEther("0.2"));
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") });
      await market.connect(buyer).purchaseProduct(2, { value: ethers.parseEther("0.2") });
      await market.connect(buyer).raiseDispute(1);

      const dashboard = await dataFetcher.getBuyerDashboard(buyer.address);
      expect(dashboard.purchases.length).to.equal(2);
      expect(dashboard.disputes.length).to.equal(1);
      expect(dashboard.disputes[0].productId).to.equal(1);
    });

    it("getSellerDashboard returns listed products, my products, and disputes", async function () {
      await market.connect(seller).listProduct("QmHash1", ethers.parseEther("0.1"));
      await market.connect(seller).listProduct("QmHash2", ethers.parseEther("0.1"));
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") });
      await market.connect(seller).raiseDispute(1);

      const dashboard = await dataFetcher.getSellerDashboard(seller.address);
      expect(dashboard.listedProducts.length).to.equal(1); // 只有 product 2 还在 Listed
      expect(dashboard.myProducts.length).to.equal(2);     // seller 的两个商品
      expect(dashboard.disputes.length).to.equal(1);
    });

    it("getStorefront returns only listed products", async function () {
      await market.connect(seller).listProduct("QmHash1", ethers.parseEther("0.1"));
      await market.connect(seller).listProduct("QmHash2", ethers.parseEther("0.2"));
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") }); // product 1 变成 Sold

      const storefront = await dataFetcher.getStorefront();
      expect(storefront.length).to.equal(1); // 只剩 product 2
      expect(storefront[0].id).to.equal(2);
    });

    it("getReviewerDashboard returns assigned disputes and earnings", async function () {
      await market.connect(seller).listProduct("QmHash1", ethers.parseEther("0.1"));
      await market.connect(buyer).purchaseProduct(1, { value: ethers.parseEther("0.1") });
      await market.connect(buyer).raiseDispute(1);

      const [assignedReviewers] = await disputeManager.getDisputeInfo(1);
      const firstReviewer = await ethers.getSigner(assignedReviewers[0]);

      const dashboard = await dataFetcher.getReviewerDashboard(firstReviewer.address);
      expect(dashboard.disputes.length).to.equal(1);
      expect(dashboard.disputes[0].productId).to.equal(1);
      expect(dashboard.totalEarnings).to.equal(0); // 还没结算
    });

  });

});
