import { Markup } from 'telegraf';
import type { BotCtx } from '../bot/session.js';
import { apiKeyManager } from './manager.js';

const LINE = '━'.repeat(20);

/**
 * Handle /setapikey command - user input private API key
 */
export async function handleSetApiKey(ctx: BotCtx): Promise<void> {
  const userId = ctx.from!.id;
  const chatId = ctx.chat!.id;

  ctx.session.conversationState = 'waiting_private_apikey' as any;

  const message = `${LINE}\n🔑 *API Key Pribadi*\n\nMasukkan API Key Anda dari RunningHub.\n\nAPI key ini akan digunakan hanya untuk generate milik akun Anda.\n\n⚠️ Jangan kirim API key milik orang lain.\n${LINE}`;

  await ctx.reply(message, { parse_mode: 'Markdown' });
}

/**
 * Handle user text input - validate and store API key
 */
export async function handleApiKeyInput(ctx: BotCtx): Promise<void> {
  const userId = ctx.from!.id;
  const chatId = ctx.chat!.id;
  const inputText = (ctx.message as any)?.text?.trim();

  if (!inputText) {
    await ctx.reply('⚠️ Input tidak valid. Coba lagi.');
    return;
  }

  // Simple validation: API key should be alphanumeric, 30+ chars typically
  if (inputText.length < 20) {
    await ctx.reply('⚠️ API key terlalu pendek. Pastikan Anda menyalin semuanya dengan benar.');
    return;
  }

  try {
    // Save the API key
    await apiKeyManager.setPrivateApiKey(userId, chatId, inputText);

    ctx.session.privateApiKey = inputText;
    ctx.session.usingPrivateMode = true;
    ctx.session.conversationState = 'idle';

    const confirmMessage = `${LINE}\n✅ *API Key berhasil disimpan*\n\nMode: 🔑 API Pribadi\n\nBilling: RunningHub Anda\n\nSilakan pilih workflow:\n${LINE}`;

    await ctx.reply(confirmMessage, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🎬 Kling Motion Control', 'workflow:kling_private')],
      ]).reply_markup,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${chatId}] Failed to save API key: ${msg}`);
    await ctx.reply(`❌ Gagal menyimpan API key: ${msg}`);
  }
}

/**
 * Handle /clearapikey command - remove stored API key
 */
export async function handleClearApiKey(ctx: BotCtx): Promise<void> {
  const userId = ctx.from!.id;
  const chatId = ctx.chat!.id;

  try {
    const hadKey = await apiKeyManager.hasPrivateApiKey(userId);

    if (!hadKey) {
      await ctx.reply('ℹ️ Tidak ada API key pribadi yang tersimpan.');
      return;
    }

    await apiKeyManager.deletePrivateApiKey(userId);
    ctx.session.privateApiKey = undefined;
    ctx.session.usingPrivateMode = false;

    await ctx.reply(`✅ API key pribadi dihapus. Kembali ke mode default.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${chatId}] Failed to clear API key: ${msg}`);
    await ctx.reply(`❌ Gagal menghapus API key: ${msg}`);
  }
}

/**
 * Check if user has private API key and load it to session
 */
export async function loadPrivateApiKeyToSession(ctx: BotCtx): Promise<void> {
  const userId = ctx.from!.id;

  try {
    const apiKey = await apiKeyManager.getPrivateApiKey(userId);
    if (apiKey) {
      ctx.session.privateApiKey = apiKey;
      ctx.session.usingPrivateMode = true;
    }
  } catch (err) {
    console.error(`Failed to load private API key for ${userId}:`, err);
  }
}
