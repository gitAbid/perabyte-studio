import Busboy from "@fastify/busboy";
import { Readable, Transform } from "node:stream";
import type { BusboyFileStream } from "@fastify/busboy";
import { join } from "node:path";
import { AssetSchema, ImportProvenanceSchema, RightsStatusSchema } from "../../../../../lib/production/contracts";
import { assertSameOriginMutation, getRequestId, productionErrorResponse } from "../../../../../lib/production/http";
import { ProductionApplicationError } from "../../../../../lib/production/errors";
import { withProductionStore, resolveProductionDataDir } from "../../../../../lib/production/runtime";
import { LocalMediaVault, type StagedVaultMedia } from "../../../../../lib/media/production/vault";

const VIDEO_LIMIT = 2 * 1024 * 1024 * 1024;
const FORM_OVERHEAD_LIMIT = 64 * 1024;
const MAX_MIME = new Set(["image/png","image/jpeg","image/webp","audio/wav","audio/mpeg","audio/aac","audio/flac","video/mp4","video/quicktime"]);

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data\s*;/i.test(contentType)) throw invalid("A multipart form with one media file and source/rights fields is required.");
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > VIDEO_LIMIT + FORM_OVERHEAD_LIMIT)) throw tooLarge();
    if (!request.body) throw invalid("A media upload body is required.");
    const dataDir = resolveProductionDataDir(process.env, process.cwd());
    const vault = new LocalMediaVault({ root: join(dataDir, "media") });
    const staged = await streamImport(request, contentType, vault);
    try {
      const provenance = ImportProvenanceSchema.safeParse({ source: staged.fields.source, rightsAttestation: staged.fields.rightsAttestation, actorId: "local_creator", createdAt: Date.now() });
      if (!provenance.success) throw invalid("Source and rights attestation must be valid and within their limits.");
      const rightsStatus = RightsStatusSchema.safeParse(staged.fields.rightsStatus);
      if (!rightsStatus.success || !["creator_attested", "licensed", "public_domain"].includes(rightsStatus.data)) throw invalid("Choose creator-attested, licensed, or public-domain rights status.");
      const media = await staged.media.publish();
      const asset = AssetSchema.parse({ ...media.asset, rightsStatus: rightsStatus.data, importProvenance: provenance.data });
      await withProductionStore(store => store.transaction(tx => tx.insertAsset({ ...media, asset })));
      return Response.json({ asset }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) { await staged.media.abort(); throw error; }
  } catch (error) { return productionErrorResponse(error, requestId); }
}

