import Database from "better-sqlite3";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importLegacyStudio } from "./legacy-import";

const dirs:string[]=[];
async function setup(){const root=await mkdtemp(join(tmpdir(),"legacy-import-"));dirs.push(root);const sourceDir=join(root,"legacy"),backupDir=join(root,"backup"),dbPath=join(root,"data","production.sqlite");await mkdir(join(sourceDir,"characters"),{recursive:true});await mkdir(join(sourceDir,"assets"),{recursive:true});return{root,sourceDir,backupDir,dbPath};}
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

describe("legacy studio import",()=>{
  it("preserves every source field and ID, backs up exact bytes and reruns idempotently",async()=>{
    const f=await setup(), raw='[{"id":"legacy-1","createdAt":"2019-01-02","prompt":"original prompt","seed":17,"sceneOrder":4,"futureField":{"x":true}}]';
    const sourceFile=join(f.sourceDir,"characters","characters.json"),mediaFile=join(f.sourceDir,"assets","anchor.webp"),media=Buffer.from([0,1,255,18]);
    await writeFile(sourceFile,raw);await writeFile(mediaFile,media);await writeFile(join(f.sourceDir,"settings.json"),"{\"secret\":\"not imported\"}");
    const first=await importLegacyStudio({...f,now:()=>22});
    expect(first.status).toBe("complete");expect(first.records).toBe(1);
    expect(await readFile(join(f.backupDir,"characters","characters.json"),"utf8")).toBe(raw);
    expect(await readFile(join(f.backupDir,"assets","anchor.webp"))).toEqual(media);
    await expect(access(join(f.backupDir,"settings.json"))).rejects.toThrow();
    const db=new Database(f.dbPath);const row=db.prepare("SELECT record_key,payload_json FROM legacy_records").get() as {record_key:string;payload_json:string};
    expect(row.record_key).toBe("characters/characters.json:0:legacy-1");expect(JSON.parse(row.payload_json)).toEqual(JSON.parse(raw)[0]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='approval'").get()).toEqual({n:0});db.close();
    const before=await readFile(join(f.backupDir,"legacy-backup-manifest.json"),"utf8");const second=await importLegacyStudio({...f,now:()=>99});
    expect(second).toEqual(first);expect((await readFile(sourceFile,"utf8"))).toBe(raw);expect(await readFile(join(f.backupDir,"legacy-backup-manifest.json"),"utf8")).toBe(before);
  });

  it("reports malformed JSON with its source path and does not mark the import complete",async()=>{
    const f=await setup(),bad=join(f.sourceDir,"locations","broken.json");await mkdir(join(f.sourceDir,"locations"),{recursive:true});await writeFile(bad,"{not json");
    const report=await importLegacyStudio(f);expect(report.status).toBe("invalid");expect(report.errors[0]?.path).toBe("locations/broken.json");
    expect(JSON.parse(await readFile(join(f.backupDir,"legacy-import-report.json"),"utf8")).status).toBe("invalid");
    await expect(access(f.dbPath)).rejects.toThrow();expect(await readFile(join(f.backupDir,"locations","broken.json"),"utf8")).toBe("{not json");
  });

  it("blocks completion when a referenced local media file is missing",async()=>{
    const f=await setup(),story=join(f.sourceDir,"stories","stories.json");await mkdir(join(f.sourceDir,"stories"),{recursive:true});await writeFile(story,JSON.stringify([{id:"story-1",referenceImagePath:"media/absent.webp"}]));
    const report=await importLegacyStudio(f);expect(report.status).toBe("invalid");expect(report.errors[0]?.message).toContain("Referenced local media is missing");
    await expect(access(f.dbPath)).rejects.toThrow();
  });

  it("preserves large unknown JSON number lexemes exactly",async()=>{
    const f=await setup(),raw='[ {"id":"large-number","futureNumber":9007199254740993,"nested":[1,2]}, {"id":"second","exponent":1e+2} ]';
    await writeFile(join(f.sourceDir,"characters","characters.json"),raw);
    const report=await importLegacyStudio(f);expect(report.status).toBe("complete");
    const db=new Database(f.dbPath),rows=db.prepare("SELECT payload_json FROM legacy_records ORDER BY record_key").all() as {payload_json:string}[];
    expect(rows.map(row=>row.payload_json)).toEqual(['{"id":"large-number","futureNumber":9007199254740993,"nested":[1,2]}','{"id":"second","exponent":1e+2}']);db.close();
  });

  it("rejects backup root, child, and report symlinks without changing their targets",async()=>{
    for (const attack of ["root","child","report"] as const) {
      const f=await setup(),outside=join(f.root,"outside");await mkdir(outside,{recursive:true});
      const sourceFile=join(f.sourceDir,"stories","stories.json");await mkdir(join(f.sourceDir,"stories"),{recursive:true});await writeFile(sourceFile,'[{"id":"story-safe"}]');
      let target:string;
      if(attack==="root") { target=join(outside,"stories","stories.json");await mkdir(join(outside,"stories"),{recursive:true});await writeFile(target,"outside-root-sentinel");await symlink(outside,f.backupDir); }
      else {
        await mkdir(f.backupDir,{recursive:true});
        if(attack==="child") { target=join(outside,"stories.json");await writeFile(target,"outside-child-sentinel");await symlink(outside,join(f.backupDir,"stories")); }
        else { target=join(outside,"report.json");await writeFile(target,"outside-report-sentinel");await symlink(target,join(f.backupDir,"legacy-import-report.json")); }
      }
      await expect(importLegacyStudio(f)).rejects.toThrow();
      expect(await readFile(target,"utf8")).toMatch(/^outside-/);expect(await readFile(sourceFile,"utf8")).toBe('[{"id":"story-safe"}]');
    }
  });

  it("does not overwrite an existing unknown backup file",async()=>{
    const f=await setup(),sourceFile=join(f.sourceDir,"stories","stories.json"),backupFile=join(f.backupDir,"stories","stories.json");
    await mkdir(join(f.sourceDir,"stories"),{recursive:true});await mkdir(join(f.backupDir,"stories"),{recursive:true});
    await writeFile(sourceFile,'[{"id":"safe"}]');await writeFile(backupFile,"user backup sentinel");
    await expect(importLegacyStudio(f)).rejects.toThrow(/overwrite an unknown backup file/);
    expect(await readFile(backupFile,"utf8")).toBe("user backup sentinel");expect(await readFile(sourceFile,"utf8")).toBe('[{"id":"safe"}]');
  });
});
