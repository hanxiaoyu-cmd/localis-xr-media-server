import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocalisConfig, PlaybackProgress } from './types';

export class ProgressStore {
  private values = new Map<string, PlaybackProgress>();
  private writeQueue = Promise.resolve();

  constructor(private readonly config: LocalisConfig) {}

  async initialize() {
    try {
      const stored = JSON.parse(await readFile(path.join(this.config.dataDir, 'progress.json'), 'utf8')) as Record<string, PlaybackProgress>;
      this.values = new Map(Object.entries(stored));
    } catch {
      // Progress starts empty.
    }
  }

  list() { return Object.fromEntries(this.values); }
  get(id: string) { return this.values.get(id); }

  async set(mediaId: string, position: number, duration: number) {
    const value: PlaybackProgress = {
      mediaId,
      position: Math.max(0, Number(position) || 0),
      duration: Math.max(0, Number(duration) || 0),
      updatedAt: new Date().toISOString(),
    };
    this.values.set(mediaId, value);
    this.writeQueue = this.writeQueue.then(() => writeFile(
      path.join(this.config.dataDir, 'progress.json'),
      JSON.stringify(Object.fromEntries(this.values), null, 2),
    ));
    await this.writeQueue;
    return value;
  }
}
