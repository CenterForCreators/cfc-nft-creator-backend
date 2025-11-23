// server.js (BEGINNER FRIENDLY, ONE FILE BACKEND)
import express from "express";
import cors from "cors";
import fileUpload from "express-fileupload";
import axios from "axios";
import FormData from "form-data";
import xrpl from "xrpl";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(fileUpload());

// Upload file to Pinata
app.post("/api/upload", async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ error: "No file uploaded" });
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
          pinata_api_key: process.env.PINATA_API_KEY,
          pinata_secret_api_key: process.env.PINATA_API_SECRET
        }
      }
    );

    const cid = upload.data.IpfsHash;
    res.json({ cid, uri: `ipfs://${cid}` });

  } catch (error) {
    res.status(500).json({ error: "Upload failed" });
  }
});

// Mint NFT on XRPL
app.post("/api/mint", async (req, res) => {
  try {
    const { wallet, metadataUri } = req.body;
    if (!wallet || !metadataUri) {
      return res.status(400).json({ error: "Missing wallet or metadata URI" });
    }

    const client = new xrpl.Client("wss://s1.ripple.com");
    await client.connect();

    const mintTx = {
      TransactionType: "NFTokenMint",
      Account: wallet,
      URI: xrpl.convertStringToHex(metadataUri),
      Flags: 8, // transferable
      NFTokenTaxon: 1
    };

    const result = await client.submit(mintTx);
    await client.disconnect();

    res.json({ minted: true, result });

  } catch (error) {
    res.status(500).json({ error: "Mint failed" });
  }
});

// Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
