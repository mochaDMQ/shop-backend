const express = require("express");
const crypto = require("crypto");
const Stripe = require("stripe");
const { body, param, query, validationResult } = require("express-validator");
const db = require("../database");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const DEFAULT_CURRENCY = (process.env.STRIPE_CURRENCY || "hkd").toLowerCase();
const isProd = process.env.NODE_ENV === "production";
const FRONTEND_ORIGIN = isProd
  ? process.env.FRONTEND_ORIGIN || "https://s75.iems5718.iecuhk.cc"
  : "http://localhost:8080";

const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

function toCents(price) {
  return Math.round(Number(price) * 100);
}

function parsePidFromDescription(desc) {
  const text = String(desc || "");
  const m = text.match(/\[PID:(\d+)\]/);
  if (!m) return null;
  return Number(m[1]);
}

function normalizeIncomingItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("Cart is empty");
  }

  const merged = new Map();
  for (const item of rawItems) {
    const pid = Number(item?.pid);
    const quantity = Number(item?.quantity);

    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("Invalid pid");
    }
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 9999) {
      throw new Error("Invalid quantity");
    }

    merged.set(pid, (merged.get(pid) || 0) + quantity);
  }

  return [...merged.entries()]
    .map(([pid, quantity]) => ({ pid, quantity }))
    .sort((a, b) => a.pid - b.pid);
}

function buildDigestPayload({ currency, salt, items, totalPriceCents }) {
  const tokens = [currency.toLowerCase(), salt];
  for (const it of items.sort((a, b) => a.pid - b.pid)) {
    tokens.push(`${it.pid}:${it.quantity}:${it.unitPriceCents}`);
  }
  tokens.push(`total:${totalPriceCents}`);
  return tokens.join("|");
}

