const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DISPUTE_WINDOW      = 21 * 24 * 60 * 60; // 21 days in seconds
const FULFILLMENT_DEADLINE = 30 * 24 * 60 * 60; // 30 days

describe("BookEscrow", function () {
  let escrow, token;
  let author, buyer, other;

  const COST   = ethers.parseUnits("420", 8);   // 420 DOGE (8 decimals)
  const PROFIT = ethers.parseUnits("580", 8);   // 580 DOGE
  const TOTAL  = COST + PROFIT;

  // Deterministic order ID
  const orderId = ethers.id("order-001");
  const shipHash = ethers.id("tracking-ABC123");

  beforeEach(async () => {
    [author, buyer, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("Mock DOGE", "DOGE", 8);

    const BookEscrow = await ethers.getContractFactory("BookEscrow");
    escrow = await BookEscrow.deploy(author.address);

    // Mint tokens to buyer and approve escrow
    await token.mint(buyer.address, TOTAL * 10n);
    await token.connect(buyer).approve(await escrow.getAddress(), TOTAL * 10n);
  });

  /* ── createOrder ──────────────────────────────────────────────────── */

  describe("createOrder", () => {
    it("locks tokens and emits OrderCreated", async () => {
      const escrowAddr = await escrow.getAddress();
      await expect(
        escrow.connect(buyer).createOrder(orderId, await token.getAddress(), COST, PROFIT)
      )
        .to.emit(escrow, "OrderCreated")
        .withArgs(orderId, buyer.address, await token.getAddress(), COST, PROFIT);

      expect(await token.balanceOf(escrowAddr)).to.equal(TOTAL);
    });

    it("reverts on duplicate order ID", async () => {
      await escrow.connect(buyer).createOrder(orderId, await token.getAddress(), COST, PROFIT);
      await expect(
        escrow.connect(buyer).createOrder(orderId, await token.getAddress(), COST, PROFIT)
      ).to.be.revertedWithCustomError(escrow, "OrderExists");
    });

    it("reverts when cost and profit are both zero", async () => {
      await expect(
        escrow.connect(buyer).createOrder(orderId, await token.getAddress(), 0, 0)
      ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    });
  });

  /* ── fulfillOrder ─────────────────────────────────────────────────── */

  describe("fulfillOrder", () => {
    beforeEach(async () => {
      await escrow.connect(buyer).createOrder(orderId, await token.getAddress(), COST, PROFIT);
    });

    it("releases cost to author and emits OrderFulfilled", async () => {
      const before = await token.balanceOf(author.address);
      await expect(escrow.connect(author).fulfillOrder(orderId, shipHash))
        .to.emit(escrow, "OrderFulfilled");
      expect(await token.balanceOf(author.address)).to.equal(before + COST);
    });

    it("reverts when called by non-author", async () => {
      await expect(
        escrow.connect(buyer).fulfillOrder(orderId, shipHash)
      ).to.be.revertedWithCustomError(escrow, "NotAuthor");
    });

    it("reverts on missing order", async () => {
      await expect(
        escrow.connect(author).fulfillOrder(ethers.id("bogus"), shipHash)
      ).to.be.revertedWithCustomError(escrow, "OrderNotFound");
    });

    it("reverts on double-fulfill", async () => {
      await escrow.connect(author).fulfillOrder(orderId, shipHash);
      await expect(
        escrow.connect(author).fulfillOrder(orderId, shipHash)
      ).to.be.revertedWithCustomError(escrow, "WrongStatus");
    });
  });

  /* ── claimProfitRefund ────────────────────────────────────────────── */

  describe("claimProfitRefund", () => {
    beforeEach(async () => {
      await escrow.connect(buyer).createOrder(orderId, await token.getAddress(), COST, PROFIT);
      await escrow.connect(author).fulfillOrder(orderId, shipHash);
    });

    it("refunds profit to buyer within window", async () => {
      const before = await token.balanceOf(buyer.address);
      await expect(escrow.connect(buyer).claimProfitRefund(orderId))
        .to.emit(escrow, "ProfitRefunded")
        .withArgs(orderId, buyer.address, PROFIT);
      expect(await token.balanceOf(buyer.address)).to.equal(before + PROFIT);
    });

    it("reverts when called by non-buyer", async () => {
      await expect(
        escrow.connect(other).claimProfitRefund(orderId)
      ).to.be.revertedWithCustomError(escrow, "NotBuyer");
    });

    it("reverts after dispute window has closed", async () => {
      await time.increase(DISPUTE_WINDOW + 1);
      await expect(
        escrow.connect(buyer).claimProfitRefund(orderId)
      ).to.be.revertedWithCustomError(escrow, "WindowClosed");
    });
  });

  /* ── releaseProfit ────────────────────────────────────────────────── */

  describe("releaseProfit", () => {
    beforeEach(async () => {
      await escrow.connect(buyer).createOrder(orderId, await token.getAddress(), COST, PROFIT);
      await escrow.connect(author).fulfillOrder(orderId, shipHash);
    });

    it("releases profit to author after window by anyone", async () => {
      await time.increase(DISPUTE_WINDOW + 1);
      const before = await token.balanceOf(author.address);
      await expect(escrow.connect(other).releaseProfit(orderId))
        .to.emit(escrow, "ProfitReleased")
        .withArgs(orderId, author.address, PROFIT);
      expect(await token.balanceOf(author.address)).to.equal(before + PROFIT);
    });

    it("reverts while dispute window is still open", async () => {
      await expect(
        escrow.connect(other).releaseProfit(orderId)
      ).to.be.revertedWithCustomError(escrow, "WindowOpen");
    });
  });

  /* ── emergencyRefund ──────────────────────────────────────────────── */

  describe("emergencyRefund", () => {
    beforeEach(async () => {
      await escrow.connect(buyer).createOrder(orderId, await token.getAddress(), COST, PROFIT);
    });

    it("refunds full amount to buyer after fulfillment deadline", async () => {
      await time.increase(FULFILLMENT_DEADLINE + 1);
      const before = await token.balanceOf(buyer.address);
      await expect(escrow.connect(buyer).emergencyRefund(orderId))
        .to.emit(escrow, "EmergencyRefund")
        .withArgs(orderId, buyer.address, TOTAL);
      expect(await token.balanceOf(buyer.address)).to.equal(before + TOTAL);
    });

    it("reverts before deadline", async () => {
      await expect(
        escrow.connect(buyer).emergencyRefund(orderId)
      ).to.be.revertedWithCustomError(escrow, "DeadlineNotReached");
    });

    it("reverts when called by non-buyer", async () => {
      await time.increase(FULFILLMENT_DEADLINE + 1);
      await expect(
        escrow.connect(other).emergencyRefund(orderId)
      ).to.be.revertedWithCustomError(escrow, "NotBuyer");
    });

    it("reverts if order was already fulfilled", async () => {
      await escrow.connect(author).fulfillOrder(orderId, shipHash);
      await time.increase(FULFILLMENT_DEADLINE + 1);
      await expect(
        escrow.connect(buyer).emergencyRefund(orderId)
      ).to.be.revertedWithCustomError(escrow, "WrongStatus");
    });
  });

  /* ── view helpers ─────────────────────────────────────────────────── */

  describe("view helpers", () => {
    it("canClaimRefund is true after fulfillment within window", async () => {
      await escrow.connect(buyer).createOrder(orderId, await token.getAddress(), COST, PROFIT);
      await escrow.connect(author).fulfillOrder(orderId, shipHash);
      expect(await escrow.canClaimRefund(orderId)).to.be.true;
    });

    it("canReleaseProfit is true after window expires", async () => {
      await escrow.connect(buyer).createOrder(orderId, await token.getAddress(), COST, PROFIT);
      await escrow.connect(author).fulfillOrder(orderId, shipHash);
      await time.increase(DISPUTE_WINDOW + 1);
      expect(await escrow.canReleaseProfit(orderId)).to.be.true;
    });
  });
});
