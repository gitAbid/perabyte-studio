import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { AssetSchema, type Asset } from "../../production/contracts";

const IMAGE_LIMIT=100*1024*1024, AUDIO_LIMIT=100*1024*1024, VIDEO_LIMIT=2*1024*1024*1024;
export interface VaultWriteOptions { mime:string; sourceKind:Asset["sourceKind"]; sourceJobId?:string|null; rightsStatus?:Asset["rightsStatus"] ; maxBytes?:number; now?:number }
export interface VaultStoredMedia { asset:Asset; verifiedAt:number; checksumVerified:true }
export interface StagedVaultMedia { media:VaultStoredMedia; publish():Promise<VaultStoredMedia>; abort():Promise<void> }
export interface DurableMediaVault { putStream(stream:NodeJS.ReadableStream,options:VaultWriteOptions):Promise<VaultStoredMedia> }
type MediaMetadata = Pick<Asset,"width"|"height"|"frames"|"fps"|"audioSamples">;
export class LocalMediaVault implements DurableMediaVault {
  readonly root:string; private readonly maxBytes:number; private readonly ffprobePath:string; private readonly ffmpegPath:string;
  constructor(options:{root:string;maxBytes?:number;ffprobePath?:string;ffmpegPath?:string}){this.root=resolve(options.root);this.maxBytes=options.maxBytes??VIDEO_LIMIT;this.ffprobePath=options.ffprobePath??process.env.FFPROBE_PATH??"ffprobe";this.ffmpegPath=options.ffmpegPath??process.env.FFMPEG_PATH??"ffmpeg";}
  async put(bytes:Uint8Array, options:VaultWriteOptions):Promise<VaultStoredMedia>{return this.putStream(Readable.from([Buffer.from(bytes)]),options);}
  async putStream(stream:NodeJS.ReadableStream, options:VaultWriteOptions):Promise<VaultStoredMedia>{const staged=await this.stageStream(stream,options);try{return await staged.publish();}catch(error){await staged.abort();throw error;}}
  async stageStream(stream:NodeJS.ReadableStream, options:VaultWriteOptions):Promise<StagedVaultMedia>{
    const maxBytes=Math.min(this.maxBytes,options.maxBytes??this.maxBytes,limitFor(options.mime));
    if(!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw new RangeError("A positive safe media size limit is required");
    const root=this.root;await mkdir(root,{recursive:true,mode:0o700});const rootStat=await lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error("Vault root must be a real directory, not a symlink");const rootReal=await realpath(root);
    const temp=join(rootReal,`.upload-${randomUUID()}.tmp`);const handle=await open(temp,"wx",0o600);const digest=createHash("sha256");let size=0;let head=Buffer.alloc(0);
    try{
      for await(const value of stream as AsyncIterable<Uint8Array>){const chunk=Buffer.from(value);size+=chunk.length;if(size>maxBytes)throw new Error("Media upload exceeds the allowed size");if(head.length<64)head=Buffer.concat([head,chunk.subarray(0,64-head.length)]);if(size===chunk.length)validateMime(options.mime,head,false);digest.update(chunk);let offset=0;while(offset<chunk.length){const wrote=await handle.write(chunk,offset,chunk.length-offset);if(wrote.bytesWritten===0)throw new Error("Unable to persist media bytes");offset+=wrote.bytesWritten;}}
      if(size===0)throw new Error("Media file is empty");validateMime(options.mime,head,true);await handle.sync();await handle.close();
      const metadata=await decodeAndProbe(temp,options.mime,this.ffprobePath,this.ffmpegPath);
      const sha256=digest.digest("hex");const base=join(rootReal,"sha256");const dir=join(base,sha256.slice(0,2));const target=join(dir,sha256);const ref=`sha256-${sha256}`;
      const asset=AssetSchema.parse({version:1,id:randomUUID(),sha256,mime:options.mime,byteSize:size,vaultRef:ref,...metadata,sourceKind:options.sourceKind,sourceJobId:options.sourceJobId??null,rightsStatus:options.rightsStatus??"unknown",createdAt:options.now??Date.now()});
      const media={asset,verifiedAt:options.now??Date.now(),checksumVerified:true as const};let settled=false;
      return{media,async publish(){if(settled)throw new Error("Staged media is no longer available");await ensureContainedDirectory(rootReal,base);await ensureContainedDirectory(rootReal,dir);try{const stat=await lstat(target);if(!stat.isFile()||stat.isSymbolicLink())throw new Error("Vault target is not a regular file");const existingHash=await hashFile(target);if(existingHash!==sha256||stat.size!==size)throw new Error("Existing vault object failed checksum verification");await rm(temp,{force:true});}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await rename(temp,target);const dirHandle=await open(dir,"r");try{await dirHandle.sync();}finally{await dirHandle.close();}}settled=true;return media;},async abort(){if(settled)return;settled=true;await rm(temp,{force:true});}};
    }catch(error){await handle.close().catch(()=>undefined);await rm(temp,{force:true}).catch(()=>undefined);throw error;}
  }
  async read(vaultRef:string):Promise<Buffer>{const file=await this.resolveRef(vaultRef);return readFile(file);}
  async readVerified(vaultRef:string,expectedSha256:string):Promise<Buffer>{if(!/^[a-f0-9]{64}$/.test(expectedSha256))throw new Error("Invalid checksum");const bytes=await this.read(vaultRef);const actual=createHash("sha256").update(bytes).digest("hex");if(actual!==expectedSha256)throw new Error("Vault checksum mismatch");return bytes;}
  async verify(vaultRef:string,expectedSha256:string):Promise<boolean>{try{await this.readVerified(vaultRef,expectedSha256);return true;}catch{return false;}}
  async createReadStream(vaultRef:string):Promise<NodeJS.ReadableStream>{return createReadStream(await this.resolveRef(vaultRef));}
  private async resolveRef(vaultRef:string):Promise<string>{const match=/^sha256-([a-f0-9]{64})$/.exec(vaultRef);if(!match)throw new Error("Invalid vault reference");const root=await realpath(this.root);const base=join(root,"sha256");await ensureContainedDirectory(root,base);const bucket=join(base,match[1]!.slice(0,2));await ensureContainedDirectory(root,bucket);const file=resolve(bucket,match[1]!);if(!file.startsWith(root+sep))throw new Error("Vault path escapes media root");const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error("Vault entry is not a regular file");return file;}
}
async function hashFile(path:string):Promise<string>{const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk as Buffer);return hash.digest("hex");}
async function ensureContainedDirectory(root:string,directory:string):Promise<void>{if(!directory.startsWith(root+sep)&&directory!==root)throw new Error("Vault directory escapes media root");let current=root;for(const part of directory.slice(root.length).split(sep).filter(Boolean)){current=join(current,part);try{await mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}const stat=await lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("Vault parent must be a real directory");const actual=await realpath(current);if(!actual.startsWith(root+sep))throw new Error("Vault parent resolves outside the media root");}}
function limitFor(mime:string):number{return mime.startsWith("video/")?VIDEO_LIMIT:mime.startsWith("audio/")?AUDIO_LIMIT:IMAGE_LIMIT;}
function validateMime(mime:string,bytes:Buffer,final:boolean):void{
  const starts=(...v:number[])=>v.every((n,i)=>bytes[i]===n);let actual:string|null=null;
  if(starts(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a))actual="image/png";
  else if(starts(0xff,0xd8,0xff))actual="image/jpeg";
  else if(bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WEBP")actual="image/webp";
  else if(bytes.subarray(4,8).toString()==="ftyp")actual=bytes.subarray(8,12).toString()==="qt  "?"video/quicktime":"video/mp4";
  else if(starts(0x49,0x44,0x33)||starts(0xff,0xfb)||starts(0xff,0xf3)||starts(0xff,0xf2))actual="audio/mpeg";
  else if(bytes.subarray(0,4).toString()==="fLaC")actual="audio/flac";
  else if(bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WAVE")actual="audio/wav";
  else if((bytes[0]!&0xff)===0xff&&((bytes[1]!&0xf6)===0xf0))actual="audio/aac";
  if(!["image/png","image/jpeg","image/webp","audio/wav","audio/mpeg","audio/aac","audio/flac","video/mp4","video/quicktime"].includes(mime))throw new Error("Media format is not supported");
  if(final&&!actual)throw new Error("Media content type could not be verified");
  if(actual&&actual!==mime)throw new Error(`MIME mismatch: content is ${actual}, declared ${mime}`);
}

async function decodeAndProbe(path:string,mime:string,ffprobePath:string,ffmpegPath:string):Promise<MediaMetadata>{
  if(mime.startsWith("image/")){
    const decoder=sharp(path,{limitInputPixels:100_000_000,sequentialRead:true});
    const metadata=await decoder.metadata();
    await sharp(path,{limitInputPixels:100_000_000,sequentialRead:true}).stats();
    if(!metadata.width||!metadata.height)throw new Error("Image decoder did not report dimensions");
    return{width:metadata.width,height:metadata.height,frames:null,fps:null,audioSamples:null};
  }
  const json=await runFfprobe(ffprobePath,["-v","error","-count_frames","-show_entries","stream=codec_type,width,height,nb_read_frames,avg_frame_rate,sample_rate,duration_ts,time_base","-of","json",path]);
  let parsed:{streams?:Array<{codec_type?:string;width?:number;height?:number;nb_read_frames?:string;avg_frame_rate?:string;sample_rate?:string;duration_ts?:string;time_base?:string}>};
  try{parsed=JSON.parse(json) as typeof parsed;}catch{throw new Error("Media probe returned invalid metadata");}
  const streams=parsed.streams??[];
  let audioSamples:number|null=null;
  if(mime.startsWith("audio/")||streams.some(stream=>stream.codec_type==="audio"))audioSamples=await decodeAudioSamples(path,ffmpegPath);
  if(mime.startsWith("video/"))await runFfmpeg(ffmpegPath,["-v","error","-xerror","-threads","1","-i",path,"-f","null","-"]);
  if(mime.startsWith("video/")){
    const video=streams.find(stream=>stream.codec_type==="video");
    if(!video||!safePositive(video.width)||!safePositive(video.height))throw new Error("Video decoder could not verify a video stream and dimensions");
    return{width:video.width!,height:video.height!,frames:parseCount(video.nb_read_frames),fps:parseRatio(video.avg_frame_rate),audioSamples};
  }
  const audio=streams.find(stream=>stream.codec_type==="audio");
  if(!audio)throw new Error("Audio decoder could not verify an audio stream");
  return{width:null,height:null,frames:null,fps:null,audioSamples};
}
function safePositive(value:unknown):value is number{return typeof value==="number"&&Number.isSafeInteger(value)&&value>0;}
function parseCount(value:string|undefined):number|null{if(!value||!/^\d+$/.test(value))return null;const count=Number(value);return Number.isSafeInteger(count)?count:null;}
function parseRatio(value:string|undefined):number|null{if(!value||!/^\d+\/\d+$/.test(value))return null;const [n,d]=value.split("/").map(Number);if(!n||!d)return null;const result=n/d;return Number.isFinite(result)&&result>0?result:null;}
async function decodeAudioSamples(path:string,ffmpegPath:string):Promise<number>{const decodedBytes=await runFfmpeg(ffmpegPath,["-v","error","-xerror","-threads","1","-i",path,"-map","0:a:0","-ar","48000","-ac","1","-c:a","pcm_s16le","-f","s16le","-"] ,true);if(decodedBytes===0||decodedBytes%2!==0)throw new Error("Audio decoder returned an invalid sample stream");const samples=decodedBytes/2;if(!Number.isSafeInteger(samples)||samples<=0)throw new Error("Audio decoder returned an invalid sample count");return samples;}
function runFfprobe(executable:string,args:string[]):Promise<string>{return new Promise((resolvePromise,reject)=>{
  const child=spawn(executable,args,{stdio:["ignore","pipe","pipe"],windowsHide:true});let stdout="",stderr="",settled=false;
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolvePromise(stdout);};
  const timer=setTimeout(()=>{child.kill("SIGKILL");finish(new Error("Media probe timed out"));},120_000);timer.unref?.();
  child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
  child.stdout.on("data",chunk=>{stdout+=chunk;if(stdout.length>256*1024){child.kill("SIGKILL");finish(new Error("Media probe output exceeded its limit"));}});
  child.stderr.on("data",chunk=>{stderr+=chunk;if(stderr.length>16*1024)stderr=stderr.slice(-16*1024);});
  child.once("error",error=>finish(new Error(`Unable to run ffprobe: ${error.message}`)));
  child.once("close",code=>code===0?finish():finish(new Error(`Media probe rejected the file${stderr.trim()?`: ${stderr.trim().slice(0,1000)}`:""}`)));
});}
function runFfmpeg(executable:string,args:string[],countOutput=false):Promise<number>{return new Promise((resolvePromise,reject)=>{
  const child=spawn(executable,args,{stdio:["ignore","pipe","pipe"],windowsHide:true});let stderr="",outputBytes=0,settled=false;
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolvePromise(outputBytes);};
  const timer=setTimeout(()=>{child.kill("SIGKILL");finish(new Error("Full media decode timed out"));},120_000);timer.unref?.();
  child.stdout.on("data",(chunk:Buffer)=>{if(countOutput){outputBytes+=chunk.length;if(!Number.isSafeInteger(outputBytes)||outputBytes>48_000*2*60*60){child.kill("SIGKILL");finish(new Error("Decoded audio exceeds the one-hour sample limit"));}}});
  child.stderr.setEncoding("utf8");child.stderr.on("data",chunk=>{stderr+=chunk;if(stderr.length>16*1024)stderr=stderr.slice(-16*1024);});
  child.once("error",error=>finish(new Error(`Unable to run ffmpeg: ${error.message}`)));
  child.once("close",code=>code===0?finish():finish(new Error(`Full media decode rejected the file${stderr.trim()?`: ${stderr.trim().slice(0,1000)}`:""}`)));
});}