function digest(payload) {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function toOrderDTO(row) {
  return {
    orderid: row.orderid,
    userid: row.userid,
    currency: row.currency,
    total_price: Number(row.total_price_cents) / 100,
    status: row.status,
    stripe_checkout_session_id: row.stripe_checkout_session_id,
    stripe_payment_intent_id: row.stripe_payment_intent_id,
    created_at: row.created_at,
    paid_at: row.paid_at,
    items: JSON.parse(row.items_json || "[]"),
  };
}

function ordersRouter() {
  const router = express.Router();

  router.post(
    "/checkout",
    requireAuth,
    body("items").isArray({ min: 1 }),
    validate,
    async (req, res) => {
      if (!stripe) {
        return res.status(500).json({ error: "Stripe is not configured" });
      }

      try {
        const requestedItems = normalizeIncomingItems(req.body.items);
        const pidList = requestedItems.map((it) => it.pid);
        const placeholders = pidList.map(() => "?").join(",");

        const rows = db
          .prepare(
            `SELECT pid, name, price
             FROM products
             WHERE pid IN (${placeholders})`,
          )
          .all(...pidList);

        if (rows.length !== pidList.length) {
          return res
            .status(400)
            .json({ error: "One or more products not found" });
        }

        const productMap = new Map(rows.map((r) => [r.pid, r]));
        const enrichedItems = requestedItems.map((it) => {
          const p = productMap.get(it.pid);
          return {
            pid: it.pid,
            quantity: it.quantity,
            name: p.name,
            unitPriceCents: toCents(p.price),
          };
        });

        const totalPriceCents = enrichedItems.reduce(
          (sum, it) => sum + it.unitPriceCents * it.quantity,
          0,
        );

        if (totalPriceCents <= 0) {
          return res.status(400).json({ error: "Invalid order total" });
        }

        const salt = crypto.randomBytes(16).toString("hex");
        const payload = buildDigestPayload({
          currency: DEFAULT_CURRENCY,
          salt,
          items: enrichedItems,
          totalPriceCents,
        });
        const orderDigest = digest(payload);

        const insertOrder = db.prepare(
          `INSERT INTO orders (
            userid, currency, salt, digest, total_price_cents, status
          ) VALUES (?, ?, ?, ?, ?, 'pending')`,
        );
        const insertOrderItem = db.prepare(
          `INSERT INTO order_items (
            orderid, pid, quantity, unit_price_cents
          ) VALUES (?, ?, ?, ?)`,
        );

        const tx = db.transaction(() => {
          const result = insertOrder.run(
            req.user.userid,
            DEFAULT_CURRENCY,
            salt,
            orderDigest,
            totalPriceCents,
          );

          const orderid = Number(result.lastInsertRowid);

          for (const it of enrichedItems) {
            insertOrderItem.run(
              orderid,
              it.pid,
              it.quantity,
              it.unitPriceCents,
            );
          }

          return orderid;
        });

        const orderid = tx();

        const stripeSession = await stripe.checkout.sessions.create({
          mode: "payment",
          success_url: `${FRONTEND_ORIGIN}/?checkout=success&orderId=${orderid}`,
          cancel_url: `${FRONTEND_ORIGIN}/?checkout=cancelled&orderId=${orderid}`,
          client_reference_id: String(orderid),
          metadata: {
            orderid: String(orderid),
            salt,
            digest: orderDigest,
          },
          line_items: enrichedItems.map((it) => ({
            quantity: it.quantity,
            price_data: {
              currency: DEFAULT_CURRENCY,
              unit_amount: it.unitPriceCents,
              product_data: {
                name: `${it.name} [PID:${it.pid}]`,
              },
            },
          })),
        });

        db.prepare(
          `UPDATE orders SET stripe_checkout_session_id = ? WHERE orderid = ?`,
        ).run(stripeSession.id, orderid);

        return res.status(201).json({
          orderid,
          checkoutUrl: stripeSession.url,
        });
      } catch (err) {
        console.error("Checkout creation failed:", err);
        return res
          .status(400)
          .json({ error: err.message || "Checkout failed" });
      }
    },
  );

  router.get(
    "/mine/recent",
    requireAuth,
    query("limit").optional().isInt({ min: 1, max: 20 }),
    validate,
    (req, res) => {
      const limit = req.query.limit ? Number(req.query.limit) : 5;
      const rows = db
        .prepare(
          `SELECT
             o.*,
             COALESCE((
               SELECT json_group_array(
                 json_object(
                   'pid', oi.pid,
                   'quantity', oi.quantity,
                   'unit_price', oi.unit_price_cents / 100.0
                 )
               )
               FROM order_items oi
               WHERE oi.orderid = o.orderid
             ), '[]') AS items_json
           FROM orders o
           WHERE o.userid = ?
           ORDER BY o.created_at DESC
           LIMIT ?`,
        )
        .all(req.user.userid, limit);

      return res.json(rows.map(toOrderDTO));
    },
  );

  router.get(
    "/admin/all",
    requireAdmin,
    query("limit").optional().isInt({ min: 1, max: 200 }),
    validate,
    (req, res) => {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const rows = db
        .prepare(
          `SELECT
             o.*,
             u.username,
             u.email,
             COALESCE((
               SELECT json_group_array(
                 json_object(
                   'pid', oi.pid,
                   'quantity', oi.quantity,
                   'unit_price', oi.unit_price_cents / 100.0
                 )
               )
               FROM order_items oi
               WHERE oi.orderid = o.orderid
             ), '[]') AS items_json
           FROM orders o
           JOIN users u ON u.userid = o.userid
           ORDER BY o.created_at DESC
           LIMIT ?`,
        )
        .all(limit)
        .map((row) => ({
          ...toOrderDTO(row),
          username: row.username,
          email: row.email,
        }));

      return res.json(rows);
    },
  );

  router.get(
    "/:id",
    requireAuth,
    param("id").isInt({ min: 1 }),
    validate,
    (req, res) => {
      const orderid = Number(req.params.id);

      const row = db
        .prepare(
          `SELECT
           o.*,
           COALESCE((
             SELECT json_group_array(
               json_object(
                 'pid', oi.pid,
                 'quantity', oi.quantity,
                 'unit_price', oi.unit_price_cents / 100.0
               )
             )
             FROM order_items oi
             WHERE oi.orderid = o.orderid
           ), '[]') AS items_json
         FROM orders o
         WHERE o.orderid = ?`,
        )
        .get(orderid);

      if (!row) {
        return res.status(404).json({ error: "Order not found" });
      }

      if (req.user.is_admin !== 1 && row.userid !== req.user.userid) {
        return res.status(403).json({ error: "Forbidden" });
      }

      return res.json(toOrderDTO(row));
    },
  );

  router.delete(
    "/:id",
    requireAdmin,
    param("id").isInt({ min: 1 }),
    validate,
    (req, res) => {
      const orderid = Number(req.params.id);
      const row = db
        .prepare("SELECT status FROM orders WHERE orderid = ?")
        .get(orderid);
      if (!row) {
        return res.status(404).json({ error: "Order not found" });
      }
      if (row.status === "paid") {
        return res.status(400).json({ error: "Paid orders cannot be deleted" });
      }

      const result = db
        .prepare("DELETE FROM orders WHERE orderid = ?")
        .run(orderid);
      return res.json({ deleted: result.changes > 0 });
    },
  );

  return router;
}

function stripeWebhookRouter() {
  const router = express.Router();

  router.post("/stripe", async (req, res) => {
    if (!stripe || !stripeWebhookSecret) {
      return res
        .status(500)
        .json({ error: "Stripe webhook is not configured" });
    }

    const signature = req.headers["stripe-signature"];
    if (!signature) {
      return res.status(400).json({ error: "Missing Stripe signature" });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        stripeWebhookSecret,
      );
    } catch (err) {
      console.error("Stripe signature verification failed:", err.message);
      return res.status(400).json({ error: "Invalid signature" });
    }

    console.log("[Stripe Webhook] Event received:", {
      id: event.id,
      type: event.type,
      created: event.created,
    });

    if (event.type !== "checkout.session.completed") {
      return res.json({ received: true });
    }

    try {
      const session = event.data.object;
      console.log("[Stripe Webhook] checkout.session.completed:", {
        id: session.id,
        client_reference_id: session.client_reference_id,
        payment_intent: session.payment_intent,
        currency: session.currency,
        amount_total: session.amount_total,
      });

      const alreadyProcessedByEvent = db
        .prepare(
          "SELECT txid FROM order_transactions WHERE stripe_event_id = ?",
        )
        .get(event.id);
      if (alreadyProcessedByEvent) {
        return res.json({ received: true, duplicate: true });
      }

      const orderid = Number(
        session.client_reference_id || session.metadata?.orderid,
      );
      if (!Number.isInteger(orderid) || orderid <= 0) {
        return res.status(400).json({ error: "Invalid order reference" });
      }

      const order = db
        .prepare(
          `SELECT orderid, userid, currency, salt, digest, total_price_cents, status
           FROM orders
           WHERE orderid = ?`,
        )
        .get(orderid);

      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      const duplicatedByPaymentIntent = session.payment_intent
        ? db
            .prepare(
              "SELECT txid FROM order_transactions WHERE stripe_payment_intent_id = ?",
            )
            .get(String(session.payment_intent))
        : null;

      if (duplicatedByPaymentIntent || order.status === "paid") {
        return res.json({ received: true, duplicate: true });
      }

      const lineItems = await stripe.checkout.sessions.listLineItems(
        session.id,
        {
          limit: 100,
        },
      );

      const stripeItems = [];
      for (const li of lineItems.data) {
        const pid = parsePidFromDescription(li.description);
        const quantity = Number(li.quantity);
        const unitPriceCents = Number(li.price?.unit_amount);

        if (!Number.isInteger(pid) || pid <= 0) {
          return res
            .status(400)
            .json({ error: "Invalid PID in Stripe line items" });
        }
        if (!Number.isInteger(quantity) || quantity <= 0) {
          return res
            .status(400)
            .json({ error: "Invalid quantity in Stripe line items" });
        }
        if (!Number.isInteger(unitPriceCents) || unitPriceCents <= 0) {
          return res
            .status(400)
            .json({ error: "Invalid unit price in Stripe line items" });
        }

        stripeItems.push({ pid, quantity, unitPriceCents });
      }

      if (stripeItems.length === 0) {
        return res.status(400).json({ error: "Stripe line items are empty" });
      }

      const totalFromItems = stripeItems.reduce(
        (sum, it) => sum + it.quantity * it.unitPriceCents,
        0,
      );

      const stripeAmountTotal = Number(session.amount_total);
      if (!Number.isInteger(stripeAmountTotal) || stripeAmountTotal <= 0) {
        return res.status(400).json({ error: "Invalid Stripe total amount" });
      }
      if (totalFromItems !== stripeAmountTotal) {
        return res
          .status(400)
          .json({ error: "Stripe amount does not match line items" });
      }

      const payload = buildDigestPayload({
        currency: String(
          session.currency || order.currency || DEFAULT_CURRENCY,
        ),
        salt: order.salt,
        items: stripeItems,
        totalPriceCents: stripeAmountTotal,
      });
      const regeneratedDigest = digest(payload);

      if (regeneratedDigest !== order.digest) {
        return res
          .status(400)
          .json({ error: "Order digest verification failed" });
      }

      const insertTx = db.prepare(
        `INSERT INTO order_transactions (
          orderid,
          stripe_event_id,
          stripe_checkout_session_id,
          stripe_payment_intent_id,
          currency,
          amount_total_cents,
          stripe_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const clearItems = db.prepare(
        "DELETE FROM order_items WHERE orderid = ?",
      );
      const insertItem = db.prepare(
        `INSERT INTO order_items (orderid, pid, quantity, unit_price_cents)
         VALUES (?, ?, ?, ?)`,
      );
      const markPaid = db.prepare(
        `UPDATE orders
         SET status = 'paid',
             currency = ?,
             total_price_cents = ?,
             stripe_checkout_session_id = ?,
             stripe_payment_intent_id = ?,
             paid_at = datetime('now')
         WHERE orderid = ?`,
      );

      const tx = db.transaction(() => {
        clearItems.run(orderid);
        for (const it of stripeItems) {
          insertItem.run(orderid, it.pid, it.quantity, it.unitPriceCents);
        }

        insertTx.run(
          orderid,
          event.id,
          String(session.id || ""),
          session.payment_intent ? String(session.payment_intent) : null,
          String(session.currency || DEFAULT_CURRENCY),
          stripeAmountTotal,
          JSON.stringify(session),
        );

        markPaid.run(
          String(session.currency || DEFAULT_CURRENCY),
          stripeAmountTotal,
          String(session.id || ""),
          session.payment_intent ? String(session.payment_intent) : null,
          orderid,
        );
      });

      tx();
      return res.json({ received: true, validated: true });
    } catch (err) {
      console.error("Stripe webhook processing failed:", err);
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  return router;
}

module.exports = {
  ordersRouter: ordersRouter(),
  stripeWebhookRouter,
};
