import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';
import { 
  ShoppingBag, Wallet, ShieldCheck, Truck, Package, Scale, User, 
  PlusCircle, History, AlertCircle, CheckCircle2, Send, ChevronRight
} from 'lucide-react';

// --- 配置文件：请确保合约地址与你的部署一致 ---
const ADDRESSES = {
  MARKET: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  FETCHER: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
  REGISTRY: "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
  DISPUTE: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853"
};

// --- ABI 导入 (假设在 src/abis/ 目录下) ---
import ProductMarketABI from './abis/ProductMarket.json';
import DataFetcherABI from './abis/DataFetcher.json';
import ReviewerRegistryABI from './abis/ReviewerRegistry.json';
import DisputeManagerABI from './abis/DisputeManager.json';

const STATUS_MAP: any = {
  0: { label: "在售", color: "bg-green-100 text-green-700" },
  1: { label: "待发货", color: "bg-orange-100 text-orange-700" },
  2: { label: "已发货", color: "bg-blue-100 text-blue-700" },
  3: { label: "交易成功", color: "bg-emerald-100 text-emerald-700" },
  4: { label: "争议中", color: "bg-red-100 text-red-700" },
  5: { label: "已关闭", color: "bg-slate-100 text-slate-400" }
};

// --- 工具函数：解析合约返回的结构体 ---
const safeParseProduct = (p: any) => {
  if (!p) return null;
  try {
    // 自动兼容命名字段和索引字段
    const id = (p.id || p[0])?.toString();
    if (!id) return null; // 如果连ID都没有，直接舍弃

    return {
      id: id,
      seller: (p.seller || p[1]) || "",
      buyer: (p.buyer || p[2]) || "",
      ipfsHash: (p.ipfsHash || p[3]) || "未知商品",
      // 核心修复：确保 price 和 status 永远是有效数字
      price: p.price ? BigInt(p.price.toString()) : (p[5] ? BigInt(p[5].toString()) : 0n),
      status: Number(p.status ?? p[7] ?? 0)
    };
  } catch (e) {
    console.error("解析单项商品失败", e);
    return null;
  }
};

// --- 1. 导航栏组件 ---
const Navbar = ({ account, deposit, connect, onDeposit }: any) => (
  <nav className="bg-white/80 backdrop-blur-md border-b sticky top-0 z-50 px-8 py-4 flex justify-between items-center shadow-sm">
    <Link to="/" className="flex items-center gap-2 font-black text-2xl text-indigo-600">
      <ShieldCheck size={30} /> DeTrust
    </Link>
    <div className="flex items-center gap-4">
      {account && (
        <div onClick={onDeposit} className="flex items-center gap-3 bg-indigo-50 px-4 py-2 rounded-xl border border-indigo-100 cursor-pointer hover:bg-indigo-100 transition-all">
          <div className="text-right">
            <p className="text-[10px] text-indigo-400 font-bold uppercase leading-none">押金余额 (点击充值)</p>
            <p className="text-sm font-black text-indigo-700">{deposit} ETH</p>
          </div>
          <Wallet size={18} className="text-indigo-600" />
        </div>
      )}
      <button onClick={connect} className="bg-slate-900 text-white px-5 py-2 rounded-full font-bold text-sm">
        {account ? `${account.slice(0, 6)}...${account.slice(-4)}` : "连接钱包"}
      </button>
    </div>
  </nav>
);

