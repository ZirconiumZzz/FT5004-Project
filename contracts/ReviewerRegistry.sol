// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ReviewerRegistry
 * @notice Maintains the pool of qualified arbitrators for DeTrust Market.
 *
 * Eligibility: a seller must complete at least 10 verified trades before
 * registering as an arbitrator. This domain-expertise gate prevents
 * uninformed participants from influencing dispute outcomes.
 *
 * forceRegister() bypasses the 10-sale requirement and is intended for
 * testing and demonstration only.
 */
contract ReviewerRegistry {
    address public marketContract;

    mapping(address => bool)    public isReviewer;
    mapping(address => uint256) public completedSales;
    address[] private reviewerPool;

    event ReviewerRegistered(address indexed reviewer);

    modifier onlyMarket() {
        require(msg.sender == marketContract, "Only market contract");
        _;
    }

    constructor(address _marketContract) {
        marketContract = _marketContract;
    }

    function setMarketContract(address _market) external {
        marketContract = _market;
    }

    /// @notice Called by ProductMarket when a buyer confirms receipt of goods.
    function recordSale(address seller) external onlyMarket {
        completedSales[seller]++;
    }

    /// @notice Production registration: requires 10 completed sales.
    function registerAsReviewer() external {
        require(completedSales[msg.sender] >= 10, "Need 10 completed sales");
        require(!isReviewer[msg.sender],           "Already a reviewer");
        isReviewer[msg.sender] = true;
        reviewerPool.push(msg.sender);
        emit ReviewerRegistered(msg.sender);
    }

    /// @notice Testing only — bypasses the 10-sale requirement.
    function forceRegister(address addr) external {
        require(!isReviewer[addr], "Already a reviewer");
        isReviewer[addr] = true;
        reviewerPool.push(addr);
        emit ReviewerRegistered(addr);
    }

    /**
     * @notice Randomly selects `count` arbitrators, excluding the buyer and seller
     *         to prevent conflicts of interest.
     * @dev Uses a Fisher-Yates partial shuffle seeded by block randomness.
     *      Not suitable for high-value adversarial settings; adequate for this prototype.
     */
    function selectReviewers(
        address exclude1,
        address exclude2,
        uint256 count
    ) external view returns (address[] memory) {
        // Build eligible pool (excluding disputing parties)
        address[] memory eligible = new address[](reviewerPool.length);
        uint256 eligibleCount = 0;
        for (uint256 i = 0; i < reviewerPool.length; i++) {
            address r = reviewerPool[i];
            if (r != exclude1 && r != exclude2) {
                eligible[eligibleCount++] = r;
            }
        }
        require(eligibleCount >= count, "Not enough reviewers in pool");

        // Partial Fisher-Yates shuffle to select `count` addresses
        address[] memory selected = new address[](count);
        uint256 seed = uint256(keccak256(abi.encodePacked(
            block.timestamp, block.prevrandao, exclude1, exclude2
        )));
        for (uint256 i = 0; i < count; i++) {
            uint256 idx  = seed % eligibleCount;
            selected[i]  = eligible[idx];
            eligible[idx] = eligible[eligibleCount - 1];
            eligibleCount--;
            seed = uint256(keccak256(abi.encodePacked(seed, i)));
        }

        return selected;
    }

    function getPoolSize() external view returns (uint256) {
        return reviewerPool.length;
    }
}
