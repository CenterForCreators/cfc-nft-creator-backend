// ========================================
// CFC NFT CREATOR — AUTOMATIC PAYMENT + MINT
// Using XRPL Ledger Polling (NO Webhooks, NO Return URL)
// ========================================

import express from "express";
import cors from "cors";
import fileUpload from "express-fileupload";
import axios from "axios";
import FormData from "form-data";
import Database from "better-sqlite3";
import xrpl from "xrpl";
import dotenv from "dotenv";

dotenv.config();

// -------------------------------
// CONFIG
// -------------------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_API_SECRET = process.env.PINATA_API_SECRET;
const XUMM_API_KEY = process.env.XUMM_API_KEY;
const XUMM_API_SECRET = process.env.XUMM_API_SECRET;

const PAYMENT_DEST = "rU15yYD3cHmNXGxHJSJGoLUSogxZ17FpKd";
const PORT = process.env.PORT || 4000;

const CREATOR_PAGE = "https://centerforcreators.com/nft-creator";

// XRPL Client (public free node)
const XRPL_NODE = "wss://xrplcluster.com";

// -------------------------------
// APP INIT
// -------------------------------
const app = express();
app.use(express.json());
app.use(fileUpload());

app.use(
  cors({
    origin: [
      "https://centerforcreators.com",
      "https://centerforcreators.com/nft-creator",
      "https://centerforcreators.com/nft-marketplace",
      "https://centerforcreators.com/nft-creator/admin",
      "https://centerforcreators.github.io",
      "https://centerforcreators.github.io/cfc-nft-creator-frontend"
    ],
    methods: ["GET", "POST"],
    credentials: true
  })
);

// -------------------------------
// SQLITE SETUP
// -------------------------------
const db = new Database("./submissions.sqlite");

db.prepare(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_wallet TEXT,
    name TEXT,
    description TEXT,
    image_cid TEXT,
    metadata_cid TEXT,
    batch_qty INTEGER,
    status TEXT,
    payment_status TEXT DEFAULT 'unpaid',
    mint_status TEXT DEFAULT 'pending',
    created_at TEXT
  )
`).run();

// -------------------------------
// UTIL — MAKE XUMM PAYLOAD
// -------------------------------
async function createXummPayload(payload) {
  const r = await axios.post("https://xumm.app/api/v1/platform/payload", payload, {
    headers: {
      "X-API-Key": XUMM_API_KEY,
      "X-API-Secret": XUMM_API_SECRET,
      "Content-Type": "application/json"
    }
  });

  return {
    uuid: r.data.uuid,
    link: r.data.next.always
  };
}

// -------------------------------
// XRPL LEDGER CHECK — PAYMENT
// -------------------------------
async function checkPayment(submissionId, wallet) {
  const client = new xrpl.Client(XRPL_NODE);
  await client.connect();

  const txs = await client.request({
    command: "account_tx",
    account: wallet,
    ledger_index_min: -1,
    ledger_index_max: -1,
    limit: 200
  });

  await client.disconnect();

  const keyword = `PAYMENT_${submissionId}`;

  const paidTx = txs.result.transactions.find((t) => {
    const meta = t.meta;
    const tx = t.tx;

    const memoMatch =
      tx.Memos &&
      tx.Memos.some((m) =>
        m.Memo?.MemoData?.includes(Buffer.from(keyword).toString("hex"))
      );

    return (
      tx.TransactionType === "Payment" &&
      tx.Destination === PAYMENT_DEST &&
      memoMatch
    );
  });

  return !!paidTx;
}

// -------------------------------
// XRPL LEDGER CHECK — MINT
// -------------------------------
async function checkMint(submissionId, wallet, metadataCid) {
  const client = new xrpl.Client(XRPL_NODE);
  await client.connect();

  const txs = await client.request({
    command: "account_tx",
    account: wallet,
    ledger_index_min: -1,
    ledger_index_max: -1,
    limit: 200
  });

  await client.disconnect();

  const keyword = `MINT_${submissionId}`;
  const targetUriHex = xrpl.convertStringToHex(`ipfs://${metadataCid}`);

  const mintTx = txs.result.transactions.find((t) => {
    const tx = t.tx;

    const memoMatch =
      tx.Memos &&
      tx.Memos.some((m) =>
        m.Memo?.MemoData?.includes(Buffer.from(keyword).toString("hex"))
      );

    return (
      tx.TransactionType === "NFTokenMint" &&
      tx.URI === targetUriHex &&
      memoMatch
    );
  });

  return !!mintTx;
}

