// ========================================
// CFC NFT CREATOR — AUTOMATED MINT VERSION
// Payment → Auto Mint → Auto Redirect
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

// -------------------------------
// XUMM CALLBACK URL
// MUST MATCH YOUR XUMM APP SETTINGS
// -------------------------------
const WEBHOOK_URL = `https://cfc-nft-creator-backend.onrender.com/api/xumm-webhook`;

// -------------------------------
// APP INIT
// -------------------------------
const app = express();
app.use(express.json());
app.use(fileUpload());

app.use(cors({
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
}));

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
// UTILITY: XUMM PAYLOAD
// -------------------------------
async function createXummPayload(payload) {
  const r = await axios.post(
    "https://xumm.app/api/v1/platform/payload",
    payload,
    {
      headers: {
        "X-API-Key": XUMM_API_KEY,
        "X-API-Secret": XUMM_API_SECRET,
        "Content-Type": "application/json"
      }
    }
  );

  return {
    uuid: r.data.uuid,
    link: r.data.next.always
  };
}

// -------------------------------
// WALLET CONNECT
// -------------------------------
app.post("/api/wallet-connect", async (req, res) => {
  try {
    const { uuid, link } = await createXummPayload({
      txjson: { TransactionType: "SignIn" }
    });

    res.json({ uuid, link });
  } catch (err) {
    res.status(500).json({ error: "Wallet connect failed" });
  }
});

// -------------------------------
// PAY 5 XRP → AUTOMATICALLY MINT
// -------------------------------
app.post("/api/pay-xrp", async (req, res) => {
  try {
    const drops = xrpl.xrpToDrops("5");
    const { submissionId } = req.body;

    if (!submissionId) {
      return res.json({ error: "Missing submissionId" });
    }

    // Create payment payload
    const { uuid, link } = await createXummPayload({
      txjson: {
        TransactionType: "Payment",
        Destination: PAYMENT_DEST,
        Amount: drops
      },
      options: {
        return_url: {
          app: CREATOR_PAGE,
          web: CREATOR_PAGE
        }
      },
      custom_meta: {
        identifier: `PAYMENT_${submissionId}`
      }
    });

    res.json({ uuid, link });
  } catch (err) {
    res.status(500).json({ error: "Payment failed" });
  }
});

// -------------------------------
// SUBMIT NFT
// -------------------------------
app.post("/api/submit", (req, res) => {
  try {
    const {
      wallet,
      name,
      description,
      imageCid,
      metadataCid,
      quantity
    } = req.body;

    const result = db.prepare(`
      INSERT INTO submissions
      (creator_wallet, name, description, image_cid, metadata_cid, batch_qty, status, payment_status, mint_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 'unpaid', 'pending', ?)
    `).run(
      wallet,
      name,
      description,
      imageCid,
      metadataCid,
      quantity,
      new Date().toISOString()
    );

    res.json({ submitted: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: "Submission failed" });
  }
});

// -------------------------------
// ADMIN GET SUBMISSIONS
// -------------------------------
app.get("/api/admin/submissions", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  const items = db.prepare(`SELECT * FROM submissions ORDER BY id DESC`).all();
  res.json(items);
});

// -------------------------------
// ADMIN APPROVE (ONLY STEP FOR ADMIN)
// -------------------------------
app.post("/api/admin/approve", (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  db.prepare(`UPDATE submissions SET status='approved' WHERE id=?`)
    .run(req.body.id);

  res.json({ approved: true });
});

// -------------------------------
// XUMM WEBHOOK (PAYMENT + MINT AUTOMATION)
// -------------------------------
app.post("/api/xumm-webhook", async (req, res) => {
  const data = req.body;

  if (!data || !data.custom_meta || !data.custom_meta.identifier) {
    return res.json({ received: true });
  }

  const identifier = data.custom_meta.identifier;

  // -----------------------------------
  // PAYMENT DETECTED
  // -----------------------------------
  if (identifier.startsWith("PAYMENT_") && data.signed === true) {
    const submissionId = identifier.replace("PAYMENT_", "");

    // Mark as paid
    db.prepare(`
      UPDATE submissions
      SET payment_status='paid'
      WHERE id=?
    `).run(submissionId);

    // Auto-mint
    autoMint(submissionId);
  }

  res.json({ received: true });
});

// -------------------------------
// AUTOMATIC MINT FUNCTION
// -------------------------------
async function autoMint(submissionId) {
  const sub = db.prepare(`SELECT * FROM submissions WHERE id=?`).get(submissionId);

  if (!sub) return;

  try {
    const mintTx = {
      TransactionType: "NFTokenMint",
      Account: sub.creator_wallet,
      URI: xrpl.convertStringToHex(`ipfs://${sub.metadata_cid}`),
      Flags: 8,
      NFTokenTaxon: 1
    };

    // Create mint payload → user signs
    const { uuid, link } = await createXummPayload({
      txjson: mintTx,
      options: {
        return_url: {
          app: CREATOR_PAGE,
          web: CREATOR_PAGE
        }
      },
      custom_meta: {
        identifier: `MINT_${submissionId}`
      }
    });

    // Wait for XUMM to handle it (user signs)
    return link;

  } catch (err) {
    console.log("Mint error:", err.message);
  }
}

// -------------------------------
// XUMM WEBHOOK HANDLES MINT TOO
// -------------------------------
app.post("/api/xumm-webhook", (req, res) => {
  const data = req.body;

  if (!data || !data.custom_meta) return res.json({ received: true });

  const id = data.custom_meta.identifier;

  // MINT SUCCESS
  if (id.startsWith("MINT_") && data.signed === true) {
    const submissionId = id.replace("MINT_", "");

    db.prepare(`
      UPDATE submissions
      SET mint_status='minted'
      WHERE id=?
    `).run(submissionId);
  }

  res.json({ received: true });
});

// -------------------------------
// START SERVER
// -------------------------------
app.listen(PORT, () => {
  console.log("CFC NFT Creator Backend running on port", PORT);
});
