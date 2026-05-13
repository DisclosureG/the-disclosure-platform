const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DISPUTE_WINDOW       = 99 * 24 * 60 * 60; // 99 days in seconds
const FULFILLMENT_DEADLINE = 30 * 24 * 60 * 60; // 30 days

describe("BookEscrow", function () {
  let escrow, doge, pepe;
  let author, buyer, other;

  const COST   = ethers.parseUnits("420", 8);   // 420 DOGE (8 decimals)
  const PROFIT = ethers.parseUnits("580", 8);   // 580 DOGE
  const TOTAL  = COST + PROFIT;

  const ZERO_PUB_KEY = ethers.ZeroHash;
  const BUYER_PUB_KEY = ethers.id("fake-x25519-pubkey");

  const orderId  = ethers.id("order-001");
  const shipHash = ethers.id("tracking-ABC123");

  beforeEach(async () => {
    [author, buyer, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    doge = await MockERC20.deploy("Mock DOGE", "DOGE", 8);
    pepe = await MockERC20.deploy("Mock PEPE", "PEPE", 18);

    const BookEscrow = await ethers.getContractFactory("BookEscrow");
    escrow = await BookEscrow.deploy(author.address, await doge.getAddress(), await pepe.getAddress());

    await doge.mint(buyer.address, TOTAL * 10n);
    await doge.connect(buyer).approve(await escrow.getAddress(), TOTAL * 10n);
  });

  /* ── createOrder ──────────────────────────────────────────────────── */

  describe("createOrder", () => {
    it("locks tokens and emits OrderCreated", async () => {
      const escrowAddr = await escrow.getAddress();
      await expect(
        escrow.connect(buyer).createOrder(orderId, await doge.getAddress(), COST, PROFIT, BUYER_PUB_KEY)
      )
        .to.emit(escrow, "OrderCreated")
        .withArgs(orderId, buyer.address, await doge.getAddress(), COST, PROFIT, BUYER_PUB_KEY);

      expect(await doge.balanceOf(escrowAddr)).to.equal(TOTAL);
    });

    it("accepts PEPE as payment token", async () => {
      const pepeAmount = ethers.parseUnits("1000", 18);
      await pepe.mint(buyer.address, pepeAmount * 10n);
      await pepe.connect(buyer).approve(await escrow.getAddress(), pepeAmount * 10n);

      const pepeOrderId = ethers.id("order-pepe-001");
      await expect(
        escrow.connect(buyer).createOrder(pepeOrderId, await pepe.getAddress(), pepeAmount / 2n, pepeAmount / 2n, ZERO_PUB_KEY)
      ).to.emit(escrow, "OrderCreated");
    });

    it("reverts on token not in whitelist", async () => {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const rando = await MockERC20.deploy("Random", "RND", 18);
      await rando.mint(buyer.address, TOTAL);
      await rando.connect(buyer).approve(await escrow.getAddress(), TOTAL);

      await expect(
        escrow.connect(buyer).createOrder(orderId, await rando.getAddress(), COST, PROFIT, ZERO_PUB_KEY)
      ).to.be.revertedWithCustomError(escrow, "TokenNotAllowed");
    });

    it("reverts on duplicate order ID", async () => {
      await escrow.connect(buyer).createOrder(orderId, await doge.getAddress(), COST, PROFIT, ZERO_PUB_KEY);
      await expect(
        escrow.connect(buyer).createOrder(orderId, await doge.getAddress(), COST, PROFIT, ZERO_PUB_KEY)
      ).to.be.revertedWithCustomError(escrow, "OrderExists");
    });

    it("reverts when cost and profit are both zero", async () => {
      await expect(
        escrow.connect(buyer).createOrder(orderId, await doge.getAddress(), 0, 0, ZERO_PUB_KEY)
      ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    });
  });

  /* ── fulfillOrder ─────────────────────────────────────────────────── */

  describe("fulfillOrder", () => {
    beforeEach(async () => {
      await escrow.connect(buyer).createOrder(orderId, await doge.getAddress(), COST, PROFIT, ZERO_PUB_KEY);
    });

    it("releases cost to author and emits OrderFulfilled", async () => {
      const before = await doge.balanceOf(author.address);
      await expect(escrow.connect(author).fulfillOrder(orderId, shipHash, "0x"))
        .to.emit(escrow, "OrderFulfilled");
      expect(await doge.balanceOf(author.address)).to.equal(before + COST);
    });

    it("stores encrypted tracking when provided", async () => {
      const tracking = ethers.toUtf8Bytes(JSON.stringify({ nonce: "abc", ciphertext: "xyz" }));
      await escrow.connect(author).fulfillOrder(orderId, shipHash, tracking);
      const stored = await escrow.encryptedTrackings(orderId);
      expect(stored).to.equal(ethers.hexlify(tracking));
    });

    it("reverts when called by non-author", async () => {
      await expect(
        escrow.connect(buyer).fulfillOrder(orderId, shipHash, "0x")
      ).to.be.revertedWithCustomError(escrow, "NotAuthor");
    });

    it("reverts on missing order", async () => {
      await expect(
        escrow.connect(author).fulfillOrder(ethers.id("bogus"), shipHash, "0x")
      ).to.be.revertedWithCustomError(escrow, "OrderNotFound");
    });

    it("reverts on double-fulfill", async () => {
      await escrow.connect(author).fulfillOrder(orderId, shipHash, "0x");
      await expect(
        escrow.connect(author).fulfillOrder(orderId, shipHash, "0x")
      ).to.be.revertedWithCustomError(escrow, "WrongStatus");
    });
  });

  /* ── claimProfitRefund ────────────────────────────────────────────── */

  describe("claimProfitRefund", () => {
    beforeEach(async () => {
      await escrow.connect(buyer).createOrder(orderId, await doge.getAddress(), COST, PROFIT, ZERO_PUB_KEY);
      await escrow.connect(author).fulfillOrder(orderId, shipHash, "0x");
    });

    it("refunds profit to buyer within window", async () => {
      const before = await doge.balanceOf(buyer.address);
      await expect(escrow.connect(buyer).claimProfitRefund(orderId))
        .to.emit(escrow, "ProfitRefunded")
        .withArgs(orderId, buyer.address, PROFIT);
      expect(await doge.balanceOf(buyer.address)).to.equal(before + PROFIT);
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
      await escrow.connect(buyer).createOrder(orderId, await doge.getAddress(), COST, PROFIT, ZERO_PUB_KEY);
      await escrow.connect(author).fulfillOrder(orderId, shipHash, "0x");
    });

    it("releases profit to author after window by anyone", async () => {
      await time.increase(DISPUTE_WINDOW + 1);
      const before = await doge.balanceOf(author.address);
      await expect(escrow.connect(other).releaseProfit(orderId))
        .to.emit(escrow, "ProfitReleased")
        .withArgs(orderId, author.address, PROFIT);
      expect(await doge.balanceOf(author.address)).to.equal(before + PROFIT);
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
      await escrow.connect(buyer).createOrder(orderId, await doge.getAddress(), COST, PROFIT, ZERO_PUB_KEY);
    });

    it("refunds full amount to buyer after fulfillment deadline", async () => {
      await time.increase(FULFILLMENT_DEADLINE + 1);
      const before = await doge.balanceOf(buyer.address);
      await expect(escrow.connect(buyer).emergencyRefund(orderId))
        .to.emit(escrow, "EmergencyRefund")
        .withArgs(orderId, buyer.address, TOTAL);
      expect(await doge.balanceOf(buyer.address)).to.equal(before + TOTAL);
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
      await escrow.connect(author).fulfillOrder(orderId, shipHash, "0x");
      await time.increase(FULFILLMENT_DEADLINE + 1);
      await expect(
        escrow.connect(buyer).emergencyRefund(orderId)
      ).to.be.revertedWithCustomError(escrow, "WrongStatus");
    });
  });

  /* ── view helpers ─────────────────────────────────────────────────── */

  describe("view helpers", () => {
    it("isAllowedToken returns true for DOGE and PEPE, false for others", async () => {
      expect(await escrow.isAllowedToken(await doge.getAddress())).to.be.true;
      expect(await escrow.isAllowedToken(await pepe.getAddress())).to.be.true;
      expect(await escrow.isAllowedToken(other.address)).to.be.false;
    });

    it("canClaimRefund is true after fulfillment within window", async () => {
      await escrow.connect(buyer).createOrder(orderId, await doge.getAddress(), COST, PROFIT, ZERO_PUB_KEY);
      await escrow.connect(author).fulfillOrder(orderId, shipHash, "0x");
      expect(await escrow.canClaimRefund(orderId)).to.be.true;
    });

    it("canReleaseProfit is true after window expires", async () => {
      await escrow.connect(buyer).createOrder(orderId, await doge.getAddress(), COST, PROFIT, ZERO_PUB_KEY);
      await escrow.connect(author).fulfillOrder(orderId, shipHash, "0x");
      await time.increase(DISPUTE_WINDOW + 1);
      expect(await escrow.canReleaseProfit(orderId)).to.be.true;
    });
  });
});
