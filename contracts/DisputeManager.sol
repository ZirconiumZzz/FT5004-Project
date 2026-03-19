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
    mapping(address => uint256) public reviewerEarnings;

    uint256 public platformBalance;

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
        bool /*aiUsageAllowed - unused in product marketplace*/
    ) external {
        require(msg.sender == address(market), "Only market contract");

        Dispute storage d = disputes[productId];
        d.productId = productId;
        d.buyer = buyer;
        d.seller = seller;
        d.deadline = block.timestamp + VOTING_PERIOD;

        // 随机assign 5个评审员，排除买卖双方
        d.assignedReviewers = registry.selectReviewers(buyer, seller, REVIEWER_COUNT);
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            reviewerDisputes[d.assignedReviewers[i]].push(productId);
        }

        emit DisputeOpened(productId, d.assignedReviewers);
    }

    // ── 评审员质押进入（质押后才能投票）────────────────────────────
    function stakeToEnter(uint256 productId) external payable {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp < d.deadline, "Voting period ended");
        require(msg.value == REVIEWER_STAKE, "Must stake exactly 0.1 ETH");

        bool isAssigned = false;
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            if (d.assignedReviewers[i] == msg.sender) {
                isAssigned = true;
                break;
            }
        }
        require(isAssigned, "Not assigned to this dispute");
        require(!d.reviewerInfo[msg.sender].hasStaked, "Already staked");

        d.reviewerInfo[msg.sender].hasStaked = true;
        d.stakedReviewerCount++;

        emit ReviewerStaked(productId, msg.sender);
    }

    // ── 评审员投票前可退出（取回质押）───────────────────────────────
    function withdrawStake(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp < d.deadline, "Voting period ended");
        require(d.reviewerInfo[msg.sender].hasStaked, "Not staked");
        require(!d.reviewerInfo[msg.sender].hasVoted, "Already voted, cannot withdraw");

        d.reviewerInfo[msg.sender].hasStaked = false;
        d.stakedReviewerCount--;

        payable(msg.sender).transfer(REVIEWER_STAKE);
        emit ReviewerWithdrew(productId, msg.sender);
    }

    // ── 评审员投票 ────────────────────────────────────────────────
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
    }

    // ── 结算 ──────────────────────────────────────────────────────
    function settleDispute(uint256 productId) external {
        Dispute storage d = disputes[productId];
        require(!d.resolved, "Already resolved");
        require(block.timestamp >= d.deadline, "Voting still ongoing");

        if (d.buyerVotes == d.sellerVotes) {
            // 平票：重置，重新随机assign评审员，开启新一轮
            d.deadline = block.timestamp + VOTING_PERIOD;
            d.buyerVotes = 0;
            d.sellerVotes = 0;

            for (uint i = 0; i < d.assignedReviewers.length; i++) {
                address r = d.assignedReviewers[i];
                ReviewerInfo storage ri = d.reviewerInfo[r];
                if (ri.hasStaked && !ri.hasVoted) {
                    ri.hasStaked = false;
                    d.stakedReviewerCount--;
                    payable(r).transfer(REVIEWER_STAKE);
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

        bool buyerWon = d.buyerVotes > d.sellerVotes;
        d.resolved = true;
        d.buyerWon = buyerWon;

        Vote winningVote = buyerWon ? Vote.BuyerWins : Vote.SellerWins;

        // 奖金池 = 输家的 0.5 ETH 质押 + 投错票评审员的质押
        uint256 prizePool = DISPUTE_STAKE;

        uint256 correctVoterCount = 0;
        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            address r = d.assignedReviewers[i];
            ReviewerInfo storage ri = d.reviewerInfo[r];
            if (ri.hasStaked && ri.hasVoted) {
                if (ri.vote == winningVote) {
                    correctVoterCount++;
                } else {
                    prizePool += REVIEWER_STAKE;
                }
            }
        }

        uint256 actualPlatformFee = prizePool >= PLATFORM_FEE ? PLATFORM_FEE : prizePool;
        platformBalance += actualPlatformFee;
        uint256 remainingPrize = prizePool - actualPlatformFee;

        uint256 rewardPerCorrectVoter = correctVoterCount > 0
            ? remainingPrize / correctVoterCount
            : 0;

        for (uint i = 0; i < d.assignedReviewers.length; i++) {
            address r = d.assignedReviewers[i];
            ReviewerInfo storage ri = d.reviewerInfo[r];
            if (ri.hasStaked) {
                if (ri.hasVoted && ri.vote == winningVote) {
                    uint256 payout = REVIEWER_STAKE + rewardPerCorrectVoter;
                    reviewerEarnings[r] += rewardPerCorrectVoter;
                    payable(r).transfer(payout);
                } else if (!ri.hasVoted) {
                    payable(r).transfer(REVIEWER_STAKE);
                }
                // 投错票：质押没收进奖金池
            }
        }

        uint256 buyerStakeReturn = buyerWon ? DISPUTE_STAKE : 0;
        uint256 sellerStakeReturn = buyerWon ? 0 : DISPUTE_STAKE;

        (bool sent, ) = address(market).call{value: DISPUTE_STAKE}("");
        require(sent, "Failed to send stake to market");

        market.resolveByDispute(productId, buyerWon, buyerStakeReturn, sellerStakeReturn);

        emit DisputeResolved(productId, buyerWon, d.buyerVotes, d.sellerVotes);
    }

    function withdrawPlatformFee(address to) external {
        uint256 amount = platformBalance;
        platformBalance = 0;
        payable(to).transfer(amount);
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
        return (
            d.assignedReviewers,
            d.buyerVotes,
            d.sellerVotes,
            d.deadline,
            d.resolved,
            d.buyerWon
        );
    }

    function getReviewerVote(uint256 productId, address reviewer)
        external view returns (Vote)
    {
        return disputes[productId].reviewerInfo[reviewer].vote;
    }

    function getReviewerStakeStatus(uint256 productId, address reviewer)
        external view returns (bool hasStaked, bool hasVoted)
    {
        ReviewerInfo storage ri = disputes[productId].reviewerInfo[reviewer];
        return (ri.hasStaked, ri.hasVoted);
    }

    receive() external payable {}
}
