// /api/shopify-order-create.js
import crypto from "node:crypto";
import getRawBody from "raw-body";

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. zeropulse.org
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const BASE_URL = process.env.BASE_URL; // your vercel app URL (used for IPN fallback if you like)

export const config = { api: { bodyParser: false } };

async function json(res, code, data) {
  res.status(code).setHeader("Content-Type", "application/json").end(JSON.stringify(data));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // ---- Verify Shopify HMAC ----
  const raw = (await getRawBody(req)).toString("utf8");
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(raw, "utf8")
    .digest("base64");

  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || ""))) {
    return res.status(401).end("Invalid HMAC");
  }

  const order = JSON.parse(raw);

  // Only act on manual gateway (your custom payment)
  if ((order.gateway || "").toLowerCase() !== "manual") {
    return json(res, 200, { ok: true, skipped: "not manual gateway" });
  }

  // Prepare NOWPayments invoice payload
  const priceCurrency = order.currency || order.presentment_currency || "USD";
  const priceAmount = Number(order.total_price || order.current_total_price || 0);

  // Make a readable order ID for the invoice
  const orderId = String(order.id || order.admin_graphql_api_id || order.name || "unknown");

  // ---- Create invoice at NOWPayments ----
  const invoicePayload = {
    price_amount: priceAmount,
    price_currency: priceCurrency,
    order_id: orderId,
    // optional: set a pay_currency to force BTC/USDT etc.
    // pay_currency: "BTC",
    // optional but recommended
    ipn_callback_url: `${BASE_URL}/api/nowpayments-ipn`
  };

  const npRes = await fetch("https://api.nowpayments.io/v1/invoice", {
    method: "POST",
    headers: {
      "x-api-key": NOWPAYMENTS_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(invoicePayload)
  });

  const npJson = await npRes.json().catch(() => ({}));

  // Log for troubleshooting
  console.log("[ORDER CREATE] Invoice create result:", {
    status: npRes.status,
    json: npJson
  });

  if (!npRes.ok || !npJson || !npJson.invoice_url) {
    // Nothing else we can do; still return 200 so Shopify doesn’t retry forever
    return json(res, 200, {
      ok: false,
      message: "Invoice not created",
      nowpayments_status: npRes.status,
      response: npJson
    });
  }

  // Save URL + invoice id onto the order note_attributes so we can read it on Order Status page
  const noteAttributes = [
    { name: "np_payment_url", value: npJson.invoice_url },
    { name: "np_invoice_id", value: String(npJson.id || "") }
  ];

  const updRes = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/orders/${order.id}.json`,
    {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ order: { id: order.id, note_attributes: noteAttributes } })
    }
  );

  const updJson = await updRes.json().catch(() => ({}));
  console.log("[ORDER CREATE] Saved note_attributes:", updRes.status, updJson);

  return json(res, 200, { ok: true, invoice_url: npJson.invoice_url });
}
