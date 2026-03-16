const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { db } = require("./db");

const JWT_SECRET = process.env.JWT_SECRET || "ztr280521";

function loginAdmin(username, password) {
  const user = db.prepare("SELECT * FROM admin_users WHERE username = ?").get(username);
  if (!user) return null;

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return null;

  return jwt.sign(
    { sub: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) {
    return res.status(401).json({ ok: false, error: "Não autenticado" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
}

module.exports = {
  loginAdmin,
  requireAuth
};