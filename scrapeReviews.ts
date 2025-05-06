#!/usr/bin/env ts-node
import fs                   from 'node:fs';
import readline             from 'node:readline';
import { parse as csvParse} from 'csv-parse/sync';
import {
  chromium,
  APIResponse,
  BrowserContext,
  Page
}                           from 'playwright';
import { Client }           from 'pg';
import * as dotenv          from 'dotenv';
dotenv.config();

/* ═══════════════════ CONSOLE STYLING ═══════════════════ */
// ANSI escape codes for creating colored terminal output
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m'
};

// Styled console logging functions for consistent output
const logger = {
  info: (msg: string) => console.log(`${COLORS.cyan}${COLORS.bold}ℹ INFO${COLORS.reset} ${msg}`),
  success: (msg: string) => console.log(`${COLORS.green}${COLORS.bold}✓ SUCCESS${COLORS.reset} ${msg}`),
  warn: (msg: string) => console.warn(`${COLORS.yellow}${COLORS.bold}⚠ WARNING${COLORS.reset} ${msg}`),
  error: (msg: string) => console.error(`${COLORS.red}${COLORS.bold}✗ ERROR${COLORS.reset} ${msg}`),
  debug: (msg: string) => console.log(`${COLORS.dim}${COLORS.italic}🔍 DEBUG${COLORS.reset} ${msg}`),
  header: (msg: string) => {
    const line = "═".repeat(msg.length + 4);
    console.log(`\n${COLORS.bold}${COLORS.blue}╔${line}╗`);
    console.log(`║  ${msg}  ║`);
    console.log(`╚${line}╝${COLORS.reset}\n`);
  }
};

/* ═══════════════════ CONFIGURATION ═══════════════════ */
/**
 * TWEAKABLE PARAMETERS
 * 
 * These values control the behavior of the scraper and can be adjusted
 * to optimize performance or avoid detection:
 * 
 * - CONCURRENCY: Number of browser pages to run in parallel
 * - FIRST_PAYLOAD_MS: Maximum time to wait for initial data to load
 * - INTER_PAGE_DELAY_MS: Delay between pagination requests (prevents rate limiting)
 * - HEADLESS: Whether to run browser in headless mode (invisible) or not
 */
const CONCURRENCY         = 4;      // Number of pages to run in parallel
const FIRST_PAYLOAD_MS    = 12_000; // Wait time for initial review data (ms)
const INTER_PAGE_DELAY_MS = 350;    // Delay between pagination requests (ms)
const HEADLESS            = true;   // Run browser in headless mode

/* ═══════════════════ TYPE DEFINITIONS ═══════════════════ */
/**
 * Represents a row from the source CSV file with business information
 */
interface SourceRow { 
  company: string;     // Business name
  location: string;    // Physical location/address 
  gmaps_url: string;   // Google Maps URL to scrape
}

/**
 * Represents a parsed Google review with all relevant data
 */
interface ReviewRow {
  company: string;        // Business name (from source)
  location: string;       // Location (from source)
  business_url: string;   // Google Maps URL (from source)
  review_id: string;      // Unique identifier for the review
  author: string;         // Name of reviewer
  rating: number|null;    // Star rating (1-5) or null if text-only
  review_text: string;    // Content of the review
  review_date: string;    // Date the review was posted
  images: string[];       // Array of image URLs attached to review
}

/**
 * Type of Google API endpoint being used
 * - 'entities': Standard reviews endpoint
 * - 'ugc': User-generated content endpoint (sometimes used for reviews)
 */
type Endpoint = 'entities'|'ugc';

/* ═══════════════════ UTILITY FUNCTIONS ═══════════════════ */
/**
 * Creates a Promise that resolves after the specified delay
 * 
 * @param ms - Number of milliseconds to sleep
 * @returns Promise that resolves after the delay
 */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Ensures the PostgreSQL table for storing reviews exists
 * Drops the table if it already exists to start fresh
 * 
 * @param pg - PostgreSQL client connection
 */
async function ensureTable(pg: Client) {
  logger.info("Ensuring database table exists...");
  
  // Drop the table if it exists
  await pg.query(`DROP TABLE IF EXISTS google_reviews`);
  
  // Create a fresh table
  await pg.query(`
    CREATE TABLE google_reviews (
      company      text,
      location     text,
      business_url text,
      review_id    text PRIMARY KEY,
      author       text,
      rating       int,
      review_text  text,
      review_date  text,
      images       text[]
    )`);
    
  logger.success("Database table recreated");
}

