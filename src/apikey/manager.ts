import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const APIKEY_FILE = path.join(DATA_DIR, 'apikeys.json');

interface UserApiKey {
  userId: number;
  chatId: number;
  apiKey: string;
  savedAt: number;
  lastUsedAt?: number;
}

interface ApiKeyStore {
  keys: Record<string, UserApiKey>;
}

/** Manage user private API keys */
class ApiKeyManager {
  private data: ApiKeyStore = { keys: {} };
  private initialized = false;

  async initialize(): Promise<void> {
    try {
      const content = await fs.readFile(APIKEY_FILE, 'utf-8');
      this.data = JSON.parse(content);
    } catch (err) {
      // File tidak ada atau invalid — mulai dari kosong
      this.data = { keys: {} };
      await this.save();
    }
    this.initialized = true;
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(APIKEY_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save API keys:', err);
    }
  }

  /** Save user's private API key */
  async setPrivateApiKey(userId: number, chatId: number, apiKey: string): Promise<void> {
    if (!this.initialized) await this.initialize();
    
    const key = String(userId);
    this.data.keys[key] = {
      userId,
      chatId,
      apiKey: apiKey.trim(),
      savedAt: Date.now(),
    };
    await this.save();
  }

  /** Get user's private API key */
  async getPrivateApiKey(userId: number): Promise<string | null> {
    if (!this.initialized) await this.initialize();
    
    const key = String(userId);
    const entry = this.data.keys[key];
    return entry ? entry.apiKey : null;
  }

  /** Check if user has private API key set */
  async hasPrivateApiKey(userId: number): Promise<boolean> {
    const key = await this.getPrivateApiKey(userId);
    return !!key;
  }

  /** Delete user's private API key */
  async deletePrivateApiKey(userId: number): Promise<void> {
    if (!this.initialized) await this.initialize();
    
    const key = String(userId);
    delete this.data.keys[key];
    await this.save();
  }

  /** Update last used timestamp */
  async updateLastUsed(userId: number): Promise<void> {
    if (!this.initialized) await this.initialize();
    
    const key = String(userId);
    if (this.data.keys[key]) {
      this.data.keys[key].lastUsedAt = Date.now();
      await this.save();
    }
  }
}

export const apiKeyManager = new ApiKeyManager();
