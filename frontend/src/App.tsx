import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useNavigate, useLocation } from 'react-router-dom';
import { ethers } from 'ethers';
import {
  ShoppingBag, Wallet, ShieldCheck, Truck, Package, Scale, User,
  PlusCircle, History, AlertCircle, CheckCircle2, Send, ChevronRight,
  ArrowRight, Lock, Gavel, TrendingUp, Clock, Star, ChevronDown
} from 'lucide-react';

import ProductMarketABI from './abis/ProductMarket.json';
import DataFetcherABI from './abis/DataFetcher.json';
import ReviewerRegistryABI from './abis/ReviewerRegistry.json';
import DisputeManagerABI from './abis/DisputeManager.json';

const ADDRESSES = {
  MARKET: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  FETCHER: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
  REGISTRY: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  DISPUTE: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9"
};

const STATUS_MAP: any = {
  0: { label: "Listed", color: "status-active" },
  1: { label: "Pending Shipment", color: "status-pending" },
  2: { label: "Shipped", color: "status-shipped" },
  3: { label: "Completed", color: "status-success" },
  4: { label: "In Dispute", color: "status-dispute" },
  5: { label: "Closed", color: "status-closed" }
};

const safeParseProduct = (p: any) => {
  if (!p) return null;
  try {
    const id = (p.id || p[0])?.toString();
    if (!id) return null;
    return {
      id,
      seller: (p.seller || p[1]) || "",
      buyer: (p.buyer || p[2]) || "",
      ipfsHash: (p.ipfsHash || p[3]) || "Unknown Item",
      price: p.price ? BigInt(p.price.toString()) : (p[5] ? BigInt(p[5].toString()) : 0n),
      status: Number(p.status ?? p[7] ?? 0)
    };
  } catch (e) {
    return null;
  }
};

