// api/nowpayments-ipn.js
import crypto from "node:crypto";
import getRawBody from "raw-body";

export const config = {
  api: { bodyParser: false }, // need raw for signature verification
};

// ───────────────────────────────────────────────────────────────────────────────
// NOWPayments signature verification
// They require HMAC-SHA512 over a "key-sorted" JSON stringified body.
function stringifySorted(obj) {
  const sortedKeys = Object.keys(obj).sort();
  const o = {};
  for (const k of sortedKeys) o[k] = obj[k];
  return JSON.stringify(o);
}

function verifyNowpaymentsSig(rawBody, headerSig, ipnSecret) {
  try {
    const decoded = JSON.parse(rawBody);
    const sortedStr = stringifySorted(decoded);
    const expected = crypto
      .createHmac("sha512", ipnSecret)
      .update(sortedStr)
      .digest("hex");
    const safe =
      typeof headerSig === "string" &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headerSig));
    return safe;
  } catch (e) {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
async function tagShopifyOrder(orderId, tagToAdd) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  // Get current tags, then PUT the updated tag string
  const getUrl = `https://${domain}/admin/api/2025-07/orders/${orderId}.json`;
  const getRes = await fetch(getUrl, {
    headers: { "X-Shopify-Access-Token": token },
  });
  const getText = await getRes.text();
  console.log("[SHOPIFY GET ORDER] status:", getRes.status, "body:", getText);
  const order = JSON.parse(getText)?.order;
  const existingTags = order?.tags || "";
  const set = new Set(
    existingTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
  );
  set.add(tagToAdd);
  const newTags = Array.from(set).join(", ");

  const putUrl = `https://${domain}/admin/api/2025-07/orders/${orderId}.json`;
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ order: { id: orderId, tags: newTags } }),
  });
  const putText = await putRes.text();
  console.log("[SHOPIFY TAG UPDATE] status:", putRes.status, "body:", putText);
}

// ───────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    console.log("[NP IPN] Non-POST hit:", req.method);
    return res.status(405).end("Method Not Allowed");
  }

  const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!ipnSecret) {
    console.error("[NP IPN] Missing NOWPAYMENTS_IPN_SECRET");
    return res.status(500).end("Server not configured");
  }

  const raw = (await getRawBody(req)).toString("utf8");
  const sigHeader = req.headers["x-nowpayments-sig"];

  // Verify signature
  const valid = verifyNowpaymentsSig(raw, sigHeader, ipnSecret);
  if (!valid) {
    console.warn("[NP IPN] Invalid signature");
    return res.status(401).end("Invalid signature");
  }

  const ipn = JSON.parse(raw);
  console.log("[NP IPN] Payload:", ipn);

  // NOWPayments usually echoes your order_id back—ensure we have it
  const orderId = ipn.order_id || ipn.orderId || ipn.order?.id;
  if (!orderId) {
    console.warn("[NP IPN] Missing order_id");
    return res.status(200).end("ok");
  }

  // Payment state machine: paid = confirmed/finished
  const status = (ipn.payment_status || ipn.paymentStatus || "").toLowerCase();
  console.log("[NP IPN] status:", status, "order:", orderId);

  try {
    if (status === "confirmed" || status === "finished") {
      await tagShopifyOrder(orderId, "crypto_paid");
    } else if (status === "partially_paid") {
      await tagShopifyOrder(orderId, "crypto_partially_paid");
    } else if (status === "failed" || status === "refunded" || status === "expired") {
      await tagShopifyOrder(orderId, `crypto_${status}`);
    }
  } catch (e) {
    console.error("[NP IPN] Error updating Shopify:", e);
  }

  return res.status(200).end("ok");
}
