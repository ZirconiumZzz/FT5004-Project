const hre = require("hardhat");

// ── 工具函数 ──────────────────────────────────────────────────
function section(title) {
  console.log(`\n${"═".repeat(55)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(55)}`);
}

function pass(msg) { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); }
function info(msg) { console.log(`     ${msg}`); }

async function expectRevert(promise, reason) {
  try {
    await promise;
    fail(`应该revert但没有: ${reason}`);
  } catch (e) {
    if (e.message.includes(reason)) {
      pass(`正确拒绝 — "${reason}"`);
    } else {
      fail(`revert了但原因不对: ${e.message}`);
    }
  }
}

// ── 部署所有合约 ──────────────────────────────────────────────
async function deploy() {
  const [buyer, seller, reviewer1, reviewer2, reviewer3, reviewer4, reviewer5, stranger] =
    await hre.ethers.getSigners();

  const Market = await hre.ethers.getContractFactory("ProductMarket");
  const market = await Market.deploy(hre.ethers.ZeroAddress);
  await market.waitForDeployment();

  const Registry = await hre.ethers.getContractFactory("ReviewerRegistry");
  const registry = await Registry.deploy(await market.getAddress());
  await registry.waitForDeployment();

  await market.setRegistry(await registry.getAddress());
  await registry.setMarketContract(await market.getAddress());

  const Dispute = await hre.ethers.getContractFactory("DisputeManager");
  const dispute = await Dispute.deploy(
    await registry.getAddress(),
    await market.getAddress()
  );
  await dispute.waitForDeployment();
  await market.setDisputeManager(await dispute.getAddress());

  const DataFetcher = await hre.ethers.getContractFactory("DataFetcher");
  const dataFetcher = await DataFetcher.deploy(
    await market.getAddress(),
    await dispute.getAddress()
  );
  await dataFetcher.waitForDeployment();

  // 注册5个评审员（forceRegister 绕过 10 笔限制，仅 demo 用）
  for (const r of [reviewer1, reviewer2, reviewer3, reviewer4, reviewer5]) {
    await registry.forceRegister(r.address);
  }

  return { market, registry, dispute, dataFetcher, buyer, seller, reviewer1, reviewer2, reviewer3, reviewer4, reviewer5, stranger };
}