/**
 * Inserts reviews into the database without checking for duplicates
 * 
 * @param pg - PostgreSQL client connection
 * @param rows - Array of review objects to insert
 * @returns Promise that resolves when insertion is complete
 */
async function insert(pg: Client, rows: ReviewRow[]) {
  if (!rows.length) return;
  
  // Prepare column names and parameterized values for SQL insertion
  const cols = [
    'company', 'location', 'business_url', 'review_id',
    'author', 'rating', 'review_text', 'review_date', 'images'
  ];
  
  const params: any[] = [];
  const values = rows.map((r, i) => {
    const o = i * cols.length; 
    // Add all field values to params array
    params.push(...cols.map(c => (r as any)[c]));
    // Create parameterized placeholders ($1, $2, etc.)
    return `(${cols.map((_,j) => `$${o+j+1}`).join(',')})`;
  }).join(',');

  // Insert reviews without checking for duplicates
  await pg.query(
    `INSERT INTO google_reviews(${cols.join(',')}) VALUES ${values}`, 
    params
  );
  
  logger.success(`Inserted ${rows.length} reviews into database`);
}

/* ═══════════════════ PAYLOAD PARSING ═══════════════════ */
const XSSI = /^\)\]\}'/;

/* ── utility helpers ──────────────────────────────────── */
const isUrlLike     = (s: string) => s.startsWith('http') || s.startsWith('/local/');
const isGoogleToken = (s: string) => /^CAES[0-9A-Za-z+/]+=*$/.test(s);
const looksCoord    = (s: string) => s.includes('0x0:');
const isLikelyName  = (s: string) => {
  if (s.length < 3 || s.length > 60)      return false;
  if (isUrlLike(s) || isGoogleToken(s))   return false;
  if (looksCoord(s) || /\d/.test(s))      return false;
  const words = s.trim().split(/\s+/);
  if (words.length > 4)                   return false;   // unlikely a real name
  return words.every(w => /^[A-Z][a-zA-Z'’.‑-]+$/.test(w));
};

/**
 * Recursively walk any value, calling strFn for strings and numFn for numbers.
 */
function walkDeep(
  node: any,
  strFn: (s: string) => void,
  numFn: (n: number) => void = () => {}
) {
  if (typeof node === 'string')      strFn(node);
  else if (typeof node === 'number') numFn(node);
  else if (Array.isArray(node))      node.forEach(v => walkDeep(v, strFn, numFn));
}

/* ═══════════════════ TEXT-EXTRACTION HELPER (v3) ═══════════════════ */
/**
 * Recursively searches for the language-tag + nested text array pattern.
 * Supports both
 *   ["en", [ ["actual review", …] ]]
 * and
 *   [ ["en"], [ ["actual review", …] ] ]
 * shapes. Returns the first matching review string, or '' if none is found.
 */
function extractReviewText(block: any): string {
  const seen = new Set<any>();

  function recurse(node: any): string | null {
    if (!Array.isArray(node) || seen.has(node)) return null;
    seen.add(node);

    // Pattern A: direct string lang + adjacent text-array
    for (let i = 0; i < node.length - 1; i++) {
      const lang = node[i];
      const next = node[i + 1];
      if (
        typeof lang === 'string' &&
        /^[A-Za-z]{2}$/.test(lang) &&
        Array.isArray(next) &&
        Array.isArray(next[0]) &&
        typeof next[0][0] === 'string'
      ) {
        return next[0][0].trim();
      }
    }

    // Pattern B: array-wrapped lang + array-wrapped text at end
    if (node.length >= 2) {
      const pen  = node[node.length - 2];
      const last = node[node.length - 1];
      if (
        Array.isArray(pen) &&
        pen.length === 1 &&
        typeof pen[0] === 'string' &&
        /^[A-Za-z]{2}$/.test(pen[0]) &&
        Array.isArray(last) &&
        Array.isArray(last[0]) &&
        typeof last[0][0] === 'string'
      ) {
        return last[0][0].trim();
      }
    }

    // dive deeper into every child array
    for (const child of node) {
      const hit = recurse(child);
      if (hit !== null) return hit;
    }

    return null;
  }

  return recurse(block) || '';
}

/**
 * Grabs the real review-ID for this block.
 * 1. First tries block[0][0] (the built-in review token).
 * 2. If that equals the page token (data[1]), falls back to the
 *    '?p=…' param in the reply URL.
 */
function extractReviewId(block: any, pageToken: string): string {
  // 1) primary: the built-in per-review token
  const candidate = block?.[0]?.[0];
  if (typeof candidate === 'string' && candidate !== pageToken) {
    return candidate;
  }

  // 2) fallback: look for the reply link containing '?p='
  let postId: string | null = null;
  walkDeep(block, (s: string) => {
    if (!postId && typeof s === 'string' && s.includes('/customers/reviews/reply?p=')) {
      postId = s.split('p=')[1];
    }
  });

  // return whichever we found (or empty string if all else fails)
  return postId ?? (typeof candidate === 'string' ? candidate : '');
}

/* ═══════════════════ PAYLOAD PARSER FUNCTION (complete) ═══════════════════ */
/**
 * Parses one batch of Google reviews JSON:
 * 1. strips XSSI prefix
 * 2. JSON.parse the payload
 * 3. iterates each review block
 * 4. extracts review_id, author, rating, date, images
 * 5. uses extractReviewText to get user’s text ('' if none)
 * 6. builds next-page token
 */
function parseBatch(raw: string, ep: Endpoint) {
  const cleaned = raw.replace(XSSI, '').trim();
  let data: any;
  try {
    data = JSON.parse(cleaned);
  } catch {
    logger.warn('Failed to parse JSON response');
    return { reviews: [], token: null };
  }

  // the array of review blocks lives at data[2]
  const blocks: any[] = Array.isArray(data?.[2]) ? data[2] : [];
  const reviews: Omit<ReviewRow, 'company' | 'location' | 'business_url'>[] = [];

  for (const b of blocks) {
    if (!Array.isArray(b)) continue;

    // unique review identifier
    const review_id = extractReviewId(b, data[1]);
    if (!review_id) continue;

    // author name lives at b[0][1][4][5][0]
    let author = '';
    if (
      Array.isArray(b?.[0]?.[1]?.[4]?.[5]) &&
      typeof b[0][1][4][5][0] === 'string'
    ) {
      author = b[0][1][4][5][0];
    }

    // pull the user’s review text ('' if none)
    const review_text = extractReviewText(b);

    // collect rating, date, and image URLs
    let rating: number | null = null;
    let review_date = '';
    const images = new Set<string>();

    walkDeep(
      b,
      (s: string) => {
        if (!s.startsWith('http') && !review_date) {
          if (/ago$|Yesterday$|^[A-Za-z]{3}\s\d{4}$|^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
            review_date = s;
          }
        } else if (s.startsWith('http')) {
          images.add(s);
        }
      },
      (n: number) => {
        if (rating === null && Number.isInteger(n) && n >= 1 && n <= 5) {
          rating = n;
        }
      }
    );

    reviews.push({
      review_id,
      author,
      rating,
      review_text,
      review_date,
      images: [...images].slice(0, 8)
    });
  }

  // build the next page token
  const token =
    ep === 'ugc'
      ? (typeof data?.[1] === 'string' ? data[1] : null)
      : (Array.isArray(data?.[data.length - 1]) ? data[data.length - 1][0] : null);

  return { reviews, token };
}


/**
 * Updates the URL with a new page token for the 'entities' endpoint
 * 
 * @param url - Original request URL
 * @param t - Page token for next batch
 * @returns Updated URL with new page token
 */
const withEntitiesToken = (url: string, t: string) =>
  url.replace(/!3s[^!]*/, (m) => `!3s${encodeURIComponent(t)}`);

/**
 * Updates the URL with a new page token for the 'ugc' endpoint
 * 
 * @param url - Original request URL
 * @param t - Page token for next batch
 * @returns Updated URL with new page token
 */
const withUgcToken = (url: string, t: string) =>
  url.replace(/!2s[^!]*/, (m) => `!2s${encodeURIComponent(t)}`);

/* ═══════════════════ UI INTERACTION HELPERS ═══════════════════ */
/**
 * Clicks on the UI element to open the reviews pane/tab
 * 
 * @param page - Playwright Page object
 * @throws Error if reviews UI cannot be found
 */
async function openReviewsPane(page: Page) {
  // Selector targets both the 'more reviews' button and the reviews tab
  const sel = '[jsaction*="pane.wfvdle10.moreReviews"],' +
              'button[role="tab"][aria-label*="Reviews"]';
              
  // Wait for the reviews UI element to appear
  const btn = await page.waitForSelector(sel, { timeout: 3_000 }).catch(() => null);
  
  if (!btn) {
    throw new Error('Reviews section not found - page structure may have changed');
  }
  
  // Click the button to open reviews
  await btn.click().catch(() => {
    logger.warn("Failed to click reviews button, but continuing anyway");
  });
}

/**
 * Handles the Google cookie consent dialog if it appears
 * 
 * @param page - Playwright Page object
 */
async function dismissCookies(page: Page) {
  // Try to find the cookie consent button
  const sel = 'form[action="https://consent.google.com/save"] button';
  const btn = await page.waitForSelector(sel, { timeout: 1_500 }).catch(() => null);
  
  // Click it if found
  if (btn) {
    logger.info("Dismissing cookie consent dialog");
    await btn.click().catch(() => {
      logger.warn("Failed to dismiss cookie dialog");
    });
  }
}

/* ═══════════════════ PROGRESS VISUALIZATION ═══════════════════ */
// Setup readline interface for terminal interaction
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let nextLine = 0;

/**
 * Creates a progress display for tracking scraping status
 * Returns a function that updates the progress display
 * 
 * @param title - Title for this progress indicator (company/location)
 * @returns Function to update the progress display
 */
function makeProgress(title: string) {
  const line = nextLine++;
  const timestamp = new Date().toLocaleTimeString();
  const paddedTitle = title.padEnd(40);
  
  // Initial display
  readline.cursorTo(process.stdout, 0, line);
  process.stdout.write(
    `${COLORS.cyan}${COLORS.bold}[${timestamp}]${COLORS.reset} ` +
    `${COLORS.yellow}↻${COLORS.reset} ${paddedTitle} | ` +
    `${COLORS.dim}0 pages processed${COLORS.reset}`
  );
  
  // Progress bar elements
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIdx = 0;
  
  // Return function to update progress
  return (pages: number, done = false) => {
    readline.cursorTo(process.stdout, 0, line);
    
    // Update timestamp
    const newTimestamp = new Date().toLocaleTimeString();
    
    // Create appropriate status indicator
    let statusIcon;
    let statusColor;
    
    if (done) {
      statusIcon = '✓';
      statusColor = COLORS.green;
    } else {
      statusIcon = spinner[spinnerIdx];
      statusColor = COLORS.yellow;
      spinnerIdx = (spinnerIdx + 1) % spinner.length;
    }
    
    // Format the message
    process.stdout.write(
      `${COLORS.cyan}${COLORS.bold}[${newTimestamp}]${COLORS.reset} ` +
      `${statusColor}${COLORS.bold}${statusIcon}${COLORS.reset} ${paddedTitle} | ` +
      `${pages} ${COLORS.dim}pages processed${COLORS.reset}` +
      (done ? ` ${COLORS.green}${COLORS.bold}COMPLETE${COLORS.reset}` : '')
    );
    
    if (done) {
      process.stdout.write('\n');
    }
  };
}

/* ═══════════════════ CORE SCRAPING LOGIC ═══════════════════ */
/**
 * Scrapes reviews for a single Google Maps place/business
 * 
 * @param ctx - Playwright browser context
 * @param pg - PostgreSQL client connection
 * @param src - Source data (company, location, URL)
 */
async function scrapePlace(ctx: BrowserContext, pg: Client, src: SourceRow) {
  const { company, location, gmaps_url } = src;
  const show = makeProgress(`${company} – ${location}`);
  const startTime = Date.now();

  // Create a new browser page
  const page = await ctx.newPage();
  
  try {
    // Navigate to the Google Maps URL
    await page.goto(gmaps_url, { waitUntil: 'domcontentloaded' });
    
    // Handle cookie consent dialog if it appears
    await dismissCookies(page);
    
    // Open the reviews pane/tab
    await openReviewsPane(page);

    // Wait for the first reviews API response
    const first = await page.waitForResponse(
      r => r.url().includes('listentitiesreviews') || r.url().includes('listugcposts'),
      { timeout: FIRST_PAYLOAD_MS }
    );

    // Get the base URL for pagination requests
    const baseUrl = first.url();
    
    // Determine which endpoint type we're dealing with
    const ep: Endpoint = baseUrl.includes('listugcposts') ? 'ugc' : 'entities';

    // Array to collect all reviews
    const all: ReviewRow[] = [];
    
    // Parse the first batch of reviews
    let { reviews, token } = parseBatch(await first.text(), ep);
    
    // Add company/location info to each review
    all.push(...reviews.map(r => ({ 
      ...r, 
      company, 
      location, 
      business_url: gmaps_url 
    })));

    // Initialize page counter
    let pageNo = 1; 
    show(pageNo);
    
    // Continue fetching pages until no more page tokens
    while (token) {
      pageNo++;
      
      // Construct URL for next page of reviews based on endpoint type
      const nextUrl = ep === 'entities'
        ? withEntitiesToken(baseUrl, token)
        : withUgcToken(baseUrl, token);
        
      // Request the next page
      const res: APIResponse = await ctx.request.get(nextUrl, {
        headers: { referer: 'https://www.google.com/' }
      });
      
      // Stop if we get a non-200 response
      if (res.status() !== 200) {
        logger.warn(`Received status ${res.status()} - stopping pagination`);
        break;
      }
      
      // Parse the response
      const parsed = parseBatch(await res.text(), ep);
      
      // Add reviews to our collection
      all.push(...parsed.reviews.map(r => ({ 
        ...r, 
        company, 
        location, 
        business_url: gmaps_url 
      })));
      
      // Update token for next page
      token = parsed.token;
      
      // Update progress display
      show(pageNo);
      
      // Add delay between requests to avoid rate limiting
      await sleep(INTER_PAGE_DELAY_MS);
    }

    // Insert reviews into database
    await insert(pg, all);
    
    // Calculate duration
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Complete progress display
    show(pageNo, true);
    
    // Log summary
    logger.success(
      `Completed ${company} (${location}): ` +
      `${all.length} reviews across ${pageNo} pages in ${duration}s`
    );
  } catch (e: any) {
    // Handle errors
    show(0, true);
    readline.cursorTo(process.stdout, 0);
    logger.error(`Failed to scrape ${company}: ${e.message}`);
    
    // Log more details in debug mode
    if (e.stack) {
      logger.debug(`Stack trace: ${e.stack}`);
    }
  } finally {
    // Always close the page to avoid memory leaks
    await page.close();
  }
}

/* ═══════════════════ MAIN EXECUTION ═══════════════════ */
(async () => {
  try {
    // Application startup banner
    logger.header("Google Reviews Scraper");
    
    // Configuration summary
    logger.info(`Running with ${CONCURRENCY} concurrent pages`);
    logger.info(`Browser mode: ${HEADLESS ? 'headless' : 'visible'}`);
    
    /* Read CSV file with source data */
    const csvPath = process.env.REVIEW_CSV_FILE ?? 'review_sources.csv';
    logger.info(`Reading sources from: ${csvPath}`);
    
    const sources: SourceRow[] = csvParse(
      fs.readFileSync(csvPath),
      { columns: true, trim: true, skip_empty_lines: true }
    );
    
    logger.success(`Loaded ${sources.length} businesses to scrape`);

    /* Initialize PostgreSQL connection */
    logger.info("Connecting to PostgreSQL database...");
    const pg = new Client({ connectionString: process.env.PG_CONN_STRING });
    await pg.connect(); 
    await ensureTable(pg);
    logger.success("Connected to database");

    /* Initialize browser */
    logger.info("Launching browser...");
    const browser = await chromium.launch({ headless: HEADLESS });
    const ctx = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                'Chrome/135.0.0.0 Safari/537.36'
    });
    logger.success("Browser launched");

    /* Process all places with worker pool */
    logger.info(`Starting scraping of ${sources.length} businesses...`);
    const startTime = Date.now();
    
    // Create queue of sources to process
    const q = [...sources];
    
    // Run concurrent workers up to CONCURRENCY limit
    await Promise.all(Array(CONCURRENCY).fill(0).map(async () => {
      while (q.length) {
        await scrapePlace(ctx, pg, q.shift()!);
      }
    }));

    // Clean up resources
    await browser.close(); 
    await pg.end();
    rl.close();

    // Calculate total duration
    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Final summary
    logger.header("Scraping Complete");
    logger.success(
      `Processed ${sources.length} businesses in ${totalDuration}s ` +
      `(avg ${(parseFloat(totalDuration) / Number(sources.length)).toFixed(1)}s per business)`
    );
  } catch (e: any) {
    // Handle any top-level errors
    logger.error(`Fatal error: ${e.message}`);
    process.exit(1);
  }
})();