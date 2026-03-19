const crypto = require("crypto");

const SALT_LENGTH = 16;
const HASH_LENGTH = 64;
const ITERATIONS = 100000;
const DIGEST = "sha512";

// Generate a hashed password
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, ITERATIONS, HASH_LENGTH, DIGEST)
    .toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) {
    return false;
  }

  const [salt, hash] = storedHash.split(":");

  if (!salt || !hash) {
    return false;
  }

  const verifyHash = crypto
    .pbkdf2Sync(password, salt, ITERATIONS, HASH_LENGTH, DIGEST)
    .toString("hex");

  // Use timingSafeEqual to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(verifyHash, "hex"),
  );
}

module.exports = {
  hashPassword,
  verifyPassword,
};
