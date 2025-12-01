// ========================================
// CFC NFT CREATOR — PAYMENT + MINT (FREE MODE)
// Uses Xumm payload.get polling (no paid webhooks)
// ========================================

import express from "express";
import cors from "cors";
import fileUpload from "express-fileupload";
import axios from "axios";
import FormData from "form-data";
import xrpl from "xrpl";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// -------------------------------
// CONFIG
// -------------------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_API_SECRET = process.env.PINATA_API_SECRET;
const XUMM_API_KEY = process.env.XUMM_API_KEY;
const XUMM_API_SECRET = process.env.XUMM_API_SECRET;

const PAYMENT_DEST = "rU15yYD3cHmNXGxHJSJGoLUSogxZ17FpKd";
const CREATOR_PAGE = "https://centerforcreators.com/nft-creator";
const PORT = process.env.PORT || 4000;

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
    ],
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// -------------------------------
// DATABASE INITIALIZATION
// -------------------------------
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      creator_wallet TEXT,
      name TEXT,
      description TEXT,
      image_cid TEXT,
      metadata_cid TEXT,
      batch_qty INTEGER,
      status TEXT,
      payment_status TEXT DEFAULT 'unpaid',
      mint_status TEXT DEFAULT 'pending',
      created_at TEXT,
      payment_uuid TEXT,
      mint_uuid TEXT
    );
  `);
}
initDB();

// -------------------------------
// UTIL — MAKE + GET PAYLOAD
// -------------------------------
async function createXummPayload(payload) {
  const r = await axios.post(
    "https://xumm.app/api/v1/platform/payload",
    payload,
    {
      headers: {
        "X-API-Key": XUMM_API_KEY,
        "X-API-Secret": XUMM_API_SECRET,
        "Content-Type": "application/json",
      },
    }
  );
  return { uuid: r.data.uuid, link: r.data.next.always };
}

async function getXummPayload(uuid) {
  const r = await axios.get(
    `https://xumm.app/api/v1/platform/payload/${uuid}`,
    {
      headers: {
        "X-API-Key": XUMM_API_KEY,
        "X-API-Secret": XUMM_API_SECRET,
      },
    }
  );
  return r.data;
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
app.post("/api/submit", async (req, res) => {
  try {
    const { wallet, name, description, imageCid, metadataCid, quantity } =
      req.body;

    const result = await pool.query(
      `
      INSERT INTO submissions
      (creator_wallet, name, description, image_cid, metadata_cid, batch_qty, status, payment_status, mint_status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'pending','unpaid','pending',$7)
      RETURNING id
    `,
      [wallet, name, description, imageCid, metadataCid, quantity, new Date().toISOString()]
    );

    res.json({ submitted: true, id: result.rows[0].id });
  } catch (err) {
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

    res.json({ cid: upload.data.IpfsHash, uri: "ipfs://" + upload.data.IpfsHash });
  } catch {
    res.status(500).json({ error: "Upload failed" });
  }
});

// -------------------------------
// ADMIN — GET ALL SUBMISSIONS
// -------------------------------
app.get("/api/admin/submissions", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  const rows = await pool.query(`SELECT * FROM submissions ORDER BY id DESC`);
  res.json(rows.rows);
});

app.post("/api/admin/approve", async (req, res) => {
  const { id, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.json({ error: "Unauthorized" });

  await pool.query(`UPDATE submissions SET status='approved' WHERE id=$1`, [id]);
  res.json({ approved: true });
});

app.post("/api/admin/reject", async (req, res) => {
  const { id, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.json({ error: "Unauthorized" });

  await pool.query(`UPDATE submissions SET status='rejected' WHERE id=$1`, [id]);
  res.json({ rejected: true });
});

// -------------------------------
// PAY 5 XRP
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
      options: { return_url: { app: CREATOR_PAGE, web: CREATOR_PAGE } },
      custom_meta: { identifier: `PAYMENT_${submissionId}` },
    });

    await pool.query(`UPDATE submissions SET payment_uuid=$1 WHERE id=$2`, [
      uuid,
      submissionId,
    ]);

    res.json({ uuid, link });
  } catch {
    res.status(500).json({ error: "Payment failed" });
  }
});

