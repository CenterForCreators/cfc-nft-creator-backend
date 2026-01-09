
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
const PLATFORM_FEE_PERCENT = 0.05;
const CREATOR_PERCENT = 0.95;

const CREATOR_PAGE = "https://centerforcreators.com/nft-creator";

const MARKETPLACE_BACKEND =
  "https://cfc-nft-shared-mint-backend.onrender.com/api/add-nft";

const PORT = process.env.PORT || 4000;
const XRPL_NETWORK = process.env.XRPL_NETWORK || "wss://s2.ripple.com";
const CFC_DISTRIBUTOR_SEED = process.env.CFC_DISTRIBUTOR_SEED;
const CFC_ISSUER = process.env.CFC_ISSUER;
const CFC_CURRENCY = "CFC";


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
      rejection_reason TEXT,
      is_delisted BOOLEAN DEFAULT false
    );
  `);

  // 🔹 LEARN-TO-EARN TABLES (ADD-ONLY)
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
// 🔹 LEARN-TO-EARN TRACK ENDPOINT
// -------------------------------
app.post("/api/learn/track", async (req, res) => {
  try {
    const { wallet, submission_id, action_type, action_ref } = req.body;
    if (!wallet || !submission_id || !action_type || !action_ref) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const existing = await pool.query(
      `
      SELECT id FROM learn_user_progress
      WHERE wallet=$1 AND submission_id=$2 AND action_type=$3 AND action_ref=$4
      `,
      [wallet, submission_id, action_type, action_ref]
    );

    if (existing.rows.length > 0) {
      return res.json({ ok: true, already_recorded: true });
    }

    await pool.query(
      `
      INSERT INTO learn_user_progress
      (wallet, submission_id, action_type, action_ref)
      VALUES ($1,$2,$3,$4)
      `,
      [wallet, submission_id, action_type, action_ref]
    );

  // -------------------------------
// LEARN-TO-EARN REWARD LOGIC
// STEP 6 — CREATOR METADATA AWARE
// -------------------------------

let tokensEarned = 0;

// Default rewards (backwards compatible)
const DEFAULT_REWARDS = {
  read: 10,       // page read (after 60s)
  activity: 20    // book / workshop activity
};

try {
  // Load submission metadata
  const meta = await pool.query(
    "SELECT metadata_cid FROM submissions WHERE id=$1",
    [submission_id]
  );

  if (meta.rows.length) {
    const cid = meta.rows[0].metadata_cid;

    const r = await axios.get(
      `https://gateway.pinata.cloud/ipfs/${cid}`,
      { timeout: 4000 }
    );

    const learnRules = r.data?.learn;

    // If creator defined learn rules, use them
    if (learnRules && typeof learnRules[action_type] === "number") {
      tokensEarned = learnRules[action_type];
    }
  }
} catch {
  // Silent fallback
}

// Fallback to defaults if nothing set
if (tokensEarned === 0) {
  tokensEarned = DEFAULT_REWARDS[action_type] || 0;
}

// -------------------------------
// RECORD REWARD
// -------------------------------
await pool.query(
  `
  INSERT INTO learn_rewards_ledger
  (wallet, submission_id, action_type, action_ref, tokens_earned)
  VALUES ($1,$2,$3,$4,$5)
  `,
  [
    wallet,
    submission_id,
    action_type,
    action_ref,
    tokensEarned
  ]
);


    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Learn-to-Earn failed" });
  }
});

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
    const {
      wallet, name, description, imageCid,
      metadataCid, quantity, email, website
    } = req.body;

    const metadataJSON = JSON.parse(req.body.metadata || "{}");

// -------------------------------
// LEARN-TO-EARN SAFETY (NO CHANGE)
// -------------------------------
if (metadataJSON.learn && typeof metadataJSON.learn !== "object") {
    delete metadataJSON.learn;
}

    const result = await pool.query(
      `
      INSERT INTO submissions
      (creator_wallet, name, description, image_cid, metadata_cid, batch_qty,
       status, payment_status, mint_status, created_at,
       terms, price_xrp, price_rlusd, email, website)
      VALUES ($1,$2,$3,$4,$5,$6,'pending','unpaid','pending',$7,$8,$9,$10,$11,$12)
      RETURNING id
      `,
      [
        wallet, name, description, imageCid, metadataCid, quantity,
        new Date().toISOString(),
        metadataJSON.terms || null,
        metadataJSON.price_xrp || null,
        metadataJSON.price_rlusd || null,
        email, website
      ]
    );

    res.json({ submitted: true, id: result.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Submission failed" });
  }
});
async function sendCfcReward({ destination, amount }) {
  const client = new xrpl.Client(XRPL_NETWORK);
  await client.connect();

  const wallet = xrpl.Wallet.fromSeed(CFC_DISTRIBUTOR_SEED);

  const tx = {
    TransactionType: "Payment",
    Account: wallet.classicAddress,
    Destination: destination,
    Amount: {
      currency: CFC_CURRENCY,
      issuer: CFC_ISSUER,
      value: String(amount)
    }
  };

  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  await client.disconnect();

  if (result.result.meta.TransactionResult !== "tesSUCCESS") {
    throw new Error("XRPL payment failed");
  }

  return result.result.hash;
}

