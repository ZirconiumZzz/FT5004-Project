# DeTrust Market

> Trustless B2B procurement for semiconductor components — smart contract escrow, on-chain dispute resolution, and industry-expert arbitration.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Smart Contracts](#smart-contracts)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation & Local Setup](#installation--local-setup)
- [Usage Guide](#usage-guide)
- [Contract Constants](#contract-constants)
- [Project Structure](#project-structure)
- [Known Limitations](#known-limitations)

---

## Overview

DeTrust Market is a decentralised application (DApp) for high-value B2B semiconductor component trading. It automates the full transaction lifecycle — listing, escrow payment, shipment verification, receipt confirmation, and dispute arbitration — entirely through smart contracts on Ethereum.

The platform is built for the semiconductor spot market, where counterfeit components and payment disputes are costly and common. By removing the need for a trusted intermediary, DeTrust Market ensures that funds are released only when contractually defined conditions are met, and that disputes are resolved by verified industry experts rather than a central authority.

---

## Architecture

The system comprises four Solidity contracts with clearly separated responsibilities:

```
┌─────────────────────────────────────────────────────────────┐
│                        React Frontend                       │
│              (ethers.js v6 + MetaMask / EIP-1193)           │
└───────────┬──────────────┬───────────────────────────────┬──┘
            │              │                               │
            ▼              ▼                               ▼
   ┌──────────────┐  ┌───────────┐                ┌──────────────────┐
   │ ProductMarket│  │DataFetcher│                │ ReviewerRegistry │
   │  (ETH vault) │  │           │                │  (juror pool)    │
   └──────┬───────┘  └───────────┘                └────────┬─────────┘
          │  raiseDispute / resolveByDispute               │ selectReviewers
          ▼                                                │
   ┌──────────────────────────────────────┐                │
   │           DisputeManager             │◄───────────────┘
   │  (voting logic, stake accounting)    │
   └──────────────────────────────────────┘
```

**Key design principle — consolidated ETH custody:** All ETH remains physically locked inside `ProductMarket` at all times. `DisputeManager` issues accounting callbacks (`rewardJuror`, `refundStake`, `creditPlatformFee`) to update balances without moving ETH between contracts. This eliminates cross-contract reentrancy risk during dispute resolution.

**Conservation invariant:**
```
sum(depositBalance) + sum(walletBalance) + platformBalance == address(ProductMarket).balance
```

---

## Smart Contracts

### ProductMarket.sol
The primary coordination layer and sole ETH custodian. Manages the full product lifecycle and the two-balance model per user:
- `depositBalance` — mandatory security bond (≥ 1 ETH required to list or purchase)
- `walletBalance` — active trading wallet used for purchases and juror staking

Key functions: `listProduct`, `purchaseProduct`, `confirmShipment`, `confirmReceipt`, `raiseDispute`, `resolveByDispute`

### DisputeManager.sol
Handles the complete arbitration lifecycle once a dispute is raised:
1. Selects 5 arbitrators randomly from the reviewer pool (excluding buyer/seller)
2. Opens a 24-hour voting window
3. Auto-finalizes once 3 votes are cast (early finalization)
4. Distributes the prize pool: losing party's 0.5 ETH stake + slashed incorrect juror stakes − platform fee, shared equally among majority jurors
5. On a tie: resets votes and assigns a fresh 5-member panel for a new round

Key functions: `openDispute`, `stakeToEnter`, `withdrawStake`, `castVote`, `settleDispute`

### ReviewerRegistry.sol
Maintains the pool of qualified arbitrators. Production registration requires ≥ 10 completed verified trades. `forceRegister()` bypasses this requirement for testing.

Key functions: `registerAsReviewer`, `forceRegister`, `selectReviewers`, `recordSale`

### DataFetcher.sol
Read-only aggregation contract designed to reduce frontend RPC round-trips by batching multi-contract data into a single view call per dashboard. The current frontend achieves equivalent functionality via concurrent `Promise.all` calls; DataFetcher is available as a drop-in optimization for production deployment where RPC call volume becomes a bottleneck.

Key functions: `getStorefront`, `getBuyerDashboard`, `getSellerDashboard`, `getReviewerDashboard`

---

## Features

### Buyer
- Browse all listed semiconductor components with full technical specifications (part number, brand, condition, quantity, origin/lot)
- Purchase components using the in-app wallet (no ETH sent per transaction — deducted from pre-deposited wallet balance)
- Confirm receipt to release payment to seller
- Raise a dispute if components are not as described (available from Pending Shipment or Shipped status)
- View dispute outcome (win/loss) with ETH settlement details

### Seller
- List components with structured metadata: name, part number, brand, condition, quantity, origin/lot
- Confirm shipment with a tracking reference stored on-chain
- Raise a dispute (available from Sold or Shipped status)
- View dispute outcome with ETH settlement details

### Arbitrator
- Register as an arbitrator by accepting the Code of Conduct (`forceRegister` in demo mode)
- View all dispute cases assigned by the system
- Stake 0.1 ETH to join a case and unlock voting rights
- Vote to side with buyer or seller
- Exit a case before voting to reclaim stake
- View juror result (correct/incorrect vote, stake returned or forfeited)

### Account Management (Wallet Modal)
- Top up in-app trading wallet (any amount)
- Withdraw from trading wallet
- Top up security deposit (fixed 1 ETH increments)
- Live balance display in the navbar for both wallet and deposit

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [npm](https://www.npmjs.com/) v9 or later
- [MetaMask](https://metamask.io/) browser extension
- [Hardhat](https://hardhat.org/) (for local blockchain)

---

## Installation & Local Setup

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd FT5004-PROJECT
```

### 2. Install root dependencies (Hardhat)

```bash
npm install
```

### 3. Install frontend dependencies

```bash
cd frontend
npm install
```

### 4. Start a local Hardhat node

From the project root:

```bash
npx hardhat node
```

This starts a local Ethereum network at `http://127.0.0.1:8545` and prints 20 funded test accounts. Keep this terminal running.

### 5. Deploy the contracts

In a new terminal, from the project root:

```bash
npx hardhat run scripts/deploy.js --network localhost
```

The deployment script deploys contracts in the required order (due to constructor dependencies):

```
ReviewerRegistry → ProductMarket → DisputeManager → DataFetcher
```

And then calls:
- `ProductMarket.setDisputeManager(disputeManagerAddress)`
- `ReviewerRegistry.setMarketContract(productMarketAddress)`

Confirm the deployed addresses match those in `frontend/src/App.tsx`:

```typescript
const ADDRESSES = {
  MARKET:   "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  REGISTRY: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  DISPUTE:  "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
};
```

> These addresses are deterministic on a fresh Hardhat node. If you restart the node, redeploy and the addresses will match automatically.

### 6. Configure MetaMask

Add the local Hardhat network to MetaMask:

| Field | Value |
|---|---|
| Network Name | Hardhat Localhost |
| RPC URL | http://127.0.0.1:8545 |
| Chain ID | 31337 |
| Currency Symbol | ETH |

Import test accounts using the private keys printed by `npx hardhat node`. You will need at least 7 accounts to run the full dispute flow: 1 seller, 1 buyer, and 5 arbitrators.

### 7. Start the frontend

```bash
cd frontend
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Usage Guide

### Full demo flow

**Account A — Seller**
1. Connect wallet → click the wallet badge → Top Up Security Deposit (1 ETH)
2. Go to Seller Portal → fill in component details → List Component
3. After a buyer purchases, enter a tracking reference and click Confirm Shipment

**Account B — Buyer**
1. Connect wallet → Top Up Security Deposit (1 ETH) → Top Up In-App Wallet (enough to cover the item price)
2. Go to Marketplace → Purchase the listed component
3. After shipment: either click Confirm Receipt (releases payment to seller) or Raise Dispute

**Accounts C–G — Arbitrators (5 accounts, dispute flow only)**
1. Connect wallet → Top Up In-App Wallet (at least 0.1 ETH for juror stake)
2. Go to Arbitration → Apply as Arbitrator → accept the Code of Conduct → Confirm & Register
3. Once a dispute is open and you are assigned: Stake 0.1 ETH to Join → vote Side with Buyer or Side with Seller
4. After 3 votes are cast, the case resolves automatically

### Dispute settlement logic

| Outcome | Buyer receives | Seller receives |
|---|---|---|
| Buyer wins | price refund + 0.5 ETH deposit returned | 0.5 ETH deposit forfeited |
| Seller wins | 0.5 ETH deposit forfeited | price paid out + 0.5 ETH deposit returned |

Majority jurors recover their 0.1 ETH stake plus a share of the prize pool. Minority jurors forfeit their stake into the prize pool. A platform fee of 0.1 ETH is deducted from the prize pool before distribution.

---

## Contract Constants

| Constant | Value | Description |
|---|---|---|
| `MIN_DEPOSIT` | 1 ETH | Minimum security deposit to list or purchase |
| `DISPUTE_STAKE` | 0.5 ETH | Frozen from each party when a dispute is raised |
| `REVIEWER_COUNT` | 5 | Arbitrators assigned per dispute |
| `REVIEWER_STAKE` | 0.1 ETH | Juror stake required to enter a case |
| `PLATFORM_FEE` | 0.1 ETH | Deducted from prize pool per resolved dispute |
| `VOTING_PERIOD` | 1 day | Deadline before `settleDispute()` can be called |

---

## Project Structure

```
FT5004-PROJECT/
├── contracts/
│   ├── ProductMarket.sol        # Core marketplace and ETH vault
│   ├── DisputeManager.sol       # Arbitration logic and stake accounting
│   ├── ReviewerRegistry.sol     # Arbitrator pool and eligibility
│   └── DataFetcher.sol          # Read-only data aggregation helper
├── frontend/
│   ├── src/
│   │   ├── abis/                # Contract ABI JSON files (generated by Hardhat)
│   │   │   ├── ProductMarket.json
│   │   │   ├── DisputeManager.json
│   │   │   ├── ReviewerRegistry.json
│   │   │   └── DataFetcher.json
│   │   ├── App.tsx              # Main React application (all UI and contract logic)
│   │   ├── index.css            # Global styles and design tokens
│   │   └── main.tsx             # React entry point
│   ├── public/
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
├── scripts/
│   ├── deploy.js                # Hardhat deployment script
│   └── manualTest.js            # Manual interaction helpers
├── test/
│   └── ProductMarket_test.js    # Automated contract test suite
├── hardhat.config.js
├── package.json
└── README.md
```

---

## Known Limitations

- **Linear product scan** — `getListedProducts()` and related view functions iterate over all product IDs. Gas cost scales linearly with total product count. Acceptable for demonstration; a production deployment would use indexed mappings.
- **Block-based randomness** — `selectReviewers()` uses `block.timestamp` and `block.prevrandao` as entropy sources. This is sufficient for a prototype but not adversarially secure; a production system would use Chainlink VRF.
- **`forceRegister()` is unrestricted** — Any address can bypass the 10-sale requirement. This function exists for testing and demonstration only and should be removed or access-controlled before any production deployment.
- **Dispute reasons stored in React state** — The reason a party raises a dispute is stored client-side only and is lost on page refresh. A production implementation would emit it as an on-chain event or store it on IPFS.
