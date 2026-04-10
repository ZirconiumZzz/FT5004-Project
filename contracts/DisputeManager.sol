// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ReviewerRegistry.sol";
import "./ProductMarket.sol";

/**
 * @title DisputeManager
 * @notice Manages the full arbitration lifecycle for DeTrust Market disputes.
 *
 * Flow:
 *  1. ProductMarket calls openDispute() when a party raises a dispute.
 *     The product's tier (1/2/3) is passed in so all stake/fee values scale correctly.
 *  2. Five arbitrators are randomly selected from ReviewerRegistry.
 *  3. Each selected arbitrator stakes the tier-appropriate amount
 *     (via ProductMarket.deductWalletForStake) and casts a vote (BuyerWins / SellerWins).
 *  4. The case auto-finalizes once three votes are cast (_finalizeDispute).
 *  5. After the 24-hour deadline, anyone may call settleDispute() to finalize
 *     or trigger a re-vote if the result is a tie.
 *
 * Tier parameters (mirroring ProductMarket constants):
 *  Tier 1: dispute stake 0.5 ETH, juror stake 0.1 ETH, platform fee 0.1 ETH
 *  Tier 2: dispute stake 1.0 ETH, juror stake 0.2 ETH, platform fee 0.15 ETH
 *  Tier 3: dispute stake 3.0 ETH, juror stake 0.6 ETH, platform fee 0.25 ETH
 *
 * Prize pool distribution:
 *  - Losing party's dispute stake
 *  + Incorrect juror stakes
 *  - Platform fee
 *  = Reward shared equally among majority jurors (who also recover their own stake)
 *
 * All ETH remains in ProductMarket; this contract only issues accounting callbacks.
 */
