import axios from 'axios';
import type { Telegram } from 'telegraf';

export interface DownloadedFile {
  buffer: Buffer;
  name: string;
}

/**
 * Unduh file dari Telegram (gambar/video yang dikirim user) ke Buffer.
 * URL unduhan Telegram: https://api.telegram.org/file/bot<token>/<file_path>
 */
export async function downloadTelegramFile(
  telegram: Telegram,
  fileId: string,
  botToken: string,
): Promise<DownloadedFile> {
  const file = await telegram.getFile(fileId);
  if (!file.file_path) {
    throw new Error('File tidak bisa diunduh (file_path kosong — kemungkinan terlalu besar).');
  }
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const r = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 300_000,
  });
  const name = file.file_path.split('/').pop() ?? 'file.bin';
  return { buffer: Buffer.from(r.data), name };
}