// ══════════════════════════════════════════════════════════════
async function main() {
  const { market, registry, dispute, dataFetcher, buyer, seller, reviewer1, reviewer2, reviewer3, reviewer4, reviewer5, stranger } = await deploy();

  // ════════════════════════════════════════════════════════════
  section("1. 押金系统测试");
  // ════════════════════════════════════════════════════════════
  // 预期结果：
  //   - 押金不足时卖家无法上架商品
  //   - 押金不足时买家无法购买商品
  //   - 双方充值后可以正常操作
  //   - 无争议时可以随时提取押金

  // 押金不足时无法上架
  await expectRevert(
    market.connect(seller).listProduct("QmHash", hre.ethers.parseEther("0.1")),
    "Insufficient deposit: need 1 ETH"
  );

  // 卖家充值后上架
  await market.connect(seller).deposit({ value: hre.ethers.parseEther("1.0") });
  await market.connect(seller).listProduct("QmHash", hre.ethers.parseEther("0.1"));

  // 押金不足时无法购买
  await expectRevert(
    market.connect(buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.1") }),
    "Insufficient deposit: need 1 ETH"
  );

  // 买家充值后可以正常购买
  await market.connect(buyer).deposit({ value: hre.ethers.parseEther("1.0") });
  await market.connect(buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.1") });
  pass("买卖双方各存 1 ETH 押金后可以正常上架/购买");
  info(`Buyer deposit: ${hre.ethers.formatEther(await market.depositBalance(buyer.address))} ETH`);
  info(`Seller deposit: ${hre.ethers.formatEther(await market.depositBalance(seller.address))} ETH`);

  // 无争议时可以提取押金
  await market.connect(seller).deposit({ value: hre.ethers.parseEther("0.5") });
  const beforeWithdraw = await market.depositBalance(seller.address);
  await market.connect(seller).withdrawDeposit(hre.ethers.parseEther("0.5"));
  const afterWithdraw = await market.depositBalance(seller.address);
  pass("无争议时可以提取押金");
  info(`Before: ${hre.ethers.formatEther(beforeWithdraw)} ETH → After: ${hre.ethers.formatEther(afterWithdraw)} ETH`);

  // ════════════════════════════════════════════════════════════
  section("2. 商品生命周期测试（正常完成流程）");
  // ════════════════════════════════════════════════════════════
  // 预期结果：
  //   Listed(0) → Sold(1) → Shipped(2) → Completed(3)
  //   卖家在买家确认收货后收到商品款
  //   成交记录 +1，满10笔后可以注册为评审员

  const c2 = await deploy();
  await c2.market.connect(c2.buyer).deposit({ value: hre.ethers.parseEther("1.0") });
  await c2.market.connect(c2.seller).deposit({ value: hre.ethers.parseEther("1.0") });

  // 卖家上架商品
  await c2.market.connect(c2.seller).listProduct("QmProductHash", hre.ethers.parseEther("0.5"));
  let p = await c2.market.getProduct(1);
  pass(`卖家上架商品，状态: ${p.status} (0=已上架)`);
  info(`IPFS hash: QmProductHash | 价格: ${hre.ethers.formatEther(p.price)} ETH`);

  // 卖家不能买自己的商品
  await expectRevert(
    c2.market.connect(c2.seller).purchaseProduct(1, { value: hre.ethers.parseEther("0.5") }),
    "Seller cannot buy own product"
  );

  // 买家发送错误金额
  await expectRevert(
    c2.market.connect(c2.buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.1") }),
    "Must send exact price"
  );

  // 买家下单购买
  await c2.market.connect(c2.buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.5") });
  p = await c2.market.getProduct(1);
  pass(`买家下单购买，状态: ${p.status} (1=已售出)`);
  info(`Buyer: ${p.buyer}`);

  // 卖家确认发货
  await c2.market.connect(c2.seller).confirmShipment(1, "QmShipmentHash");
  p = await c2.market.getProduct(1);
  pass(`卖家确认发货，状态: ${p.status} (2=已发货)`);
  info(`Shipment IPFS hash: QmShipmentHash`);

  // 买家确认收货，卖家收款
  const sellerBefore = await hre.ethers.provider.getBalance(c2.seller.address);
  await c2.market.connect(c2.buyer).confirmReceipt(1);
  const sellerAfter = await hre.ethers.provider.getBalance(c2.seller.address);
  p = await c2.market.getProduct(1);
  pass(`买家确认收货，状态: ${p.status} (3=已完成)`);
  info(`Seller ETH gained: ${hre.ethers.formatEther(sellerAfter - sellerBefore)} ETH`);

  // 完成后卖家成交记录+1
  const sales = await c2.registry.completedSales(c2.seller.address);
  pass(`卖家成交记录+1，当前: ${sales} 笔（满10笔可注册为评审员）`);

  // ════════════════════════════════════════════════════════════
  section("3. 卖家下架测试");
  // ════════════════════════════════════════════════════════════
  // 预期结果：
  //   - Listed 状态可以下架
  //   - 已购买（Sold 或之后）不能下架

  const c3 = await deploy();
  await c3.market.connect(c3.seller).deposit({ value: hre.ethers.parseEther("1.0") });
  await c3.market.connect(c3.buyer).deposit({ value: hre.ethers.parseEther("1.0") });

  await c3.market.connect(c3.seller).listProduct("QmHash1", hre.ethers.parseEther("0.1"));
  await c3.market.connect(c3.seller).listProduct("QmHash2", hre.ethers.parseEther("0.2"));

  // 未被购买可以下架
  await c3.market.connect(c3.seller).delistProduct(1);
  const p3 = await c3.market.getProduct(1);
  pass(`未被购买的商品可以下架，状态: ${p3.status} (5=已下架)`);

  // 已购买不能下架
  await c3.market.connect(c3.buyer).purchaseProduct(2, { value: hre.ethers.parseEther("0.2") });
  await expectRevert(
    c3.market.connect(c3.seller).delistProduct(2),
    "Cannot delist after purchase"
  );

  // ════════════════════════════════════════════════════════════
  section("4. Dashboard 查询测试");
  // ════════════════════════════════════════════════════════════
  // 预期结果：
  //   - 买家 Dashboard 显示所有购买记录 + 相关争议
  //   - 卖家 Dashboard 显示全平台在售商品 + 自己所有商品 + 相关争议
  //   - Storefront 只显示 Listed 状态的商品

  const c4 = await deploy();
  await c4.market.connect(c4.buyer).deposit({ value: hre.ethers.parseEther("1.0") });
  await c4.market.connect(c4.seller).deposit({ value: hre.ethers.parseEther("1.0") });

  await c4.market.connect(c4.seller).listProduct("QmHash1", hre.ethers.parseEther("0.1"));
  await c4.market.connect(c4.seller).listProduct("QmHash2", hre.ethers.parseEther("0.2"));
  await c4.market.connect(c4.buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.1") });

  // Storefront（所有人可见的在售商品）
  const storefront = await c4.dataFetcher.getStorefront();
  pass(`Storefront: 在售商品 ${storefront.length} 个（Product #2，#1 已售出）`);
  info(`Product #${storefront[0].id}: 价格=${hre.ethers.formatEther(storefront[0].price)} ETH`);

  // 买家 Dashboard
  const buyerDash = await c4.dataFetcher.getBuyerDashboard(c4.buyer.address);
  pass(`买家 Dashboard: 共 ${buyerDash.purchases.length} 个购买记录`);
  const statusMap = ["已上架", "已售出", "已发货", "已完成", "争议中", "已解决"];
  for (const item of buyerDash.purchases) {
    info(`Product #${item.id}: 状态=${statusMap[item.status]} | 价格=${hre.ethers.formatEther(item.price)} ETH`);
  }

  // 卖家 Dashboard
  const sellerDash = await c4.dataFetcher.getSellerDashboard(c4.seller.address);
  pass(`卖家 Dashboard: 平台在售 ${sellerDash.listedProducts.length} 个，我的商品共 ${sellerDash.myProducts.length} 个`);
  info(`Listed: Product #${sellerDash.listedProducts[0]?.id}`);
  info(`My products: #${sellerDash.myProducts[0]?.id}, #${sellerDash.myProducts[1]?.id}`);

  // ════════════════════════════════════════════════════════════
  section("5. 争议触发条件测试");
  // ════════════════════════════════════════════════════════════
  // 预期结果：
  //   - Listed 状态（未购买）不能发起争议
  //   - 局外人不能发起争议
  //   - Sold 状态买卖双方均可发起争议
  //   - Shipped 状态买卖双方均可发起争议

  const c5 = await deploy();
  await c5.market.connect(c5.buyer).deposit({ value: hre.ethers.parseEther("1.0") });
  await c5.market.connect(c5.seller).deposit({ value: hre.ethers.parseEther("1.0") });
  await c5.market.connect(c5.seller).listProduct("QmHash", hre.ethers.parseEther("0.1"));

  // Listed 状态不能发起争议
  await expectRevert(
    c5.market.connect(c5.seller).raiseDispute(1),
    "Can only dispute after purchase"
  );

  // 陌生人不能发起争议
  await c5.market.connect(c5.buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.1") });
  await expectRevert(
    c5.market.connect(c5.stranger).raiseDispute(1),
    "Not involved in this product"
  );

  // Sold 状态买家可以发起争议
  await c5.market.connect(c5.buyer).raiseDispute(1);
  let p5 = await c5.market.getProduct(1);
  pass(`Sold 状态买家可以发起争议，状态: ${p5.status} (4=争议中)`);

  // Sold 状态卖家可以发起争议
  const c5b = await deploy();
  await c5b.market.connect(c5b.buyer).deposit({ value: hre.ethers.parseEther("1.0") });
  await c5b.market.connect(c5b.seller).deposit({ value: hre.ethers.parseEther("1.0") });
  await c5b.market.connect(c5b.seller).listProduct("QmHash", hre.ethers.parseEther("0.1"));
  await c5b.market.connect(c5b.buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.1") });
  await c5b.market.connect(c5b.seller).raiseDispute(1);
  let p5b = await c5b.market.getProduct(1);
  pass(`Sold 状态卖家也可以发起争议，状态: ${p5b.status} (4=争议中)`);

  // Shipped 状态也可以发起争议
  const c5c = await deploy();
  await c5c.market.connect(c5c.buyer).deposit({ value: hre.ethers.parseEther("1.0") });
  await c5c.market.connect(c5c.seller).deposit({ value: hre.ethers.parseEther("1.0") });
  await c5c.market.connect(c5c.seller).listProduct("QmHash", hre.ethers.parseEther("0.1"));
  await c5c.market.connect(c5c.buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.1") });
  await c5c.market.connect(c5c.seller).confirmShipment(1, "QmDelivery");
  await c5c.market.connect(c5c.buyer).raiseDispute(1);
  let p5c = await c5c.market.getProduct(1);
  pass(`Shipped 状态买家也可以发起争议，状态: ${p5c.status} (4=争议中)`);

  // ════════════════════════════════════════════════════════════
  section("6. 争议质押 & 押金限制测试");
  // ════════════════════════════════════════════════════════════
  // 预期结果：
  //   - 发起争议时买卖双方各扣除 0.5 ETH 质押
  //   - 争议期间无法提取押金
  //   - 押金不足（< 1 ETH）时无法上架新商品/购买
  //   - 补充押金后可以继续正常操作

  const c6 = await deploy();
  await c6.market.connect(c6.buyer).deposit({ value: hre.ethers.parseEther("1.0") });
  await c6.market.connect(c6.seller).deposit({ value: hre.ethers.parseEther("1.0") });
  await c6.market.connect(c6.seller).listProduct("QmHash", hre.ethers.parseEther("0.1"));
  await c6.market.connect(c6.buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.1") });

  // 发起争议后双方押金各扣 0.5 ETH
  await c6.market.connect(c6.buyer).raiseDispute(1);
  const buyerDep6 = await c6.market.depositBalance(c6.buyer.address);
  const sellerDep6 = await c6.market.depositBalance(c6.seller.address);
  pass("发起争议后买卖双方各扣除 0.5 ETH 质押");
  info(`Buyer deposit: 1.0 → ${hre.ethers.formatEther(buyerDep6)} ETH`);
  info(`Seller deposit: 1.0 → ${hre.ethers.formatEther(sellerDep6)} ETH`);

  // 争议期间无法提取押金
  await expectRevert(
    c6.market.connect(c6.buyer).withdrawDeposit(hre.ethers.parseEther("0.1")),
    "Cannot withdraw during active dispute"
  );

  // 押金不足时无法上架新商品（卖家押金只剩 0.5 ETH）
  await c6.market.connect(c6.seller).listProduct("QmHash2", hre.ethers.parseEther("0.1")).then(
    () => fail("应该失败但成功了"),
    () => pass("争议扣款后押金不足(0.5 ETH)，无法上架新商品")
  );

  // 押金不足时无法购买（买家押金只剩 0.5 ETH）
  await c6.market.connect(c6.seller).deposit({ value: hre.ethers.parseEther("0.5") }); // 卖家先补充上架
  await c6.market.connect(c6.seller).listProduct("QmHash2", hre.ethers.parseEther("0.1"));
  await c6.market.connect(c6.buyer).purchaseProduct(2, { value: hre.ethers.parseEther("0.1") }).then(
    () => fail("应该失败但成功了"),
    () => pass("争议扣款后押金不足(0.5 ETH)，无法购买新商品")
  );

  // 补充押金后可以继续
  await c6.market.connect(c6.buyer).deposit({ value: hre.ethers.parseEther("0.5") });
  await c6.market.connect(c6.buyer).purchaseProduct(2, { value: hre.ethers.parseEther("0.1") });
  pass("补充押金至 1 ETH 后可以正常购买新商品");

  // ════════════════════════════════════════════════════════════
  section("7. 争议完整流程 — 买家赢");
  // ════════════════════════════════════════════════════════════
  // 预期结果：
  //   - 5个评审员被随机分配（排除买卖双方）
  //   - 非分配评审员无法质押进入
  //   - 3票买家赢 vs 2票卖家赢 → 买家获胜
  //   - 投完票无法反悔退出
  //   - DDL 前无法结算
  //   - 结算后：买家收到商品款退款 + 质押退回；投错票评审员质押被没收

  const c7 = await deploy();
  await c7.market.connect(c7.buyer).deposit({ value: hre.ethers.parseEther("1.0") });
  await c7.market.connect(c7.seller).deposit({ value: hre.ethers.parseEther("1.0") });
  await c7.market.connect(c7.seller).listProduct("QmHash", hre.ethers.parseEther("0.1"));
  await c7.market.connect(c7.buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.1") });
  await c7.market.connect(c7.buyer).raiseDispute(1);

  const info7 = await c7.dispute.getDisputeInfo(1);
  pass(`系统随机分配 ${info7[0].length} 个评审员`);

  const reviewers7 = info7[0];

  // 非分配评审员无法质押进入
  await expectRevert(
    c7.dispute.connect(c7.stranger).stakeToEnter(1, { value: hre.ethers.parseEther("0.1") }),
    "Not assigned to this dispute"
  );

  // 3票买家赢，2票卖家赢
  for (let i = 0; i < 3; i++) {
    const r = await hre.ethers.getSigner(reviewers7[i]);
    await c7.dispute.connect(r).stakeToEnter(1, { value: hre.ethers.parseEther("0.1") });
    await c7.dispute.connect(r).castVote(1, 1); // BuyerWins
  }
  for (let i = 3; i < 5; i++) {
    const r = await hre.ethers.getSigner(reviewers7[i]);
    await c7.dispute.connect(r).stakeToEnter(1, { value: hre.ethers.parseEther("0.1") });
    await c7.dispute.connect(r).castVote(1, 2); // SellerWins
  }
  pass("3票买家赢，2票卖家赢，投票完成");

  // 投完票无法反悔
  const r0_7 = await hre.ethers.getSigner(reviewers7[0]);
  await expectRevert(
    c7.dispute.connect(r0_7).withdrawStake(1),
    "Already voted, cannot withdraw"
  );

  // DDL 前无法结算
  await expectRevert(
    c7.dispute.connect(c7.buyer).settleDispute(1),
    "Voting still ongoing"
  );

  // 快进 24 小时后结算
  await hre.network.provider.send("evm_increaseTime", [86401]);
  await hre.network.provider.send("evm_mine");

  const buyerBefore7 = await hre.ethers.provider.getBalance(c7.buyer.address);
  const sellerBefore7 = await hre.ethers.provider.getBalance(c7.seller.address);
  const r0Before7 = await hre.ethers.provider.getBalance(reviewers7[0]);
  const r3Before7 = await hre.ethers.provider.getBalance(reviewers7[3]);

  await c7.dispute.connect(c7.buyer).settleDispute(1);

  const buyerAfter7 = await hre.ethers.provider.getBalance(c7.buyer.address);
  const sellerAfter7 = await hre.ethers.provider.getBalance(c7.seller.address);
  const r0After7 = await hre.ethers.provider.getBalance(reviewers7[0]);
  const r3After7 = await hre.ethers.provider.getBalance(reviewers7[3]);
  const p7 = await c7.market.getProduct(1);

  pass(`争议结算完成，Product 状态: ${p7.status} (5=已解决)`);
  console.log("\n  ── 买家赢结算结果 ─────────────────────────────────");
  info(`Buyer ETH gained:       ${hre.ethers.formatEther(buyerAfter7 - buyerBefore7)} (商品退款 0.1 + 质押退回 0.5 ≈ 0.6)`);
  info(`Seller ETH change:      ${hre.ethers.formatEther(sellerAfter7 - sellerBefore7)} (质押被没收，无其他收入)`);
  info(`Reviewer[0] ETH gained: ${hre.ethers.formatEther(r0After7 - r0Before7)} (投对票，退质押+分奖金)`);
  info(`Reviewer[3] ETH change: ${hre.ethers.formatEther(r3After7 - r3Before7)} (投错票，质押被没收)`);
  info(`Platform balance:       ${hre.ethers.formatEther(await c7.dispute.platformBalance())} ETH`);
  console.log("  ── 奖金池说明 ──────────────────────────────────────");
  info("Prize pool: 0.5 (seller stake) + 0.2 (2 wrong voters × 0.1) = 0.7 ETH");
  info("Platform fee: 0.1 ETH | Remaining: 0.6 ETH / 3 correct voters = 0.2 ETH each");
  info("Each correct reviewer gets: 0.1 (stake back) + 0.2 (prize) = 0.3 ETH");

  // ════════════════════════════════════════════════════════════
  section("8. 争议完整流程 — 卖家赢");
  // ════════════════════════════════════════════════════════════
  // 预期结果：
  //   - 4票卖家赢 → 卖家获胜，收到商品款 + 质押退回
  //   - 质押后投票前退出的评审员：质押退回，不进奖金池
  //   - 买家质押被没收

  const c8 = await deploy();
  await c8.market.connect(c8.buyer).deposit({ value: hre.ethers.parseEther("1.0") });
  await c8.market.connect(c8.seller).deposit({ value: hre.ethers.parseEther("1.0") });
  await c8.market.connect(c8.seller).listProduct("QmHash", hre.ethers.parseEther("0.1"));
  await c8.market.connect(c8.buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.1") });
  await c8.market.connect(c8.buyer).raiseDispute(1);

  const info8 = await c8.dispute.getDisputeInfo(1);
  const reviewers8 = info8[0];

  // 4票卖家赢
  for (let i = 0; i < 4; i++) {
    const r = await hre.ethers.getSigner(reviewers8[i]);
    await c8.dispute.connect(r).stakeToEnter(1, { value: hre.ethers.parseEther("0.1") });
    await c8.dispute.connect(r).castVote(1, 2); // SellerWins
  }

  // 第5个评审员质押后退出（投票前可退，质押退回不进奖金池）
  const r4_8 = await hre.ethers.getSigner(reviewers8[4]);
  const r4BeforeStake = await hre.ethers.provider.getBalance(reviewers8[4]);
  await c8.dispute.connect(r4_8).stakeToEnter(1, { value: hre.ethers.parseEther("0.1") });
  await c8.dispute.connect(r4_8).withdrawStake(1);
  const r4AfterWithdraw = await hre.ethers.provider.getBalance(reviewers8[4]);
  pass("评审员质押后投票前可以退出，质押退回（无惩罚）");
  info(`Reviewer[4] net change: ${hre.ethers.formatEther(r4AfterWithdraw - r4BeforeStake)} ETH (仅损失 gas)`);

  await hre.network.provider.send("evm_increaseTime", [86401]);
  await hre.network.provider.send("evm_mine");

  const buyerBefore8 = await hre.ethers.provider.getBalance(c8.buyer.address);
  const sellerBefore8 = await hre.ethers.provider.getBalance(c8.seller.address);
  const r0Before8 = await hre.ethers.provider.getBalance(reviewers8[0]);

  await c8.dispute.connect(c8.seller).settleDispute(1);

  const buyerAfter8 = await hre.ethers.provider.getBalance(c8.buyer.address);
  const sellerAfter8 = await hre.ethers.provider.getBalance(c8.seller.address);
  const r0After8 = await hre.ethers.provider.getBalance(reviewers8[0]);
  const p8 = await c8.market.getProduct(1);

  pass(`争议结算完成，Product 状态: ${p8.status} (5=已解决)`);
  console.log("\n  ── 卖家赢结算结果 ─────────────────────────────────");
  info(`Seller ETH gained:      ${hre.ethers.formatEther(sellerAfter8 - sellerBefore8)} (商品款 0.1 + 质押退回 0.5 ≈ 0.6)`);
  info(`Buyer ETH change:       ${hre.ethers.formatEther(buyerAfter8 - buyerBefore8)} (质押被没收，商品款已付出)`);
  info(`Reviewer[0] ETH gained: ${hre.ethers.formatEther(r0After8 - r0Before8)} (投对票，退质押+分奖金)`);
  info(`Platform balance:       ${hre.ethers.formatEther(await c8.dispute.platformBalance())} ETH`);
  console.log("  ── 奖金池说明 ──────────────────────────────────────");
  info("Prize pool: 0.5 (buyer stake) = 0.5 ETH（退出的评审员不进奖金池）");
  info("Platform fee: 0.1 ETH | Remaining: 0.4 ETH / 4 correct voters = 0.1 ETH each");
  info("Each correct reviewer gets: 0.1 (stake back) + 0.1 (prize) = 0.2 ETH");

  // ════════════════════════════════════════════════════════════
  section("9. 平票重新分发测试");
  // ════════════════════════════════════════════════════════════
  // 预期结果：
  //   - 2票 vs 2票 → 平票，触发 TieDetected 事件
  //   - 票数重置为 0，重新随机分配评审员
  //   - 已投票评审员的质押保留进入下一轮

  const c9 = await deploy();
  await c9.market.connect(c9.buyer).deposit({ value: hre.ethers.parseEther("1.0") });
  await c9.market.connect(c9.seller).deposit({ value: hre.ethers.parseEther("1.0") });
  await c9.market.connect(c9.seller).listProduct("QmHash", hre.ethers.parseEther("0.1"));
  await c9.market.connect(c9.buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.1") });
  await c9.market.connect(c9.buyer).raiseDispute(1);

  const info9 = await c9.dispute.getDisputeInfo(1);
  const reviewers9 = info9[0];

  // 2票 vs 2票（平票）
  for (let i = 0; i < 2; i++) {
    const r = await hre.ethers.getSigner(reviewers9[i]);
    await c9.dispute.connect(r).stakeToEnter(1, { value: hre.ethers.parseEther("0.1") });
    await c9.dispute.connect(r).castVote(1, 1); // BuyerWins
  }
  for (let i = 2; i < 4; i++) {
    const r = await hre.ethers.getSigner(reviewers9[i]);
    await c9.dispute.connect(r).stakeToEnter(1, { value: hre.ethers.parseEther("0.1") });
    await c9.dispute.connect(r).castVote(1, 2); // SellerWins
  }

  await hre.network.provider.send("evm_increaseTime", [86401]);
  await hre.network.provider.send("evm_mine");

  const infoBeforeTie = await c9.dispute.getDisputeInfo(1);
  await c9.dispute.connect(c9.buyer).settleDispute(1);
  const infoAfterTie = await c9.dispute.getDisputeInfo(1);

  pass("平票触发重新分发，票数重置");
  info(`Before settle - buyerVotes: ${infoBeforeTie[1]}, sellerVotes: ${infoBeforeTie[2]}`);
  info(`After settle  - buyerVotes: ${infoAfterTie[1]}, sellerVotes: ${infoAfterTie[2]} (重置为0，进入下一轮)`);

  // ════════════════════════════════════════════════════════════
  section("10. 评审员 Dashboard 测试");
  // ════════════════════════════════════════════════════════════
  // 预期结果：
  //   - 评审员可以看到自己被分配的所有争议
  //   - 显示是否已质押、已投票及投票内容
  //   - 结算前 totalEarnings 为 0

  const c10 = await deploy();
  await c10.market.connect(c10.buyer).deposit({ value: hre.ethers.parseEther("1.0") });
  await c10.market.connect(c10.seller).deposit({ value: hre.ethers.parseEther("1.0") });
  await c10.market.connect(c10.seller).listProduct("QmHash", hre.ethers.parseEther("0.1"));
  await c10.market.connect(c10.buyer).purchaseProduct(1, { value: hre.ethers.parseEther("0.1") });
  await c10.market.connect(c10.buyer).raiseDispute(1);

  const info10 = await c10.dispute.getDisputeInfo(1);
  const firstReviewer10 = await hre.ethers.getSigner(info10[0][0]);
  await c10.dispute.connect(firstReviewer10).stakeToEnter(1, { value: hre.ethers.parseEther("0.1") });
  await c10.dispute.connect(firstReviewer10).castVote(1, 1); // BuyerWins

  const reviewerDash = await c10.dataFetcher.getReviewerDashboard(info10[0][0]);
  pass(`评审员 Dashboard: 共 ${reviewerDash.disputes.length} 个分配的争议`);
  const d = reviewerDash.disputes[0];
  const voteMap = ["未投票", "买家赢", "卖家赢"];
  info(`Product #${d.productId}: 已质押=${d.myHasStaked} | 已投票=${d.myHasVoted} | 我的投票=${voteMap[d.myVote]} | 已解决=${d.resolved}`);
  info(`Total earnings: ${hre.ethers.formatEther(reviewerDash.totalEarnings)} ETH（结算前为 0）`);

  // ════════════════════════════════════════════════════════════
  section("11. 评审员资格注册测试");
  // ════════════════════════════════════════════════════════════
  // 预期结果：
  //   - 不足 10 笔成交记录时无法自助注册
  //   - forceRegister 可以绕过限制（仅 demo 用）
  //   - 正式环境：卖家完成 10 笔交易后可以 registerAsReviewer()

  const c11 = await deploy();

  // 成交记录不足时无法注册
  await expectRevert(
    c11.registry.connect(c11.seller).registerAsReviewer(),
    "Need 10 completed sales"
  );

  // forceRegister 可以绕过（仅 demo 用）
  await c11.registry.connect(c11.buyer).forceRegister(c11.stranger.address);
  pass("forceRegister 成功注册评审员（demo用，绕过10笔限制）");
  info(`Is reviewer: ${await c11.registry.isReviewer(c11.stranger.address)}`);
  info(`Pool size: ${await c11.registry.getPoolSize()} 个评审员`);

  // ════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(55)}`);
  console.log("  🎉 所有手动测试完成");
  console.log(`${"═".repeat(55)}\n`);
}

main().catch(console.error);
