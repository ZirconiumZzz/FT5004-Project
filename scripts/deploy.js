const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const Market = await hre.ethers.getContractFactory("ProductMarket");
  const market = await Market.deploy(hre.ethers.ZeroAddress);
  await market.waitForDeployment();
  console.log("ProductMarket:   ", await market.getAddress());

  const Registry = await hre.ethers.getContractFactory("ReviewerRegistry");
  const registry = await Registry.deploy(await market.getAddress());
  await registry.waitForDeployment();
  console.log("ReviewerRegistry:", await registry.getAddress());

  await market.setRegistry(await registry.getAddress());
  await registry.setMarketContract(await market.getAddress());

  const Dispute = await hre.ethers.getContractFactory("DisputeManager");
  const dispute = await Dispute.deploy(
    await registry.getAddress(),
    await market.getAddress()
  );
  await dispute.waitForDeployment();
  console.log("DisputeManager:  ", await dispute.getAddress());

  await market.setDisputeManager(await dispute.getAddress());

  const DataFetcher = await hre.ethers.getContractFactory("DataFetcher");
  const dataFetcher = await DataFetcher.deploy(
    await market.getAddress(),
    await dispute.getAddress()
  );
  await dataFetcher.waitForDeployment();
  console.log("DataFetcher:     ", await dataFetcher.getAddress());

  console.log("\n--- All contracts deployed and linked ---");
}

main().catch(console.error);