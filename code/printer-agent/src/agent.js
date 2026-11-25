'use strict';

// SmartPrint printer agent - runs on the print shop's PC.
//
// Every few seconds it asks SmartPrint for the next paid order of its shop
// ("start next" - the same button staff press), downloads each file (Word,
// Excel and PowerPoint come as PDF), prints it with the order's settings
// (copies, colour, sides, paper size, pages), then marks the order READY, which
// tells the student their print is ready.
//
//   npm start      keep running and print orders as they arrive
//   npm run once   print just the next order, then stop ("one-click print")
//
// If something cannot be printed automatically, the order is left as
// PRINTING and the agent says so; staff print it by hand and press
// "Mark ready" in the staff screen. Only one order prints per shop at a time,
// so the agent simply waits until that is done.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createApi } = require('./api');
const { createPrinter, extensionFor, isPrintable } = require('./printer');

class ManualPrintNeeded extends Error {}

function log(...args) {
  console.log(new Date().toLocaleTimeString(), ...args);
}

async function withRetries(fn, attempts, delayMs) {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts) {
        log(`  attempt ${i} failed (${err.message}); retrying...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

// Returns 'idle' (nothing to do), 'printed', or 'failed' (left for staff).
async function processNextJob({ api, printer, shopId, retryDelayMs = 5_000, logger = log }) {
  const queue = await api.startNext(shopId);
  if (!queue) return 'idle';

  logger(`Printing order ${queue.orderCode} (queue #${queue.queueNumber})...`);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartprint-agent-'));
  try {
    const order = await api.getOrder(queue.orderId);
    for (const [index, item] of order.items.entries()) {
      const doc = await withRetries(() => api.downloadDocument(item.documentId), 3, retryDelayMs);
      if (!isPrintable(doc.contentType)) {
        throw new ManualPrintNeeded(
          `"${item.fileName}" is not a PDF or image (it could not be converted to PDF on upload)`,
        );
      }
      const file = path.join(workDir, `item-${index + 1}${extensionFor(doc.contentType)}`);
      await fs.writeFile(file, doc.data);
      const label = `${order.orderCode}_${index + 1}`;
      const saved = await withRetries(() => printer.print(file, item, label), 3, retryDelayMs);
      logger(
        `  ${item.fileName}: ${item.copies} cop${item.copies === 1 ? 'y' : 'ies'}, ${item.printType}, ` +
          `${item.paperSize}, ${item.sides}${item.pageRange ? `, pages ${item.pageRange}` : ''}` +
          (saved ? ` -> ${saved}` : ' -> sent to printer'),
      );
    }
    await withRetries(() => api.complete(shopId, queue.queueId), 3, retryDelayMs);
    logger(`Order ${queue.orderCode} is READY - the student has been told.`);
    return 'printed';
  } catch (err) {
    logger(
      `!! Order ${queue.orderCode} could not be printed automatically: ${err.message}\n` +
        '   It stays PRINTING. Print it by hand, then press "Mark ready" in the staff screen.',
    );
    return 'failed';
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function readConfig(env = process.env) {
  const required = ['SMARTPRINT_URL', 'AGENT_EMAIL', 'AGENT_PASSWORD'];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`Missing settings: ${missing.join(', ')} (copy agent.env.example to agent.env)`);
  }
  return {
    baseUrl: env.SMARTPRINT_URL.replace(/\/+$/, ''),
    email: env.AGENT_EMAIL,
    password: env.AGENT_PASSWORD,
    method: env.PRINT_METHOD || 'auto',
    printerName: env.PRINTER_NAME || '',
    sumatraPath: env.SUMATRA_PATH || '',
    outputDir: env.OUTPUT_DIR || './printed',
    pollMs: Math.max(2, Number(env.POLL_SECONDS || 10)) * 1000,
  };
}

async function main(argv = process.argv.slice(2)) {
  const once = argv.includes('--once');
  const config = readConfig();
  const api = createApi(config);
  const printer = createPrinter(config);

  const user = await api.login();
  const shopId = user.shopId;
  log(`Signed in as ${user.name} (${user.email}). Printing with: ${printer.method}.`);

  const current = await api.currentJob(shopId);
  if (current) {
    log(
      `Order ${current.orderCode} is already PRINTING. Finish it and press "Mark ready" in the ` +
        'staff screen; new orders start after that.',
    );
  }

  if (once) {
    const result = await processNextJob({ api, printer, shopId });
    if (result === 'idle') log('Nothing to print right now.');
    process.exitCode = result === 'failed' ? 1 : 0;
    return;
  }

  let stopping = false;
  process.on('SIGINT', () => {
    log('Stopping after the current order...');
    stopping = true;
  });

  log(`Waiting for orders (checking every ${config.pollMs / 1000}s). Press Ctrl+C to stop.`);
  while (!stopping) {
    let result = 'idle';
    try {
      result = await processNextJob({ api, printer, shopId });
    } catch (err) {
      log(`Could not check for orders: ${err.message}`);
    }
    if (result !== 'printed' && !stopping) {
      await new Promise((r) => setTimeout(r, config.pollMs));
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Printer agent stopped: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { processNextJob, readConfig, withRetries };
