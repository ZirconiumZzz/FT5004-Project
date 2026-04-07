// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ProductMarket.sol";
import "./DisputeManager.sol";

/**
 * @title DataFetcher
 * @notice Read-only aggregation contract that bundles data from ProductMarket
 *         and DisputeManager into a single RPC call per dashboard view.
 *
 * This reduces frontend latency by replacing multiple sequential eth_call
 * requests with one batched view call. No state is modified here.
 */
contract DataFetcher {
    ProductMarket  public market;
    DisputeManager public dispute;

    constructor(address _market, address _dispute) {
        market  = ProductMarket(_market);
        dispute = DisputeManager(payable(_dispute));
    }

    struct ProductSummary {
        uint256 id;
        address seller;
        address buyer;
        string  ipfsHash;
        string  deliveryIpfsHash;
        uint256 price;
        uint256 listedAt;
        uint8   status;
    }

    // ── Buyer dashboard ───────────────────────────────────────────────────────

    struct BuyerDashboard {
        ProductSummary[]                    purchases;
        DisputeManager.PartyDisputeView[]   disputes;
    }

    function getBuyerDashboard(address buyer)
        external view returns (BuyerDashboard memory)
    {
        uint256[] memory productIds = market.getProductsByBuyer(buyer);
        uint256[] memory disputeIds = market.getMyDisputes(buyer);

        return BuyerDashboard({
            purchases: _buildProductSummaries(productIds),
            disputes:  dispute.getDisputesByParty(disputeIds)
        });
    }

    // ── Seller dashboard ──────────────────────────────────────────────────────

    struct SellerDashboard {
        ProductSummary[]                    listedProducts;  // all platform listings (market context)
        ProductSummary[]                    myProducts;      // seller's own listings
        DisputeManager.PartyDisputeView[]   disputes;
    }

    function getSellerDashboard(address seller)
        external view returns (SellerDashboard memory)
    {
        uint256[] memory listedIds  = market.getListedProducts();
        uint256[] memory myIds      = market.getProductsBySeller(seller);
        uint256[] memory disputeIds = market.getMyDisputes(seller);

        return SellerDashboard({
            listedProducts: _buildProductSummaries(listedIds),
            myProducts:     _buildProductSummaries(myIds),
            disputes:       dispute.getDisputesByParty(disputeIds)
        });
    }

    // ── Arbitrator dashboard ──────────────────────────────────────────────────

    struct ReviewerDashboard {
        DisputeManager.DisputeView[] disputes;
        uint256                      totalEarnings;
    }

    function getReviewerDashboard(address reviewer)
        external view returns (ReviewerDashboard memory)
    {
        return ReviewerDashboard({
            disputes:      dispute.getReviewerDisputeDetails(reviewer),
            totalEarnings: market.reviewerEarnings(reviewer)
        });
    }

    // ── Public storefront (no login required) ─────────────────────────────────

    function getStorefront() external view returns (ProductSummary[] memory) {
        uint256[] memory listedIds = market.getListedProducts();
        return _buildProductSummaries(listedIds);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _buildProductSummaries(uint256[] memory ids)
        internal view returns (ProductSummary[] memory)
    {
        ProductSummary[] memory result = new ProductSummary[](ids.length);
        for (uint i = 0; i < ids.length; i++) {
            ProductMarket.Product memory p = market.getProduct(ids[i]);
            result[i] = ProductSummary({
                id:               p.id,
                seller:           p.seller,
                buyer:            p.buyer,
                ipfsHash:         p.ipfsHash,
                deliveryIpfsHash: p.deliveryIpfsHash,
                price:            p.price,
                listedAt:         p.listedAt,
                status:           uint8(p.status)
            });
        }
        return result;
    }
}
