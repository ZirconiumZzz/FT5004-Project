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
 *  2. Five arbitrators are randomly selected from ReviewerRegistry.
 *  3. Each selected arbitrator stakes 0.1 ETH (via ProductMarket.deductWalletForStake)
 *     and casts a vote (BuyerWins / SellerWins).
 *  4. The case auto-finalizes once three votes are cast (_finalizeDispute).
 *  5. After the 24-hour deadline, anyone may call settleDispute() to finalize
 *     or trigger a re-vote if the result is a tie.
 *
 * Prize pool distribution:
 *  - Losing party's 0.5 ETH dispute stake
 *  + Incorrect juror stakes
 *  - Platform fee (0.1 ETH)
 *  = Reward shared equally among majority jurors (who also recover their own stake)
 *
 * All ETH remains in ProductMarket; this contract only issues accounting callbacks.
 */
contract DisputeManager {
    ReviewerRegistry public registry;
    ProductMarket    public market;

    uint256 public constant VOTING_PERIOD   = 1 days;
    uint256 public constant REVIEWER_COUNT  = 5;
    uint256 public constant REVIEWER_STAKE  = 0.1 ether;
    uint256 public constant DISPUTE_STAKE   = 0.5 ether;
    uint256 public constant PLATFORM_FEE    = 0.1 ether;

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

    event DisputeOpened  (uint256 indexed productId, address[] reviewers);
    event ReviewerStaked (uint256 indexed productId, address indexed reviewer);
    event ReviewerWithdrew(uint256 indexed productId, address indexed reviewer);
    event VoteCast       (uint256 indexed productId, address indexed reviewer, Vote vote);
    event DisputeResolved(uint256 indexed productId, bool buyerWon, uint256 buyerVotes, uint256 sellerVotes);
    event TieDetected    (uint256 indexed productId);

    constructor(address _registry, address _market) {
        registry = ReviewerRegistry(_registry);
        market   = ProductMarket(payable(_market));
    }

    // ── Dispute initialization ────────────────────────────────────────────────

    /// @notice Called exclusively by ProductMarket when a dispute is raised.
    function openDispute(
        uint256 productId,
        address buyer,
        address seller,
        bool    /*aiUsageAllowed*/  // reserved for future AI-assisted evidence review
    ) external {
        require(msg.sender == address(market), "Only market contract");

        Dispute storage d = disputes[productId];
        d.productId = productId;
        d.buyer     = buyer;
        d.seller    = seller;
        d.deadline  = block.timestamp + VOTING_PERIOD;

        d.assignedReviewers = registry.selectReviewers(buyer, seller, REVIEWER_COUNT);
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            reviewerDisputes[d.assignedReviewers[i]].push(productId);
        }

        emit DisputeOpened(productId, d.assignedReviewers);
    }

    // ── Juror staking ─────────────────────────────────────────────────────────

    /// @notice Assigned arbitrators call this to commit their 0.1 ETH stake and enter the case.
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

        // Deduct from wallet; ETH remains in ProductMarket vault
        market.deductWalletForStake(msg.sender, REVIEWER_STAKE);

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

        market.refundStake(msg.sender, REVIEWER_STAKE);

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

    function _finalizeDispute(uint256 productId) internal {
        Dispute storage d = disputes[productId];
        if (d.resolved) return;

        bool buyerWon     = d.buyerVotes > d.sellerVotes;
        d.resolved        = true;
        d.buyerWon        = buyerWon;
        d.deadline        = block.timestamp;  // close the voting window

        Vote winningVote  = buyerWon ? Vote.BuyerWins : Vote.SellerWins;

        // Prize pool = losing party's dispute stake + incorrect juror stakes
        uint256 prizePool         = DISPUTE_STAKE;
        uint256 correctVoterCount = 0;

        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            address        r  = d.assignedReviewers[i];
            ReviewerInfo storage ri = d.reviewerInfo[r];
            if (ri.hasStaked && ri.hasVoted) {
                if (ri.vote == winningVote) { correctVoterCount++; }
                else                        { prizePool += REVIEWER_STAKE; }  // slashed stake enters pool
            }
        }

        uint256 actualPlatformFee    = prizePool >= PLATFORM_FEE ? PLATFORM_FEE : prizePool;
        uint256 remainingPrize       = prizePool - actualPlatformFee;
        uint256 rewardPerCorrectVoter = correctVoterCount > 0
            ? remainingPrize / correctVoterCount
            : 0;

        // Settle all juror balances via accounting callbacks
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            address        r  = d.assignedReviewers[i];
            ReviewerInfo storage ri = d.reviewerInfo[r];
            if (!ri.hasStaked) continue;

            if (ri.hasVoted && ri.vote == winningVote) {
                // Correct vote: recover stake + receive reward
                market.rewardJuror(r, REVIEWER_STAKE, rewardPerCorrectVoter);
            } else if (!ri.hasVoted) {
                // Abstained (timed out): stake returned, no reward
                market.refundStake(r, REVIEWER_STAKE);
            }
            // Incorrect vote: stake is slashed (already counted in prizePool)

            ri.hasStaked = false;
            ri.hasVoted  = false;
        }

        market.creditPlatformFee(actualPlatformFee);

        // Resolve the product: winner recovers their dispute stake, loser forfeits theirs
        uint256 buyerStakeReturn  = buyerWon ? DISPUTE_STAKE : 0;
        uint256 sellerStakeReturn = buyerWon ? 0             : DISPUTE_STAKE;
        market.resolveByDispute(productId, buyerWon, buyerStakeReturn, sellerStakeReturn);

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

            for (uint i = 0; i < d.assignedReviewers.length; i++) {
                address        r  = d.assignedReviewers[i];
                ReviewerInfo storage ri = d.reviewerInfo[r];
                if (ri.hasStaked && !ri.hasVoted) {
                    ri.hasStaked = false;
                    d.stakedReviewerCount--;
                    market.refundStake(r, REVIEWER_STAKE);
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
                productId:   ids[i],
                buyer:       d.buyer,
                seller:      d.seller,
                buyerVotes:  d.buyerVotes,
                sellerVotes: d.sellerVotes,
                deadline:    d.deadline,
                resolved:    d.resolved,
                buyerWon:    d.buyerWon,
                myVote:      uint8(ri.vote),
                myHasStaked: ri.hasStaked,
                myHasVoted:  ri.hasVoted
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
        bool             buyerWon
    ) {
        Dispute storage d = disputes[productId];
        return (d.assignedReviewers, d.buyerVotes, d.sellerVotes, d.deadline, d.resolved, d.buyerWon);
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

    receive() external payable {}
}