// -------------------------------
// ADMIN ROUTES (UNCHANGED)
// -------------------------------
app.get("/api/admin/submissions", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Unauthorized" });

  const rows = await pool.query("SELECT * FROM submissions ORDER BY id DESC");
  res.json(rows.rows);
});
// -------------------------------
// LEARN-TO-EARN ADMIN ACTIVITY (READ-ONLY)
// -------------------------------
app.get("/api/admin/learn-activity", async (req, res) => {
  try {
    if (req.query.password !== ADMIN_PASSWORD) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const r = await pool.query(`
      SELECT *
      FROM learn_rewards_ledger
      ORDER BY created_at DESC
      LIMIT 200
    `);

    res.json(r.rows);
  } catch (e) {
    console.error("learn-activity error:", e);
    res.status(500).json({ error: "Failed to load learn activity" });
  }
});

app.post("/api/admin/approve", async (req, res) => {
  const { id, password } = req.body;
  if (password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Unauthorized" });

  await pool.query(
    "UPDATE submissions SET status='approved', rejection_reason=NULL WHERE id=$1",
    [id]
  );
  res.json({ ok: true });
});

app.post("/api/admin/reject", async (req, res) => {
  const { id, password, reason } = req.body;
  if (password !== ADMIN_PASSWORD)
    return res.status(403).json({ error: "Unauthorized" });

  await pool.query(
    "UPDATE submissions SET status='rejected', rejection_reason=$2 WHERE id=$1",
    [id, reason || null]
  );
  res.json({ ok: true });
});
// -------------------------------
// DELIST / RELIST (CREATOR)
// -------------------------------
app.post("/api/toggle-delist", async (req, res) => {
  try {
    const { submission_id, delist } = req.body;

    if (typeof submission_id !== "number") {
      return res.status(400).json({ error: "Invalid submission id" });
    }

    await pool.query(
      "UPDATE submissions SET is_delisted=$1 WHERE id=$2",
      [!!delist, submission_id]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Delist toggle failed" });
  }
});

// -------------------------------
// STEP 5 — PAY OUT UNPAID CFC REWARDS
// -------------------------------
app.post("/api/admin/payout-learn-rewards", async (req, res) => {
  try {
    if (req.body.password !== ADMIN_PASSWORD) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Get unpaid rewards
    const rewards = await pool.query(`
      SELECT *
      FROM learn_rewards_ledger
      WHERE tokens_earned > tokens_paid
      ORDER BY created_at ASC
      LIMIT 50
    `);

    let paidCount = 0;

    for (const r of rewards.rows) {
      const amount = r.tokens_earned - r.tokens_paid;
      if (amount <= 0) continue;
const txHash = await sendCfcReward({
  destination: r.wallet,
  amount
});

await pool.query(
  `
  UPDATE learn_rewards_ledger
  SET tokens_paid = tokens_earned,
      tx_hash = $2
  WHERE id = $1
  `,
  [r.id, txHash]
);
      paidCount++;
    }

    res.json({ ok: true, paid: paidCount });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Payout failed" });
  }
});
// -------------------------------
// PAY 1 XRP MINT FEE (CREATOR)
// -------------------------------
app.post("/api/pay-xrp", async (req, res) => {
  try {
    const { submissionId } = req.body;

    if (!submissionId) {
      return res.status(400).json({ error: "Missing submissionId" });
    }

   const r = await pool.query(
  "SELECT creator_wallet, batch_qty FROM submissions WHERE id=$1",
  [submissionId]
);

    if (!r.rows.length) {
      return res.status(404).json({ error: "Submission not found" });
    }
const payload = await createXummPayload({
  TransactionType: "Payment",
  Destination: PAYMENT_DEST,
  Amount: xrpl.xrpToDrops(String(r.rows[0].batch_qty || 1))
});

    await pool.query(
      "UPDATE submissions SET payment_uuid=$1 WHERE id=$2",
      [payload.uuid, submissionId]
    );

    res.json(payload);
  } catch (e) {
    console.error("Mint fee payment error:", e);
    res.status(500).json({ error: "Failed to create mint payment" });
  }
});

// -------------------------------
// -------------------------------
// MARK PAID AFTER XAMAN PAYMENT
// -------------------------------
app.post("/api/mark-paid", async (req, res) => {
  try {
    const { id, uuid } = req.body;
    if (!id || !uuid) {
      return res.status(400).json({ error: "Missing id or uuid" });
    }

    const r = await pool.query(
      `
      UPDATE submissions
      SET payment_status='paid'
      WHERE id=$1 AND payment_uuid=$2
      RETURNING id
      `,
      [id, uuid]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: "Submission not found or already paid" });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("mark-paid error:", e);
    res.status(500).json({ error: "Failed to mark paid" });
  }
});

// -------------------------------
// MARK MINTED AFTER XAMAN MINT
// -------------------------------
app.post("/api/mark-minted", async (req, res) => {
  try {
    const { id, uuid } = req.body;
    // 🔹 FETCH NFTokenID FROM XRPL (ADD-ONLY)
const client = new xrpl.Client(XRPL_NETWORK);
await client.connect();

const payloadRes = await axios.get(
  `https://xumm.app/api/v1/platform/payload/${uuid}`,
  {
    headers: {
      "X-API-Key": XUMM_API_KEY,
      "X-API-Secret": XUMM_API_SECRET
    }
  }
);

const txid = payloadRes.data?.response?.txid;

if (txid) {
  const tx = await client.request({
    command: "tx",
    transaction: txid,
    binary: false
  });

  const createdNode = tx.result.meta.AffectedNodes.find(
    n => n.CreatedNode?.LedgerEntryType === "NFTokenPage"
  );

  const nftoken_id =
    createdNode?.CreatedNode?.NewFields?.NFTokens?.[0]?.NFToken?.NFTokenID;

  if (nftoken_id) {
    await pool.query(
      "UPDATE submissions SET nftoken_id=$1 WHERE id=$2",
      [nftoken_id, id]
    );
  }
}

await client.disconnect();

    if (!id || !uuid) {
      return res.status(400).json({ error: "Missing id or uuid" });
    }

    const r = await pool.query(
      `
      UPDATE submissions
      SET mint_status='minted'
      WHERE id=$1
      RETURNING *
      `,
      [id]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: "Submission not found" });
    }
    // ADD TO MARKETPLACE AFTER MINT (NON-BLOCKING + LOGS)
    try {
      console.log("➡️ Sending NFT to marketplace", r.rows[0].id);

      const resp = await axios.post(MARKETPLACE_BACKEND, {
        submission_id: r.rows[0].id,
        name: r.rows[0].name,
        description: r.rows[0].description || "",
        category: "all",
        image_cid: r.rows[0].image_cid,
        metadata_cid: r.rows[0].metadata_cid,
        price_xrp: r.rows[0].price_xrp,
        price_rlusd: r.rows[0].price_rlusd,
        creator_wallet: r.rows[0].creator_wallet,
        terms: r.rows[0].terms || "",
        website: r.rows[0].website || "",
        quantity: 1
      });

      await pool.query(
        "UPDATE submissions SET sent_to_marketplace=true WHERE id=$1",
        [r.rows[0].id]
      );

      console.log("✅ Marketplace response:", resp.data);

    } catch (err) {
      console.error("❌ Marketplace insert failed:", err?.response?.data || err.message);
    }

    // ✅ THIS MUST STAY INSIDE THE ROUTE FUNCTION
    res.json({ ok: true });

  } catch (e) {
    console.error("mark-minted error:", e);
    return res.status(500).json({ error: "Failed to mark minted" });
  }
});

   
// -------------------------------
// SET REGULAR KEY (ONE-TIME CREATOR APPROVAL)
// -------------------------------
app.post("/api/set-regular-key", async (req, res) => {
  try {
    const { wallet } = req.body;
    if (!wallet) {
      return res.status(400).json({ error: "Missing wallet" });
    }

    const payload = await createXummPayload({
      TransactionType: "SetRegularKey",
      Account: wallet,
      RegularKey: process.env.MARKETPLACE_REGULAR_KEY
    });

    res.json(payload);
  } catch (e) {
    console.error("set-regular-key error:", e);
    res.status(500).json({ error: "Failed to set regular key" });
  }
});

