// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs"); // reservado p/ futuros usuarios reales
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const mime = require("mime-types");
const { getPool } = require("./db");

const app = express();
app.set("trust proxy", true); // req.protocol correcto tras proxies

// ---- Config básica ----
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "cambia_esto";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, ""); // sin slash final

// ---- Archivos subidos ----
const UPLOAD_DIR = path.resolve(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

// ---- Middlewares globales ----
app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- Multer (solo imágenes) ----
const fileFilter = (req, file, cb) => {
  const ok = /image\/(jpeg|png|webp|gif)/i.test(file.mimetype || "");
  cb(ok ? null : new Error("Solo imágenes (jpg, png, webp, gif)"), ok);
};
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = mime.extension(file.mimetype) || "jpg";
    const safeId = String(req.params.id || "x").replace(/[^a-zA-Z0-9_-]/g, "");
    cb(null, `inv_${safeId}_${Date.now()}.${ext}`);
  },
});
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ---- Helpers Auth ----
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}
function auth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "Falta token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
}

// ---- Parser numérico robusto ("1.234,56" -> 1234.56) ----
function parseNumAny(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  const clean = s.replace(/\./g, "").replace(",", ".");
  return Number(clean);
}

// ---- Salud ----
app.get("/salud", async (req, res) => {
  try {
    const pool = await getPool();
    const [r] = await pool.query("SELECT DATABASE() AS bd");
    res.json({ ok: true, datos: r[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Auth simple ----
app.post("/auth/login", async (req, res) => {
  const { usuario, contrasena } = req.body || {};
  const U = process.env.ADMIN_USER || "admin";
  const P = process.env.ADMIN_PASS || "admin";
  if (usuario === U && contrasena === P) {
    const token = signToken({ rol: "admin", nombre: "Administrador" });
    return res.json({
      ok: true,
      datos: { token, usuario: { nombre: "Administrador", rol: "admin" } },
    });
  }
  return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
});

// ======================================================
// ===============     INVENTARIO      ==================
// ======================================================
app.get("/api/inventario", auth, async (req, res) => {
  try {
    const { q, categoria } = req.query;
    const cond = [];
    const vals = [];
    if (q) {
      cond.push("nombre_producto LIKE ?");
      vals.push(`%${q}%`);
    }
    if (categoria) {
      cond.push("categoria = ?");
      vals.push(categoria);
    }

    let sql = `
      SELECT id_producto, nombre_producto, categoria, precio_unitario,
             stock_inicial, stock_minimo, imagen_url
      FROM inventario
    `;
    if (cond.length) sql += " WHERE " + cond.join(" AND ");
    sql += " ORDER BY id_producto ASC";

    const pool = await getPool();
    const [rows] = await pool.query(sql, vals);
    res.json({ ok: true, datos: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Opciones livianas para combos (id, nombre, imagen, precio)
app.get("/api/inventario/opciones", auth, async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query(
      "SELECT id_producto, nombre_producto, imagen_url, precio_unitario FROM inventario ORDER BY nombre_producto ASC"
    );
    res.json({ ok: true, datos: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/inventario/:id", auth, async (req, res) => {
  try {
    const pool = await getPool();
    const [r] = await pool.query(
      "SELECT * FROM inventario WHERE id_producto = ?",
      [req.params.id]
    );
    if (!r.length)
      return res.status(404).json({ ok: false, error: "No encontrado" });
    res.json({ ok: true, datos: r[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/inventario", auth, async (req, res) => {
  try {
    const {
      id_producto,
      nombre_producto,
      categoria,
      precio_unitario,
      stock_inicial,
      stock_minimo = 3,
      imagen_url,
    } = req.body || {};

    if (!nombre_producto || !categoria) {
      return res.status(400).json({
        ok: false,
        error: "nombre_producto y categoria son obligatorios",
      });
    }

    const pool = await getPool();
    let newId = id_producto;
    if (!newId) {
      const [m] = await pool.query(
        "SELECT COALESCE(MAX(id_producto),0)+1 AS nextId FROM inventario"
      );
      newId = m[0].nextId;
    }

    await pool.query(
      "INSERT INTO inventario (id_producto, nombre_producto, categoria, precio_unitario, stock_inicial, stock_minimo, imagen_url) VALUES (?,?,?,?,?,?,?)",
      [
        newId,
        nombre_producto,
        categoria,
        Number(precio_unitario || 0),
        Number(stock_inicial || 0),
        Number(stock_minimo || 3),
        imagen_url || null,
      ]
    );

    const [r] = await pool.query(
      "SELECT * FROM inventario WHERE id_producto=?",
      [newId]
    );
    res.json({ ok: true, datos: r[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put("/api/inventario/:id", auth, async (req, res) => {
  try {
    const {
      nombre_producto,
      categoria,
      precio_unitario,
      stock_inicial,
      stock_minimo,
      imagen_url,
    } = req.body || {};
    const pool = await getPool();
    const [r] = await pool.query(
      "UPDATE inventario SET nombre_producto=?, categoria=?, precio_unitario=?, stock_inicial=?, stock_minimo=?, imagen_url=? WHERE id_producto=?",
      [
        nombre_producto,
        categoria,
        Number(precio_unitario),
        Number(stock_inicial),
        Number(stock_minimo),
        imagen_url ?? null,
        req.params.id,
      ]
    );
    if (!r.affectedRows)
      return res.status(404).json({ ok: false, error: "No encontrado" });

    const [row] = await pool.query(
      "SELECT * FROM inventario WHERE id_producto=?",
      [req.params.id]
    );
    res.json({ ok: true, datos: row[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/inventario/:id", auth, async (req, res) => {
  try {
    const pool = await getPool();
    const [r] = await pool.query("DELETE FROM inventario WHERE id_producto=?", [
      req.params.id,
    ]);
    if (!r.affectedRows)
      return res.status(404).json({ ok: false, error: "No encontrado" });
    res.json({ ok: true, datos: { id_producto: Number(req.params.id) } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Subir/actualizar imagen de un producto
app.post(
  "/api/inventario/:id/imagen",
  auth,
  upload.single("imagen"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: "ID inválido" });
      if (!req.file)
        return res
          .status(400)
          .json({ ok: false, error: 'Falta archivo "imagen"' });

      const pool = await getPool();

      // ¿Existe el producto?
      const [ex] = await pool.query(
        "SELECT imagen_url FROM inventario WHERE id_producto=?",
        [id]
      );
      if (!ex.length) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        return res
          .status(404)
          .json({ ok: false, error: "Producto no encontrado" });
      }

      // (Opcional) borrar imagen anterior local
      const anterior = ex[0].imagen_url;
      if (anterior && anterior.includes("/uploads/")) {
        try {
          const rel = anterior.split("/uploads/")[1];
          const abs = path.join(UPLOAD_DIR, rel);
          if (abs.startsWith(UPLOAD_DIR) && fs.existsSync(abs))
            fs.unlinkSync(abs);
        } catch {}
      }

      // Construir URL pública
      const base = (
        PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`
      ).replace(/\/$/, "");
      const publicUrl = `${base}/uploads/${encodeURIComponent(
        req.file.filename
      )}`;

      // Guardar URL
      await pool.query(
        "UPDATE inventario SET imagen_url=? WHERE id_producto=?",
        [publicUrl, id]
      );

      // Devolver fila actualizada
      const [row] = await pool.query(
        "SELECT * FROM inventario WHERE id_producto=?",
        [id]
      );

      console.log("[UPLOAD] id:", id);
      console.log("[UPLOAD] file:", req.file.filename);
      console.log("[UPLOAD] url:", publicUrl);

      return res.json({ ok: true, datos: row[0] });
    } catch (e) {
      console.error("[UPLOAD] error:", e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// ======================================================
// ==================       VENTAS       ================
// ======================================================
app.get("/api/ventas", auth, async (req, res) => {
  try {
    const { desde, hasta, id_producto } = req.query;
    const cond = [];
    const vals = [];
    if (desde) {
      cond.push("v.fecha >= ?");
      vals.push(desde);
    }
    if (hasta) {
      cond.push("v.fecha <= ?");
      vals.push(hasta);
    }
    if (id_producto) {
      cond.push("v.id_producto = ?");
      vals.push(id_producto);
    }

    let sql = `
      SELECT
        v.*,
        i.nombre_producto,
        i.imagen_url
      FROM ventas v
      INNER JOIN inventario i ON i.id_producto = v.id_producto
    `;
    if (cond.length) sql += " WHERE " + cond.join(" AND ");
    sql += " ORDER BY v.fecha DESC, v.id DESC";

    const pool = await getPool();
    const [rows] = await pool.query(sql, vals);
    res.json({ ok: true, datos: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Crear venta (RESTAR stock en inventario UNA sola vez)
app.post("/api/ventas", auth, async (req, res) => {
  const { fecha, id_producto, cantidad_vendida, total_venta, observaciones } =
    req.body || {};
  const idNum = Number(id_producto);
  const qty = parseNumAny(cantidad_vendida);
  const tot = parseNumAny(total_venta);

  if (!fecha || !idNum || Number.isNaN(qty) || qty <= 0 || Number.isNaN(tot)) {
    return res.status(400).json({
      ok: false,
      error:
        "fecha, id_producto, cantidad_vendida y total_venta son obligatorios/válidos",
    });
  }

  const pool = await getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Restar stock SOLO aquí (si hay stock suficiente)
    const [upd] = await conn.query(
      `UPDATE inventario
         SET stock_inicial = stock_inicial - ?
       WHERE id_producto = ? AND stock_inicial >= ?`,
      [qty, idNum, qty]
    );

    if (upd.affectedRows === 0) {
      await conn.rollback();
      return res.status(409).json({
        ok: false,
        error: `Stock insuficiente o producto inexistente (id=${idNum})`,
      });
    }

    // Obtener nombre y stock restante
    const [[prod]] = await conn.query(
      `SELECT nombre_producto, stock_inicial
         FROM inventario
        WHERE id_producto = ?`,
      [idNum]
    );
    const nombre = prod?.nombre_producto || "";
    const stockRestante = Number(prod?.stock_inicial ?? 0);

    // Insertar venta
    const [ins] = await conn.query(
      `INSERT INTO ventas (fecha, id_producto, producto, cantidad_vendida, total_venta, observaciones)
       VALUES (?,?,?,?,?,?)`,
      [fecha, idNum, nombre, qty, tot, observaciones || null]
    );

    await conn.commit();
    return res.json({
      ok: true,
      datos: {
        creado: true,
        id_venta: ins.insertId,
        stock_restante: stockRestante,
      },
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    conn.release();
  }
});

// Borrar venta (REPONER stock en inventario)
app.delete("/api/ventas/:id", auth, async (req, res) => {
  const pool = await getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Traer venta
    const [[venta]] = await conn.query(
      "SELECT id, id_producto, cantidad_vendida FROM ventas WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!venta) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "No encontrado" });
    }

    // Reponer stock
    await conn.query(
      "UPDATE inventario SET stock_inicial = stock_inicial + ? WHERE id_producto = ?",
      [Number(venta.cantidad_vendida) || 0, Number(venta.id_producto)]
    );

    // Borrar venta
    const [del] = await conn.query("DELETE FROM ventas WHERE id = ?", [
      req.params.id,
    ]);
    if (del.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "No encontrado" });
    }

    await conn.commit();
    return res.json({ ok: true, datos: { id: Number(req.params.id) } });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    conn.release();
  }
});

// ======================================================
// =================  CONSUMO TALLER  ===================
// ======================================================
app.get("/api/consumo", auth, async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query(
      "SELECT * FROM consumo_taller ORDER BY fecha DESC, id DESC"
    );
    res.json({ ok: true, datos: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/consumo", auth, async (req, res) => {
  try {
    const {
      fecha,
      id_producto,
      cantidad,
      valor,
      producto,
      tableros,
      parales,
      venta,
    } = req.body || {};
    if (!fecha || !id_producto || !cantidad || valor == null || !producto) {
      return res.status(400).json({
        ok: false,
        error:
          "fecha, id_producto, producto, cantidad y valor son obligatorios",
      });
    }
    const pool = await getPool();
    // (NOTA) Aquí NO tocamos inventario: si quieres que consumo también descuente,
    // aplica la MISMA estrategia con transacción que en ventas.
    await pool.query(
      "INSERT INTO consumo_taller (fecha, id_producto, producto, cantidad, valor, tableros, parales, venta) VALUES (?,?,?,?,?,?,?,?)",
      [
        fecha,
        id_producto,
        Number(cantidad),
        Number(valor),
        producto,
        tableros != null ? Number(tableros) : null,
        parales != null ? Number(parales) : null,
        venta != null ? Number(venta) : null,
      ]
    );
    res.json({ ok: true, datos: { creado: true } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/consumo/:id", auth, async (req, res) => {
  try {
    const pool = await getPool();
    const [r] = await pool.query("DELETE FROM consumo_taller WHERE id=?", [
      req.params.id,
    ]);
    if (!r.affectedRows)
      return res.status(404).json({ ok: false, error: "No encontrado" });
    res.json({ ok: true, datos: { id: Number(req.params.id) } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ======================================================
// =====================  STOCK  ========================
// ======================================================
// Devolver todas las claves posibles para compatibilidad:
//  - stock_inicial AS stock
//  - stock_inicial (tal cual)
//  - stock_inicial AS stock_actual
app.get("/api/stock", auth, async (req, res) => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT
         id_producto,
         nombre_producto,
         categoria,
         precio_unitario,
         stock_inicial AS stock,         -- 👈 la que tu UI solía usar
         stock_inicial,                  -- 👈 por si leen este nombre
         stock_inicial AS stock_actual,  -- 👈 o este
         stock_minimo,
         imagen_url
       FROM inventario
       ORDER BY nombre_producto`
    );
    res.json({ ok: true, datos: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Start ----
app.listen(PORT, "0.0.0.0", () => {
  console.log(`API escuchando en:`);
  console.log(`  → LAN:   http://192.168.1.9:${PORT}`);
  console.log(`  → Local: http://localhost:${PORT}`);
});
