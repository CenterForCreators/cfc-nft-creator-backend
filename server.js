// ========================================
// CFC NFT CREATOR — PAYMENT + MINT (FREE MODE)
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
      mint_uuid TEXT,
      terms TEXT,
      price_xrp TEXT,
      price_rlusd TEXT
    );
  `);
}
initDB();

// -------------------------------
// UTIL — XUMM PAYLOAD
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
// UPLOAD FILE TO PINATA
// -------------------------------
app.post("/api/upload", async (req, res) => {
  try {
    const file = req.files?.file;
    if (!file) return res.status(400).json({ error: "No file" });

    const form = new FormData();
    form.append("file", file.data, file.name);

    const uploadRes = await axios.post(
      "https://api.pinata.cloud/pinning/pinFileToIPFS",
      form,
      {
        headers: {
          ...form.getHeaders(),
          pinata_api_key: PINATA_API_KEY,
          pinata_secret_api_key: PINATA_API_SECRET,
        },
      }
    );

    res.json({ cid: uploadRes.data.IpfsHash });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// -------------------------------
// SUBMIT NFT
// -------------------------------
app.post("/api/submit", async (req, res) => {
  try {
    const { wallet, name, description, imageCid, metadataCid, quantity } =
      req.body;

    const metadataJSON = JSON.parse(req.body.metadata || "{}");

    const terms = metadataJSON.terms || null;
    const price_xrp = metadataJSON.price_xrp || null;
    const price_rlusd = metadataJSON.price_rlusd || null;

    const result = await pool.query(
      `
      INSERT INTO submissions
      (creator_wallet, name, description, image_cid, metadata_cid, batch_qty,
       status, payment_status, mint_status, created_at,
       terms, price_xrp, price_rlusd)
      VALUES ($1,$2,$3,$4,$5,$6,'pending','unpaid','pending',$7,$8,$9,$10)
      RETURNING id
      `,
      [
        wallet,
        name,
        description,
        imageCid,
        metadataCid,
        quantity,
        new Date().toISOString(),
        terms,
        price_xrp,
        price_rlusd,
      ]
    );

    res.json({ submitted: true, id: result.rows[0].id });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Submission failed" });
  }
});

// -------------------------------
// ADMIN — GET ALL SUBMISSIONS
// -------------------------------
app.get("/api/admin/submissions", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Unauthorized" });

  const rows = await pool.query("SELECT * FROM submissions ORDER BY id DESC");
  res.json(rows.rows);
});

// -------------------------------
// ADMIN — APPROVE
// -------------------------------
app.post("/api/admin/approve", async (req, res) => {
  const { id, password } = req.body;
  if (password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Unauthorized" });

  await pool.query("UPDATE submissions SET status='approved' WHERE id=$1", [
    id,
  ]);

  res.json({ ok: true });
});

// -------------------------------
// ADMIN — REJECT
// -------------------------------
app.post("/api/admin/reject", async (req, res) => {
  const { id, password } = req.body;
  if (password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Unauthorized" });

  await pool.query("UPDATE submissions SET status='rejected' WHERE id=$1", [
    id,
  ]);

  res.json({ ok: true });
});

// -------------------------------
// PAY XRP
// -------------------------------
app.post("/api/pay-xrp", async (req, res) => {
  const { submissionId } = req.body;

  const payload = {
    TransactionType: "Payment",
    Destination: PAYMENT_DEST,
    Amount: String(5 * 1_000_000), // 5 XRP
    Memos: [
      {
        Memo: {
          MemoType: Buffer.from("CFC_PAYMENT").toString("hex"),
          MemoData: Buffer.from(String(submissionId)).toString("hex"),
        },
      },
    ],
  };

  const { uuid, link } = await createXummPayload(payload);

  await pool.query("UPDATE submissions SET payment_uuid=$1 WHERE id=$2", [
    uuid,
    submissionId,
  ]);

  res.json({ uuid, link });
});

// -------------------------------
// MARK PAID
// -------------------------------
app.post("/api/mark-paid", async (req, res) => {
  const { id, uuid } = req.body;

  await pool.query(
    "UPDATE submissions SET payment_status='paid' WHERE id=$1",
    [id]
  );

  res.json({ ok: true });
});

// -------------------------------
// START MINT
// -------------------------------
app.post("/api/start-mint", async (req, res) => {
  const { id } = req.body;

  const payload = {
    TransactionType: "NFTokenMint",
    Flags: 8,
    URI: "",
    NFTokenTaxon: 0,
  };

  const { uuid, link } = await createXummPayload(payload);

  await pool.query("UPDATE submissions SET mint_uuid=$1 WHERE id=$2", [
    uuid,
    id,
  ]);

  res.json({ uuid, link });
});

// -------------------------------
// MARK MINTED
// -------------------------------
app.post("/api/mark-minted", async (req, res) => {
  const { id } = req.body;

  await pool.query(
    "UPDATE submissions SET mint_status='minted' WHERE id=$1",
    [id]
  );

  res.json({ ok: true });
});

// -------------------------------
// START SERVER
// -------------------------------
app.listen(PORT, () => {
  console.log("CFC NFT Creator Backend running on", PORT);
});
