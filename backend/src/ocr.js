// OCR: reads the printed text on a certificate photo (JPEG or PNG) using Tesseract, so the portal can
// compare what the paper says with the details the QR / registry carries. The traineddata is downloaded
// once into data/tessdata (git-ignored) on first use and reused offline afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import { backendRoot } from './config.js';

const TRAINEDDATA_URL = 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz';
// Reuse the local copy when it exists (offline-friendly, git-ignored); on a read-only platform such as
// Vercel serverless it lives in the OS temp directory, which is the only writable place once deployed.
const devTessDir = path.join(backendRoot, 'data', 'tessdata');
const tessDir = fs.existsSync(devTessDir) ? devTessDir : path.join(os.tmpdir(), 'certverify-tessdata');
const tessPath = path.join(tessDir, 'eng.traineddata.gz');

async function ensureTrainedData() {
  if (fs.existsSync(tessPath)) return;
  fs.mkdirSync(tessDir, { recursive: true });
  const res = await fetch(TRAINEDDATA_URL);
  if (!res.ok) throw new Error(`Could not download Tesseract language data (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${tessPath}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, tessPath);
}

let workerPromise = null;
let queue = Promise.resolve();

async function getWorker() {
  if (!workerPromise) {
    // tesseract.js resolves a local langPath to a file on disk in Node, so after the first download
    // everything happens offline.
    workerPromise = (async () => {
      await ensureTrainedData();
      return createWorker('eng', 1, { langPath: tessDir, logger: () => {} });
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

// Text from an image buffer. A Tesseract worker handles one request at a time, so calls are serialised.
export function recognizeText(buffer) {
  const job = queue.then(async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(buffer);
    return data.text;
  });
  queue = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

export async function closeOcr() {
  const w = workerPromise;
  workerPromise = null;
  queue = Promise.resolve();
  if (w) {
    try {
      (await w).terminate();
    } catch {
      /* already gone */
    }
  }
}