// ========================================
// CFC NFT CREATOR — AUTOMATIC PAYMENT + MINT + REVERSE PROXY IFRAME FIX
// ========================================

import express from "express";
import cors from "cors";
import fileUpload from "express-fileupload";
import axios from "axios";
import FormData from "form-data";
import Database from "better-sqlite3";
import xrpl from "xrpl";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

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
// PATH HELPERS
// -------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
      "https://centerforcreators.github.io/cfc-nft-creator-frontend",
      "https://cfc-nft-creator-backend.onrender.com"
    ],
    methods: ["GET", "POST"],
    credentials: true,
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
      "Content-Type": "application/json",
    },
  });

  return {
    uuid: r.data.uuid,
    link: r.data.next.always,
  };
}

// -------------------------------
// WALLET CONNECT
// -------------------------------
app.post("/api/wallet-connect", async (req, res) => {
  try {
    const { uuid, link } = await createXummPayload({
      txjson: { TransactionType: "SignIn" },
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
    const { wallet, name, description, imageCid, metadataCid, quantity } = req.body;

    const result = db
      .prepare(
        `
      INSERT INTO submissions
      (creator_wallet, name, description, image_cid, metadata_cid, batch_qty, status, payment_status, mint_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 'unpaid', 'pending', ?)
    `
      )
      .run(wallet, name, description, imageCid, metadataCid, quantity, new Date().toISOString());

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
          pinata_secret_api_key: PINATA_API_SECRET,
        },
      }
    );

    res.json({
      cid: upload.data.IpfsHash,
      uri: "ipfs://" + upload.data.IpfsHash,
    });
  } catch {
    res.status(500).json({ error: "Upload failed" });
  }
});

// -------------------------------
// ADMIN GET SUBMISSIONS
// -------------------------------
app.get("/api/admin/submissions", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  const rows = db.prepare("SELECT * FROM submissions ORDER BY id DESC").all();
  res.json(rows);
});

// -------------------------------
// ADMIN APPROVE
// -------------------------------
app.post("/api/admin/approve", (req, res) => {
  const { id, password } = req.body;

  if (password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  db.prepare("UPDATE submissions SET status='approved' WHERE id=?").run(id);

  res.json({ approved: true });
});

// -------------------------------
// PAY 5 XRP — RETURN-WEBHOOK MODE
// -------------------------------
app.post("/api/pay-xrp", async (req, res) => {
  try {
    const { submissionId } = req.body;
    const drops = xrpl.xrpToDrops("5");

    const { uuid, link } = await createXummPayload({
      txjson: {
        TransactionType: "Payment",
        Destination: PAYMENT_DEST,
        Amount: drops,
      },
      options: {
        return_url: {
          app: CREATOR_PAGE,
          web: CREATOR_PAGE,
          webhook: `https://cfc-nft-creator-backend.onrender.com/api/xumm-return`,
        },
      },
      custom_meta: {
        identifier: `PAYMENT_${submissionId}`,
      },
    });

    res.json({ uuid, link });
  } catch {
    res.status(500).json({ error: "Payment failed" });
  }
});

// -------------------------------
// AUTO-MINT FUNCTION
// -------------------------------
async function autoMint(submissionId) {
  const sub = db.prepare("SELECT * FROM submissions WHERE id=?").get(submissionId);
  if (!sub) return;

  try {
    const mintTx = {
      TransactionType: "NFTokenMint",
      Account: sub.creator_wallet,
      URI: xrpl.convertStringToHex(`ipfs://${sub.metadata_cid}`),
      Flags: 8,
      NFTokenTaxon: 1,
    };

    await createXummPayload({
      txjson: mintTx,
      options: {
        return_url: {
          app: CREATOR_PAGE,
          web: CREATOR_PAGE,
          webhook: `https://cfc-nft-creator-backend.onrender.com/api/xumm-return`,
        },
      },
      custom_meta: {
        identifier: `MINT_${submissionId}`,
      },
    });
  } catch (err) {
    console.log("Mint error:", err.message);
  }
}

// -------------------------------
// RETURN-WEBHOOK HANDLER
// -------------------------------
app.get("/api/xumm-return", (req, res) => {
  const payload = req.query;

  // PAYMENT COMPLETED
  if (payload.custom_meta?.identifier?.startsWith("PAYMENT_") && payload.signed === "true") {
    const id = payload.custom_meta.identifier.replace("PAYMENT_", "");
    db.prepare("UPDATE submissions SET payment_status='paid' WHERE id=?").run(id);
    autoMint(id);
  }

  // MINT COMPLETED
  if (payload.custom_meta?.identifier?.startsWith("MINT_") && payload.signed === "true") {
    const id = payload.custom_meta.identifier.replace("MINT_", "");
    db.prepare("UPDATE submissions SET mint_status='minted' WHERE id=?").run(id);
  }

  return res.redirect(CREATOR_PAGE);
});

// -------------------------------
// REMOVE LEGACY WEBHOOK (SAFE)
// -------------------------------
// It never runs on Render free tier & is no longer needed.

// -------------------------------
// REVERSE PROXY IFRAME FIX
// -------------------------------
app.get("/proxy/creator", (req, res) => {
  res.sendFile(path.join(__dirname, "creator-proxy.html"));
});

app.get("/proxy/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin-proxy.html"));
});

// -------------------------------
// START SERVER
// -------------------------------
app.listen(PORT, () => {
  console.log("CFC NFT Creator Backend running on", PORT);
});
