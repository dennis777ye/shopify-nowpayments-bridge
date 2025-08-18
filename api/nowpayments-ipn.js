import crypto from "node:crypto";
import getRawBody from "raw-body";

const NOW_IPN_SECRET       = process.env.NOWPAYMENTS_IPN_SECRET;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// Sort object keys before HMAC (NOWPayments requirement)
function stringifySorted(obj) {
  const sortedKeys = Object.keys(obj).sort();
  const sorted = {};
  for (const k of sortedKeys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const raw = (await getRawBody(req)).toString("utf8");
  const ipnData = JSON.parse(raw);

  const signature = req.headers["x-nowpayments-sig"];
  const signedStr = stringifySorted(ipnData);
  const expected = crypto.createHmac("sha512", NOW_IPN_SECRET).update(signedStr).digest("hex");

  if (expected !== signature) {
    return res.status(401).send("Bad IPN signature");
  }

  const status = (ipnData.payment_status || ipnData.status || "").toLowerCase();
  if (!["confirmed", "finished"].includes(status)) {
    return res.status(200).send("No action");
  }

  const shopifyIdNumeric = String(ipnData.order_id);
  const orderGID = `gid://shopify/Order/${shopifyIdNumeric}`;

  const query = `
    mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) {
        userErrors { field message }
        order { id displayFinancialStatus }
      }
    }`;

  const resp = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables: { input: { id: orderGID } } })
  });

  const data = await resp.json();
  if (data?.data?.orderMarkAsPaid?.userErrors?.length) {
    console.error("orderMarkAsPaid errors:", data.data.orderMarkAsPaid.userErrors);
  }

  return res.status(200).json({ ok: true });
}
