import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useNavigate, useLocation } from 'react-router-dom';
import { ethers } from 'ethers';
import {
  ShoppingBag, Wallet, ShieldCheck, Package, Scale,
  PlusCircle, AlertCircle, CheckCircle2, Send,
  ArrowRight, Lock, Gavel, Cpu
} from 'lucide-react';

import ProductMarketABI   from './abis/ProductMarket.json';
import ReviewerRegistryABI from './abis/ReviewerRegistry.json';
import DisputeManagerABI  from './abis/DisputeManager.json';

// ── Contract addresses (Hardhat localhost defaults) ───────────────────────────
const ADDRESSES = {
  MARKET:   "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  REGISTRY: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  DISPUTE:  "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
};

// Maps ProductStatus enum (from ProductMarket.sol) to display strings
const STATUS_MAP: Record<number, { label: string; color: string }> = {
  0: { label: "Listed",           color: "status-active"  },
  1: { label: "Pending Shipment", color: "status-pending" },
  2: { label: "Shipped",          color: "status-shipped" },
  3: { label: "Completed",        color: "status-success" },
  4: { label: "In Dispute",       color: "status-dispute" },
  5: { label: "Closed",           color: "status-closed"  },
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface ComponentMeta {
  name: string;
  partNumber?: string;
  brand?: string;
  condition?: string;
  quantity?: string;
  origin?: string;
}

interface Product {
  id: string;
  seller: string;
  buyer: string;
  ipfsHash: string;
  meta: ComponentMeta;
  price: bigint;
  status: number;
  disputeResolved?: boolean;
  buyerWon?: boolean;
  iWon?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Parse the ipfsHash field, which stores component metadata as JSON
const parseProductMeta = (raw: string): ComponentMeta => {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj.name) return obj;
  } catch {}
  return { name: raw || "Unknown Component" };
};

const formatProductTitle = (meta: ComponentMeta): string =>
  meta.partNumber ? `${meta.name} [${meta.partNumber}]` : meta.name;

// Safely parse a raw contract product tuple into a typed Product object
const safeParseProduct = (p: any): Product | null => {
  if (!p) return null;
  try {
    const id = (p.id ?? p[0])?.toString();
    if (!id) return null;
    const rawHash = (p.ipfsHash ?? p[3]) || "Unknown Component";
    return {
      id,
      seller:   (p.seller ?? p[1]) || "",
      buyer:    (p.buyer  ?? p[2]) || "",
      ipfsHash: rawHash,
      meta:     parseProductMeta(rawHash),
      price:    BigInt((p.price ?? p[5] ?? 0).toString()),
      status:   Number(p.status ?? p[7] ?? 0),
    };
  } catch {
    return null;
  }
};

// ── ProductMetaGrid ───────────────────────────────────────────────────────────
const ProductMetaGrid = ({ meta }: { meta: ComponentMeta }) => {
  const fields = [
    { label: "Part Number",   value: meta.partNumber },
    { label: "Brand / MFR",  value: meta.brand      },
    { label: "Condition",    value: meta.condition   },
    { label: "Quantity",     value: meta.quantity    },
    { label: "Origin / Lot", value: meta.origin      },
  ].filter(f => f.value);

  if (fields.length === 0) return null;
  return (
    <div className="product-meta-grid">
      {fields.map(f => (
        <div key={f.label} className="product-meta-item">
          <span className="product-meta-label">{f.label}</span>
          <span className="product-meta-value">{f.value}</span>
        </div>
      ))}
    </div>
  );
};

// ── WalletModal ───────────────────────────────────────────────────────────────
const WalletModal = ({ wallet, deposit, onWalletDeposit, onWalletWithdraw, onDepositSeller, onClose }: any) => {
  const [amount, setAmount] = useState("");
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Account Overview</h3>
          <button className="modal-close" onClick={onClose}>&#x2715;</button>
        </div>

        <div className="modal-balances">
          <div className="modal-balance-item">
            <span className="modal-balance-label">In-App Wallet</span>
            <span className="modal-balance-value">{wallet} ETH</span>
            <span className="modal-balance-desc">Used for purchases &amp; juror staking</span>
          </div>
          <div className="modal-balance-item">
            <span className="modal-balance-label">Security Deposit</span>
            <span className="modal-balance-value">{deposit} ETH</span>
            <span className="modal-balance-desc">Requires &ge; 1 ETH to trade; 0.5 ETH held during disputes</span>
          </div>
        </div>

        <div className="modal-section">
          <label className="modal-label">Amount (ETH)</label>
          <input
            className="form-input" type="number" placeholder="0.5"
            value={amount} onChange={e => setAmount(e.target.value)}
          />
        </div>

        <div className="modal-actions">
          <button className="btn-primary"  onClick={() => { onWalletDeposit(amount); onClose(); }}>Top Up In-App Wallet</button>
          <button className="btn-outline"  onClick={() => { onWalletWithdraw(amount); onClose(); }}>Withdraw from Wallet</button>
          <button className="btn-ghost"    onClick={() => { onDepositSeller(); onClose(); }}>Top Up Security Deposit (1 ETH)</button>
        </div>
      </div>
    </div>
  );
};

