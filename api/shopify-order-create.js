// Vercel serverless function to handle Shopify order creation
import crypto from "node:crypto";
import getRawBody from "raw-body";

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_STORE_DOMAIN  = process.env.SHOPIFY_STORE_DOMAIN;   // e.g. myshop.myshopify.com
const SHOPIFY_ACCESS_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
const NOW_API_KEY           = process.env.NOWPAYMENTS_API_KEY;
const BASE_URL              = process.env.BASE_URL;               // e.g. https://your-app.vercel.app

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // Verify Shopify HMAC
  const raw = (await getRawBody(req)).toString("utf8");
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(raw, "utf8")
    .digest("base64");
  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader))) {
    return res.status(401).send("Invalid HMAC");
  }

  const order = JSON.parse(raw);

  // Only act on manual-payment orders
  if ((order.gateway || "").toLowerCase() !== "manual") {
    return res.status(200).send("Ignored: not manual gateway");
  }

  // Create NOWPayments Invoice
  const price_amount    = Number(order.total_price);
  const price_currency  = order.currency || "AUD";

  const body = {
    price_amount,
    price_currency,
    order_id: String(order.id),
    ipn_callback_url: `${BASE_URL}/api/nowpayments-ipn`,
    success_url: `https://${SHOPIFY_STORE_DOMAIN}/pages/thank-you`
  };

  const invResp = await fetch("https://api.nowpayments.io/v1/invoice", {
    method: "POST",
    headers: {
      "x-api-key": NOW_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!invResp.ok) {
    const text = await invResp.text();
    console.error("NOWPayments invoice error:", text);
    return res.status(500).send("NOWPayments invoice error");
  }

  const invoice = await invResp.json(); // { id, invoice_url, ... }

  // Attach the invoice URL to the Shopify order note
  const note = `Crypto payment link: ${invoice.invoice_url}`;
  await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2025-07/orders/${order.id}.json`, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ order: { id: order.id, note, tags: `${order.tags || ""}, Awaiting Crypto` } })
  });

  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  console.log("📦 Shopify Order Create request received:", {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });

  try {
    // your existing logic here...

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Error in shopify-order-create:", err);
    res.status(500).json({ error: err.message });
  }
}

