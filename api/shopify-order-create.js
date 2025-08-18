// api/shopify-order-create.js
import crypto from "node:crypto";
import getRawBody from "raw-body";

export const config = {
  api: { bodyParser: false }, // we need raw body for HMAC verification
};

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
function safeJSON(parseMe) {
  try {
    return JSON.parse(parseMe);
  } catch (e) {
    return null;
  }
}

async function shopifyUpdateOrderNoteAttribute(orderId, name, value) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  const url = `https://${domain}/admin/api/2025-07/orders/${orderId}.json`;
  const body = {
    order: {
      id: orderId,
      note_attributes: [{ name, value }],
    },
  };

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log("[SHOPIFY UPDATE ORDER NOTE] status:", res.status, "body:", text);
  return { status: res.status, body: text };
}

async function createNowPaymentsInvoice({
  price_amount,
  price_currency,
  pay_currency,
  order_id,
  order_description,
}) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  const baseUrl = process.env.BASE_URL || "https://example.com";

  const payload = {
    price_amount,
    price_currency,
    // You can let customer pick coin later; keeping a default here:
    pay_currency: pay_currency || "BTC",
    order_id: String(order_id),
    order_description: order_description || "Shopify order",
    ipn_callback_url: `${baseUrl}/api/nowpayments-ipn`,
    // Optional UX:
    // success_url: "https://yourstore.com/thank-you",
    // cancel_url:  "https://yourstore.com/cancelled",
  };

  console.log("[NP INVOICE REQUEST]", payload);

  const res = await fetch("https://api.nowpayments.io/v1/invoice", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log("[NP INVOICE RESPONSE] status:", res.status, "body:", text);

  return { status: res.status, json: safeJSON(text), text };
}

// ───────────────────────────────────────────────────────────────────────────────
// Main handler
export default async function handler(req, res) {
  if (req.method !== "POST") {
    console.log("[ORDER CREATE] Non-POST hit:", req.method);
    return res.status(405).end("Method Not Allowed");
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[ORDER CREATE] Missing SHOPIFY_WEBHOOK_SECRET");
    return res.status(500).end("Server not configured");
  }

  // 1) Verify Shopify HMAC
  const raw = (await getRawBody(req)).toString("utf8");
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  const digest = crypto
    .createHmac("sha256", secret)
    .update(raw, "utf8")
    .digest("base64");

  const valid = crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmacHeader || "", "utf8")
  );

  if (!valid) {
    console.warn("[ORDER CREATE] Invalid HMAC");
    return res.status(401).end("Invalid signature");
  }

  // 2) Parse payload
  const order = safeJSON(raw);
  console.log("[ORDER CREATE] Webhook body:", order);

  if (!order || !order.id) {
    console.warn("[ORDER CREATE] No order in body");
    return res.status(200).end("ok"); // still 200 so Shopify stops retrying
  }

  // 3) Build invoice request
  const price_amount = Number(order.total_price || order.total_price_set?.shop_money?.amount || 0);
  const price_currency = order.currency || "USD";
  // You can change this to TRX or let users choose via note_attribute in the future.
  const pay_currency = "BTC";
  const order_id = order.id;
  const order_description = `Shopify Order #${order.name || order.order_number || order.id}`;

  // 4) Create invoice on NOWPayments
  try {
    const inv = await createNowPaymentsInvoice({
      price_amount,
      price_currency,
      pay_currency,
      order_id,
      order_description,
    });

    // If invoice created, attach URL to order as note attribute for reference
    if (inv.json?.invoice_url) {
      await shopifyUpdateOrderNoteAttribute(order_id, "nowpayments_invoice_url", inv.json.invoice_url);
    }

    // Always log what we got back
    console.log("[ORDER CREATE] Invoice create result:", inv);

  } catch (e) {
    console.error("[ORDER CREATE] Error creating invoice:", e);
    // We still return 200 so Shopify does not retry forever.
  }

  return res.status(200).end("ok");
}