// ── ArbitratorTermsModal ──────────────────────────────────────────────────────
const ARBITRATOR_TERMS = [
  "I confirm that I have professional experience in semiconductor components, electronic parts procurement, or a closely related industry.",
  "I will evaluate each dispute impartially, based solely on the evidence provided — including product specifications, part numbers, condition descriptions, and shipment documentation.",
  "I will not accept any form of bribe, side payment, or inducement from either the buyer or seller involved in a dispute.",
  "I understand that incorrect or dishonest votes may result in forfeiture of my 0.1 ETH stake, as determined by the outcome of the majority vote.",
  "I acknowledge that I was selected randomly from the eligible arbitrator pool and that my identity is not disclosed to the disputing parties during the voting period.",
];

const ArbitratorTermsModal = ({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) => {
  const [agreed, setAgreed] = useState(false);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Arbitrator Code of Conduct</h3>
          <button className="modal-close" onClick={onClose}>&#x2715;</button>
        </div>

        <div className="terms-intro">
          <div className="terms-icon"><Gavel size={20} /></div>
          <p>
            By registering as an arbitrator on DeTrust Market, you agree to uphold the standards
            of the semiconductor component trading community. Please read and acknowledge the following terms.
          </p>
        </div>

        <div className="terms-list">
          {ARBITRATOR_TERMS.map((term, i) => (
            <div key={i} className="terms-item">
              <span className="terms-num">{i + 1}</span>
              <span>{term}</span>
            </div>
          ))}
        </div>

        <label className="terms-checkbox">
          <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
          <span>I have read and agree to all of the above terms</span>
        </label>

        <div className="modal-actions" style={{ marginTop: '20px' }}>
          <button
            className="btn-primary"
            style={{ justifyContent: 'center', padding: '12px', opacity: agreed ? 1 : 0.4 }}
            disabled={!agreed}
            onClick={() => { if (agreed) { onConfirm(); onClose(); } }}
          >
            <Gavel size={15} /> Confirm &amp; Register as Arbitrator
          </button>
          <button className="btn-ghost" style={{ justifyContent: 'center', padding: '12px' }} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Navbar ────────────────────────────────────────────────────────────────────
const Navbar = ({ account, deposit, wallet, connect, onDeposit, onWalletDeposit, onWalletWithdraw }: any) => {
  const location = useLocation();
  const [showWallet, setShowWallet] = useState(false);

  return (
    <>
      <nav className="navbar">
        <div className="navbar-inner">
          <Link to="/" className="navbar-brand">
            <div className="brand-icon"><ShieldCheck size={16} /></div>
            <span>DeTrust Market</span>
          </Link>

          <div className="navbar-links">
            {account && (
              <>
                <Link to="/buyer/market"    className={`nav-link ${location.pathname.startsWith('/buyer')      ? 'active' : ''}`}>Marketplace</Link>
                <Link to="/seller/listings" className={`nav-link ${location.pathname.startsWith('/seller')     ? 'active' : ''}`}>Seller Portal</Link>
                <Link to="/arbitrator/pool" className={`nav-link ${location.pathname.startsWith('/arbitrator') ? 'active' : ''}`}>Arbitration</Link>
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
          wallet={wallet} deposit={deposit}
          onWalletDeposit={onWalletDeposit} onWalletWithdraw={onWalletWithdraw}
          onDepositSeller={onDeposit} onClose={() => setShowWallet(false)}
        />
      )}
    </>
  );
};

// ── RoleSelectPage (Landing + Role Select) ────────────────────────────────────
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
          <span>Semiconductor Components · Blockchain Escrow · Expert Arbitration</span>
        </div>
        <h1 className="landing-title">De<span className="title-accent">Trust</span></h1>
        <p className="landing-subtitle">Trusted B2B Procurement for Semiconductor Components</p>
        <p className="landing-desc">
          Counterfeit parts cost the industry billions each year. DeTrust Market uses smart contract
          escrow and industry-expert arbitration to protect every transaction.
        </p>
        <button className="btn-primary btn-lg" onClick={connect}>
          <Wallet size={18} /> Connect Wallet <ArrowRight size={16} />
        </button>
        <div className="landing-stats">
          <div className="stat-item"><span className="stat-num">100%</span><span className="stat-label">On-Chain Escrow</span></div>
          <div className="stat-divider" />
          <div className="stat-item"><span className="stat-num">Expert</span><span className="stat-label">Industry Arbitrators</span></div>
          <div className="stat-divider" />
          <div className="stat-item"><span className="stat-num">Trustless</span><span className="stat-label">No Intermediaries</span></div>
        </div>
      </div>
    </div>
  );

  const roles = [
    { path: '/buyer/market',    icon: <ShoppingBag size={28} />, cls: 'role-icon-blue', name: 'Buyer',      desc: 'Browse verified component listings, purchase with escrow protection, confirm delivery or raise a dispute' },
    { path: '/seller/listings', icon: <Cpu size={28} />,         cls: 'role-icon-teal', name: 'Seller',     desc: 'List semiconductor components with full technical specifications, manage orders and shipments' },
    { path: '/arbitrator/pool', icon: <Scale size={28} />,       cls: 'role-icon-gold', name: 'Arbitrator', desc: 'Apply your industry expertise to resolve component disputes, stake ETH and earn rewards' },
  ];

  return (
    <div className="page-container">
      <div className="page-header">
        <p className="page-eyebrow">Welcome back</p>
        <h2 className="page-title">Select Your Role</h2>
        <p className="page-desc">{account.slice(0, 8)}···{account.slice(-6)}</p>
      </div>
      <div className="role-grid">
        {roles.map(r => (
          <button key={r.path} className="role-card" onClick={() => navigate(r.path)}>
            <div className={`role-icon ${r.cls}`}>{r.icon}</div>
            <h3 className="role-name">{r.name}</h3>
            <p className="role-desc">{r.desc}</p>
            <div className="role-arrow"><ArrowRight size={16} /></div>
          </button>
        ))}
      </div>
    </div>
  );
};