// --- 2. 角色选择页面 ---
const RoleSelectPage = ({ account, connect }: any) => {
  const navigate = useNavigate();
  if (!account) return (
    <div className="flex flex-col items-center justify-center min-h-[80vh]">
      <ShieldCheck size={80} className="text-indigo-600 mb-6" />
      <h1 className="text-4xl font-black mb-4 tracking-tight">去中心化担保交易平台</h1>
      <p className="text-slate-500 mb-8">安全、透明、由社区仲裁驱动的 Web3 市场</p>
      <button onClick={connect} className="bg-indigo-600 text-white px-10 py-4 rounded-2xl font-bold text-xl shadow-xl shadow-indigo-100 hover:scale-105 transition-all">连接钱包进入</button>
    </div>
  );
  return (
    <div className="max-w-4xl mx-auto py-20 px-8 text-center">
      <h2 className="text-3xl font-black mb-12">选择您的角色</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <button onClick={() => navigate('/buyer/market')} className="bg-white p-10 rounded-[40px] border shadow-sm hover:border-indigo-600 transition-all group">
          <ShoppingBag size={40} className="mx-auto text-indigo-600 mb-4 group-hover:scale-110 transition-transform"/>
          <h3 className="text-xl font-bold">我是买家</h3>
        </button>
        <button onClick={() => navigate('/seller/listings')} className="bg-white p-10 rounded-[40px] border shadow-sm hover:border-indigo-600 transition-all group">
          <Package size={40} className="mx-auto text-indigo-600 mb-4 group-hover:scale-110 transition-transform"/>
          <h3 className="text-xl font-bold">我是卖家</h3>
        </button>
        <button onClick={() => navigate('/arbitrator/pool')} className="bg-white p-10 rounded-[40px] border shadow-sm hover:border-indigo-600 transition-all group">
          <Scale size={40} className="mx-auto text-indigo-600 mb-4 group-hover:scale-110 transition-transform"/>
          <h3 className="text-xl font-bold">仲裁大厅</h3>
        </button>
      </div>
    </div>
  );
};

// --- 3. 买家：商品市场 ---
const BuyerMarket = ({ products, onBuy }: any) => (
  <div className="max-w-7xl mx-auto py-10 px-8">
    <div className="flex justify-between items-center mb-10">
      <h2 className="text-4xl font-black">发现商品</h2>
      <Link to="/buyer/orders" className="flex items-center gap-2 text-indigo-600 font-bold hover:underline"><History size={20}/> 我的订单</Link>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
      {products.filter((p: any) => p.status === 0).map((p: any) => (
        <div key={p.id} className="bg-white rounded-[32px] p-6 border hover:shadow-xl transition-shadow">
          <div className="aspect-square bg-slate-50 rounded-[24px] mb-4 flex items-center justify-center text-4xl">🎁</div>
          <h3 className="font-bold text-lg mb-1 truncate">{p.ipfsHash}</h3>
          <div className="flex justify-between items-center pt-4 border-t mt-4">
            <span className="text-indigo-600 font-black text-xl">{ethers.formatEther(p.price)} ETH</span>
            <button onClick={() => onBuy(p.id, p.price)} className="bg-slate-900 text-white px-5 py-2 rounded-xl font-bold text-sm">购买</button>
          </div>
        </div>
      ))}
    </div>
  </div>
);

