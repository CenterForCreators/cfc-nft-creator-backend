// ===============================
// CFC NFT CREATOR — BACKEND (PHASE 4)
// Wallet Connect + Payments Added
// Secure For Render Deployment
// ===============================

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
//  CONFIG
// -------------------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_API_SECRET = process.env.PINATA_API_SECRET;
const XUMM_API_KEY = process.env.XUMM_API_KEY;
const XUMM_API_SECRET = process.env.XUMM_API_SECRET;

// Wallet where ALL minting fees go  
const PAYMENT_DEST = "rU15yYD3cHmNXGxHJSJGoLUSogxZ17FpKd";

const PORT = process.env.PORT || 4000;

// -------------------------------
//  APP INIT
// -------------------------------
const app = express();

app.use(cors({
  origin: [
    "https://centerforcreators.com",
    "https://centerforcreators.com/nft-marketplace",
    "https://centerforcreators.com/nft-creator",
    "https://centerforcreators.github.io",
    "https://centerforcreators.github.io/cfc-nft-creator-frontend"
    "https://centerforcreators.com/nft-creator/admin"
  ],
  methods: ["GET", "POST"],
  credentials: true
}));

app.use(express.json());
app.use(fileUpload());

// -------------------------------
//  SQLITE SETUP
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
    created_at TEXT
  )
`).run();

// -------------------------------
//  UTILITY: CREATE XUMM PAYLOAD
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
//  WALLET CONNECT (SignIn)
// -------------------------------
app.post("/api/wallet-connect", async (req, res) => {
  try {
    const { uuid, link } = await createXummPayload({
      txjson: { TransactionType: "SignIn" }
    });

    res.json({ uuid, link });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Wallet connect failed" });
  }
});

// -------------------------------
//  CHECK SIGN-IN (polling)
// -------------------------------
app.get("/api/check-signin/:uuid", async (req, res) => {
  try {
    const uuid = req.params.uuid;

    const r = await axios.get(
      `https://xumm.app/api/v1/platform/payload/${uuid}`,
      {
        headers: { "X-API-Key": XUMM_API_KEY }
      }
    );

    if (!r.data.response) return res.json({ signed: false });

    if (r.data.signed === true) {
      return res.json({
        signed: true,
        account: r.data.response.account
      });
    }

    res.json({ signed: false });

  } catch (err) {
    res.json({ signed: false });
  }
});

// -------------------------------
//  PAY XRP (Mint Fee)
// -------------------------------
app.post("/api/pay-xrp", async (req, res) => {
  try {
    const drops = xrpl.xrpToDrops("5");

    const { uuid, link } = await createXummPayload({
      txjson: {
        TransactionType: "Payment",
        Destination: PAYMENT_DEST,
        Amount: drops
      }
    });

    res.json({ uuid, link });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "XRP payment failed" });
  }
});

// -------------------------------
//  PAY RLUSD (Mint Fee)
// -------------------------------
app.post("/api/pay-rlusd", async (req, res) => {
  try {
    const { uuid, link } = await createXummPayload({
      txjson: {
      TransactionType: "Payment",
      Destination: PAYMENT_DEST,
      Amount: {
        currency: "524C555344000000000000000000000000000000",
        issuer: PAYMENT_DEST,
        value: "12.50"
      }
  );

    res.json({ uuid, link });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "RLUSD payment failed" });
  }
});

// -------------------------------
//  ADMIN LOGIN
// -------------------------------
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  res.json({ success: password === ADMIN_PASSWORD });
});

// -------------------------------
//  UPLOAD FILE TO PINATA
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
        }
      }
    );

    const cid = upload.data.IpfsHash;
    res.json({ cid, uri: `ipfs://${cid}` });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// -------------------------------
//  SUBMIT NFT FOR APPROVAL
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

    db.prepare(`
      INSERT INTO submissions
      (creator_wallet, name, description, image_cid, metadata_cid, batch_qty, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      wallet,
      name,
      description,
      imageCid,
      metadataCid,
      quantity,
      new Date().toISOString()
    );

    res.json({ submitted: true });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Submission failed" });
  }
});

// -------------------------------
//  ADMIN GET SUBMISSIONS
// -------------------------------
app.get("/api/admin/submissions", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  const items = db.prepare(`SELECT * FROM submissions ORDER BY id DESC`).all();
  res.json(items);
});

// -------------------------------
//  ADMIN APPROVE
// -------------------------------
app.post("/api/admin/approve", (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  db.prepare(`UPDATE submissions SET status='approved' WHERE id=?`)
    .run(req.body.id);

  res.json({ approved: true });
});

// -------------------------------
//  ADMIN REJECT
// -------------------------------
app.post("/api/admin/reject", (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  db.prepare(`UPDATE submissions SET status='rejected' WHERE id=?`)
    .run(req.body.id);

  res.json({ rejected: true });
});

// -------------------------------
//  ADMIN MINT (XLS-20) — FIXED
// -------------------------------
app.post("/api/admin/mint", async (req, res) => {
  const { id, password } = req.body;

  if (password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  const sub = db.prepare(`SELECT * FROM submissions WHERE id=?`).get(id);
  if (!sub) return res.json({ error: "Not found" });

  try {
    const client = new xrpl.Client("wss://s1.ripple.com");
    await client.connect();

    // Fetch account sequence
    const acct = await client.request({
      command: "account_info",
      account: sub.creator_wallet,
      ledger_index: "current"
    });

    // Build mint transaction
    const mintTx = {
      TransactionType: "NFTokenMint",
      Account: sub.creator_wallet,
      URI: xrpl.convertStringToHex(`ipfs://${sub.metadata_cid}`),
      Flags: 8,
      NFTokenTaxon: 1,
      Sequence: acct.result.account_data.Sequence
    };

    // XUMM signing payload
    const { uuid, link } = await createXummPayload({ txjson: mintTx });

    await client.disconnect();

    res.json({
      mint_ready: true,
      sign_url: link,
      uuid
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Minting failed", details: err.message });
  }
});

// -------------------------------
//  START SERVER
// -------------------------------
app.listen(PORT, () => {
  console.log(`CFC NFT Creator Backend running on port ${PORT}`);
});
