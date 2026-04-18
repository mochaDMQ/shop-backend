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

        const stripeSession = await stripe.checkout.sessions.create({
          mode: "payment",
          success_url: `${FRONTEND_ORIGIN}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${FRONTEND_ORIGIN}/?checkout=cancelled`,
          client_reference_id: String(req.user.userid),
          metadata: {
            userid: String(req.user.userid),
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

        return res.status(201).json({
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

  router.all("/checkout/confirm", requireAuth, async (req, res) => {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured" });
    }

    try {
      const sessionId = String(
        req.body?.session_id || req.query?.session_id || "",
      ).trim();
      if (!sessionId) {
        return res.status(400).json({ error: "Missing checkout session id" });
      }

      const existingTx = db
        .prepare(
          `SELECT o.*,
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
             FROM order_transactions ot
             JOIN orders o ON o.orderid = ot.orderid
             WHERE ot.stripe_checkout_session_id = ?`,
        )
        .get(sessionId);

      if (existingTx) {
        return res.json({
          orderid: existingTx.orderid,
          order: toOrderDTO(existingTx),
          duplicate: true,
        });
      }

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (!session || session.mode !== "payment") {
        return res.status(400).json({ error: "Invalid checkout session" });
      }

      if (session.payment_status !== "paid") {
        return res.status(400).json({ error: "Payment is not completed" });
      }

      const sessionUserId = Number(
        session.client_reference_id || session.metadata?.userid,
      );
      if (
        !Number.isInteger(sessionUserId) ||
        sessionUserId <= 0 ||
        sessionUserId !== req.user.userid
      ) {
        return res.status(403).json({ error: "Session user mismatch" });
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
        const directUnit = Number(li.price?.unit_amount);
        const subtotal = Number(li.amount_subtotal);
        const unitPriceCents =
          Number.isInteger(directUnit) && directUnit > 0
            ? directUnit
            : Number.isInteger(subtotal) &&
                Number.isInteger(quantity) &&
                quantity > 0
              ? Math.round(subtotal / quantity)
              : NaN;

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

      const salt = String(session.metadata?.salt || "");
      const expectedDigest = String(session.metadata?.digest || "");
      if (!salt || !expectedDigest) {
        return res.status(400).json({ error: "Missing checkout metadata" });
      }

      const currency = String(
        session.currency || DEFAULT_CURRENCY,
      ).toLowerCase();
      const payload = buildDigestPayload({
        currency,
        salt,
        items: stripeItems,
        totalPriceCents: stripeAmountTotal,
      });
      const regeneratedDigest = digest(payload);
      if (regeneratedDigest !== expectedDigest) {
        return res
          .status(400)
          .json({ error: "Order digest verification failed" });
      }

      const insertOrder = db.prepare(
        `INSERT INTO orders (
            userid,
            currency,
            salt,
            digest,
            total_price_cents,
            status,
            stripe_checkout_session_id,
            stripe_payment_intent_id,
            paid_at
          ) VALUES (?, ?, ?, ?, ?, 'paid', ?, ?, datetime('now'))`,
      );
      const insertOrderItem = db.prepare(
        `INSERT INTO order_items (
            orderid, pid, quantity, unit_price_cents
          ) VALUES (?, ?, ?, ?)`,
      );
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

      const tx = db.transaction(() => {
        const result = insertOrder.run(
          req.user.userid,
          currency,
          salt,
          expectedDigest,
          stripeAmountTotal,
          String(session.id || ""),
          session.payment_intent ? String(session.payment_intent) : null,
        );

        const orderid = Number(result.lastInsertRowid);

        for (const it of stripeItems) {
          insertOrderItem.run(orderid, it.pid, it.quantity, it.unitPriceCents);
        }

        insertTx.run(
          orderid,
          `session_confirmed:${session.id}`,
          String(session.id || ""),
          session.payment_intent ? String(session.payment_intent) : null,
          currency,
          stripeAmountTotal,
          JSON.stringify(session),
        );

        return orderid;
      });

      const orderid = tx();
      const created = db
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

      return res.status(201).json({
        orderid,
        order: toOrderDTO(created),
      });
    } catch (err) {
      console.error("Checkout confirm failed:", err);
      return res.status(400).json({
        error: err.message || "Checkout confirm failed",
      });
    }
  });

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

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log("[Stripe Webhook] checkout.session.completed (no-op):", {
        id: session.id,
        client_reference_id: session.client_reference_id,
        payment_intent: session.payment_intent,
        currency: session.currency,
        amount_total: session.amount_total,
      });
    }

    return res.json({ received: true });
  });

  return router;
}

module.exports = {
  ordersRouter: ordersRouter(),
  stripeWebhookRouter,
};