// -------------------------------
// CREATE MINT PAYLOAD
// -------------------------------
async function createMintPayload(submissionId) {
  const sub = await pool.query(`SELECT * FROM submissions WHERE id=$1`, [submissionId]);
  if (!sub.rows.length) return null;

  const s = sub.rows[0];

  const mintTx = {
    TransactionType: "NFTokenMint",
    Account: s.creator_wallet,
    URI: xrpl.convertStringToHex(`ipfs://${s.metadata_cid}`),
    Flags: 8,
    NFTokenTaxon: 1,
  };

  const { uuid, link } = await createXummPayload({
    txjson: mintTx,
    options: { return_url: { app: CREATOR_PAGE, web: CREATOR_PAGE } },
    custom_meta: { identifier: `MINT_${submissionId}` },
  });

  await pool.query(`UPDATE submissions SET mint_uuid=$1 WHERE id=$2`, [
    uuid,
    submissionId,
  ]);

  return { uuid, link };
}

// -------------------------------
// MARK PAID
// -------------------------------
app.post("/api/mark-paid", async (req, res) => {
  try {
    const { id, uuid } = req.body;

    const sub = await pool.query(`SELECT * FROM submissions WHERE id=$1`, [id]);
    if (!sub.rows.length) return res.status(404).json({ error: "Not found" });

    const payload = await getXummPayload(uuid);
    const signed = payload?.meta?.signed ?? payload?.signed;
    const resolved = payload?.meta?.resolved ?? payload?.resolved;

    if (!resolved || !signed) return res.json({ ok: false });

    await pool.query(`UPDATE submissions SET payment_status='paid' WHERE id=$1`, [
      id,
    ]);

    const mint = await createMintPayload(id);

    if (!mint) return res.json({ ok: true, mintCreated: false });

    res.json({
      ok: true,
      mintCreated: true,
      mintUuid: mint.uuid,
      mintLink: mint.link,
    });
  } catch {
    res.status(500).json({ error: "mark-paid failed" });
  }
});

// -------------------------------
// MARK MINTED
// -------------------------------
app.post("/api/mark-minted", async (req, res) => {
  try {
    const { id, uuid } = req.body;

    const sub = await pool.query(`SELECT * FROM submissions WHERE id=$1`, [id]);
    if (!sub.rows.length) return res.status(404).json({ error: "Not found" });

    const payload = await getXummPayload(uuid);
    const signed = payload?.meta?.signed ?? payload?.signed;
    const resolved = payload?.meta?.resolved ?? payload?.resolved;

    if (!resolved || !signed) return res.json({ ok: false });

    await pool.query(`UPDATE submissions SET mint_status='minted' WHERE id=$1`, [
      id,
    ]);

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "mark-minted failed" });
  }
});

// -------------------------------
// ⭐ NEW: START MINT (MANUAL MINT BUTTON)
// -------------------------------
app.post("/api/start-mint", async (req, res) => {
  const { id } = req.body;

  const sub = await pool.query(`SELECT * FROM submissions WHERE id=$1`, [id]);
  if (!sub.rows.length) return res.status(404).json({ error: "Not found" });

  const s = sub.rows[0];

  const mintTx = {
    TransactionType: "NFTokenMint",
    Account: s.creator_wallet,
    URI: xrpl.convertStringToHex(`ipfs://${s.metadata_cid}`),
    Flags: 8,
    NFTokenTaxon: 1,
  };

  const { uuid, link } = await createXummPayload({
    txjson: mintTx,
    options: { return_url: { app: CREATOR_PAGE, web: CREATOR_PAGE } },
  });

  // ⭐ ONLY FIX YOU REQUESTED (kept exactly)
  await pool.query(
    `UPDATE submissions SET mint_status='minted', mint_uuid=$1 WHERE id=$2`,
    [uuid, id]
  );

  res.json({ uuid, link });
});

// -------------------------------
// OPTIONAL NO-OP WEBHOOK
// -------------------------------
app.post("/api/xumm-webhook", async (req, res) => {
  res.json({ received: true });
});

// -------------------------------
// START SERVER
–-------------------------------
app.listen(PORT, () => {
  console.log("CFC NFT Creator Backend running on", PORT);
});