// -------------------------------
// START NFT MINT (CREATOR)
// -------------------------------
app.post("/api/start-mint", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: "Missing submission id" });
    }

    const r = await pool.query(
      `
      SELECT creator_wallet, metadata_cid
      FROM submissions
      WHERE id=$1 AND payment_status='paid'
      `,
      [id]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: "Submission not ready for mint" });
    }
const qty = Number(batch_qty || 1);

for (let i = 0; i < qty; i++) {
  const payload = {
    txjson: {
      TransactionType: "NFTokenMint",
      Account: creatorWallet.classicAddress,
      URI: xrpl.convertStringToHex(`ipfs://${metadata_cid}`),
      Flags: 8,
      NFTokenTaxon: 0
    }
  };

  await axios.post(
    "https://xumm.app/api/v1/platform/payload",
    payload,
    {
      headers: {
        "X-API-Key": process.env.XUMM_API_KEY,
        "X-API-Secret": process.env.XUMM_API_SECRET
     }
    }
  );
}

    await pool.query(
      "UPDATE submissions SET mint_uuid=$1 WHERE id=$2",
      [payload.uuid, id]
    );

    res.json(payload);

  } catch (e) {
    console.error("start-mint error:", e);
    res.status(500).json({ error: "Failed to start mint" });
  }
});

app.listen(PORT, () => {
  console.log("CFC NFT Creator Backend running on", PORT);
});

