import assert from 'node:assert/strict';

/** Decode the delivered MP4 in Chrome and compare it to lossless scene renders. */
export async function verifyVideoFrames(page, directory, times) {
 const results = await page.evaluate(async ({ directory, times }) => {
  const video = document.createElement('video'); video.preload = 'auto'; video.muted = true;
  const ready = new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('MP4 decode failed')); });
  video.src = '/' + directory + '/reference.mp4'; await ready;
  const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }), checks = [];
  try {
   for (const time of times) {
    const seeked = new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = () => reject(new Error('MP4 seek failed')); });
    video.currentTime = time + .001; await seeked;
    ctx.drawImage(video, 0, 0); const decoded = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const reference = new Image(); reference.src = '/' + directory + '/frame-' + time.toFixed(3) + '.png'; await reference.decode();
    ctx.drawImage(reference, 0, 0); const expected = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let error = 0, changed = 0;
    for (let i = 0; i < decoded.length; i += 4) for (let channel = 0; channel < 3; channel++) {
     const delta = Math.abs(decoded[i + channel] - expected[i + channel]); error += delta; if (delta > 20) changed++;
    }
    checks.push({ time, meanChannelError: error / (decoded.length * .75), largeErrorFraction: changed / (decoded.length * .75) });
   }
  } finally { video.removeAttribute('src'); video.load(); }
  return checks;
 }, { directory, times });
 for (const result of results) {
  assert.ok(result.meanChannelError < 3, `Export image differs from scene at ${result.time}s: ${JSON.stringify(result)}`);
  assert.ok(result.largeErrorFraction < .02, `Export image mismatch at ${result.time}s: ${JSON.stringify(result)}`);
 }
 return results;
}