// --- 4. 买家：我的订单 ---
const BuyerOrders = ({ orders, onConfirm, onDispute }: any) => (
  <div className="max-w-5xl mx-auto py-10 px-8">
    <h2 className="text-4xl font-black mb-10">我的订单</h2>
    <div className="grid gap-4">
      {orders.length === 0 && <div className="text-center py-20 text-slate-400">暂无订单</div>}
      {orders.map((o: any) => (
        <div key={o.id} className="bg-white p-6 rounded-[30px] border flex justify-between items-center shadow-sm">
          <div className="flex items-center gap-4">
            <div className="p-4 bg-indigo-50 rounded-2xl text-indigo-600"><ShoppingBag /></div>
            <div>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${(STATUS_MAP[o.status] || {}).color}`}>{STATUS_MAP[o.status]?.label}</span>
              <h4 className="font-bold text-lg mt-1">{o.ipfsHash}</h4>
              <p className="text-xs text-slate-400">卖家: {o.seller.slice(0, 10)}...</p>
            </div>
          </div>
          <div className="flex gap-2">
            {o.status === 2 && (
              <>
                <button onClick={() => onConfirm(o.id)} className="bg-emerald-600 text-white px-5 py-2 rounded-xl font-bold text-sm flex items-center gap-2"><CheckCircle2 size={16}/> 确认收货</button>
                <button onClick={() => onDispute(o.id)} className="bg-red-50 text-red-600 px-5 py-2 rounded-xl font-bold text-sm flex items-center gap-2"><AlertCircle size={16}/> 申请仲裁</button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  </div>
);

// --- 5. 卖家：管理中心 ---
const SellerListings = ({ myProducts, onList, onShip }: any) => {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [shipHash, setShipHash] = useState<any>({});

  return (
    <div className="max-w-5xl mx-auto py-10 px-8">
      <div className="bg-white p-8 rounded-[40px] border shadow-sm mb-12">
        <h3 className="text-xl font-black mb-6 flex items-center gap-2"><PlusCircle size={20}/> 上架新商品 (需扣除1 ETH押金)</h3>
        <div className="flex gap-4">
          <input value={name} onChange={e => setName(e.target.value)} className="flex-1 p-4 bg-slate-50 border rounded-2xl outline-none" placeholder="商品名称" />
          <input type="number" value={price} onChange={e => setPrice(e.target.value)} className="w-32 p-4 bg-slate-50 border rounded-2xl outline-none" placeholder="ETH" />
          <button onClick={() => onList(name, price)} className="bg-indigo-600 text-white px-8 rounded-2xl font-black">发布</button>
        </div>
      </div>
      <h3 className="text-2xl font-black mb-6">我的销售记录</h3>
      <div className="grid gap-4">
        {myProducts.map((p: any) => (
          <div key={p.id} className="bg-white p-6 rounded-3xl border flex justify-between items-center shadow-sm">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className={`px-3 py-0.5 rounded-full text-[10px] font-bold ${STATUS_MAP[p.status].color}`}>{STATUS_MAP[p.status].label}</span>
                <span className="text-slate-400 text-xs">#{p.id}</span>
              </div>
              <h4 className="font-bold text-lg">{p.ipfsHash}</h4>
            </div>
            {p.status === 1 ? (
              <div className="flex gap-2">
                <input placeholder="发货单号" className="p-2 border rounded-xl text-sm w-32" onChange={e => setShipHash({...shipHash, [p.id]: e.target.value})} />
                <button onClick={() => onShip(p.id, shipHash[p.id] || "SENT")} className="bg-slate-900 text-white px-5 py-2 rounded-xl font-bold text-sm flex items-center gap-2"><Send size={14}/> 发货</button>
              </div>
            ) : <span className="text-slate-400 font-bold">{ethers.formatEther(p.price)} ETH</span>}
          </div>
        ))}
      </div>
    </div>
  );
};

// --- 6. 仲裁：仲裁池 ---
const ArbitratorPool = ({ disputes, isReviewer, onJoin, onVote, onForceRegister, onSettle }: any) => (
  <div className="max-w-6xl mx-auto py-10 px-8">
    <div className="flex justify-between items-center mb-10">
      <h2 className="text-4xl font-black">仲裁池</h2>
      {!isReviewer && (
        <button onClick={onForceRegister} className="bg-orange-100 text-orange-700 px-6 py-2 rounded-full font-bold text-sm">
          申请成为仲裁员
        </button>
      )}
    </div>
    <div className="grid gap-6">
      {disputes.length === 0 && <div className="text-center py-20 text-slate-300 font-bold">暂无争议案件</div>}
      {disputes.map((d: any) => {
        // 计算总票数
        const totalVotes = d.buyerVotes + d.sellerVotes;
        // 只有当案件尚未解决时，才显示操作按钮
        const isResolved = d.resolved; 

        return (
          <div key={d.productId} className="bg-white p-8 rounded-[40px] border shadow-sm flex justify-between items-center">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="bg-red-50 text-red-600 px-3 py-1 rounded-full text-[10px] font-black uppercase">
                  案件 ID: {d.productId}
                </span>
                <span className="text-slate-400 text-xs">
                  当前投票: {totalVotes} / 5
                </span>
                {isResolved && (
                  <span className="bg-emerald-50 text-emerald-600 px-3 py-1 rounded-full text-[10px] font-black">
                    已结算: {d.buyerWon ? "买家胜" : "卖家胜"}
                  </span>
                )}
              </div>
              <h4 className="text-2xl font-bold mb-1">"{d.ipfsHash}"</h4>
            </div>

            <div className="flex items-center gap-3">
              {/* 如果案件已结算，显示最终状态 */}
              {isResolved ? (
                <span className="text-slate-400 font-bold italic">该争议已关闭</span>
              ) : (
                <div className="flex gap-2">
                  {/* 情况 1: 还没质押加入 */}
                  {!d.isStaked ? (
                    <button 
                      onClick={() => onJoin(d.productId)} 
                      disabled={!isReviewer} 
                      className={`px-6 py-3 rounded-2xl font-bold ${isReviewer ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400'}`}
                    >
                      质押 0.1 ETH 加入
                    </button>
                  ) : (
                    <>
                      {/* 情况 2: 已加入但还没投票 */}
                      {!d.hasVoted ? (
                        <>
                          <button onClick={() => onVote(d.productId, 1)} className="bg-blue-600 text-white px-5 py-3 rounded-xl font-bold text-sm">投买家</button>
                          <button onClick={() => onVote(d.productId, 2)} className="bg-red-600 text-white px-5 py-3 rounded-xl font-bold text-sm">投卖家</button>
                        </>
                      ) : (
                        /* 情况 3: 已投票，显示状态 */
                        <span className="text-emerald-600 font-bold flex items-center px-4">已提交</span>
                      )}

                      {/* 情况 4: 只要投过票或票数足够，就显示结算按钮（供测试使用） */}
                      <button 
                        onClick={() => onSettle(d.productId)} 
                        className="bg-slate-900 text-white px-5 py-3 rounded-xl font-bold text-sm hover:bg-black transition-colors"
                      >
                        结算并拨款
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  </div>
);

// --- 7. 主程序 App ---
export default function App() {
  const [account, setAccount] = useState("");
  const [data, setData] = useState<any>({ products: [], mySales: [], myOrders: [], myDisputes: [], deposit: "0", isReviewer: false });

  const connectWallet = async () => {
    if (!window.ethereum) return alert("请安装插件");
    try {
      await window.ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(accounts[0]);
    } catch (e) {}
  };

  const loadData = useCallback(async () => {
      if (!window.ethereum || !account) return;
      try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, provider);
        const disputeManager = new ethers.Contract(ADDRESSES.DISPUTE, DisputeManagerABI.abi, provider);
        const registry = new ethers.Contract(ADDRESSES.REGISTRY, ReviewerRegistryABI.abi, provider);

        const revStatus = await registry.isReviewer(account).catch(() => false);
        const allIds = Array.from({ length: 20 }, (_, i) => (i + 1).toString());

        // --- 核心修复：获取所有商品数据 ---
        const allFetchedProducts = await Promise.all(allIds.map(async (id) => {
          try {
            const p = await market.products(id);
            return safeParseProduct(p); 
          } catch (e) { return null; }
        }));

        const validProducts = allFetchedProducts.filter((p): p is any => p !== null && p.id !== "0");

        // --- 核心修复：获取争议数据 ---
        const activeDisputes = await Promise.all(validProducts.map(async (pInfo) => {
          if (pInfo.status === 4) { // 争议中
            try {
              const d = await disputeManager.getDisputeInfo(pInfo.id);
              const [hasStaked, hasVoted] = await disputeManager.getReviewerStakeStatus(pInfo.id, account).catch(() => [false, false]);
              return {
                productId: pInfo.id,
                buyerVotes: Number(d.buyerVotes || d[1] || 0),
                sellerVotes: Number(d.sellerVotes || d[2] || 0),
                isStaked: hasStaked,
                hasVoted: hasVoted,
                ipfsHash: pInfo.ipfsHash,
                resolved: d.resolved || d[4] // 建议加上 resolved 状态判断
              };
            } catch (e) { return null; }
          }
          return null;
        }));

        const dep = await market.depositBalance(account).catch(() => 0n);

        // --- 核心修复：给状态机分配数据 ---
        setData((prev: any) => ({
          ...prev,
          // 1. 所有在售商品（用于买家市场）
          products: validProducts, 
          // 2. 当前用户作为卖家的商品（用于卖家管理）
          mySales: validProducts.filter(p => p.seller.toLowerCase() === account.toLowerCase()),
          // 3. 当前用户作为买家的订单（用于我的订单）
          myOrders: validProducts.filter(p => p.buyer.toLowerCase() === account.toLowerCase()),
          // 4. 争议案件
          myDisputes: activeDisputes.filter(Boolean),
          isReviewer: revStatus,
          deposit: ethers.formatEther(dep)
        }));

        console.log("数据加载成功:", {
          商品总数: validProducts.length,
          我的销售: validProducts.filter(p => p.seller.toLowerCase() === account.toLowerCase()).length,
          争议案件: activeDisputes.filter(Boolean).length
        });

      } catch (err) {
        console.error("加载失败:", err);
      }
    }, [account]);

    useEffect(() => {
      if (account) loadData();
      if (window.ethereum) {
        window.ethereum.on('accountsChanged', (accs: any) => setAccount(accs[0] || ""));
      }
    }, [account, loadData]);

  // --- 操作逻辑 ---
  const handleDeposit = async () => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      const tx = await market.deposit({ value: ethers.parseEther("1.0") });
      await tx.wait(); loadData();
    } catch (e) { alert("充值失败"); }
  };

  const handleList = async (n: string, p: string) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      const tx = await market.listProduct(n, ethers.parseEther(p));
      await tx.wait(); loadData();
    } catch (e: any) { alert(e.reason || "上架失败：请确保押金充足"); }
  };

  const handleBuy = async (id: any, p: any) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      const tx = await market.purchaseProduct(id, { value: p });
      await tx.wait(); loadData();
    } catch (e) { alert("购买失败"); }
  };

  const handleShip = async (id: any, hash: string) => {
    if (!id || id === "0") {
      alert("无效的订单ID");
      return;
    }
    
    console.log(`准备发货：订单ID ${id}, 物流哈希 ${hash}`);
    
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      
      // 调用合约
      const tx = await market.confirmShipment(id, hash);
      console.log("交易已提交:", tx.hash);
      
      await tx.wait();
      alert("发货成功！");
      loadData(); // 刷新界面
    } catch (e: any) {
      console.error("发货详细错误:", e);
      // 提取合约报错原因
      const reason = e.reason || e.message || "未知错误";
      alert(`发货失败: ${reason}`);
    }
  };

  const handleConfirm = async (id: any) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      const tx = await market.confirmProduct(id);
      await tx.wait(); loadData();
    } catch (e) { alert("确认失败"); }
  };

  const handleDispute = async (id: any) => {
    if (!id || id === "0") return alert("无效的订单ID");
    
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const market = new ethers.Contract(ADDRESSES.MARKET, ProductMarketABI.abi, signer);
      
      const tx = await market.raiseDispute(id); 
      
      console.log("争议请求已提交:", tx.hash);
      await tx.wait();
      alert("申请仲裁成功！订单已进入争议状态。");
      loadData(); 
    } catch (e: any) {
      console.error("申请仲裁详细错误:", e);
      // 这里的错误提示可以帮你看到具体的合约 Revert 原因
      alert(`申请仲裁失败: ${e.reason || "请检查订单状态是否为'已发货'"}`);
    }
  };

  // 加入/质押仲裁
  const handleJoinDispute = async (productId: string) => {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const disputeContract = new ethers.Contract(ADDRESSES.DISPUTE, DisputeManagerABI.abi, signer);

      // 1. 获取合约要求的押金 (0.1 ETH)
      const stakeAmount = await disputeContract.REVIEWER_STAKE(); 

      // 2. 调用正确的函数 stakeToEnter
      const tx = await disputeContract.stakeToEnter(BigInt(productId), { 
        value: stakeAmount 
      });
      
      await tx.wait();
      alert("成功质押并进入仲裁流程！");
      loadData();
    } catch (e: any) {
      console.error(e);
      // 重点排查：如果你不是被选中的 5 人之一，会报 "Not assigned to this dispute"
      alert("操作失败: " + (e.reason || "您可能未被系统分配到此案件，或余额不足"));
    }
  };

  // 投票
  const handleVote = async (productId: string, choice: number) => {
    try {
      const signer = await (new ethers.BrowserProvider(window.ethereum)).getSigner();
      const dispute = new ethers.Contract(ADDRESSES.DISPUTE, DisputeManagerABI.abi, signer);

      // choice: 1 (BuyerWins), 2 (SellerWins)
      const tx = await dispute.castVote(BigInt(productId), choice);
      await tx.wait();
      alert("投票成功！");
      loadData();
    } catch (e: any) {
      alert("投票失败: " + (e.reason || e.message));
    }
  };

  const handleSettle = async (productId: string) => {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      
      // 实例化 DisputeManager 合约
      const disputeContract = new ethers.Contract(
        ADDRESSES.DISPUTE, 
        DisputeManagerABI.abi, 
        signer
      );

      console.log("正在尝试结算案件 ID:", productId);
      
      // 调用合约中的 settleDispute 函数
      const tx = await disputeContract.settleDispute(BigInt(productId));
      
      await tx.wait();
      alert("案件结算成功！资金已拨付给胜诉方，仲裁员奖金已发放。");
      
      // 重新加载数据以刷新界面
      loadData();
      
    } catch (e: any) {
      console.error("结算失败详情:", e);
      // 如果你没在控制台快进 24 小时，这里通常会报 "Voting still ongoing"
      alert("结算失败: " + (e.reason || "请确认投票时间是否已截止"));
    }
  };

  const handleForceRegister = async () => {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const myAddress = await signer.getAddress(); // 获取当前钱包地址
      
      const registry = new ethers.Contract(
        ADDRESSES.REGISTRY, 
        ReviewerRegistryABI.abi, 
        signer
      );

      console.log("正在为地址注册仲裁员资格:", myAddress);

      // ✅ 关键修改：必须传入当前地址 myAddress
      const tx = await registry.forceRegister(myAddress); 
      
      await tx.wait();
      alert("仲裁员注册成功！");
      loadData();
    } catch (e: any) {
      console.error("注册失败详细原因:", e);
      // 如果还是报错，检查是否是合约逻辑报错（例如：该地址已注册）
      alert("注册失败: " + (e.reason || "请检查控制台报错信息"));
    }
  };

  return (
    <Router>
      <div className="min-h-screen bg-[#F8F9FD] pb-24 font-sans text-slate-900">
        <Navbar account={account} deposit={data.deposit} connect={connectWallet} onDeposit={handleDeposit} />
        <Routes>
          <Route path="/" element={<RoleSelectPage account={account} connect={connectWallet} />} />
          <Route path="/buyer/market" element={<BuyerMarket products={data.products} onBuy={handleBuy} />} />
          <Route path="/buyer/orders" element={<BuyerOrders orders={data.myOrders} onConfirm={handleConfirm} onDispute={handleDispute} />} />
          <Route path="/seller/listings" element={<SellerListings myProducts={data.mySales} onList={handleList} onShip={handleShip} />} />
          <Route path="/arbitrator/pool" element={<ArbitratorPool disputes={data.myDisputes} isReviewer={data.isReviewer} onJoin={handleJoinDispute} onVote={handleVote} onForceRegister={handleForceRegister} onSettle={handleSettle} />} />
        </Routes>
        
        {account && (
          <div className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur shadow-2xl border px-6 py-2 rounded-full flex gap-8 z-40">
            <Link to="/buyer/market" className="flex flex-col items-center p-2 text-slate-500 hover:text-indigo-600 transition-colors">
              <ShoppingBag size={20}/><span className="text-[10px] font-bold">买家</span>
            </Link>
            <Link to="/seller/listings" className="flex flex-col items-center p-2 text-slate-500 hover:text-indigo-600 transition-colors">
              <Package size={20}/><span className="text-[10px] font-bold">卖家</span>
            </Link>
            <Link to="/arbitrator/pool" className="flex flex-col items-center p-2 text-slate-500 hover:text-indigo-600 transition-colors">
              <Scale size={20}/><span className="text-[10px] font-bold">仲裁</span>
            </Link>
          </div>
        )}
      </div>
    </Router>
  );
}