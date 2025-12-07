// ========================================
// CFC NFT CREATOR — PAYMENT + MINT + MARKETPLACE SYNC + REDIRECT (RESTORED PAY FLOW)
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

const MARKETPLACE_BACKEND =
  "https://cfc-nft-shared-mint-backend.onrender.com/api/add-nft";

const PORT = process.env.PORT || 4000;

// -------------------------------
// APP INIT
// -------------------------------
const app = express();
app.use(express.json());
app.use(fileUpload());

app.use(
  cors({
    origin: function (origin, callback) {
      const allowed = [
        "https://centerforcreators.com",
        "https://centerforcreators.github.io",
      ];
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS blocked: " + origin));
      }
    },
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
// UTIL — XUMM PAYLOAD (RESTORED FORMAT + REDIRECT)
// -------------------------------
async function createXummPayload(txjson) {
  const r = await axios.post(
    "https://xumm.app/api/v1/platform/payload",
    {
      txjson,
      options: {
        return_url: {
          web: CREATOR_PAGE,
          app: CREATOR_PAGE,
        },
      },
    },
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
    res.status(500).json({ error: "Submission failed" });
  }
});

// -------------------------------
// ADMIN ROUTES
// -------------------------------
app.get("/api/admin/submissions", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Unauthorized" });

  const rows = await pool.query("SELECT * FROM submissions ORDER BY id DESC");
  res.json(rows.rows);
});

app.post("/api/admin/approve", async (req, res) => {
  const { id, password } = req.body;
  if (password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Unauthorized" });

  await pool.query("UPDATE submissions SET status='approved' WHERE id=$1", [id]);
  res.json({ ok: true });
});

app.post("/api/admin/reject", async (req, res) => {
  const { id, password } = req.body;
  if (password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Unauthorized" });

  await pool.query("UPDATE submissions SET status='rejected' WHERE id=$1", [id]);
  res.json({ ok: true });
});

// -------------------------------
// PAY XRP (RESTORED WORKING FORMAT)
// -------------------------------
app.post("/api/pay-xrp", async (req, res) => {
  try {
    const { submissionId } = req.body;

    const payload = {
      TransactionType: "Payment",
      Destination: PAYMENT_DEST,
      Amount: String(5 * 1_000_000),
    };

    const { uuid, link } = await createXummPayload(payload);

    await pool.query("UPDATE submissions SET payment_uuid=$1 WHERE id=$2", [
      uuid,
      submissionId,
    ]);

    res.json({ uuid, link });
  } catch (err) {
    res.status(500).json({ error: "Failed to create payment payload" });
  }
});

// -------------------------------
// MARK PAID
// -------------------------------
app.post("/api/mark-paid", async (req, res) => {
  const { id } = req.body;

  await pool.query(
    "UPDATE submissions SET payment_status='paid' WHERE id=$1",
    [id]
  );

  res.json({ ok: true });
});

// -------------------------------
// START MINT (REDIRECT + WORKING FORMAT)
// -------------------------------
app.post("/api/start-mint", async (req, res) => {
  try {
    const { id } = req.body;

    const result = await pool.query(
      "SELECT metadata_cid FROM submissions WHERE id=$1",
      [id]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Submission not found" });

    const metadataCid = result.rows[0].metadata_cid;
    const uriHex = Buffer.from("ipfs://" + metadataCid).toString("hex");

    const payload = {
      TransactionType: "NFTokenMint",
      Flags: 8,
      URI: uriHex,
      NFTokenTaxon: 0,
    };

    const { uuid, link } = await createXummPayload(payload);

    await pool.query("UPDATE submissions SET mint_uuid=$1 WHERE id=$2", [
      uuid,
      id,
    ]);

    res.json({ uuid, link });
  } catch (err) {
    res.status(500).json({ error: "Failed to create mint payload" });
  }
});

// -------------------------------
// MARK MINTED + SEND TO MARKETPLACE
// -------------------------------
app.post("/api/mark-minted", async (req, res) => {
  const { id } = req.body;

  await pool.query(
    "UPDATE submissions SET mint_status='minted' WHERE id=$1",
    [id]
  );

  const q = await pool.query("SELECT * FROM submissions WHERE id=$1", [id]);
  const sub = q.rows[0];

  try {
    await axios.post(MARKETPLACE_BACKEND, {
      submission_id: sub.id,
      name: sub.name,
      description: sub.description,
      image_cid: sub.image_cid,
      metadata_cid: sub.metadata_cid,
      price_xrp: sub.price_xrp,
      price_rlusd: sub.price_rlusd,
      creator_wallet: sub.creator_wallet,
    });
  } catch (e) {
    console.error("Marketplace sync failed:", e.message);
  }

  res.json({ ok: true });
});

// -------------------------------
// START SERVER
// -------------------------------
app.listen(PORT, () => {
  console.log("CFC NFT Creator Backend running on", PORT);
});
