// ===============================
// CFC NFT CREATOR — BACKEND (PHASE 2)
// server.js
// ===============================

import express from "express";
import cors from "cors";
import fileUpload from "express-fileupload";
import axios from "axios";
import FormData from "form-data";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
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
app.use(cors());
app.use(express.json());
app.use(fileUpload());

// -------------------------------
//  SQLITE DATABASE
// -------------------------------
let db;

async function initDB() {
  db = await open({
    filename: "./submissions.sqlite",
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_wallet TEXT,
      name TEXT,
      description TEXT,
      image_cid TEXT,
      metadata_cid TEXT,
      batch_qty INTEGER,
      status TEXT,        -- pending / approved / rejected
      created_at TEXT
    );
  `);
}
initDB();

// -------------------------------
//  ADMIN LOGIN
// -------------------------------
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;

  if (!password) return res.json({ success: false });

  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true });
  }

  return res.json({ success: false });
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
app.post("/api/submit", async (req, res) => {
  try {
    const {
      wallet,
      name,
      description,
      imageCid,
      metadataCid,
      quantity
    } = req.body;

    await db.run(
      `INSERT INTO submissions (creator_wallet, name, description, image_cid, metadata_cid, batch_qty, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        wallet,
        name,
        description,
        imageCid,
        metadataCid,
        quantity,
        "pending",
        new Date().toISOString()
      ]
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
app.get("/api/admin/submissions", async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.json({ error: "Not authorized" });

  const submissions = await db.all(`SELECT * FROM submissions ORDER BY id DESC`);
  res.json(submissions);
});

// -------------------------------
//  ADMIN: APPROVE SUBMISSION
// -------------------------------
app.post("/api/admin/approve", async (req, res) => {
  const { id, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.json({ error: "Unauthorized" });

  await db.run(`UPDATE submissions SET status = 'approved' WHERE id = ?`, [id]);
  res.json({ approved: true });
});

// -------------------------------
//  ADMIN: REJECT SUBMISSION
// -------------------------------
app.post("/api/admin/reject", async (req, res) => {
  const { id, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.json({ error: "Unauthorized" });

  await db.run(`UPDATE submissions SET status = 'rejected' WHERE id = ?`, [id]);
  res.json({ rejected: true });
});

// -------------------------------
//  ADMIN: MINT NFT (XLS-20)
// -------------------------------
app.post("/api/admin/mint", async (req, res) => {
  const { id, password } = req.body;

  if (password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  const sub = await db.get(`SELECT * FROM submissions WHERE id = ?`, [id]);

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

    await db.run(`UPDATE submissions SET status = 'minted' WHERE id = ?`, [id]);

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