// ── BuyerMarket ───────────────────────────────────────────────────────────────
const BuyerMarket = ({ products, onBuy }: any) => {
  const forSale = products.filter((p: any) => p.status === 0);
  return (
    <div className="page-container">
      <div className="page-header-row">
        <div>
          <p className="page-eyebrow">Marketplace</p>
          <h2 className="page-title">Component Listings</h2>
        </div>
        <Link to="/buyer/orders" className="btn-ghost">My Orders <ArrowRight size={14} /></Link>
      </div>

      {forSale.length === 0 ? (
        <div className="empty-state"><Cpu size={40} /><p>No components listed yet</p></div>
      ) : (
        <div className="product-grid">
          {forSale.map((p: any) => (
            <div key={p.id} className="product-card">
              <div className="product-thumb">
                <span>&#128268;</span>
                <span className="product-id">#{p.id}</span>
              </div>
              <div className="product-info">
                <h4 className="product-name">{formatProductTitle(p.meta)}</h4>
                <p className="product-seller">{p.seller.slice(0, 10)}···</p>
                <ProductMetaGrid meta={p.meta} />
              </div>
              <div className="product-footer">
                <span className="product-price">{ethers.formatEther(p.price)} ETH</span>
                <button className="btn-primary btn-sm" onClick={() => onBuy(p.id, p.price)}>Purchase</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── DisputeModal ──────────────────────────────────────────────────────────────
const DisputeModal = ({ order, onSubmit, onClose }: any) => {
  const [reason, setReason] = useState("");
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Raise a Dispute</h3>
          <button className="modal-close" onClick={onClose}>&#x2715;</button>
        </div>

        <div className="dispute-modal-product">
          {[
            { label: "Component", value: `#${order.id} · ${formatProductTitle(order.meta)}` },
            { label: "Value",     value: `${ethers.formatEther(order.price)} ETH` },
          ].map(row => (
            <div key={row.label} className="dispute-modal-row">
              <span className="modal-balance-label">{row.label}</span>
              <span className="dispute-modal-value">{row.value}</span>
            </div>
          ))}
          <div className="dispute-modal-row">
            <span className="modal-balance-label">Status</span>
            <span className={`status-badge ${STATUS_MAP[order.status]?.color}`}>{STATUS_MAP[order.status]?.label}</span>
          </div>
        </div>

        <div className="modal-section">
          <label className="modal-label">Reason for Dispute (visible to arbitrators)</label>
          <textarea
            className="form-input form-textarea" rows={4}
            placeholder="Describe the issue — e.g. components did not match stated part number, suspected counterfeit, wrong quantity shipped, items arrived damaged..."
            value={reason} onChange={e => setReason(e.target.value)}
          />
        </div>

        <div className="dispute-modal-warning">
          &#9888;&#65039; Raising a dispute will deduct 0.5 ETH from each party's security deposit.
          Arbitrators with semiconductor industry expertise will be randomly selected to review the case.
        </div>

        <div className="modal-actions">
          <button className="btn-danger" style={{ width: '100%', justifyContent: 'center', padding: '12px' }}
            onClick={() => { onSubmit(order.id, reason); onClose(); }}>
            <AlertCircle size={16} /> Confirm Dispute
          </button>
          <button className="btn-ghost" style={{ width: '100%', justifyContent: 'center', padding: '12px' }} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

// ── BuyerOrders ───────────────────────────────────────────────────────────────
const BuyerOrders = ({ orders, onConfirm, onDispute }: any) => {
  const [disputeTarget, setDisputeTarget] = useState<any>(null);
  return (
    <div className="page-container">
      <div className="page-header">
        <p className="page-eyebrow">Buyer Dashboard</p>
        <h2 className="page-title">My Orders</h2>
      </div>

      {orders.length === 0 ? (
        <div className="empty-state"><ShoppingBag size={40} /><p>No orders yet</p></div>
      ) : (
        <div className="order-list">
          {orders.map((o: any) => (
            <div key={o.id} className="order-card">
              <div className="order-left">
                <div className="order-icon"><ShoppingBag size={18} /></div>
                <div>
                  <div className="order-meta">
                    <span className={`status-badge ${STATUS_MAP[o.status]?.color}`}>{STATUS_MAP[o.status]?.label}</span>
                    <span className="order-id">#{o.id}</span>
                    {o.disputeResolved && (
                      <span className={`status-badge ${o.iWon ? 'status-success' : 'status-dispute'}`}>
                        {o.iWon ? '&#9878;&#65039; Dispute Won' : '&#9878;&#65039; Dispute Lost'}
                      </span>
                    )}
                  </div>
                  <h4 className="order-name">{formatProductTitle(o.meta)}</h4>
                  <p className="order-seller">Seller: {o.seller.slice(0, 12)}···</p>
                  {o.disputeResolved && (
                    <p className={`dispute-result-text ${o.iWon ? 'result-win' : 'result-lose'}`}>
                      {o.iWon
                        ? `\u2713 Refund of ${ethers.formatEther(o.price)} ETH returned to your wallet`
                        : `\u2717 Payment of ${ethers.formatEther(o.price)} ETH awarded to seller, 0.5 ETH security deposit forfeited`}
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
        <DisputeModal order={disputeTarget} onSubmit={onDispute} onClose={() => setDisputeTarget(null)} />
      )}
    </div>
  );
};

// ── SellerListings ────────────────────────────────────────────────────────────
const SellerListings = ({ myProducts, onList, onShip, onDispute }: any) => {
  const [name,       setName]       = useState("");
  const [price,      setPrice]      = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [brand,      setBrand]      = useState("");
  const [condition,  setCondition]  = useState("");
  const [quantity,   setQuantity]   = useState("");
  const [origin,     setOrigin]     = useState("");
  const [shipHash,   setShipHash]   = useState<Record<string, string>>({});
  const [disputeTarget, setDisputeTarget] = useState<any>(null);

  const handleList = () => {
    const meta: ComponentMeta = {
      name,
      ...(partNumber && { partNumber }),
      ...(brand      && { brand      }),
      ...(condition  && { condition  }),
      ...(quantity   && { quantity   }),
      ...(origin     && { origin     }),
    };
    onList(JSON.stringify(meta), price);
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <p className="page-eyebrow">Seller Portal</p>
        <h2 className="page-title">Manage Listings</h2>
      </div>

      {/* Listing form */}
      <div className="form-card">
        <div className="form-card-header">
          <PlusCircle size={18} />
          <h3>List a Component</h3>
          <span className="form-badge">Security Deposit Required: 1 ETH</span>
        </div>

        <div className="form-row" style={{ marginBottom: '12px' }}>
          <div className="form-field">
            <label>Component Name <span className="field-required">*</span></label>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. NVIDIA A100 80GB PCIe GPU" className="form-input" />
          </div>
          <div className="form-field form-field-sm">
            <label>Price (ETH) <span className="field-required">*</span></label>
            <input type="number" value={price} onChange={e => setPrice(e.target.value)}
              placeholder="10.0" className="form-input" />
          </div>
        </div>

        <div className="form-optional-label">
          <span>Technical Specifications</span>
          <span className="form-optional-tag">Recommended — buyers can see all specifications before purchasing</span>
        </div>

        <div className="form-grid">
          <div className="form-field">
            <label>Part Number / MPN</label>
            <input value={partNumber} onChange={e => setPartNumber(e.target.value)}
              placeholder="e.g. 900-21001-0000-000" className="form-input" />
          </div>
          <div className="form-field">
            <label>Brand / Manufacturer</label>
            <input value={brand} onChange={e => setBrand(e.target.value)}
              placeholder="e.g. NVIDIA, Intel, Samsung" className="form-input" />
          </div>
          <div className="form-field">
            <label>Condition</label>
            <select value={condition} onChange={e => setCondition(e.target.value)} className="form-input">
              <option value="">Select condition</option>
              <option>New (Sealed)</option>
              <option>New (Open Box)</option>
              <option>Like New</option>
              <option>Used</option>
              <option>Refurbished</option>
            </select>
          </div>
          <div className="form-field">
            <label>Quantity</label>
            <input value={quantity} onChange={e => setQuantity(e.target.value)}
              placeholder="e.g. 50 units" className="form-input" />
          </div>
          <div className="form-field">
            <label>Origin / Lot / Batch</label>
            <input value={origin} onChange={e => setOrigin(e.target.value)}
              placeholder="e.g. Taiwan, Lot #2024-Q3" className="form-input" />
          </div>
        </div>

        <div style={{ marginTop: '16px' }}>
          <button className="btn-primary" onClick={handleList} disabled={!name || !price}>
            <PlusCircle size={15} /> List Component
          </button>
        </div>
      </div>

      {/* My listings */}
      <h3 className="section-title">My Listings &amp; Sales</h3>
      {myProducts.length === 0 ? (
        <div className="empty-state"><Cpu size={40} /><p>No listings yet</p></div>
      ) : (
        <div className="order-list">
          {myProducts.map((p: any) => (
            <div key={p.id} className="order-card">
              <div className="order-left">
                <div className="order-icon"><Package size={18} /></div>
                <div>
                  <div className="order-meta">
                    <span className={`status-badge ${STATUS_MAP[p.status]?.color}`}>{STATUS_MAP[p.status]?.label}</span>
                    <span className="order-id">#{p.id}</span>
                    {p.disputeResolved && (
                      <span className={`status-badge ${p.iWon ? 'status-success' : 'status-dispute'}`}>
                        {p.iWon ? '&#9878;&#65039; Dispute Won' : '&#9878;&#65039; Dispute Lost'}
                      </span>
                    )}
                  </div>
                  <h4 className="order-name">{formatProductTitle(p.meta)}</h4>
                  {p.disputeResolved && (
                    <p className={`dispute-result-text ${p.iWon ? 'result-win' : 'result-lose'}`}>
                      {p.iWon
                        ? `\u2713 Payment of ${ethers.formatEther(p.price)} ETH received in your wallet`
                        : `\u2717 Payment of ${ethers.formatEther(p.price)} ETH refunded to buyer, 0.5 ETH security deposit forfeited`}
                    </p>
                  )}
                </div>
              </div>
              <div className="order-actions">
                {p.status === 1 && (
                  <>
                    <input
                      placeholder="Tracking / Shipment ref."
                      className="form-input form-input-sm"
                      onChange={e => setShipHash(prev => ({ ...prev, [p.id]: e.target.value }))}
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
        <DisputeModal order={disputeTarget} onSubmit={onDispute} onClose={() => setDisputeTarget(null)} />
      )}
    </div>
  );
};

// ── ArbitratorPool ────────────────────────────────────────────────────────────
const ArbitratorPool = ({ disputes, isReviewer, onJoin, onVote, onForceRegister, onWithdrawStake, onSettle }: any) => {
  const [showTerms, setShowTerms] = useState(false);

  return (
    <div className="page-container">
      <div className="page-header-row">
        <div>
          <p className="page-eyebrow">Arbitration Hall</p>
          <h2 className="page-title">Active Cases</h2>
        </div>
        {isReviewer ? (
          <span className="arbitrator-badge"><ShieldCheck size={13} /> Registered Arbitrator</span>
        ) : (
          <button className="btn-outline" onClick={() => setShowTerms(true)}>
            <Gavel size={14} /> Apply as Arbitrator
          </button>
        )}
      </div>

      {!isReviewer && (
        <div className="arbitrator-info-banner">
          <Cpu size={16} />
          <div>
            <strong>Industry Experts Only</strong>
            <p>
              Arbitrators must have completed &ge; 10 verified transactions on DeTrust Market.
              A stake of 0.1 ETH is required per case to ensure honest participation.
            </p>
          </div>
        </div>
      )}

      {disputes.length === 0 ? (
        <div className="empty-state">
          <Scale size={40} />
          <p>{isReviewer ? "No dispute cases assigned to you" : "Register as an arbitrator to be assigned cases"}</p>
        </div>
      ) : (
        <div className="dispute-list">
          {disputes.map((d: any) => {
            const meta        = parseProductMeta(d.ipfsHash || "");
            const totalVotes  = d.buyerVotes + d.sellerVotes;
            const votingClosed = d.resolved || totalVotes >= 3;

            return (
              <div key={d.productId} className="dispute-card">

                {/* Case header */}
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

                {/* Component details */}
                <div className="dispute-info-grid">
                  <div className="dispute-info-item">
                    <span className="dispute-info-label">Component</span>
                    <span className="dispute-info-value">{formatProductTitle(meta)}</span>
                  </div>
                  {meta.partNumber && (
                    <div className="dispute-info-item">
                      <span className="dispute-info-label">Part Number</span>
                      <span className="dispute-info-value">{meta.partNumber}</span>
                    </div>
                  )}
                  {meta.brand && (
                    <div className="dispute-info-item">
                      <span className="dispute-info-label">Brand / MFR</span>
                      <span className="dispute-info-value">{meta.brand}</span>
                    </div>
                  )}
                  {meta.condition && (
                    <div className="dispute-info-item">
                      <span className="dispute-info-label">Stated Condition</span>
                      <span className="dispute-info-value">{meta.condition}</span>
                    </div>
                  )}
                  {meta.quantity && (
                    <div className="dispute-info-item">
                      <span className="dispute-info-label">Quantity</span>
                      <span className="dispute-info-value">{meta.quantity}</span>
                    </div>
                  )}
                  {meta.origin && (
                    <div className="dispute-info-item">
                      <span className="dispute-info-label">Origin / Lot</span>
                      <span className="dispute-info-value">{meta.origin}</span>
                    </div>
                  )}
                  <div className="dispute-info-item">
                    <span className="dispute-info-label">Order Status</span>
                    <span className={`status-badge ${STATUS_MAP[d.status]?.color}`}>{STATUS_MAP[d.status]?.label}</span>
                  </div>
                  {d.disputeReason && (
                    <div className="dispute-info-item dispute-info-full">
                      <span className="dispute-info-label">Stated Reason</span>
                      <span className="dispute-reason-text">{d.disputeReason}</span>
                    </div>
                  )}
                </div>

                {/* Juror actions */}
                <div className="dispute-actions">
                  {d.resolved ? (
                    <div className="juror-result-box">
                      <span className="text-muted">This case is closed</span>
                      {d.jurorResult ? (
                        <div className={`juror-result-detail ${d.jurorResult.iWon ? 'result-win' : 'result-lose'}`}>
                          <span className="juror-result-verdict">
                            {d.jurorResult.iWon ? '\u2713 Correct Vote' : '\u2717 Incorrect Vote'}
                            {' \u00b7 '}
                            {d.jurorResult.buyerWon ? 'Buyer Prevailed' : 'Seller Prevailed'}
                          </span>
                          <span className="juror-result-amount">
                            {d.jurorResult.iWon ? '+0.1 ETH stake returned + reward' : '-0.1 ETH stake forfeited'}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted" style={{ fontSize: '12px' }}>You did not participate in this case</span>
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
                  ) : !d.hasVoted && !votingClosed ? (
                    <>
                      <button className="btn-primary btn-sm" onClick={() => onVote(d.productId, 1)}>Side with Buyer</button>
                      <button className="btn-outline btn-sm" onClick={() => onVote(d.productId, 2)}>Side with Seller</button>
                      <button className="btn-ghost btn-sm" onClick={() => onWithdrawStake(d.productId)}
                        title="Exit arbitration and reclaim your 0.1 ETH stake">
                        Exit Case
                      </button>
                    </>
                  ) : d.hasVoted ? (
                    <span className="text-success">\u2713 Vote submitted &mdash; awaiting other arbitrators</span>
                  ) : (
                    <span className="text-muted">Voting has ended</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showTerms && (
        <ArbitratorTermsModal onConfirm={onForceRegister} onClose={() => setShowTerms(false)} />
      )}
    </div>
  );
};

// ── App (root component) ──────────────────────────────────────────────────────
export default function App() {
  const [account, setAccount] = useState("");
  const [disputeReasons, setDisputeReasons] = useState<Record<string, string>>({});
  const [data, setData] = useState<any>({
    products: [], mySales: [], myOrders: [], myDisputes: [],
    deposit: "0", wallet: "0", isReviewer: false,
  });

  // Request a new account selection on every click (allows switching accounts)
  const connectWallet = async () => {
    if (!window.ethereum) return alert("Please install the MetaMask extension");
    try {
      await window.ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(accounts[0]);
    } catch {}
  };

  // Helper: return a signer-bound contract instance
  const getSigner = () => new ethers.BrowserProvider(window.ethereum).getSigner();
  const getMarket  = async () => new ethers.Contract(ADDRESSES.MARKET,   ProductMarketABI.abi,    await getSigner());
  const getDispute = async () => new ethers.Contract(ADDRESSES.DISPUTE,  DisputeManagerABI.abi,   await getSigner());

  // Load all on-chain state for the connected account
  const loadData = useCallback(async () => {
    if (!window.ethereum || !account) return;
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const market   = new ethers.Contract(ADDRESSES.MARKET,   ProductMarketABI.abi,    provider);
      const dispute  = new ethers.Contract(ADDRESSES.DISPUTE,  DisputeManagerABI.abi,   provider);
      const registry = new ethers.Contract(ADDRESSES.REGISTRY, ReviewerRegistryABI.abi, provider);

      const [revStatus, latestId] = await Promise.all([
        registry.isReviewer(account).catch(() => false),
        market.getLatestProductId().catch(() => 0n),
      ]);

      // Fetch every product by sequential ID
      const allIds = Array.from({ length: Number(latestId) }, (_, i) => String(i + 1));
      const fetched = await Promise.all(
        allIds.map(id => market.products(id).then(safeParseProduct).catch(() => null))
      );
      const validProducts = fetched.filter((p): p is Product => p !== null && p.id !== "0");

      // For closed (Resolved) products, attach dispute outcome so the UI can display win/loss
      const enrichWithDisputeResult = async (products: Product[]) =>
        Promise.all(products.map(async p => {
          if (p.status !== 5) return p;
          try {
            const [,,,, resolved, buyerWon] = await dispute.getDisputeInfo(p.id);
            if (resolved) {
              const isBuyer = p.buyer.toLowerCase() === account.toLowerCase();
              return { ...p, disputeResolved: true, buyerWon, iWon: isBuyer ? buyerWon : !buyerWon };
            }
          } catch {}
          return p;
        }));

      const mySalesRaw  = validProducts.filter(p => p.seller.toLowerCase() === account.toLowerCase());
      const myOrdersRaw = validProducts.filter(p => p.buyer.toLowerCase()  === account.toLowerCase());
      const [mySales, myOrders] = await Promise.all([
        enrichWithDisputeResult(mySalesRaw),
        enrichWithDisputeResult(myOrdersRaw),
      ]);

      // Arbitrators: load their assigned dispute cases
      let activeDisputes: any[] = [];
      if (revStatus) {
        const disputeIds: any[] = await dispute.getDisputesByReviewer(account).catch(() => []);
        activeDisputes = (await Promise.all(disputeIds.map(async (id: any) => {
          try {
            const [, buyerVotes, sellerVotes,, resolved, buyerWon] = await dispute.getDisputeInfo(id);
            const [hasStaked, hasVoted] = await dispute.getReviewerStakeStatus(id, account).catch(() => [false, false]);
            const myVote = Number(await dispute.getReviewerVote(id, account).catch(() => 0));
            const p = await market.getProduct(id).catch(() => null);

            const jurorResult = (resolved && myVote !== 0)
              ? { iWon: myVote === (buyerWon ? 1 : 2), myVote, buyerWon }
              : null;

            return {
              productId: id,
              buyerVotes:    Number(buyerVotes),
              sellerVotes:   Number(sellerVotes),
              resolved,      buyerWon,
              isStaked:      hasStaked,
              hasVoted,      myVote,
              jurorResult,
              ipfsHash:      p?.ipfsHash || "",
              status:        p ? Number(p.status) : 4,
              disputeReason: disputeReasons[id.toString()] || "",
            };
          } catch { return null; }
        }))).filter(Boolean);
      }

      const [dep, wal] = await Promise.all([
        market.depositBalance(account).catch(() => 0n),
        market.walletBalance(account).catch(() => 0n),
      ]);

      setData((prev: any) => ({
        ...prev,
        products: validProducts, mySales, myOrders,
        myDisputes: activeDisputes, isReviewer: revStatus,
        deposit: ethers.formatEther(dep),
        wallet:  ethers.formatEther(wal),
      }));
    } catch (err) { console.error("loadData error:", err); }
  }, [account, disputeReasons]);

  useEffect(() => {
    if (account) loadData();
    window.ethereum?.on('accountsChanged', (accs: any) => setAccount(accs[0] || ""));
  }, [account, loadData]);

  // ── Transaction handlers ───────────────────────────────────────────────────

  const handleDeposit = async () => {
    try { await (await (await getMarket()).deposit({ value: ethers.parseEther("1.0") })).wait(); loadData(); }
    catch { alert("Deposit failed"); }
  };

  const handleWalletDeposit = async (amount: string) => {
    if (!amount || parseFloat(amount) <= 0) return alert("Please enter a valid amount");
    try { await (await (await getMarket()).walletDeposit({ value: ethers.parseEther(amount) })).wait(); loadData(); }
    catch { alert("Top-up failed"); }
  };

  const handleWalletWithdraw = async (amount: string) => {
    if (!amount || parseFloat(amount) <= 0) return alert("Please enter a valid amount");
    try { await (await (await getMarket()).walletWithdraw(ethers.parseEther(amount))).wait(); loadData(); }
    catch (e: any) { alert(e.reason || "Withdrawal failed — check your balance"); }
  };

  const handleList = async (metaJson: string, p: string) => {
    try { await (await (await getMarket()).listProduct(metaJson, ethers.parseEther(p))).wait(); loadData(); }
    catch (e: any) { alert(e.reason || "Listing failed — ensure your security deposit is sufficient"); }
  };

  const handleBuy = async (id: any) => {
    try { await (await (await getMarket()).purchaseProduct(id)).wait(); loadData(); }
    catch (e: any) { alert(e.reason || "Purchase failed — check your wallet balance"); }
  };

  const handleShip = async (id: any, hash: string) => {
    try { await (await (await getMarket()).confirmShipment(id, hash)).wait(); loadData(); }
    catch (e: any) { alert(`Shipment failed: ${e.reason || e.message}`); }
  };

  const handleConfirm = async (id: any) => {
    try { await (await (await getMarket()).confirmReceipt(id)).wait(); loadData(); }
    catch { alert("Confirmation failed"); }
  };

  const handleDispute = async (id: any, reason: string) => {
    try {
      await (await (await getMarket()).raiseDispute(id)).wait();
      if (reason) setDisputeReasons(prev => ({ ...prev, [id.toString()]: reason }));
      loadData();
    } catch (e: any) { alert(`Dispute failed: ${e.reason || "Check that both parties have sufficient security deposits"}`); }
  };

  const handleJoinDispute = async (productId: string) => {
    try { await (await (await getDispute()).stakeToEnter(BigInt(productId))).wait(); loadData(); }
    catch (e: any) { alert("Failed to join: " + (e.reason || "You may not be assigned to this case or have insufficient balance")); }
  };

  const handleVote = async (productId: string, choice: number) => {
    try { await (await (await getDispute()).castVote(BigInt(productId), choice)).wait(); loadData(); }
    catch (e: any) { alert("Vote failed: " + (e.reason || e.message)); }
  };

  const handleWithdrawStake = async (productId: string) => {
    try { await (await (await getDispute()).withdrawStake(BigInt(productId))).wait(); loadData(); }
    catch (e: any) { alert("Exit failed: " + (e.reason || e.message)); }
  };

  const handleSettle = async (productId: string) => {
    try { await (await (await getDispute()).settleDispute(BigInt(productId))).wait(); loadData(); }
    catch (e: any) { alert("Settlement failed: " + (e.reason || "Voting period may still be ongoing")); }
  };

  const handleForceRegister = async () => {
    try {
      const signer   = await getSigner();
      const registry = new ethers.Contract(ADDRESSES.REGISTRY, ReviewerRegistryABI.abi, signer);
      await (await registry.forceRegister(await signer.getAddress())).wait();
      loadData();
    } catch (e: any) { alert("Registration failed: " + (e.reason || "Check console for details")); }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Router>
      <div className="app-shell">
        <Navbar
          account={account} deposit={data.deposit} wallet={data.wallet}
          connect={connectWallet} onDeposit={handleDeposit}
          onWalletDeposit={handleWalletDeposit} onWalletWithdraw={handleWalletWithdraw}
        />
        <main className="app-main">
          <Routes>
            <Route path="/"                 element={<RoleSelectPage account={account} connect={connectWallet} />} />
            <Route path="/buyer/market"     element={<BuyerMarket products={data.products} onBuy={handleBuy} />} />
            <Route path="/buyer/orders"     element={<BuyerOrders orders={data.myOrders} onConfirm={handleConfirm} onDispute={handleDispute} />} />
            <Route path="/seller/listings"  element={<SellerListings myProducts={data.mySales} onList={handleList} onShip={handleShip} onDispute={handleDispute} />} />
            <Route path="/arbitrator/pool"  element={<ArbitratorPool disputes={data.myDisputes} isReviewer={data.isReviewer} onJoin={handleJoinDispute} onVote={handleVote} onForceRegister={handleForceRegister} onWithdrawStake={handleWithdrawStake} onSettle={handleSettle} />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}
