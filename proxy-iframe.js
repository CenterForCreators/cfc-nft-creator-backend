import express from "express";
import request from "request";

const router = express.Router();

// Reverse proxy: Fix GoDaddy iframe sandbox issues
router.get("/proxy", (req, res) => {
  const target = req.query.url;

  if (!target) {
    return res.status(400).send("Missing URL");
  }

  request({ url: target }).pipe(res);
});

export default router;
