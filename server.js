import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import shopifyAppExpress from '@shopify/shopify-app-express';
import { LATEST_API_VERSION } from '@shopify/shopify-api';
const { shopifyApp } = shopifyAppExpress;

import { MemorySessionStorage } from '@shopify/shopify-app-session-storage-memory';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SCOPES,
  APP_URL,
  SESSION_SECRET
} = process.env;

const app = express();
const PORT = process.env.PORT || 10000;

app.use(morgan('tiny'));
app.use(compression());
app.use(cors());
app.use(express.json());

// Memory session storage (easy deploy)
const storage = new MemorySessionStorage();

const shopify = shopifyApp({
  api: {
    apiKey: SHOPIFY_API_KEY,
    apiSecretKey: SHOPIFY_API_SECRET,
    apiVersion: LATEST_API_VERSION,
    scopes: (SCOPES || '').split(',').map(s => s.trim()).filter(Boolean),
  },
  auth: { path: '/auth', callbackPath: '/auth/callback' },
  sessionStorage: storage,
  appUrl: APP_URL,
});

// OAuth
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(shopify.config.auth.callbackPath, shopify.auth.callback(), shopify.redirectToShopifyOrAppRoot());

// After install: ScriptTag + metafields + webhook
shopify.addEventHook("afterAuth", async ({ admin }) => {
  try {
    const scriptSrc = `${APP_URL}/preorder.js`;

    // ScriptTag
    const scriptTagCreate = `
      mutation scriptTagCreate($input: ScriptTagInput!) {
        scriptTagCreate(input: $input) {
          scriptTag { id src displayScope }
          userErrors { message }
        }
      }`;
    await admin.graphql(scriptTagCreate, { variables: { input: { src: scriptSrc, displayScope: "ONLINE_STORE" } } });

    // Metafields
    const metafieldDef = `
      mutation metafieldDefinitionCreate($def: MetafieldDefinitionCreateInput!) {
        metafieldDefinitionCreate(definition: $def) {
          createdDefinition { id }
          userErrors { message }
        }
      }`;
    await admin.graphql(metafieldDef, { variables: { def: { name:"Enable Preorder", namespace:"preorder", key:"enabled", type:"boolean", ownerType:"PRODUCT", pin:true } } }).catch(()=>{});
    await admin.graphql(metafieldDef, { variables: { def: { name:"Preorder Message", namespace:"preorder", key:"message", type:"single_line_text_field", ownerType:"PRODUCT", pin:true } } }).catch(()=>{});

    // Webhook (absolute URL recommended)
    const webhookCreate = `
      mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
          userErrors { message }
          webhookSubscription { id }
        }
      }`;
    await admin.graphql(webhookCreate, {
      variables: { topic: "INVENTORY_LEVELS_UPDATE", sub: { callbackUrl: `${APP_URL}/webhooks/inventory`, format: "JSON" } }
    });

  } catch (e) { console.error("[afterAuth]", e); }
});

// Serve storefront JS (root file)
app.get("/preorder.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "preorder.js"));
});

// PDP status endpoint
app.get("/apps/preorder/status", async (req, res) => {
  try {
    const { shop, variantId } = req.query;
    if (!shop || !variantId) return res.status(400).json({ checked: true, allow: false });

    const sessions = await storage.findSessionsByShop(shop);
    const session = sessions && sessions[0];
    if (!session) return res.status(401).json({ checked: true, allow: false });

    const client = new shopify.api.clients.Graphql({ session });
    const q = `
      query VariantWithProduct($id: ID!) {
        productVariant(id: $id) {
          id
          sellableOnlineQuantity
          product {
            enabled: metafield(namespace:"preorder", key:"enabled"){ value }
            message: metafield(namespace:"preorder", key:"message"){ value }
          }
        }
      }`;
    const r = await client.query({ data: { query: q, variables: { id: variantId } } });
    const pv = r.body?.data?.productVariant;
    if (!pv) return res.json({ checked: true, allow: false });

    const qty = typeof pv.sellableOnlineQuantity === "number" ? pv.sellableOnlineQuantity : 0;
    const enabled = pv.product?.enabled?.value === "true";
    const customMessage = pv.product?.message?.value || null;

    const allow = enabled || qty <= 0;
    res.json({
      checked: true,
      allow,
      buttonText: allow ? "Preorder Now" : null,
      message: allow ? (customMessage || "This item is on preorder and will ship once back in stock.") : null
    });
  } catch (e) {
    console.error("status", e);
    res.json({ checked: true, allow: false });
  }
});

// Webhook: inventory -> set CONTINUE when OOS
app.post("/webhooks/inventory", express.text({ type: '*/*' }), async (req, res) => {
  try {
    const hmac = req.get("X-Shopify-Hmac-Sha256");
    const shop = req.get("X-Shopify-Shop-Domain");
    const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(req.body, 'utf8').digest('base64');
    if (digest !== hmac) return res.status(401).send("Invalid HMAC");

    const payload = JSON.parse(req.body || "{}");
    const { inventory_item_id, available } = payload;
    if (typeof available !== "number" || !inventory_item_id) return res.status(200).send("ok");
    if (available > 0) return res.status(200).send("ok");

    const sessions = await storage.findSessionsByShop(shop);
    const session = sessions && sessions[0];
    if (!session) return res.status(200).send("no session");

    const client = new shopify.api.clients.Graphql({ session });

    const mapQ = `
      query InvMap($id: ID!) {
        inventoryItem(id: $id) { variant { id product { id } } }
      }`;
    const invGid = `gid://shopify/InventoryItem/${inventory_item_id}`;
    const mapR = await client.query({ data: { query: mapQ, variables: { id: invGid } } });
    const variantId = mapR.body?.data?.inventoryItem?.variant?.id;
    const productId = mapR.body?.data?.inventoryItem?.variant?.product?.id;
    if (!variantId || !productId) return res.status(200).send("no variant");

    const upd = `
      mutation PreorderEnable($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { message }
          productVariants { id inventoryPolicy }
        }
      }`;
    await client.query({ data: { query: upd, variables: { productId, variants: [{ id: variantId, inventoryPolicy: "CONTINUE" }] } } });

    res.status(200).send("ok");
  } catch (e) {
    console.error("webhook", e);
    res.status(200).send("ok");
  }
});

// Health
app.get("/", (_req, res) => {
  res.type("html").send(`<h2>Preorder App (Auto Inject)</h2>
    <p>Storefront script: <code>${APP_URL}/preorder.js</code></p>`);
});

app.listen(PORT, () => console.log("Preorder app listening on", PORT));
