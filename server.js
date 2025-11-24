// ===============================
// CFC NFT CREATOR — BACKEND (PHASE 3)
// FIXED FOR RENDER — better-sqlite3 VERSION + CORS ALLOW LIST
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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // "CFCBaby3!"
const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_API_SECRET = process.env.PINATA_API_SECRET;
const PORT = process.env.PORT || 4000;

// -------------------------------
//  APP INIT
// -------------------------------
const app = express();

// *** CORS FIX — REQUIRED FOR FRONT-END TO CONNECT ***
app.use(cors({
  origin: [
    "https://centerforcreators.com",
    "https://centerforcreators.com/nft-marketplace",
    "https://centerforcreators.com/nft-creator",
    "https://centerforcreators.github.io",
    "https://centerforcreators.github.io/cfc-nft-creator-frontend"
  ],
  methods: ["GET", "POST"],
  credentials: true
}));

app.use(express.json());
app.use(fileUpload());

// -------------------------------
//  SQLITE INITIALIZATION
// -------------------------------
const db = new Database("./submissions.sqlite");

// Create table if missing
db.prepare(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_wallet TEXT,
    name TEXT,
    description TEXT,
    image_cid TEXT,
    metadata_cid TEXT,
    batch_qty INTEGER,
    status TEXT,       -- pending / approved / rejected / minted
    created_at TEXT
  )
`).run();

// -------------------------------
//  ADMIN LOGIN
// -------------------------------
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;

  if (!password || password !== ADMIN_PASSWORD) {
    return res.json({ success: false });
  }
  res.json({ success: true });
});

// -------------------------------
//  UPLOAD FILE TO PINATA
// -------------------------------
app.post("/api/upload", async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ error: "No file received." });
    }

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

    res.json({
      cid,
      uri: `ipfs://${cid}`
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Upload failed." });
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

    const stmt = db.prepare(`
      INSERT INTO submissions
      (creator_wallet, name, description, image_cid, metadata_cid, batch_qty, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      wallet,
      name,
      description,
      imageCid,
      metadataCid,
      quantity,
      "pending",
      new Date().toISOString()
    );

    res.json({ submitted: true });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Submission failed." });
  }
});

// -------------------------------
//  ADMIN: GET ALL SUBMISSIONS
// -------------------------------
app.get("/api/admin/submissions", (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.json({ error: "Unauthorized" });

  const submissions = db.prepare(`SELECT * FROM submissions ORDER BY id DESC`).all();
  res.json(submissions);
});

// -------------------------------
//  ADMIN: APPROVE SUBMISSION
// -------------------------------
app.post("/api/admin/approve", (req, res) => {
  const { id, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.json({ error: "Unauthorized" });

  db.prepare(`UPDATE submissions SET status = 'approved' WHERE id = ?`).run(id);
  res.json({ approved: true });
});

// -------------------------------
//  ADMIN: REJECT SUBMISSION
// -------------------------------
app.post("/api/admin/reject", (req, res) => {
  const { id, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.json({ error: "Unauthorized" });

  db.prepare(`UPDATE submissions SET status = 'rejected' WHERE id = ?`).run(id);
  res.json({ rejected: true });
});

// -------------------------------
//  ADMIN: MINT NFT (XLS-20)
// -------------------------------
app.post("/api/admin/mint", async (req, res) => {
  const { id, password } = req.body;

  if (password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  const sub = db.prepare(`SELECT * FROM submissions WHERE id = ?`).get(id);
  if (!sub) return res.json({ error: "Not found" });

  try {
    const client = new xrpl.Client("wss://s1.ripple.com");
    await client.connect();

    const mintTx = {
      TransactionType: "NFTokenMint",
      Account: sub.creator_wallet,
      URI: xrpl.convertStringToHex(`ipfs://${sub.metadata_cid}`),
      Flags: 8,
      NFTokenTaxon: 1
    };

    const resp = await client.submit(mintTx);
    await client.disconnect();

    db.prepare(`UPDATE submissions SET status = 'minted' WHERE id = ?`).run(id);

    res.json({ minted: true, xrpl: resp });

  } catch (err) {
    console.log(err);
    res.status(500).json({ minted: false, error: "Minting failed." });
  }
});

// -------------------------------
//  START SERVER
// -------------------------------
app.listen(PORT, () =>
  console.log(`CFC NFT Creator Backend running on port ${PORT}`)
);
