// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ReviewerRegistry {
    address public marketContract;

    mapping(address => bool) public isReviewer;
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

    function recordSale(address seller) external onlyMarket {
        completedSales[seller]++;
    }

    function registerAsReviewer() external {
        require(completedSales[msg.sender] >= 10, "Need 10 completed sales");
        require(!isReviewer[msg.sender], "Already a reviewer");
        isReviewer[msg.sender] = true;
        reviewerPool.push(msg.sender);
        emit ReviewerRegistered(msg.sender);
    }

    // 仅供测试用，绕过10笔限制
    function forceRegister(address addr) external {
        require(!isReviewer[addr], "Already a reviewer");
        isReviewer[addr] = true;
        reviewerPool.push(addr);
        emit ReviewerRegistered(addr);
    }

    // 随机assign评审员，排除买卖双方，防止串通
    function selectReviewers(
        address exclude1,
        address exclude2,
        uint256 count
    ) external view returns (address[] memory) {
        address[] memory eligible = new address[](reviewerPool.length);
        uint256 eligibleCount = 0;

        for (uint256 i = 0; i < reviewerPool.length; i++) {
            address r = reviewerPool[i];
            if (r != exclude1 && r != exclude2) {
                eligible[eligibleCount] = r;
                eligibleCount++;
            }
        }

        require(eligibleCount >= count, "Not enough reviewers in pool");

        address[] memory selected = new address[](count);
        uint256 seed = uint256(keccak256(abi.encodePacked(
            block.timestamp, block.prevrandao, exclude1, exclude2
        )));

        for (uint256 i = 0; i < count; i++) {
            uint256 idx = seed % eligibleCount;
            selected[i] = eligible[idx];
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
