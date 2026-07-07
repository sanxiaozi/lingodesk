/**
 * 文件存档:把 Telegram 文件下载到本地(Bot API getFile 上限 20MB)。
 * 超限的文件返回 null,只靠 file_id 保留(Telegram 云端,可随时重发)。
 * 多租户:调用方传对应租户 bot 的 token 与子目录(tenantId/tgId)。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

const MAX_DOWNLOAD = 20 * 1024 * 1024; // Bot API getFile 限制

/** 下载文件到 storage/<subDir>/<fileName>,返回本地路径或 null */
export async function downloadTgFile(botToken: string, fileId: string, subDir: string, fileName: string): Promise<string | null> {
  try {
    const gf = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
    const gj = (await gf.json()) as { ok: boolean; result?: { file_path?: string; file_size?: number } };
    if (!gj.ok || !gj.result?.file_path) return null;
    if ((gj.result.file_size ?? 0) > MAX_DOWNLOAD) return null; // 超 20MB,留 file_id
    const url = `https://api.telegram.org/file/bot${botToken}/${gj.result.file_path}`;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const dir = join(config.storageDir, subDir.replace(/[^\w/-]/g, "_"));
    await mkdir(dir, { recursive: true });
    const safeName = fileName.replace(/[/\\]/g, "_");
    const dest = join(dir, `${Date.now()}_${safeName}`);
    await writeFile(dest, buf);
    return dest;
  } catch (e) {
    console.error("文件下载失败:", e);
    return null;
  }
}
