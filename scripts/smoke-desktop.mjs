import assert from 'node:assert/strict';

const baseUrl = process.argv[2] || 'http://localhost:18080';
const lanUrl = process.argv[3];
const deadline = Date.now() + 180_000;
let health;

while (Date.now() < deadline) {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
    if (response.ok) {
      health = await response.json();
      break;
    }
  } catch {
    // The portable executable may need several seconds to unpack on first run.
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

assert.ok(health, `Localis did not become ready at ${baseUrl}`);
assert.equal(health.ok, true);
assert.equal(health.service, 'localis');
assert.equal(health.build?.available, true, 'The packaged server did not expose a verified build identity');
assert.equal(health.build.metadata.schemaVersion, 1);
assert.match(health.build.metadata.buildId, /^[0-9a-f]{64}$/);
if (process.env.LOCALIS_COMMIT_SHA) {
  assert.equal(health.build.metadata.commitSha, process.env.LOCALIS_COMMIT_SHA.toLowerCase());
}
assert.ok(Number(health.mediaCount) > 0, 'The packaged ffprobe did not scan the test media');
assert.equal(health.aiSuperResolution?.available, true, 'The packaged AI runtime/model was not detected');

const page = await fetch(baseUrl);
assert.equal(page.status, 200);
assert.match(await page.text(), /Localis/);

const pairStatus = await fetch(`${baseUrl}/api/pair/status`).then((response) => response.json());
assert.match(pairStatus.pairingCode, /^\d{6}$/);

const verify = await fetch(`${baseUrl}/api/pair/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: baseUrl },
  body: JSON.stringify({ code: pairStatus.pairingCode }),
});
assert.equal(verify.status, 200);
const cookie = verify.headers.get('set-cookie')?.split(';', 1)[0];
assert.ok(cookie, 'Pairing did not return a session cookie');

const authenticated = { headers: { cookie } };
const serverInfo = await fetch(`${baseUrl}/api/server`, authenticated).then((response) => response.json());
assert.equal(serverInfo.pairingCode, pairStatus.pairingCode);
assert.equal(serverInfo.canPickLocalFolder, true);
assert.ok(Array.isArray(serverInfo.lanUrls));

const library = await fetch(`${baseUrl}/api/library`, authenticated).then((response) => response.json());
const media = library.items.find((item) => item.title === 'flat-demo');
assert.ok(media, 'Packaged media library is missing flat-demo');

let playlist;
for (let attempt = 0; attempt < 20; attempt += 1) {
  playlist = await fetch(`${baseUrl}/api/media/${media.id}/hls/standard/index.m3u8`, authenticated);
  if (playlist.status === 200) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(playlist?.status, 200, 'Packaged server did not create the seekable HLS playlist');
assert.match(await playlist.text(), /#EXT-X-PLAYLIST-TYPE:VOD/);

const segment = await fetch(`${baseUrl}/api/media/${media.id}/hls/standard/seg_000000.ts`, authenticated);
assert.equal(segment.status, 200);
assert.match(segment.headers.get('content-type') || '', /video\/mp2t/);
const segmentBytes = (await segment.arrayBuffer()).byteLength;
assert.ok(segmentBytes > 10_000, 'Bundled FFmpeg returned an empty super-resolution segment');

const transcodeStatus = await fetch(`${baseUrl}/api/media/${media.id}/hls/standard/status`, authenticated).then((response) => response.json());
assert.equal(transcodeStatus.state, 'ready');
assert.equal(transcodeStatus.superResolution, 'standard');
assert.equal(transcodeStatus.plan.outputWidth, 1600);
assert.equal(transcodeStatus.plan.outputHeight, 900);

let aiPlaylist;
for (let attempt = 0; attempt < 30; attempt += 1) {
  aiPlaylist = await fetch(`${baseUrl}/api/media/${media.id}/hls/ai/index.m3u8`, authenticated);
  if (aiPlaylist.status === 200) break;
  assert.equal(aiPlaylist.status, 202, 'Packaged AI precompute returned an unexpected state');
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(aiPlaylist?.status, 200, 'Packaged server did not finish the full AI precompute');
assert.match(await aiPlaylist.text(), /#EXT-X-TARGETDURATION:4/);
const aiSegment = await fetch(`${baseUrl}/api/media/${media.id}/hls/ai/seg_000000.ts`, authenticated);
assert.equal(aiSegment.status, 200);
const aiSegmentBytes = (await aiSegment.arrayBuffer()).byteLength;
assert.ok(aiSegmentBytes > 10_000, 'Bundled Real-ESRGAN returned an empty segment');
const aiStatus = await fetch(`${baseUrl}/api/media/${media.id}/hls/ai/status`, authenticated).then((response) => response.json());
assert.equal(aiStatus.enhancementBackend, 'Real-ESRGAN NCNN Vulkan');
assert.equal(aiStatus.strategy, 'precompute');
assert.equal(aiStatus.progressPercent, 100);
assert.equal(aiStatus.plan.outputWidth, 2560);
assert.equal(aiStatus.plan.outputHeight, 1440);

let lanPairCodeHidden = null;
if (lanUrl) {
  const lanStatus = await fetch(`${lanUrl}/api/pair/status`).then((response) => response.json());
  lanPairCodeHidden = !Object.hasOwn(lanStatus, 'pairingCode');
  assert.equal(lanPairCodeHidden, true, 'LAN client was able to read the computer pairing code');
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  mediaCount: health.mediaCount,
  encoder: health.encoder,
  buildId: health.build.metadata.buildId,
  pairingCodeVisibleOnComputer: true,
  lanPairCodeHidden,
  superResolution: `${media.width}x${media.height} -> ${transcodeStatus.plan.outputWidth}x${transcodeStatus.plan.outputHeight}`,
  segmentBytes,
  aiSuperResolution: `${media.width}x${media.height} -> ${aiStatus.plan.outputWidth}x${aiStatus.plan.outputHeight}`,
  aiSegmentBytes,
})}\n`);