// ─── Wallet Modal ──────────────────────────────────────────────────────────────
const WalletModal = ({ wallet, deposit, onWalletDeposit, onWalletWithdraw, onDepositSeller, onClose }: any) => {
  const [amount, setAmount] = useState("");
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Account Overview</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-balances">
          <div className="modal-balance-item">
            <span className="modal-balance-label">In-App Wallet</span>
            <span className="modal-balance-value">{wallet} ETH</span>
            <span className="modal-balance-desc">Used for purchases & juror staking</span>
          </div>
          <div className="modal-balance-item">
            <span className="modal-balance-label">Security Deposit</span>
            <span className="modal-balance-value">{deposit} ETH</span>
            <span className="modal-balance-desc">Requires ≥ 1 ETH to trade; 0.5 ETH held during disputes</span>
          </div>
        </div>

        <div className="modal-section">
          <label className="modal-label">Amount (ETH)</label>
          <input
            className="form-input"
            type="number"
            placeholder="0.5"
            value={amount}
            onChange={e => setAmount(e.target.value)}
          />
        </div>

        <div className="modal-actions">
          <button className="btn-primary" onClick={() => { onWalletDeposit(amount); onClose(); }}>
            Top Up In-App Wallet
          </button>
          <button className="btn-outline" onClick={() => { onWalletWithdraw(amount); onClose(); }}>
            Withdraw from Wallet
          </button>
          <button className="btn-ghost" onClick={() => { onDepositSeller(); onClose(); }}>
            Top Up Security Deposit (1 ETH)
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Navbar ───────────────────────────────────────────────────────────────────
const Navbar = ({ account, deposit, wallet, connect, onDeposit, onWalletDeposit, onWalletWithdraw }: any) => {
  const location = useLocation();
  const [showWallet, setShowWallet] = useState(false);

  return (
    <>
      <nav className="navbar">
        <div className="navbar-inner">
          <Link to="/" className="navbar-brand">
            <div className="brand-icon">
              <ShieldCheck size={16} />
            </div>
            <span>DeTrust</span>
          </Link>

          <div className="navbar-links">
            {account && (
              <>
                <Link to="/buyer/market" className={`nav-link ${location.pathname.startsWith('/buyer') ? 'active' : ''}`}>
                  Market
                </Link>
                <Link to="/seller/listings" className={`nav-link ${location.pathname.startsWith('/seller') ? 'active' : ''}`}>
                  Seller
                </Link>
                <Link to="/arbitrator/pool" className={`nav-link ${location.pathname.startsWith('/arbitrator') ? 'active' : ''}`}>
                  Arbitration
                </Link>
              </>
            )}
          </div>

          <div className="navbar-actions">
            {account && (
              <button className="wallet-badge" onClick={() => setShowWallet(true)}>
                <div className="wallet-badge-row">
                  <span className="wallet-badge-item">
                    <span className="wallet-badge-label">Wallet</span>
                    <span className="wallet-badge-value">{wallet} ETH</span>
                  </span>
                  <span className="wallet-badge-divider" />
                  <span className="wallet-badge-item">
                    <span className="wallet-badge-label">Deposit</span>
                    <span className="wallet-badge-value deposit">{deposit} ETH</span>
                  </span>
                </div>
              </button>
            )}
            <button className="btn-connect" onClick={connect}>
              <Wallet size={14} />
              {account ? `${account.slice(0, 6)}···${account.slice(-4)}` : 'Connect Wallet'}
            </button>
          </div>
        </div>
      </nav>
      {showWallet && (
        <WalletModal
          wallet={wallet}
          deposit={deposit}
          onWalletDeposit={onWalletDeposit}
          onWalletWithdraw={onWalletWithdraw}
          onDepositSeller={onDeposit}
          onClose={() => setShowWallet(false)}
        />
      )}
    </>
  );
};

// ─── Landing / Role Select ─────────────────────────────────────────────────────
const RoleSelectPage = ({ account, connect }: any) => {
  const navigate = useNavigate();

  if (!account) return (
    <div className="landing">
      <div className="landing-bg">
        <div className="grid-overlay" />
        <div className="orb orb-1" />
        <div className="orb orb-2" />
      </div>
      <div className="landing-content">
        <div className="landing-badge">
          <ShieldCheck size={12} />
          <span>Smart Contract Escrow · Decentralized Arbitration</span>
        </div>
        <h1 className="landing-title">
          De<span className="title-accent">Trust</span>
        </h1>
        <p className="landing-subtitle">Decentralized Digital Escrow & Dispute Resolution</p>
        <p className="landing-desc">All funds held in smart contracts. Disputes resolved by community arbitration.</p>
        <button className="btn-primary btn-lg" onClick={connect}>
          <Wallet size={18} />
          Connect Wallet
          <ArrowRight size={16} />
        </button>

        <div className="landing-stats">
          <div className="stat-item">
            <span className="stat-num">100%</span>
            <span className="stat-label">On-Chain Escrow</span>
          </div>
          <div className="stat-divider" />
          <div className="stat-item">
            <span className="stat-num">DAO</span>
            <span className="stat-label">Community Arbitration</span>
          </div>
          <div className="stat-divider" />
          <div className="stat-item">
            <span className="stat-num">Trustless</span>
            <span className="stat-label">No Intermediaries</span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="page-container">
      <div className="page-header">
        <p className="page-eyebrow">Welcome back</p>
        <h2 className="page-title">Select Your Role</h2>
        <p className="page-desc">{account.slice(0, 8)}···{account.slice(-6)}</p>
      </div>
      <div className="role-grid">
        <button className="role-card" onClick={() => navigate('/buyer/market')}>
          <div className="role-icon role-icon-blue">
            <ShoppingBag size={28} />
          </div>
          <h3 className="role-name">Buyer</h3>
          <p className="role-desc">Browse listings, purchase items, confirm delivery or raise a dispute</p>
          <div className="role-arrow"><ArrowRight size={16} /></div>
        </button>
        <button className="role-card" onClick={() => navigate('/seller/listings')}>
          <div className="role-icon role-icon-teal">
            <Package size={28} />
          </div>
          <h3 className="role-name">Seller</h3>
          <p className="role-desc">List products, manage orders, confirm shipment</p>
          <div className="role-arrow"><ArrowRight size={16} /></div>
        </button>
        <button className="role-card" onClick={() => navigate('/arbitrator/pool')}>
          <div className="role-icon role-icon-gold">
            <Scale size={28} />
          </div>
          <h3 className="role-name">Arbitrator</h3>
          <p className="role-desc">Review disputes, cast votes, earn rewards</p>
          <div className="role-arrow"><ArrowRight size={16} /></div>
        </button>
      </div>
    </div>
  );
};

// ─── Buyer Market ──────────────────────────────────────────────────────────────
const BuyerMarket = ({ products, onBuy }: any) => {
  const forSale = products.filter((p: any) => p.status === 0);
  return (
    <div className="page-container">
      <div className="page-header-row">
        <div>
          <p className="page-eyebrow">Marketplace</p>
          <h2 className="page-title">Active Listings</h2>
        </div>
        <Link to="/buyer/orders" className="btn-ghost">
          My Orders <ArrowRight size={14} />
        </Link>
      </div>

      {forSale.length === 0 ? (
        <div className="empty-state">
          <Package size={40} />
          <p>No listings available</p>
        </div>
      ) : (
        <div className="product-grid">
          {forSale.map((p: any) => (
            <div key={p.id} className="product-card">
              <div className="product-thumb">
                <span>🛒</span>
                <span className="product-id">#{p.id}</span>
              </div>
              <div className="product-info">
                <h4 className="product-name">{p.ipfsHash}</h4>
                <p className="product-seller">{p.seller.slice(0, 10)}···</p>
              </div>
              <div className="product-footer">
                <span className="product-price">{ethers.formatEther(p.price)} ETH</span>
                <button className="btn-primary btn-sm" onClick={() => onBuy(p.id, p.price)}>
                  Buy Now
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Dispute Modal ────────────────────────────────────────────────────────────
const DisputeModal = ({ order, onSubmit, onClose }: any) => {
  const [reason, setReason] = useState("");
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Raise a Dispute</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="dispute-modal-product">
          <div className="dispute-modal-row">
            <span className="modal-balance-label">Item</span>
            <span className="dispute-modal-value">#{order.id} · {order.ipfsHash}</span>
          </div>
          <div className="dispute-modal-row">
            <span className="modal-balance-label">Value</span>
            <span className="dispute-modal-value">{ethers.formatEther(order.price)} ETH</span>
          </div>
          <div className="dispute-modal-row">
            <span className="modal-balance-label">Status</span>
            <span className={`status-badge ${STATUS_MAP[order.status]?.color}`}>{STATUS_MAP[order.status]?.label}</span>
          </div>
        </div>
        <div className="modal-section">
          <label className="modal-label">Reason for Dispute (visible to arbitrators)</label>
          <textarea
            className="form-input form-textarea"
            placeholder="Describe the issue, e.g. item not as described, seller refused to ship, item arrived damaged..."
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={4}
          />
        </div>
        <div className="dispute-modal-warning">
          ⚠️ Raising a dispute will deduct 0.5 ETH from each party's security deposit
        </div>
        <div className="modal-actions">
          <button className="btn-danger" style={{width:'100%', justifyContent:'center', padding:'12px'}}
            onClick={() => { onSubmit(order.id, reason); onClose(); }}>
            <AlertCircle size={16} /> Confirm Dispute
          </button>
          <button className="btn-ghost" style={{width:'100%', justifyContent:'center', padding:'12px'}} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Buyer Orders ──────────────────────────────────────────────────────────────
const BuyerOrders = ({ orders, onConfirm, onDispute }: any) => {
  const [disputeTarget, setDisputeTarget] = useState<any>(null);
  return (
    <div className="page-container">
      <div className="page-header">
        <p className="page-eyebrow">Buyer Dashboard</p>
        <h2 className="page-title">My Orders</h2>
      </div>

      {orders.length === 0 ? (
        <div className="empty-state">
          <ShoppingBag size={40} />
          <p>No orders yet</p>
        </div>
      ) : (
        <div className="order-list">
          {orders.map((o: any) => (
            <div key={o.id} className="order-card">
              <div className="order-left">
                <div className="order-icon"><ShoppingBag size={18} /></div>
                <div>
                  <div className="order-meta">
                    <span className={`status-badge ${STATUS_MAP[o.status]?.color}`}>
                      {STATUS_MAP[o.status]?.label}
                    </span>
                    <span className="order-id">#{o.id}</span>
                    {o.disputeResolved && (
                      <span className={`status-badge ${o.iWon ? 'status-success' : 'status-dispute'}`}>
                        {o.iWon ? '⚖️ Dispute Won' : '⚖️ Dispute Lost'}
                      </span>
                    )}
                  </div>
                  <h4 className="order-name">{o.ipfsHash}</h4>
                  <p className="order-seller">Seller: {o.seller.slice(0, 12)}···</p>
                  {o.disputeResolved && (
                    <p className={`dispute-result-text ${o.iWon ? 'result-win' : 'result-lose'}`}>
                      {o.iWon
                        ? `✓ Refund of ${ethers.formatEther(o.price)} ETH returned to your wallet`
                        : `✗ Payment of ${ethers.formatEther(o.price)} ETH awarded to seller, 0.5 ETH security deposit forfeited`}
                    </p>
                  )}
                </div>
              </div>
              <div className="order-actions">
                {o.status === 2 && (
                  <button className="btn-primary btn-sm" onClick={() => onConfirm(o.id)}>
                    <CheckCircle2 size={14} /> Confirm Receipt
                  </button>
                )}
                {(o.status === 1 || o.status === 2) && (
                  <button className="btn-danger btn-sm" onClick={() => setDisputeTarget(o)}>
                    <AlertCircle size={14} /> Raise Dispute
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {disputeTarget && (
        <DisputeModal
          order={disputeTarget}
          onSubmit={onDispute}
          onClose={() => setDisputeTarget(null)}
        />
      )}
    </div>
  );
};

// ─── Seller Listings ───────────────────────────────────────────────────────────
const SellerListings = ({ myProducts, onList, onShip, onDispute }: any) => {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [shipHash, setShipHash] = useState<any>({});
  const [disputeTarget, setDisputeTarget] = useState<any>(null);

  return (
    <div className="page-container">
      <div className="page-header">
        <p className="page-eyebrow">Seller Dashboard</p>
        <h2 className="page-title">Manage Listings</h2>
      </div>

      <div className="form-card">
        <div className="form-card-header">
          <PlusCircle size={18} />
          <h3>Create New Listing</h3>
        </div>
        <div className="form-row">
          <div className="form-field">
            <label>Item Name / Description</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Limited Edition Digital Collectible"
              className="form-input"
            />
          </div>
          <div className="form-field form-field-sm">
            <label>Price (ETH)</label>
            <input
              type="number"
              value={price}
              onChange={e => setPrice(e.target.value)}
              placeholder="0.5"
              className="form-input"
            />
          </div>
          <button className="btn-primary" onClick={() => onList(name, price)}>
            List Item
          </button>
        </div>
      </div>

      <h3 className="section-title">Sales History</h3>
      {myProducts.length === 0 ? (
        <div className="empty-state">
          <Package size={40} />
          <p>No listings yet</p>
        </div>
      ) : (
        <div className="order-list">
          {myProducts.map((p: any) => (
            <div key={p.id} className="order-card">
              <div className="order-left">
                <div className="order-icon"><Package size={18} /></div>
                <div>
                  <div className="order-meta">
                    <span className={`status-badge ${STATUS_MAP[p.status]?.color}`}>
                      {STATUS_MAP[p.status]?.label}
                    </span>
                    <span className="order-id">#{p.id}</span>
                    {p.disputeResolved && (
                      <span className={`status-badge ${p.iWon ? 'status-success' : 'status-dispute'}`}>
                        {p.iWon ? '⚖️ Dispute Won' : '⚖️ Dispute Lost'}
                      </span>
                    )}
                  </div>
                  <h4 className="order-name">{p.ipfsHash}</h4>
                  {p.disputeResolved && (
                    <p className={`dispute-result-text ${p.iWon ? 'result-win' : 'result-lose'}`}>
                      {p.iWon
                        ? `✓ Payment of ${ethers.formatEther(p.price)} ETH received in your wallet`
                        : `✗ Payment of ${ethers.formatEther(p.price)} ETH refunded to buyer, 0.5 ETH security deposit forfeited`}
                    </p>
                  )}
                </div>
              </div>
              <div className="order-actions">
                {p.status === 1 && (
                  <>
                    <input
                      placeholder="Tracking number"
                      className="form-input form-input-sm"
                      onChange={e => setShipHash({ ...shipHash, [p.id]: e.target.value })}
                    />
                    <button className="btn-primary btn-sm" onClick={() => onShip(p.id, shipHash[p.id] || "SENT")}>
                      <Send size={14} /> Confirm Shipment
                    </button>
                  </>
                )}
                {(p.status === 1 || p.status === 2) && (
                  <button className="btn-danger btn-sm" onClick={() => setDisputeTarget(p)}>
                    <AlertCircle size={14} /> Raise Dispute
                  </button>
                )}
                {p.status !== 1 && p.status !== 2 && (
                  <span className="price-tag">{ethers.formatEther(p.price)} ETH</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {disputeTarget && (
        <DisputeModal
          order={disputeTarget}
          onSubmit={onDispute}
          onClose={() => setDisputeTarget(null)}
        />
      )}
    </div>
  );
};

// ─── Arbitrator Pool ───────────────────────────────────────────────────────────
const ArbitratorPool = ({ disputes, isReviewer, onJoin, onVote, onForceRegister, onWithdrawStake, onSettle }: any) => (
  <div className="page-container">
    <div className="page-header-row">
      <div>
        <p className="page-eyebrow">Arbitration Hall</p>
        <h2 className="page-title">Active Cases</h2>
      </div>
      {!isReviewer && (
        <button className="btn-outline" onClick={onForceRegister}>
          <Gavel size={14} /> Apply as Arbitrator
        </button>
      )}
    </div>

    {disputes.length === 0 ? (
      <div className="empty-state">
        <Scale size={40} />
        <p>No dispute cases assigned</p>
      </div>
    ) : (
      <div className="dispute-list">
        {disputes.map((d: any) => {
          const totalVotes = d.buyerVotes + d.sellerVotes;
          const votingClosed = d.resolved || totalVotes >= 3;
          return (
            <div key={d.productId} className="dispute-card">

              <div className="dispute-header">
                <div className="dispute-meta">
                  <span className="dispute-id">Case #{d.productId.toString()}</span>
                  <span className="vote-count">{totalVotes}/3 votes cast</span>
                  {d.resolved && (
                    <span className={`status-badge ${d.buyerWon ? 'status-success' : 'status-pending'}`}>
                      {d.buyerWon ? 'Buyer Prevailed' : 'Seller Prevailed'}
                    </span>
                  )}
                </div>
                <div className="vote-bar">
                  <div className="vote-bar-inner" style={{ width: `${Math.min((totalVotes / 3) * 100, 100)}%` }} />
                </div>
              </div>

              <div className="dispute-info-grid">
                <div className="dispute-info-item">
                  <span className="dispute-info-label">Item in Dispute</span>
                  <span className="dispute-info-value">"{d.ipfsHash}"</span>
                </div>
                <div className="dispute-info-item">
                  <span className="dispute-info-label">Order Status</span>
                  <span className={`status-badge ${STATUS_MAP[d.status]?.color}`}>
                    {STATUS_MAP[d.status]?.label}
                  </span>
                </div>
                {d.disputeReason && (
                  <div className="dispute-info-item dispute-info-full">
                    <span className="dispute-info-label">Dispute Reason</span>
                    <span className="dispute-reason-text">{d.disputeReason}</span>
                  </div>
                )}
              </div>

              <div className="dispute-actions">
                {d.resolved ? (
                  <div className="juror-result-box">
                    <span className="text-muted">This case is closed</span>
                    {d.jurorResult && (
                      <div className={`juror-result-detail ${d.jurorResult.iWon ? 'result-win' : 'result-lose'}`}>
                        <span className="juror-result-verdict">
                          {d.jurorResult.iWon ? '✓ Correct Vote' : '✗ Incorrect Vote'}
                          {' · '}
                          {d.jurorResult.buyerWon ? 'Buyer Prevailed' : 'Seller Prevailed'}
                        </span>
                        <span className="juror-result-amount">
                          {d.jurorResult.iWon
                            ? `+0.1 ETH stake returned + reward`
                            : `-0.1 ETH stake forfeited`}
                        </span>
                      </div>
                    )}
                    {d.resolved && !d.jurorResult && (
                      <span className="text-muted" style={{fontSize:'12px'}}>You did not participate in this case</span>
                    )}
                  </div>
                ) : !d.isStaked ? (
                  !votingClosed ? (
                    <button className="btn-primary btn-sm" onClick={() => onJoin(d.productId)} disabled={!isReviewer}>
                      <Lock size={14} /> Stake 0.1 ETH to Join
                    </button>
                  ) : (
                    <span className="text-muted">Voting has ended</span>
                  )
                ) : (
                  <>
                    {!d.hasVoted && !votingClosed ? (
                      <>
                        <button className="btn-primary btn-sm" onClick={() => onVote(d.productId, 1)}>
                          Side with Buyer
                        </button>
                        <button className="btn-outline btn-sm" onClick={() => onVote(d.productId, 2)}>
                          Side with Seller
                        </button>
                        <button className="btn-ghost btn-sm" onClick={() => onWithdrawStake(d.productId)}
                          title="Exit arbitration and reclaim your 0.1 ETH stake">
                          Exit Case
                        </button>
                      </>
                    ) : d.hasVoted ? (
                      <span className="text-success">✓ Vote submitted — awaiting other arbitrators</span>
                    ) : (
                      <span className="text-muted">Voting has ended</span>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    )}
  </div>
);

// ─── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [account, setAccount] = useState("");
  const [disputeReasons, setDisputeReasons] = useState<Record<string, string>>({});
  const [data, setData] = useState<any>({
    products: [], mySales: [], myOrders: [], myDisputes: [], deposit: "0", wallet: "0", isReviewer: false
  });

  const connectWallet = async () => {
    if (!window.ethereum) return alert("Please install the MetaMask extension");
    try {
      await window.ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(accounts[0]);
    } catch (e) { }
  };

  const loadData = useCallback(async () => {
    if (!window.ethereum || !account) return;
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, provider);
      const disputeManager = new ethers.Contract(ADDRESSES.DISPUTE, DisputeManagerABI.abi, provider);
      const registry = new ethers.Contract(ADDRESSES.REGISTRY, ReviewerRegistryABI.abi, provider);

      const revStatus = await registry.isReviewer(account).catch(() => false);
      const latestId = await market.getLatestProductId().catch(() => 0n);
      const allIds = Array.from({ length: Number(latestId) }, (_, i) => (i + 1).toString());

      const allFetchedProducts = await Promise.all(allIds.map(async (id) => {
        try {
          const p = await market.products(id);
          return safeParseProduct(p);
        } catch (e) { return null; }
      }));
      const validProducts = allFetchedProducts.filter((p): p is any => p !== null && p.id !== "0");

      let activeDisputes: any[] = [];
      if (revStatus) {
        const disputeIds: any[] = await disputeManager.getDisputesByReviewer(account).catch(() => []);
        activeDisputes = (await Promise.all(disputeIds.map(async (id: any) => {
          try {
            const [, buyerVotes, sellerVotes, , resolved, buyerWon] = await disputeManager.getDisputeInfo(id);
            const [hasStaked, hasVoted] = await disputeManager.getReviewerStakeStatus(id, account).catch(() => [false, false]);
            const myVoteRaw = await disputeManager.getReviewerVote(id, account).catch(() => 0);
            const myVote = Number(myVoteRaw);
            const p = await market.getProduct(id).catch(() => null);

            let jurorResult = null;
            if (resolved && myVote !== 0) {
              const winningVote = buyerWon ? 1 : 2;
              const iWon = myVote === winningVote;
              jurorResult = { iWon, myVote, buyerWon };
            }

            return {
              productId: id,
              buyerVotes: Number(buyerVotes),
              sellerVotes: Number(sellerVotes),
              resolved,
              buyerWon,
              isStaked: hasStaked,
              hasVoted,
              myVote,
              jurorResult,
              ipfsHash: p?.ipfsHash || "",
              status: p ? Number(p.status) : 4,
              disputeReason: disputeReasons[id.toString()] || ""
            };
          } catch (e) { return null; }
        }))).filter(Boolean);
      }

      const dep = await market.depositBalance(account).catch(() => 0n);
      const wal = await market.walletBalance(account).catch(() => 0n);

      const enrichWithDisputeResult = async (products: any[]) => {
        return Promise.all(products.map(async (p) => {
          if (p.status === 5) {
            try {
              const [, , , , resolved, buyerWon] = await disputeManager.getDisputeInfo(p.id);
              if (resolved) {
                const isBuyer = p.buyer.toLowerCase() === account.toLowerCase();
                return { ...p, disputeResolved: true, buyerWon, iWon: isBuyer ? buyerWon : !buyerWon };
              }
            } catch (e) {}
          }
          return p;
        }));
      };

      const mySalesRaw = validProducts.filter((p: any) => p.seller.toLowerCase() === account.toLowerCase());
      const myOrdersRaw = validProducts.filter((p: any) => p.buyer.toLowerCase() === account.toLowerCase());
      const [mySales, myOrders] = await Promise.all([
        enrichWithDisputeResult(mySalesRaw),
        enrichWithDisputeResult(myOrdersRaw)
      ]);

      setData((prev: any) => ({
        ...prev,
        products: validProducts,
        mySales,
        myOrders,
        myDisputes: activeDisputes,
        isReviewer: revStatus,
        deposit: ethers.formatEther(dep),
        wallet: ethers.formatEther(wal)
      }));
    } catch (err) { console.error("Failed to load data:", err); }
  }, [account]);

  useEffect(() => {
    if (account) loadData();
    if (window.ethereum) {
      window.ethereum.on('accountsChanged', (accs: any) => setAccount(accs[0] || ""));
    }
  }, [account, loadData]);

  const handleDeposit = async () => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      await (await market.deposit({ value: ethers.parseEther("1.0") })).wait(); loadData();
    } catch (e) { alert("Deposit failed"); }
  };

  const handleWalletDeposit = async (amount: string) => {
    if (!amount || parseFloat(amount) <= 0) return alert("Please enter a valid amount");
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      await (await market.walletDeposit({ value: ethers.parseEther(amount) })).wait(); loadData();
    } catch (e) { alert("Top-up failed"); }
  };

  const handleWalletWithdraw = async (amount: string) => {
    if (!amount || parseFloat(amount) <= 0) return alert("Please enter a valid amount");
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      await (await market.walletWithdraw(ethers.parseEther(amount))).wait(); loadData();
    } catch (e: any) { alert(e.reason || "Withdrawal failed — check your balance"); }
  };

  const handleList = async (n: string, p: string) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      await (await market.listProduct(n, ethers.parseEther(p))).wait(); loadData();
    } catch (e: any) { alert(e.reason || "Listing failed — ensure your security deposit is sufficient"); }
  };

  const handleBuy = async (id: any, _price: any) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      await (await market.purchaseProduct(id)).wait(); loadData();
    } catch (e: any) { alert(e.reason || "Purchase failed — check your wallet balance"); }
  };

  const handleShip = async (id: any, hash: string) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      await (await market.confirmShipment(id, hash)).wait(); loadData();
    } catch (e: any) { alert(`Shipment failed: ${e.reason || e.message}`); }
  };

  const handleConfirm = async (id: any) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      await (await market.confirmReceipt(id)).wait(); loadData();
    } catch (e) { alert("Confirmation failed"); }
  };

  const handleDispute = async (id: any, reason: string) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      await (await market.raiseDispute(id)).wait();
      if (reason) setDisputeReasons(prev => ({ ...prev, [id.toString()]: reason }));
      loadData();
    } catch (e: any) { alert(`Dispute failed: ${e.reason || "Check that both parties have sufficient security deposits"}`); }
  };

  const handleWithdrawStake = async (productId: string) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const dispute = new ethers.Contract(ADDRESSES.DISPUTE, DisputeManagerABI.abi, signer);
      await (await dispute.withdrawStake(BigInt(productId))).wait(); loadData();
    } catch (e: any) { alert("Exit failed: " + (e.reason || e.message)); }
  };

  const handleJoinDispute = async (productId: string) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const dispute = new ethers.Contract(ADDRESSES.DISPUTE, DisputeManagerABI.abi, signer);
      await (await dispute.stakeToEnter(BigInt(productId))).wait(); loadData();
    } catch (e: any) { alert("Failed to join: " + (e.reason || "You may not be assigned to this case or have insufficient balance")); }
  };

  const handleVote = async (productId: string, choice: number) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const dispute = new ethers.Contract(ADDRESSES.DISPUTE, DisputeManagerABI.abi, signer);
      await (await dispute.castVote(BigInt(productId), choice)).wait(); loadData();
    } catch (e: any) { alert("Vote failed: " + (e.reason || e.message)); }
  };

  const handleSettle = async (productId: string) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const dispute = new ethers.Contract(ADDRESSES.DISPUTE, DisputeManagerABI.abi, signer);
      await (await dispute.settleDispute(BigInt(productId))).wait(); loadData();
    } catch (e: any) { alert("Settlement failed: " + (e.reason || "Voting period may still be ongoing")); }
  };

  const handleForceRegister = async () => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const myAddress = await signer.getAddress();
      const registry = new ethers.Contract(ADDRESSES.REGISTRY, ReviewerRegistryABI.abi, signer);
      await (await registry.forceRegister(myAddress)).wait(); loadData();
    } catch (e: any) { alert("Registration failed: " + (e.reason || "Check console for details")); }
  };

  return (
    <Router>
      <div className="app-shell">
        <Navbar account={account} deposit={data.deposit} wallet={data.wallet} connect={connectWallet} onDeposit={handleDeposit} onWalletDeposit={handleWalletDeposit} onWalletWithdraw={handleWalletWithdraw} />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<RoleSelectPage account={account} connect={connectWallet} />} />
            <Route path="/buyer/market" element={<BuyerMarket products={data.products} onBuy={handleBuy} />} />
            <Route path="/buyer/orders" element={<BuyerOrders orders={data.myOrders} onConfirm={handleConfirm} onDispute={handleDispute} />} />
            <Route path="/seller/listings" element={<SellerListings myProducts={data.mySales} onList={handleList} onShip={handleShip} onDispute={handleDispute} />} />
            <Route path="/arbitrator/pool" element={<ArbitratorPool disputes={data.myDisputes} isReviewer={data.isReviewer} onJoin={handleJoinDispute} onVote={handleVote} onForceRegister={handleForceRegister} onWithdrawStake={handleWithdrawStake} onSettle={handleSettle} />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}
