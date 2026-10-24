import assert from "node:assert/strict";
import { readFile,stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const demoRoot=path.resolve("apps/web/public/demo/localdemo");

test("static localdemo HLS fixture contains four complete 16:9 clip spans",async()=>{
  const manifest=JSON.parse(await readFile(path.join(demoRoot,"program.json"),"utf8"));
  const playlist=await readFile(path.join(demoRoot,"playlist.m3u8"),"utf8");
  assert.equal(manifest.playlistUrl,"/sloptogether/demo/localdemo/playlist.m3u8");
  assert.equal(manifest.mimeType,"application/vnd.apple.mpegurl");
  assert.equal(manifest.programSpans.length,4);
  assert.ok(manifest.programSpans.at(-1).outputEndSeconds>60);
  assert.match(playlist,/#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(playlist,/#EXT-X-ENDLIST/);
  assert.equal((playlist.match(/#EXT-X-DISCONTINUITY/g)??[]).length,3);
  const segments=playlist.split(/\r?\n/).filter(line=>line&&!line.startsWith("#"));
  assert.equal(segments.length,32);
  let totalBytes=0;
  for(const segment of segments){
    assert.match(segment,/^segments\/\d{3}\.ts$/);
    const info=await stat(path.join(demoRoot,segment));
    assert.ok(info.size>0);
    totalBytes+=info.size;
  }
  assert.ok(totalBytes<32*1024*1024);
});
