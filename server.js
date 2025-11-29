// ========================================
// CFC NFT CREATOR — PAYMENT + MINT (FREE MODE, MANUAL "MINT" BUTTON)
// Uses Xumm payload.get polling (no paid webhooks)
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

// Wallet where ALL payments go
const PAYMENT_DEST = "rU15yYD3cHmNXGxHJSJGoLUSogxZ17FpKd";

// Public creator page
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

try {
  db.prepare(`ALTER TABLE submissions ADD COLUMN payment_uuid TEXT`).run();
} catch (e) {}
try {
  db.prepare(`ALTER TABLE submissions ADD COLUMN mint_uuid TEXT`).run();
} catch (e) {}

// -------------------------------
// UTIL — MAKE XUMM PAYLOAD
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

  return {
    uuid: r.data.uuid,
    link: r.data.next.always,
  };
}

// Check payload status from Xumm
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
  } catch (err) {
    console.log("wallet-connect error:", err.message);
    res.status(500).json({ error: "Wallet connect failed" });
  }
});

// -------------------------------
// SUBMIT NFT
// -------------------------------
app.post("/api/submit", (req, res) => {
  try {
    const { wallet, name, description, imageCid, metadataCid, quantity } =
      req.body;

    const result = db
      .prepare(
        `
      INSERT INTO submissions
      (creator_wallet, name, description, image_cid, metadata_cid, batch_qty, status, payment_status, mint_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 'unpaid', 'pending', ?)
    `
      )
      .run(
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
    console.log("Submit error:", err.message);
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
  } catch (err) {
    console.log("Upload error:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

// -------------------------------
// ADMIN (GET SUBMISSIONS)
// -------------------------------
app.get("/api/admin/submissions", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  const rows = db.prepare(`SELECT * FROM submissions ORDER BY id DESC`).all();
  res.json(rows);
});

// -------------------------------
// ADMIN APPROVE
// -------------------------------
app.post("/api/admin/approve", (req, res) => {
  const { id, password } = req.body;

  if (password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  db.prepare(`UPDATE submissions SET status='approved' WHERE id=?`).run(id);

  res.json({ approved: true });
});

// -------------------------------
// ADMIN REJECT
// -------------------------------
app.post("/api/admin/reject", (req, res) => {
  const { id, password } = req.body;

  if (password !== ADMIN_PASSWORD)
    return res.json({ error: "Unauthorized" });

  db.prepare(`UPDATE submissions SET status='rejected' WHERE id=?`).run(id);

  res.json({ rejected: true });
});

// -------------------------------
// PAY 5 XRP — CREATE PAYMENT PAYLOAD
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
        },
      },
      custom_meta: {
        identifier: `PAYMENT_${submissionId}`,
      },
    });

    db.prepare(
      `UPDATE submissions SET payment_uuid=? WHERE id=?`
    ).run(uuid, submissionId);

    res.json({ uuid, link });
  } catch (err) {
    console.log("Pay XRP error:", err.message);
    res.status(500).json({ error: "Payment failed" });
  }
});

// -------------------------------
// CREATE MINT PAYLOAD (helper)
// -------------------------------
async function createMintPayload(submissionId) {
  const sub = db.prepare(`SELECT * FROM submissions WHERE id=?`).get(submissionId);
  if (!sub) return null;

  const mintTx = {
    TransactionType: "NFTokenMint",
    Account: sub.creator_wallet,
    URI: xrpl.convertStringToHex(`ipfs://${sub.metadata_cid}`),
    Flags: 8,
    NFTokenTaxon: 1,
  };

  const { uuid, link } = await createXummPayload({
    txjson: mintTx,
    options: {
      return_url: {
        app: CREATOR_PAGE,
        web: CREATOR_PAGE,
      },
    },
    custom_meta: {
      identifier: `MINT_${submissionId}`,
    },
  });

  db.prepare(
    `UPDATE submissions SET mint_uuid=? WHERE id=?`
  ).run(uuid, submissionId);

  return { uuid, link };
}

// -------------------------------
// MARK PAID (CALLED BY FRONT-END AFTER PAYMENT SIGNED)
// (no auto-mint here anymore)
// -------------------------------
app.post("/api/mark-paid", async (req, res) => {
  try {
    const { id, uuid } = req.body;
    const sub = db.prepare(`SELECT * FROM submissions WHERE id=?`).get(id);
    if (!sub) return res.status(404).json({ error: "Not found" });

    if (sub.payment_uuid && sub.payment_uuid !== uuid) {
      return res.status(400).json({ error: "UUID mismatch" });
    }

    const payload = await getXummPayload(uuid);
    const signed = payload?.meta?.signed ?? payload?.signed;
    const resolved = payload?.meta?.resolved ?? payload?.resolved;

    if (!resolved || !signed) {
      return res.json({ ok: false, reason: "Not signed yet" });
    }

    db.prepare(
      `UPDATE submissions SET payment_status='paid' WHERE id=?`
    ).run(id);

    res.json({ ok: true });
  } catch (err) {
    console.log("mark-paid error:", err.message);
    res.status(500).json({ error: "mark-paid failed" });
  }
});

// -------------------------------
// CREATE MINT PAYLOAD (WHEN USER CLICKS "MINT NFT")
// -------------------------------
app.post("/api/mint-now", async (req, res) => {
  try {
    const { id } = req.body;
    const sub = db.prepare(`SELECT * FROM submissions WHERE id=?`).get(id);
    if (!sub) return res.status(404).json({ error: "Not found" });

    if (sub.payment_status !== "paid") {
      return res.status(400).json({ error: "Payment not completed" });
    }

    const mint = await createMintPayload(id);
    if (!mint) {
      return res.status(500).json({ error: "Failed to create mint payload" });
    }

    res.json({
      ok: true,
      mintUuid: mint.uuid,
      mintLink: mint.link,
    });
  } catch (err) {
    console.log("mint-now error:", err.message);
    res.status(500).json({ error: "mint-now failed" });
  }
});

// -------------------------------
// MARK MINTED (AFTER USER SIGNS MINT)
// -------------------------------
app.post("/api/mark-minted", async (req, res) => {
  try {
    const { id, uuid } = req.body;
    const sub = db.prepare(`SELECT * FROM submissions WHERE id=?`).get(id);
    if (!sub) return res.status(404).json({ error: "Not found" });

    if (sub.mint_uuid && sub.mint_uuid !== uuid) {
      return res.status(400).json({ error: "UUID mismatch" });
    }

    const payload = await getXummPayload(uuid);
    const signed = payload?.meta?.signed ?? payload?.signed;
    const resolved = payload?.meta?.resolved ?? payload?.resolved;

    if (!resolved || !signed) {
      return res.json({ ok: false, reason: "Not signed yet" });
    }

    db.prepare(
      `UPDATE submissions SET mint_status='minted' WHERE id=?`
    ).run(id);

    res.json({ ok: true });
  } catch (err) {
    console.log("mark-minted error:", err.message);
    res.status(500).json({ error: "mark-minted failed" });
  }
});

// -------------------------------
// OPTIONAL: LEGACY WEBHOOK (NO-OP)
// -------------------------------
app.post("/api/xumm-webhook", async (req, res) => {
  res.json({ received: true });
});

// -------------------------------
// START SERVER
// -------------------------------
app.listen(PORT, () => {
  console.log("CFC NFT Creator Backend running on", PORT);
});
