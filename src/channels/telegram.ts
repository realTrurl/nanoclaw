import fs from 'fs';
import path from 'path';

import { Bot } from 'grammy';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  TRIGGER_PATTERN,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

/** File extension map for common MIME types */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
};

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Download a Telegram file to the group's media directory.
   * Returns the container-relative path (/workspace/group/media/...) on success, or null on failure.
   */
  private async downloadTelegramFile(
    fileId: string,
    groupFolder: string,
    options?: { mimeType?: string; fileName?: string; prefix?: string },
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      // Build download URL
      const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

      // Determine extension from: explicit fileName > mimeType > file_path
      let ext = '';
      if (options?.fileName) {
        const dotIdx = options.fileName.lastIndexOf('.');
        if (dotIdx >= 0) ext = options.fileName.substring(dotIdx);
      }
      if (!ext && options?.mimeType) {
        ext = MIME_EXTENSIONS[options.mimeType] || '';
      }
      if (!ext) {
        const fpExt = path.extname(file.file_path);
        ext = fpExt || '.bin';
      }

      // Create media directory in the group folder
      const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });

      // Generate filename: prefix-timestamp-shortId.ext
      const prefix = options?.prefix || 'file';
      const ts = Date.now();
      const shortId = fileId.slice(-8);
      const localName = `${prefix}-${ts}-${shortId}${ext}`;
      const localPath = path.join(mediaDir, localName);

      // Download file
      const res = await fetch(downloadUrl);
      if (!res.ok) {
        logger.warn({ fileId, status: res.status }, 'Failed to download Telegram file');
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(localPath, buffer);

      // Return the container-visible path (agents see /workspace/group/...)
      const containerPath = `/workspace/group/media/${localName}`;
      logger.info({ fileId, localPath, containerPath, size: buffer.length }, 'Telegram file downloaded');
      return containerPath;
    } catch (err) {
      logger.error({ fileId, err }, 'Error downloading Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Helper to build common message fields from a media context
    const extractMeta = (ctx: any) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return null;
      return {
        chatJid,
        group,
        timestamp: new Date(ctx.message.date * 1000).toISOString(),
        senderName: ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown',
        sender: ctx.from?.id?.toString() || '',
        msgId: ctx.message.message_id.toString(),
        caption: ctx.message.caption ? ` ${ctx.message.caption}` : '',
      };
    };

    const storeNonText = (ctx: any, placeholder: string) => {
      const meta = extractMeta(ctx);
      if (!meta) return;
      this.opts.onChatMetadata(meta.chatJid, meta.timestamp);
      this.opts.onMessage(meta.chatJid, {
        id: meta.msgId,
        chat_jid: meta.chatJid,
        sender: meta.sender,
        sender_name: meta.senderName,
        content: `${placeholder}${meta.caption}`,
        timestamp: meta.timestamp,
        is_from_me: false,
      });
    };

    // --- Media handlers with file download ---

    this.bot.on('message:photo', async (ctx) => {
      const meta = extractMeta(ctx);
      if (!meta) return;
      this.opts.onChatMetadata(meta.chatJid, meta.timestamp);

      // Telegram sends multiple sizes; pick the largest (last in array)
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const filePath = await this.downloadTelegramFile(largest.file_id, meta.group.folder, {
        mimeType: 'image/jpeg',
        prefix: 'photo',
      });

      const content = filePath
        ? `[Photo: ${filePath}]${meta.caption}`
        : `[Photo]${meta.caption}`;

      this.opts.onMessage(meta.chatJid, {
        id: meta.msgId, chat_jid: meta.chatJid, sender: meta.sender,
        sender_name: meta.senderName, content, timestamp: meta.timestamp, is_from_me: false,
      });
    });

    this.bot.on('message:video', async (ctx) => {
      const meta = extractMeta(ctx);
      if (!meta) return;
      this.opts.onChatMetadata(meta.chatJid, meta.timestamp);

      const video = ctx.message.video;
      const filePath = await this.downloadTelegramFile(video.file_id, meta.group.folder, {
        mimeType: video.mime_type,
        prefix: 'video',
      });

      const content = filePath
        ? `[Video: ${filePath}]${meta.caption}`
        : `[Video]${meta.caption}`;

      this.opts.onMessage(meta.chatJid, {
        id: meta.msgId, chat_jid: meta.chatJid, sender: meta.sender,
        sender_name: meta.senderName, content, timestamp: meta.timestamp, is_from_me: false,
      });
    });

    this.bot.on('message:voice', async (ctx) => {
      const meta = extractMeta(ctx);
      if (!meta) return;
      this.opts.onChatMetadata(meta.chatJid, meta.timestamp);

      const voice = ctx.message.voice;
      const filePath = await this.downloadTelegramFile(voice.file_id, meta.group.folder, {
        mimeType: voice.mime_type || 'audio/ogg',
        prefix: 'voice',
      });

      const content = filePath
        ? `[Voice message: ${filePath}]${meta.caption}`
        : `[Voice message]${meta.caption}`;

      this.opts.onMessage(meta.chatJid, {
        id: meta.msgId, chat_jid: meta.chatJid, sender: meta.sender,
        sender_name: meta.senderName, content, timestamp: meta.timestamp, is_from_me: false,
      });
    });

    this.bot.on('message:audio', async (ctx) => {
      const meta = extractMeta(ctx);
      if (!meta) return;
      this.opts.onChatMetadata(meta.chatJid, meta.timestamp);

      const audio = ctx.message.audio;
      const filePath = await this.downloadTelegramFile(audio.file_id, meta.group.folder, {
        mimeType: audio.mime_type,
        prefix: 'audio',
      });

      const content = filePath
        ? `[Audio: ${filePath}]${meta.caption}`
        : `[Audio]${meta.caption}`;

      this.opts.onMessage(meta.chatJid, {
        id: meta.msgId, chat_jid: meta.chatJid, sender: meta.sender,
        sender_name: meta.senderName, content, timestamp: meta.timestamp, is_from_me: false,
      });
    });

    this.bot.on('message:document', async (ctx) => {
      const meta = extractMeta(ctx);
      if (!meta) return;
      this.opts.onChatMetadata(meta.chatJid, meta.timestamp);

      const doc = ctx.message.document;
      const fileName = doc?.file_name || 'file';
      const filePath = doc ? await this.downloadTelegramFile(doc.file_id, meta.group.folder, {
        mimeType: doc.mime_type,
        fileName,
        prefix: 'doc',
      }) : null;

      const content = filePath
        ? `[Document: ${fileName} ${filePath}]${meta.caption}`
        : `[Document: ${fileName}]${meta.caption}`;

      this.opts.onMessage(meta.chatJid, {
        id: meta.msgId, chat_jid: meta.chatJid, sender: meta.sender,
        sender_name: meta.senderName, content, timestamp: meta.timestamp, is_from_me: false,
      });
    });

    // Non-downloadable media types — keep as placeholders
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}