contract DisputeManager {
    ReviewerRegistry public registry;
    ProductMarket    public market;

    uint256 public constant VOTING_PERIOD  = 1 days;
    uint256 public constant REVIEWER_COUNT = 5;

    // ── Tier-specific constants (must match ProductMarket) ────────────────────
    uint256 public constant TIER1_DISPUTE_STAKE = 0.5 ether;
    uint256 public constant TIER1_JUROR_STAKE   = 0.1 ether;
    uint256 public constant TIER1_PLATFORM_FEE  = 0.1 ether;

    uint256 public constant TIER2_DISPUTE_STAKE = 1 ether;
    uint256 public constant TIER2_JUROR_STAKE   = 0.2 ether;
    uint256 public constant TIER2_PLATFORM_FEE  = 0.15 ether;

    uint256 public constant TIER3_DISPUTE_STAKE = 3 ether;
    uint256 public constant TIER3_JUROR_STAKE   = 0.6 ether;
    uint256 public constant TIER3_PLATFORM_FEE  = 0.25 ether;

    enum Vote { None, BuyerWins, SellerWins }

    struct ReviewerInfo {
        bool hasStaked;
        bool hasVoted;
        Vote vote;
    }

    struct Dispute {
        uint256   productId;
        address   buyer;
        address   seller;
        uint8     tier;               // 1, 2, or 3 — determines stake/fee amounts
        address[] assignedReviewers;
        mapping(address => ReviewerInfo) reviewerInfo;
        uint256   buyerVotes;
        uint256   sellerVotes;
        uint256   stakedReviewerCount;
        uint256   deadline;
        bool      resolved;
        bool      buyerWon;
    }

    mapping(uint256 => Dispute)    private disputes;
    mapping(address => uint256[])  private reviewerDisputes;  // dispute IDs per arbitrator

    event DisputeOpened   (uint256 indexed productId, address[] reviewers, uint8 tier);
    event ReviewerStaked  (uint256 indexed productId, address indexed reviewer);
    event ReviewerWithdrew(uint256 indexed productId, address indexed reviewer);
    event VoteCast        (uint256 indexed productId, address indexed reviewer, Vote vote);
    event DisputeResolved (uint256 indexed productId, bool buyerWon, uint256 buyerVotes, uint256 sellerVotes);
    event TieDetected     (uint256 indexed productId);

    constructor(address _registry, address _market) {
        registry = ReviewerRegistry(_registry);
        market   = ProductMarket(payable(_market));
    }

    // ── Tier helpers ──────────────────────────────────────────────────────────

    function _disputeStake(uint8 tier) internal pure returns (uint256) {
        if (tier == 3) return TIER3_DISPUTE_STAKE;
        if (tier == 2) return TIER2_DISPUTE_STAKE;
        return TIER1_DISPUTE_STAKE;
    }

    function _jurorStake(uint8 tier) internal pure returns (uint256) {
        if (tier == 3) return TIER3_JUROR_STAKE;
        if (tier == 2) return TIER2_JUROR_STAKE;
        return TIER1_JUROR_STAKE;
    }

    function _platformFee(uint8 tier) internal pure returns (uint256) {
        if (tier == 3) return TIER3_PLATFORM_FEE;
        if (tier == 2) return TIER2_PLATFORM_FEE;
        return TIER1_PLATFORM_FEE;
    }

    // ── Dispute initialization ────────────────────────────────────────────────

    /// @notice Called exclusively by ProductMarket when a dispute is raised.
    /// @param tier  The tier determined by the product price (1, 2, or 3).
    function openDispute(
        uint256 productId,
        address buyer,
        address seller,
        bool    /*aiUsageAllowed*/,  // reserved for future AI-assisted evidence review
        uint8   tier
    ) external {
        require(msg.sender == address(market), "Only market contract");
        require(tier >= 1 && tier <= 3, "Invalid tier");

        Dispute storage d = disputes[productId];
        d.productId = productId;
        d.buyer     = buyer;
        d.seller    = seller;
        d.tier      = tier;
        d.deadline  = block.timestamp + VOTING_PERIOD;

        d.assignedReviewers = registry.selectReviewers(buyer, seller, REVIEWER_COUNT);
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            reviewerDisputes[d.assignedReviewers[i]].push(productId);
        }

        emit DisputeOpened(productId, d.assignedReviewers, tier);
    }

    // ── Juror staking ─────────────────────────────────────────────────────────

    /// @notice Assigned arbitrators call this to commit their tier-appropriate stake and enter the case.
    function stakeToEnter(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved,                          "Already resolved");
        require(block.timestamp < d.deadline,         "Voting period ended");

        bool isAssigned = false;
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            if (d.assignedReviewers[i] == msg.sender) { isAssigned = true; break; }
        }
        require(isAssigned,                           "Not assigned to this dispute");
        require(!d.reviewerInfo[msg.sender].hasStaked,"Already staked");

        uint256 stake = _jurorStake(d.tier);

        // Deduct from wallet; ETH remains in ProductMarket vault
        market.deductWalletForStake(msg.sender, stake);

        d.reviewerInfo[msg.sender].hasStaked = true;
        d.stakedReviewerCount++;

        emit ReviewerStaked(productId, msg.sender);
    }

    /// @notice Staked arbitrators may exit and reclaim their stake before casting a vote.
    function withdrawStake(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved,                           "Already resolved");
        require(block.timestamp < d.deadline,          "Voting period ended");
        require(d.reviewerInfo[msg.sender].hasStaked,  "Not staked");
        require(!d.reviewerInfo[msg.sender].hasVoted,  "Already voted, cannot withdraw");

        d.reviewerInfo[msg.sender].hasStaked = false;
        d.stakedReviewerCount--;

        market.refundStake(msg.sender, _jurorStake(d.tier));

        emit ReviewerWithdrew(productId, msg.sender);
    }

    // ── Voting ────────────────────────────────────────────────────────────────

    /// @notice Cast a vote. Auto-finalizes the dispute once 3 votes have been submitted.
    function castVote(uint256 productId, Vote vote) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved,                           "Already resolved");
        require(block.timestamp < d.deadline,          "Voting period ended");
        require(vote != Vote.None,                     "Invalid vote");
        require(d.reviewerInfo[msg.sender].hasStaked,  "Must stake before voting");
        require(!d.reviewerInfo[msg.sender].hasVoted,  "Already voted");

        d.reviewerInfo[msg.sender].vote     = vote;
        d.reviewerInfo[msg.sender].hasVoted = true;

        if (vote == Vote.BuyerWins) { d.buyerVotes++; }
        else                        { d.sellerVotes++; }

        emit VoteCast(productId, msg.sender, vote);

        // Early finalization: 3 votes reach a majority of 5
        if (d.buyerVotes + d.sellerVotes >= 3) {
            _finalizeDispute(productId);
        }
    }

    // ── Internal settlement ───────────────────────────────────────────────────

    /// @dev Step 1: compute prize pool and reward per correct voter.
    ///      Kept separate to avoid "stack too deep" in _finalizeDispute.
    function _computePrizePool(uint256 productId, Vote winningVote)
        internal view returns (uint256 rewardPerCorrectVoter, uint256 actualPlatformFee)
    {
        Dispute storage d       = disputes[productId];
        uint256 jurorStake_     = _jurorStake(d.tier);
        uint256 platFee         = _platformFee(d.tier);
        uint256 prizePool       = _disputeStake(d.tier);
        uint256 correctCount    = 0;

        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            ReviewerInfo storage ri = d.reviewerInfo[d.assignedReviewers[i]];
            if (ri.hasStaked && ri.hasVoted) {
                if (ri.vote == winningVote) { correctCount++; }
                else                        { prizePool += jurorStake_; }
            }
        }

        actualPlatformFee    = prizePool >= platFee ? platFee : prizePool;
        uint256 remaining    = prizePool - actualPlatformFee;
        rewardPerCorrectVoter = correctCount > 0 ? remaining / correctCount : 0;
    }

    /// @dev Step 2: pay out jurors. Separate function keeps _finalizeDispute stack shallow.
    function _settleJurors(uint256 productId, Vote winningVote, uint256 rewardPerCorrectVoter) internal {
        Dispute storage d   = disputes[productId];
        uint256 jurorStake_ = _jurorStake(d.tier);

        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            address              r  = d.assignedReviewers[i];
            ReviewerInfo storage ri = d.reviewerInfo[r];
            if (!ri.hasStaked) continue;

            if (ri.hasVoted && ri.vote == winningVote) {
                market.rewardJuror(r, jurorStake_, rewardPerCorrectVoter);
            } else if (!ri.hasVoted) {
                market.refundStake(r, jurorStake_);
            }
            // Incorrect vote: stake slashed (already in prizePool)

            ri.hasStaked = false;
            ri.hasVoted  = false;
        }
    }

    function _finalizeDispute(uint256 productId) internal {
        Dispute storage d = disputes[productId];
        if (d.resolved) return;

        bool buyerWon  = d.buyerVotes > d.sellerVotes;
        d.resolved     = true;
        d.buyerWon     = buyerWon;
        d.deadline     = block.timestamp;

        Vote winningVote = buyerWon ? Vote.BuyerWins : Vote.SellerWins;

        (uint256 rewardPerCorrectVoter, uint256 actualPlatformFee) =
            _computePrizePool(productId, winningVote);

        _settleJurors(productId, winningVote, rewardPerCorrectVoter);

        market.creditPlatformFee(actualPlatformFee);

        uint256 dispStake = _disputeStake(d.tier);
        market.resolveByDispute(
            productId,
            buyerWon,
            buyerWon ? dispStake : 0,
            buyerWon ? 0         : dispStake
        );

        emit DisputeResolved(productId, buyerWon, d.buyerVotes, d.sellerVotes);
    }

    // ── Deadline-based settlement ─────────────────────────────────────────────

    /**
     * @notice Callable by anyone after the voting deadline.
     *         If tied, resets votes and assigns a fresh 5-member panel for another round.
     *         If there is a majority, finalizes the dispute immediately.
     */
    function settleDispute(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved,                   "Already resolved");
        require(block.timestamp >= d.deadline, "Voting still ongoing");

        if (d.buyerVotes == d.sellerVotes) {
            // Tie: extend deadline and reshuffle the juror panel
            d.deadline     = block.timestamp + VOTING_PERIOD;
            d.buyerVotes   = 0;
            d.sellerVotes  = 0;

            uint256 jurorStake_ = _jurorStake(d.tier);
            for (uint i = 0; i < d.assignedReviewers.length; i++) {
                address        r  = d.assignedReviewers[i];
                ReviewerInfo storage ri = d.reviewerInfo[r];
                if (ri.hasStaked && !ri.hasVoted) {
                    ri.hasStaked = false;
                    d.stakedReviewerCount--;
                    market.refundStake(r, jurorStake_);
                }
                ri.hasVoted = false;
                ri.vote     = Vote.None;
            }

            d.assignedReviewers = registry.selectReviewers(d.buyer, d.seller, REVIEWER_COUNT);
            for (uint i = 0; i < d.assignedReviewers.length; i++) {
                reviewerDisputes[d.assignedReviewers[i]].push(productId);
            }

            emit TieDetected(productId);
            return;
        }

        _finalizeDispute(productId);
    }

    // ── View functions ────────────────────────────────────────────────────────

    struct DisputeView {
        uint256   productId;
        address   buyer;
        address   seller;
        uint8     tier;
        uint256   jurorStakeRequired;   // convenience: exact ETH juror must stake
        uint256   buyerVotes;
        uint256   sellerVotes;
        uint256   deadline;
        bool      resolved;
        bool      buyerWon;
        uint8     myVote;
        bool      myHasStaked;
        bool      myHasVoted;
    }

    struct PartyDisputeView {
        uint256 productId;
        uint8   tier;
        uint256 buyerVotes;
        uint256 sellerVotes;
        uint256 deadline;
        bool    resolved;
        bool    buyerWon;
    }

    /// @notice Returns full dispute details for each case assigned to an arbitrator.
    function getReviewerDisputeDetails(address reviewer)
        external view returns (DisputeView[] memory)
    {
        uint256[] memory ids    = reviewerDisputes[reviewer];
        DisputeView[] memory result = new DisputeView[](ids.length);
        for (uint i = 0; i < ids.length; i++) {
            Dispute storage      d  = disputes[ids[i]];
            ReviewerInfo storage ri = d.reviewerInfo[reviewer];
            result[i] = DisputeView({
                productId:          ids[i],
                buyer:              d.buyer,
                seller:             d.seller,
                tier:               d.tier,
                jurorStakeRequired: _jurorStake(d.tier),
                buyerVotes:         d.buyerVotes,
                sellerVotes:        d.sellerVotes,
                deadline:           d.deadline,
                resolved:           d.resolved,
                buyerWon:           d.buyerWon,
                myVote:             uint8(ri.vote),
                myHasStaked:        ri.hasStaked,
                myHasVoted:         ri.hasVoted
            });
        }
        return result;
    }

    /// @notice Returns dispute progress for a buyer or seller's own disputes.
    function getDisputesByParty(uint256[] calldata productIds)
        external view returns (PartyDisputeView[] memory)
    {
        PartyDisputeView[] memory result = new PartyDisputeView[](productIds.length);
        for (uint i = 0; i < productIds.length; i++) {
            Dispute storage d = disputes[productIds[i]];
            result[i] = PartyDisputeView({
                productId:   productIds[i],
                tier:        d.tier,
                buyerVotes:  d.buyerVotes,
                sellerVotes: d.sellerVotes,
                deadline:    d.deadline,
                resolved:    d.resolved,
                buyerWon:    d.buyerWon
            });
        }
        return result;
    }

    /// @notice Returns the list of product IDs assigned to a reviewer.
    function getDisputesByReviewer(address reviewer)
        external view returns (uint256[] memory)
    {
        return reviewerDisputes[reviewer];
    }

    /// @notice Returns core dispute state for a given product ID.
    function getDisputeInfo(uint256 productId) external view returns (
        address[] memory assignedReviewers,
        uint256          buyerVotes,
        uint256          sellerVotes,
        uint256          deadline,
        bool             resolved,
        bool             buyerWon,
        uint8            tier
    ) {
        Dispute storage d = disputes[productId];
        return (d.assignedReviewers, d.buyerVotes, d.sellerVotes, d.deadline, d.resolved, d.buyerWon, d.tier);
    }

    function getReviewerStakeStatus(uint256 productId, address reviewer)
        external view returns (bool hasStaked, bool hasVoted)
    {
        ReviewerInfo storage ri = disputes[productId].reviewerInfo[reviewer];
        return (ri.hasStaked, ri.hasVoted);
    }

    function getReviewerVote(uint256 productId, address reviewer)
        external view returns (Vote)
    {
        return disputes[productId].reviewerInfo[reviewer].vote;
    }

    /// @notice Convenience view: returns the juror stake required for a given dispute.
    function getJurorStakeRequired(uint256 productId) external view returns (uint256) {
        return _jurorStake(disputes[productId].tier);
    }

    receive() external payable {}
}
