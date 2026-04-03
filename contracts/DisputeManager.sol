// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ReviewerRegistry.sol";
import "./ProductMarket.sol";

contract DisputeManager {
    ReviewerRegistry public registry;
    ProductMarket public market;

    uint256 public constant VOTING_PERIOD = 1 days;
    uint256 public constant REVIEWER_COUNT = 5;
    uint256 public constant REVIEWER_STAKE = 0.1 ether;
    uint256 public constant DISPUTE_STAKE = 0.5 ether;
    uint256 public constant PLATFORM_FEE = 0.1 ether;

    enum Vote { None, BuyerWins, SellerWins }

    struct ReviewerInfo {
        bool hasStaked;
        bool hasVoted;
        Vote vote;
    }

    struct Dispute {
        uint256 productId;
        address buyer;
        address seller;
        address[] assignedReviewers;
        mapping(address => ReviewerInfo) reviewerInfo;
        uint256 buyerVotes;
        uint256 sellerVotes;
        uint256 stakedReviewerCount;
        uint256 deadline;
        bool resolved;
        bool buyerWon;
    }

    mapping(uint256 => Dispute) private disputes;
    mapping(address => uint256[]) private reviewerDisputes;

    event DisputeOpened(uint256 indexed productId, address[] reviewers);
    event ReviewerStaked(uint256 indexed productId, address indexed reviewer);
    event ReviewerWithdrew(uint256 indexed productId, address indexed reviewer);
    event VoteCast(uint256 indexed productId, address indexed reviewer, Vote vote);
    event DisputeResolved(uint256 indexed productId, bool buyerWon, uint256 buyerVotes, uint256 sellerVotes);
    event TieDetected(uint256 indexed productId);

    constructor(address _registry, address _market) {
        registry = ReviewerRegistry(_registry);
        market = ProductMarket(payable(_market));
    }

    function openDispute(
        uint256 productId,
        address buyer,
        address seller,
        bool /*aiUsageAllowed*/
    ) external {
        require(msg.sender == address(market), "Only market contract");

        Dispute storage d = disputes[productId];
        d.productId = productId;
        d.buyer = buyer;
        d.seller = seller;
        d.deadline = block.timestamp + VOTING_PERIOD;

        d.assignedReviewers = registry.selectReviewers(buyer, seller, REVIEWER_COUNT);
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            reviewerDisputes[d.assignedReviewers[i]].push(productId);
        }

        emit DisputeOpened(productId, d.assignedReviewers);
    }

    // ── Juror 质押：从站内钱包扣（ETH 留在 market）──────────────
    function stakeToEnter(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp < d.deadline, "Voting period ended");

        bool isAssigned = false;
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            if (d.assignedReviewers[i] == msg.sender) {
                isAssigned = true;
                break;
            }
        }
        require(isAssigned, "Not assigned to this dispute");
        require(!d.reviewerInfo[msg.sender].hasStaked, "Already staked");

        // 纯记账：从站内钱包扣，ETH 继续留在 market
        market.deductWalletForStake(msg.sender, REVIEWER_STAKE);

        d.reviewerInfo[msg.sender].hasStaked = true;
        d.stakedReviewerCount++;

        emit ReviewerStaked(productId, msg.sender);
    }

    // ── Juror 退出：退回站内钱包（纯记账）──────────────────────
    function withdrawStake(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp < d.deadline, "Voting period ended");
        require(d.reviewerInfo[msg.sender].hasStaked, "Not staked");
        require(!d.reviewerInfo[msg.sender].hasVoted, "Already voted, cannot withdraw");

        d.reviewerInfo[msg.sender].hasStaked = false;
        d.stakedReviewerCount--;

        // 纯记账：退回站内钱包
        market.refundStake(msg.sender, REVIEWER_STAKE);

        emit ReviewerWithdrew(productId, msg.sender);
    }

    // ── 投票 ──────────────────────────────────────────────────────
    function castVote(uint256 productId, Vote vote) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp < d.deadline, "Voting period ended");
        require(vote != Vote.None, "Invalid vote");
        require(d.reviewerInfo[msg.sender].hasStaked, "Must stake before voting");
        require(!d.reviewerInfo[msg.sender].hasVoted, "Already voted");

        d.reviewerInfo[msg.sender].vote = vote;
        d.reviewerInfo[msg.sender].hasVoted = true;

        if (vote == Vote.BuyerWins) {
            d.buyerVotes++;
        } else {
            d.sellerVotes++;
        }

        emit VoteCast(productId, msg.sender, vote);

        if (d.buyerVotes + d.sellerVotes >= 3) {
            _finalizeDispute(productId);
        }
    }

    function _finalizeDispute(uint256 productId) internal {
        Dispute storage d = disputes[productId];
        if (d.resolved) return;

        bool buyerWon = d.buyerVotes > d.sellerVotes;
        d.resolved = true;
        d.buyerWon = buyerWon;
        d.deadline = block.timestamp;

        Vote winningVote = buyerWon ? Vote.BuyerWins : Vote.SellerWins;

        // 计算奖池：输家的质押 + 争议押金的一半（另一半归胜方）
        uint256 prizePool = DISPUTE_STAKE; // 败方的 0.5 ETH 押金
        uint256 correctVoterCount = 0;

        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            address r = d.assignedReviewers[i];
            ReviewerInfo storage ri = d.reviewerInfo[r];
            if (ri.hasStaked && ri.hasVoted) {
                if (ri.vote == winningVote) {
                    correctVoterCount++;
                } else {
                    // 错误投票的质押加入奖池
                    prizePool += REVIEWER_STAKE;
                }
            }
        }

        uint256 actualPlatformFee = prizePool >= PLATFORM_FEE ? PLATFORM_FEE : prizePool;
        uint256 remainingPrize = prizePool - actualPlatformFee;

        uint256 rewardPerCorrectVoter = correctVoterCount > 0
            ? remainingPrize / correctVoterCount
            : 0;

        // 结算所有 juror（纯记账，ETH 留在 market）
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            address r = d.assignedReviewers[i];
            ReviewerInfo storage ri = d.reviewerInfo[r];
            if (!ri.hasStaked) continue;

            if (ri.hasVoted && ri.vote == winningVote) {
                // 正确投票：退回质押 + 奖励
                market.rewardJuror(r, REVIEWER_STAKE, rewardPerCorrectVoter);
            } else if (!ri.hasVoted) {
                // 未投票（超时）：仅退回质押
                market.refundStake(r, REVIEWER_STAKE);
            }
            // 错误投票：质押不退，已计入 prizePool

            ri.hasStaked = false;
            ri.hasVoted = false;
        }

        // 平台手续费入账
        market.creditPlatformFee(actualPlatformFee);

        // 争议结算：纯记账
        uint256 buyerStakeReturn = buyerWon ? DISPUTE_STAKE : 0;
        uint256 sellerStakeReturn = buyerWon ? 0 : DISPUTE_STAKE;
        market.resolveByDispute(productId, buyerWon, buyerStakeReturn, sellerStakeReturn);

        emit DisputeResolved(productId, buyerWon, d.buyerVotes, d.sellerVotes);
    }

    // ── 超时结算 ──────────────────────────────────────────────────
    function settleDispute(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp >= d.deadline, "Voting still ongoing");

        if (d.buyerVotes == d.sellerVotes) {
            d.deadline = block.timestamp + VOTING_PERIOD;
            d.buyerVotes = 0;
            d.sellerVotes = 0;

            for (uint i = 0; i < d.assignedReviewers.length; i++) {
                address r = d.assignedReviewers[i];
                ReviewerInfo storage ri = d.reviewerInfo[r];
                if (ri.hasStaked && !ri.hasVoted) {
                    ri.hasStaked = false;
                    d.stakedReviewerCount--;
                    market.refundStake(r, REVIEWER_STAKE);
                }
                ri.hasVoted = false;
                ri.vote = Vote.None;
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

    // ── 查询函数 ──────────────────────────────────────────────────

    struct DisputeView {
        uint256 productId;
        address buyer;
        address seller;
        uint256 buyerVotes;
        uint256 sellerVotes;
        uint256 deadline;
        bool resolved;
        bool buyerWon;
        uint8 myVote;
        bool myHasStaked;
        bool myHasVoted;
    }

    struct PartyDisputeView {
        uint256 productId;
        uint256 buyerVotes;
        uint256 sellerVotes;
        uint256 deadline;
        bool resolved;
        bool buyerWon;
    }

    function getReviewerDisputeDetails(address reviewer)
        external view returns (DisputeView[] memory)
    {
        uint256[] memory ids = reviewerDisputes[reviewer];
        DisputeView[] memory result = new DisputeView[](ids.length);
        for (uint i = 0; i < ids.length; i++) {
            Dispute storage d = disputes[ids[i]];
            ReviewerInfo storage ri = d.reviewerInfo[reviewer];
            result[i] = DisputeView({
                productId: ids[i],
                buyer: d.buyer,
                seller: d.seller,
                buyerVotes: d.buyerVotes,
                sellerVotes: d.sellerVotes,
                deadline: d.deadline,
                resolved: d.resolved,
                buyerWon: d.buyerWon,
                myVote: uint8(ri.vote),
                myHasStaked: ri.hasStaked,
                myHasVoted: ri.hasVoted
            });
        }
        return result;
    }

    function getDisputesByParty(uint256[] calldata productIds)
        external view returns (PartyDisputeView[] memory)
    {
        PartyDisputeView[] memory result = new PartyDisputeView[](productIds.length);
        for (uint i = 0; i < productIds.length; i++) {
            Dispute storage d = disputes[productIds[i]];
            result[i] = PartyDisputeView({
                productId: productIds[i],
                buyerVotes: d.buyerVotes,
                sellerVotes: d.sellerVotes,
                deadline: d.deadline,
                resolved: d.resolved,
                buyerWon: d.buyerWon
            });
        }
        return result;
    }

    function getDisputesByReviewer(address reviewer)
        external view returns (uint256[] memory)
    {
        return reviewerDisputes[reviewer];
    }

    function getDisputeInfo(uint256 productId) external view returns (
        address[] memory assignedReviewers,
        uint256 buyerVotes,
        uint256 sellerVotes,
        uint256 deadline,
        bool resolved,
        bool buyerWon
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