interface ImportFields { source: string; rightsAttestation: string; rightsStatus: string }
async function streamImport(request: Request, contentType: string, vault: LocalMediaVault): Promise<{ media: StagedVaultMedia; fields: ImportFields }> {
  const fields: Partial<ImportFields> = {};
  let filePromise: Promise<StagedVaultMedia> | null = null;
  let activeFile: BusboyFileStream | null = null;
  let fileCount = 0;
  let failure: unknown;
  const parser = new Busboy({ headers: { "content-type": contentType }, preservePath: false, limits: { fields: 3, files: 1, parts: 4, fieldNameSize: 40, fieldSize: 4_000, fileSize: VIDEO_LIMIT, headerPairs: 32, headerSize: 8_192 } });
  const source = Readable.fromWeb(request.body as import("node:stream/web").ReadableStream, { signal: request.signal });
  let receivedBytes = 0;
  let abortHandler:(()=>void)|null=null;
  const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) { receivedBytes += chunk.length; if (receivedBytes > VIDEO_LIMIT + FORM_OVERHEAD_LIMIT) callback(tooLarge()); else callback(null, chunk); } });
  const parsed = new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => { if (!failure) failure = error; activeFile?.destroy(error instanceof Error ? error : undefined); parser.destroy(); source.destroy(); if (settled) return; settled = true; request.signal.removeEventListener("abort", onAbort); reject(failure); };
    const onAbort = () => fail(request.signal.reason ?? new Error("Upload request was canceled."));
    abortHandler=onAbort;
    request.signal.addEventListener("abort", onAbort, { once: true });
    parser.on("field", (name: string, value: string, nameTruncated: boolean, valueTruncated: boolean) => {
      if (nameTruncated || valueTruncated || !["source", "rightsAttestation", "rightsStatus"].includes(name) || name in fields || !value.trim()) { fail(invalid("The source and rights fields must each appear once and fit their limits.")); return; }
      fields[name as keyof ImportFields] = value;
    });
    parser.on("file", (name: string, file: BusboyFileStream, _filename: string, _encoding: string, rawMime: string) => {
      activeFile = file;
      fileCount += 1;
      const mime = rawMime.split(";", 1)[0]!.trim().toLowerCase();
      if (name !== "file" || fileCount !== 1 || !MAX_MIME.has(mime)) { file.resume(); fail(invalid("Upload exactly one supported media file in the file field.")); return; }
      file.on("limit", () => fail(tooLarge()));
      filePromise = vault.stageStream(file, { mime, sourceKind: "upload", rightsStatus: "unknown", maxBytes: VIDEO_LIMIT })
        .then(async media => { if (file.truncated) { await media.abort(); throw tooLarge(); } return media; })
        .catch(error => { const normalized=error instanceof RangeError||(error instanceof Error&&/exceeds the allowed size/i.test(error.message))?tooLarge():new ProductionApplicationError("MEDIA_UNAVAILABLE","Uploaded media could not be decoded and verified.");fail(normalized);throw normalized; });
      void filePromise.catch(() => undefined);
    });
    parser.once("filesLimit", () => fail(invalid("Only one file is allowed per upload.")));
    parser.once("fieldsLimit", () => fail(invalid("Too many upload fields.")));
    parser.once("partsLimit", () => fail(invalid("Too many multipart sections.")));
    parser.once("error", fail);
    parser.once("finish", () => { if (!settled) { settled = true; resolve(); } });
    source.once("error", fail);bounded.once("error",fail);
    source.pipe(bounded).pipe(parser);
  });
  try {
    await parsed;
    if (failure) throw failure;
    if (!filePromise || fileCount !== 1 || !fields.source?.trim() || !fields.rightsAttestation?.trim() || !fields.rightsStatus) throw invalid("The file, source, rights status, and rights attestation are all required.");
    let media: StagedVaultMedia;
    try { media = await filePromise; }
    catch (error) { if (error instanceof RangeError || (error instanceof Error && /exceeds the allowed size/i.test(error.message))) throw tooLarge(); throw new ProductionApplicationError("MEDIA_UNAVAILABLE", "Uploaded media could not be decoded and verified."); }
    if (failure || request.signal.aborted) { await media.abort(); throw failure ?? request.signal.reason ?? new Error("Upload request was canceled."); }
    if(abortHandler)request.signal.removeEventListener("abort",abortHandler);
    return { media, fields: fields as ImportFields };
  } catch (error) {
    if(abortHandler)request.signal.removeEventListener("abort",abortHandler);
    const pending = filePromise as Promise<StagedVaultMedia> | null; if (pending !== null) { const completed = await Promise.allSettled([pending]); if (completed[0]?.status === "fulfilled") await completed[0].value.abort(); }
    if (failure instanceof ProductionApplicationError) throw failure;
    if (error instanceof ProductionApplicationError) throw error;
    if (error instanceof RangeError || (error instanceof Error && /exceeds the allowed size/i.test(error.message))) throw tooLarge();
    throw invalid("Multipart upload could not be parsed.");
  }
}
function invalid(message: string) { return new ProductionApplicationError("INVALID_INPUT", message); }
function tooLarge() { return Object.assign(invalid("Media upload exceeds the allowed size."), { status: 413 }); }