// -------------------------------
// API — SYNC LEDGER → DB
// Called automatically when front end loads dashboard
// -------------------------------
app.get("/api/sync/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const sub = db.prepare(`SELECT * FROM submissions WHERE id=?`).get(id);
    if (!sub) return res.json({ updated: false });

    // 1) Check payment
    if (sub.payment_status === "unpaid") {
      const paid = await checkPayment(id, sub.creator_wallet);
      if (paid) {
        db.prepare(
          `UPDATE submissions SET payment_status='paid' WHERE id=?`
        ).run(id);
      }
    }

    // 2) If paid → check mint
    if (sub.payment_status === "paid" && sub.mint_status !== "minted") {
      const minted = await checkMint(id, sub.creator_wallet, sub.metadata_cid);
      if (minted) {
        db.prepare(
          `UPDATE submissions SET mint_status='minted' WHERE id=?`
        ).run(id);
      }
    }

    res.json({ updated: true });
  } catch (err) {
    console.log("sync error:", err.message);
    res.json({ updated: false });
  }
});

// -------------------------------
// WALLET CONNECT
// -------------------------------
app.post("/api/wallet-connect", async (req, res) => {
  try {
    const { uuid, link } = await createXummPayload({
      txjson: { TransactionType: "SignIn" }
    });
    res.json({ uuid, link });
  } catch {
    res.status(500).json({ error: "Wallet connect failed" });
  }
});

// -------------------------------
// SUBMIT NFT
// -------------------------------
app.post("/api/submit", (req, res) => {
  try {
    const { wallet, name, description, imageCid, metadataCid, quantity } =
      req.body;

    const result = db
      .prepare(
        `
      INSERT INTO submissions
      (creator_wallet, name, description, image_cid, metadata_cid, batch_qty, status, payment_status, mint_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 'unpaid', 'pending', ?)
    `
      )
      .run(
        wallet,
        name,
        description,
        imageCid,
        metadataCid,
        quantity,
        new Date().toISOString()
      );

    res.json({ submitted: true, id: result.lastInsertRowid });
  } catch {
    res.status(500).json({ error: "Submission failed" });
  }
});

// -------------------------------
// UPLOAD TO PINATA
// -------------------------------
app.post("/api/upload", async (req, res) => {
  try {
    if (!req.files || !req.files.file)
      return res.status(400).json({ error: "No file received" });

    const file = req.files.file;
    const formData = new FormData();
    formData.append("file", file.data, file.name);

    const upload = await axios.post(
      "https://api.pinata.cloud/pinning/pinFileToIPFS",
      formData,
      {
        maxBodyLength: "Infinity",
        headers: {
          ...formData.getHeaders(),
          pinata_api_key: PINATA_API_KEY,
          pinata_secret_api_key: PINATA_API_SECRET
        }
      }
    );

    res.json({
      cid: upload.data.IpfsHash,
      uri: "ipfs://" + upload.data.IpfsHash
    });
  } catch (err) {
    res.status(500).json({ error: "Upload failed" });
  }
});

// -------------------------------
// ADMIN (GET SUBMISSIONS)
// -------------------------------
app.get("/api/admin/submissions", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  const rows = db.prepare(`SELECT * FROM submissions ORDER BY id DESC`).all();
  res.json(rows);
});

// -------------------------------
// ADMIN APPROVE
// -------------------------------
app.post("/api/admin/approve", (req, res) => {
  const { id, password } = req.body;

  if (password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  db.prepare(`UPDATE submissions SET status='approved' WHERE id=?`).run(id);

  res.json({ approved: true });
});

// -------------------------------
// PAY 5 XRP — NO WEBHOOKS
// -------------------------------
app.post("/api/pay-xrp", async (req, res) => {
  try {
    const { submissionId } = req.body;

    const drops = xrpl.xrpToDrops("5");
    const memoHex = Buffer.from(`PAYMENT_${submissionId}`).toString("hex");

    const { uuid, link } = await createXummPayload({
      txjson: {
        TransactionType: "Payment",
        Destination: PAYMENT_DEST,
        Amount: drops,
        Memos: [
          {
            Memo: {
              MemoData: memoHex
            }
          }
        ]
      }
    });

    res.json({ uuid, link });
  } catch {
    res.status(500).json({ error: "Payment failed" });
  }
});

// -------------------------------
// AUTO MINT — NO WEBHOOKS
// -------------------------------
async function autoMint(submissionId) {
  const sub = db.prepare(`SELECT * FROM submissions WHERE id=?`).get(submissionId);
  if (!sub) return;

  const memoHex = Buffer.from(`MINT_${submissionId}`).toString("hex");

  await createXummPayload({
    txjson: {
      TransactionType: "NFTokenMint",
      Account: sub.creator_wallet,
      URI: xrpl.convertStringToHex(`ipfs://${sub.metadata_cid}`),
      Flags: 8,
      NFTokenTaxon: 1,
      Memos: [
        {
          Memo: {
            MemoData: memoHex
          }
        }
      ]
    }
  });
}

// -------------------------------
// START SERVER
// -------------------------------
app.listen(PORT, () => {
  console.log("CFC NFT Creator Backend running on", PORT);
});
