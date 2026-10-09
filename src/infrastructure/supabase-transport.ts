import type { ZamerDatabase } from "./database";
import { MediaRepository, checksum } from "./media-repository";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseSnapshot } from "../domain/snapshot";
import type { OutboxEntry } from "./sync-model";
import type { SyncTransport } from "./sync-worker";
let cached: SupabaseClient | undefined;
export function configuredClient(): SupabaseClient | null {
  if (cached) return cached;
  const url = import.meta.env.VITE_SUPABASE_URL,
    key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" &&
    !(
      parsed.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(parsed.hostname)
    )
  )
    throw new Error("Supabase требует HTTPS");
  if (key.startsWith("sb_secret_"))
    throw new Error("Секретный ключ нельзя использовать в браузере");
  if (key.split(".").length === 3) {
    try {
      const payload = JSON.parse(
        atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
      if (payload.role === "service_role")
        throw new Error("Секретный ключ нельзя использовать в браузере");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Секретный"))
        throw error;
    }
  }
  return (cached = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)])
            : AbortSignal.timeout(20000),
        }),
    },
  }));
}
const revision = z.number().int().positive();
export class SupabaseTransport implements SyncTransport {
  constructor(
    readonly client: SupabaseClient,
    readonly db?: ZamerDatabase,
  ) {}
  async push(entry: OutboxEntry) {
    if (!entry.snapshot) throw new Error("Не подготовлена версия отправки");
    const { data, error } = await this.client.rpc("zamer_push", {
      project_id: entry.projectId,
      command_id: entry.id,
      base_revision: entry.baseRevision,
      snapshot: entry.snapshot,
    });
    if (error) throw error;
    const result = z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("ack"), revision }),
        z.object({
          type: z.literal("conflict"),
          revision,
          snapshot: z.unknown(),
        }),
      ])
      .parse(data);
    if (result.type === "ack" && (entry.snapshot.photos ?? []).length) {
      if (!this.db) throw new Error("Хранилище оригиналов недоступно");
      const media = new MediaRepository(this.db);
      for (const photo of entry.snapshot.photos ?? []) {
        await media.access(entry.projectId);
        const state = await this.db.photoTransfers.get(photo.id);
        if (
          state?.uploaded &&
          state.checksum === photo.checksum &&
          state.storageKey === photo.storageKey
        )
          continue;
        try {
          const file = await this.db.photoFiles.get(photo.checksum);
          if (
            !file ||
            file.original.size !== photo.size ||
            (await checksum(file.original)) !== photo.checksum
          )
            throw new Error(
              "Оригинал недоступен или повреждён; очередь сохранена",
            );
          const { error: uploadError } = await this.client.storage
            .from("zamer-originals")
            .upload(photo.storageKey, file.original, {
              contentType: photo.mimeType,
              upsert: false,
            });
          if (
            uploadError &&
            !["409", "400"].includes(
              String((uploadError as { statusCode?: string }).statusCode),
            )
          )
            throw uploadError;
          const { data: downloaded, error: downloadError } =
            await this.client.storage
              .from("zamer-originals")
              .download(photo.storageKey);
          if (
            downloadError ||
            !downloaded ||
            downloaded.size !== photo.size ||
            (await checksum(downloaded)) !== photo.checksum
          )
            throw new Error("Storage не подтвердил целостность оригинала");
          await media.access(entry.projectId);
          await this.db.photoTransfers.put({
            photoId: photo.id,
            projectId: entry.projectId,
            uploaded: true,
            checksum: photo.checksum,
            storageKey: photo.storageKey,
            error: null,
          });
        } catch (error) {
          await this.db.photoTransfers.put({
            photoId: photo.id,
            projectId: entry.projectId,
            uploaded: false,
            checksum: photo.checksum,
            storageKey: photo.storageKey,
            error: "Оригинал ожидает отправки",
          });
          throw error;
        }
      }
    }
    return result.type === "ack"
      ? result
      : { ...result, snapshot: parseSnapshot(result.snapshot) };
  }
  async list() {
    const { data, error } = await this.client.rpc("zamer_list");
    if (error) throw error;
    return z
      .array(z.object({ revision, snapshot: z.unknown() }))
      .parse(data)
      .map((r) => ({ ...r, snapshot: parseSnapshot(r.snapshot) }));
  }
}
