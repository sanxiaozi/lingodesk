/**
 * 租户 bot token 的静态加密(AES-256-GCM,密钥 = sha256(TOKEN_SECRET))。
 * 存储格式:iv.tag.cipher(均 base64url)。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";

const key = createHash("sha256").update(config.tokenSecret).digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}

export function decrypt(stored: string): string {
  const [iv, tag, data] = stored.split(".");
  if (!iv || !tag || !data) throw new Error("加密串格式不对(TOKEN_SECRET 是否换过?)");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
