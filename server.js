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
// ⭐ FIX 1 — Add terms + prices (persistent)
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
// SUBMIT NFT
// -------------------------------
// ⭐ FIX 2 — store terms + prices in DB
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
// (ALL OTHER ROUTES UNCHANGED)
// -------------------------------
