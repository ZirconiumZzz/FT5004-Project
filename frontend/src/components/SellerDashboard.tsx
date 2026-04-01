import React, { useState } from 'react';
import { ethers } from 'ethers';
import ProductMarketABI from '../abis/ProductMarket.json';

const MARKET_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

export function SellerDashboard() {
  const [price, setPrice] = useState("");
  const [desc, setDesc] = useState("");
  const [loading, setLoading] = useState(false);

  const handleListProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.ethereum) return;

    try {
      setLoading(true);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const market = new ethers.Contract(MARKET_ADDRESS, ProductMarketABI.abi, signer);

      // 1. 检查押金 (为了简化，这里直接调用上架，如果没押金合约会报错)
      // 在实际项目中，我们会先调用 deposit()
      console.log("正在上架...");
      const tx = await market.listProduct(
        desc, // 存入商品描述（实际应存IPFS Hash）
        ethers.parseEther(price) // 将 ETH 单位转换为 Wei
      );

      await tx.wait();
      alert("上架成功喵！🐾");
      window.location.reload(); // 刷新页面看新商品
    } catch (err: any) {
      console.error(err);
      alert("上架失败: " + (err.reason || "请检查是否存入了足够押金"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white p-8 rounded-3xl shadow-xl border border-slate-100 max-w-md mx-auto">
      <h2 className="text-2xl font-black mb-6 flex items-center gap-2">
        发布新商品 <span className="text-sm font-normal text-slate-400">(卖家需1 ETH押金)</span>
      </h2>
      
      <form onSubmit={handleListProduct} className="space-y-4">
        <div>
          <label className="block text-sm font-bold mb-2">商品描述</label>
          <input 
            type="text" 
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
            placeholder="例如: 绝版猫粮"
            required
          />
        </div>
        
        <div>
          <label className="block text-sm font-bold mb-2">价格 (ETH)</label>
          <input 
            type="number" 
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
            placeholder="0.5"
            required
          />
        </div>

        <button 
          type="submit"
          disabled={loading}
          className="w-full bg-orange-500 text-white font-black py-4 rounded-2xl hover:bg-orange-600 transition-all disabled:bg-slate-300"
        >
          {loading ? "链上处理中..." : "立即上架"}
        </button>
      </form>
    </div>
  );
}