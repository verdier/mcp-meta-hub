import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

/** What survives a restart for one server. The PKCE verifier and the authorization state never do. */
export interface CredentialRecord {
  /** Normalized endpoint the record is bound to: a different endpoint starts from scratch. */
  endpoint: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
}

const RecordSchema = z.object({
  endpoint: z.url(),
  clientInformation: z.union([OAuthClientInformationFullSchema, OAuthClientInformationSchema]).optional(),
  tokens: OAuthTokensSchema.optional(),
  discoveryState: z.object({
    authorizationServerUrl: z.url(),
    authorizationServerMetadata: z.union([OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema]).optional(),
    resourceMetadata: OAuthProtectedResourceMetadataSchema.optional(),
    resourceMetadataUrl: z.url().optional(),
  }).strict().optional(),
}).strict();

const FileSchema = z.object({ version: z.literal(1), credentials: z.record(z.string(), RecordSchema) }).strict();

export const STORE_FILE = "credentials.json";

/**
 * Plaintext credentials of every OAuth child in one JSON file: directory 0700,
 * file 0600, written atomically (temp file, fsync, rename), every
 * read-modify-write serialized. One hub process per store.
 */
export class CredentialStore {
  readonly filePath: string;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.filePath = join(dir, STORE_FILE);
    this.ensureDirectory();
    this.isSafeFile();
  }

  /** Bind `key` to `endpoint`; a record bound to another endpoint is dropped. */
  prepare(key: string, endpoint: string): Promise<void> {
    return this.update(key, (current) => (current?.endpoint === endpoint ? current : { endpoint }));
  }

  load(key: string): Promise<CredentialRecord | undefined> {
    return this.serialize(async () => this.read()[key]);
  }

  update(key: string, updater: (current: CredentialRecord | undefined) => CredentialRecord): Promise<void> {
    return this.serialize(async () => {
      const records = this.read();
      records[key] = RecordSchema.parse(updater(records[key])) as CredentialRecord;
      this.write(records);
    });
  }

  private read(): Record<string, CredentialRecord> {
    this.ensureDirectory();
    if (!this.isSafeFile()) return {};
    try {
      return FileSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8"))).credentials as Record<string, CredentialRecord>;
    } catch {
      throw new Error(`OAuth credential store ${this.filePath} is corrupt or unreadable`);
    }
  }

  private write(records: Record<string, CredentialRecord>): void {
    const temp = join(this.dir, `.${STORE_FILE}.${randomBytes(12).toString("hex")}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ version: 1, credentials: records }, null, 2)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.filePath);
      const dirFd = openSync(this.dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        // Already renamed.
      }
      throw error;
    }
  }

  private ensureDirectory(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const stats = lstatSync(this.dir);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("unsafe");
      chmodSync(this.dir, 0o700);
    } catch {
      throw new Error(`OAuth store directory ${this.dir} is unsafe`);
    }
  }

  /** False if the file does not exist yet; throws if it is not a regular file. */
  private isSafeFile(): boolean {
    try {
      const stats = lstatSync(this.filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("unsafe");
      chmodSync(this.filePath, 0o600);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error(`OAuth credential store ${this.filePath} is unsafe`);
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
