import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outputDir = path.join(root, 'sample-media');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
mkdirSync(outputDir, { recursive: true });

function run(name: string, args: string[]) {
  process.stdout.write(`生成 ${name}… `);
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    cwd: outputDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stdout.write('失败\n');
    throw new Error(result.stderr || `${name} 生成失败`);
  }
  process.stdout.write('完成\n');
}

run('普通 H.264/AAC 视频', [
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '4', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast',
  '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-shortest', 'flat-demo.mp4',
]);

run('VR180 SBS 视频', [
  '-f', 'lavfi', '-i', 'color=c=0x8a4fff:size=640x640:rate=30',
  '-f', 'lavfi', '-i', 'color=c=0x46c7da:size=640x640:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
  '-filter_complex', '[0:v]drawgrid=w=80:h=80:t=2:c=white@0.5[l];[1:v]drawgrid=w=80:h=80:t=2:c=black@0.4[r];[l][r]hstack=inputs=2[v]',
  '-t', '4', '-map', '[v]', '-map', '2:a:0', '-c:v', 'libx264', '-preset', 'ultrafast',
  '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-shortest', 'demo-vr180-sbs-lr.mp4',
]);

run('360° 单目视频', [
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x640:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
  '-vf', 'drawgrid=w=80:h=80:t=2:c=white@0.35', '-t', '4', '-map', '0:v:0', '-map', '1:a:0',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '60',
  '-c:a', 'aac', '-b:a', '128k', '-shortest', 'demo-360-mono.mp4',
]);

run('MKV 重新封装样本', ['-i', 'flat-demo.mp4', '-c', 'copy', 'flat-remux.mkv']);
run('AVI 转码样本', [
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000',
  '-t', '3', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'pcm_s16le', '-shortest', 'legacy-transcode.avi',
]);
run('小尺寸编码器回退样本', [
  '-f', 'lavfi', '-i', 'testsrc2=size=128x128:rate=24',
  '-t', '1', '-c:v', 'mpeg4', '-q:v', '5', 'tiny-legacy.avi',
]);
run('奇数尺寸缩放样本', [
  '-f', 'lavfi', '-i', 'testsrc=size=641x359:rate=24',
  '-t', '1', '-c:v', 'ffv1', 'odd-legacy.mkv',
]);
run('H.264 High10 兼容转码样本', [
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
  '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
  '-profile:v', 'high10', 'high10-incompatible.mp4',
]);
run('非方形像素比例样本', [
  '-f', 'lavfi', '-i', 'testsrc=size=720x576:rate=25',
  '-vf', 'setsar=16/15', '-t', '1', '-c:v', 'ffv1', 'anamorphic-legacy.mkv',
]);
run('高帧率降帧样本', [
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=120',
  '-t', '0.5', '-c:v', 'ffv1', 'highfps-legacy.mkv',
]);
run('MPEG-2 常见扩展名样本', [
  '-f', 'lavfi', '-i', 'testsrc2=size=352x288:rate=25',
  '-t', '1', '-c:v', 'mpeg2video', 'common-format.mpg',
]);
run('AC-3 音频样本', [
  '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000',
  '-t', '1', '-c:a', 'ac3', 'common-audio.ac3',
]);
run('FLAC 音频', ['-f', 'lavfi', '-i', 'sine=frequency=523.25:sample_rate=48000', '-t', '4', '-c:a', 'flac', 'localis-tone.flac']);

console.log(`测试媒体已写入 ${outputDir}`);
