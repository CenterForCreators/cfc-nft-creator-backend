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
        null
      ];
      if (!origin || allowed.includes(origin)) callback(null, true);
      else callback(new Error("CORS blocked: " + origin));
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
      price_rlusd TEXT,
      email TEXT,
      website TEXT,
      rejection_reason TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS learn_user_progress (
      id SERIAL PRIMARY KEY,
      wallet TEXT NOT NULL,
      submission_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      action_ref TEXT NOT NULL,
      completed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(wallet, submission_id, action_type, action_ref)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS learn_rewards_ledger (
      id SERIAL PRIMARY KEY,
      wallet TEXT NOT NULL,
      submission_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      action_ref TEXT NOT NULL,
      tokens_earned NUMERIC(20,8) DEFAULT 0,
      tokens_paid NUMERIC(20,8) DEFAULT 0,
      tx_hash TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
initDB();

// -------------------------------
// UTIL — XUMM PAYLOAD
// -------------------------------
async function createXummPayload(txjson) {
  const r = await axios.post(
    "https://xumm.app/api/v1/platform/payload",
    {
      txjson,
      options: { return_url: { web: CREATOR_PAGE, app: CREATOR_PAGE } },
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
// LEARN-TO-EARN TRACK
// -------------------------------
app.post("/api/learn/track", async (req, res) => {
  try {
    const { wallet, submission_id, action_type, action_ref } = req.body;
    if (!wallet || !submission_id || !action_type || !action_ref)
      return res.status(400).json({ error: "Missing fields" });

    const exists = await pool.query(
      `SELECT 1 FROM learn_user_progress
       WHERE wallet=$1 AND submission_id=$2 AND action_type=$3 AND action_ref=$4`,
      [wallet, submission_id, action_type, action_ref]
    );
    if (exists.rows.length) return res.json({ ok: true });

    await pool.query(
      `INSERT INTO learn_user_progress (wallet, submission_id, action_type, action_ref)
       VALUES ($1,$2,$3,$4)`,
      [wallet, submission_id, action_type, action_ref]
    );

    await pool.query(
      `INSERT INTO learn_rewards_ledger (wallet, submission_id, action_type, action_ref)
       VALUES ($1,$2,$3,$4)`,
      [wallet, submission_id, action_type, action_ref]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Learn failed" });
  }
});

// -------------------------------
// ADMIN — LEARN-TO-EARN VIEW
// -------------------------------
app.get("/api/admin/learn-activity", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Unauthorized" });

  const r = await pool.query(`
    SELECT * FROM learn_rewards_ledger
    ORDER BY created_at DESC
    LIMIT 500
  `);
  res.json(r.rows);
});

// -------------------------------
// ORIGINAL ROUTES (UNCHANGED)
// -------------------------------
app.post("/api/upload", async (req, res) => {
  const form = new FormData();
  form.append("file", req.files.file.data, req.files.file.name);
  const r = await axios.post(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    form,
    { headers: { ...form.getHeaders(), pinata_api_key: PINATA_API_KEY, pinata_secret_api_key: PINATA_API_SECRET } }
  );
  res.json({ cid: r.data.IpfsHash });
});

app.post("/api/submit", async (req, res) => {
  const m = JSON.parse(req.body.metadata || "{}");
  const r = await pool.query(
    `INSERT INTO submissions
     (creator_wallet,name,description,image_cid,metadata_cid,batch_qty,status,payment_status,mint_status,created_at,terms,price_xrp,price_rlusd,email,website)
     VALUES ($1,$2,$3,$4,$5,$6,'pending','unpaid','pending',$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      req.body.wallet, req.body.name, req.body.description,
      req.body.imageCid, req.body.metadataCid, req.body.quantity,
      new Date().toISOString(), m.terms, m.price_xrp, m.price_rlusd,
      req.body.email, req.body.website
    ]
  );
  res.json({ submitted: true, id: r.rows[0].id });
});

app.get("/api/admin/submissions", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Unauthorized" });
  const r = await pool.query("SELECT * FROM submissions ORDER BY id DESC");
  res.json(r.rows);
});

app.post("/api/admin/approve", async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.sendStatus(403);
  await pool.query("UPDATE submissions SET status='approved' WHERE id=$1", [req.body.id]);
  res.json({ ok: true });
});

app.post("/api/admin/reject", async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.sendStatus(403);
  await pool.query(
    "UPDATE submissions SET status='rejected', rejection_reason=$2 WHERE id=$1",
    [req.body.id, req.body.reason]
  );
  res.json({ ok: true });
});

app.post("/api/pay-xrp", async (req, res) => {
  const { uuid, link } = await createXummPayload({
    TransactionType: "Payment",
    Destination: PAYMENT_DEST,
    Amount: String(5_000_000),
  });
  await pool.query(
    "UPDATE submissions SET payment_status='paid', payment_uuid=$1 WHERE id=$2",
    [uuid, req.body.submissionId]
  );
  res.json({ uuid, link });
});

app.post("/api/start-mint", async (req, res) => {
  const q = await pool.query("SELECT metadata_cid FROM submissions WHERE id=$1", [req.body.id]);
  const uriHex = Buffer.from("ipfs://" + q.rows[0].metadata_cid).toString("hex");
  const { uuid, link } = await createXummPayload({
    TransactionType: "NFTokenMint",
    Flags: 8,
    URI: uriHex,
    NFTokenTaxon: 0,
  });
  await pool.query("UPDATE submissions SET mint_uuid=$1 WHERE id=$2", [uuid, req.body.id]);
  res.json({ uuid, link });
});

app.post("/api/mark-minted", async (req, res) => {
  await pool.query("UPDATE submissions SET mint_status='minted' WHERE id=$1", [req.body.id]);
  const q = await pool.query("SELECT * FROM submissions WHERE id=$1", [req.body.id]);
  await axios.post(MARKETPLACE_BACKEND, q.rows[0]);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("CFC NFT Creator Backend running on", PORT);
});
