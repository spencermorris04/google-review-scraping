# 🌟 Google Reviews Scraper

A Google Maps reviews scraper that collects and stores business reviews in a PostgreSQL database. Built with TypeScript, Playwright, and Node.js.

## ✨ Features

- 🚀 **Concurrent scraping** - Process multiple businesses simultaneously
- 🔄 **Automatic pagination** - Fetches all available reviews across multiple pages
- 💾 **PostgreSQL storage** - Save reviews in a structured database
- 🖼️ **Image URL extraction** - Collects image URLs from reviews
- 🌈 **Beautiful console output** - Visual progress tracking with colors and spinners
- 🛡️ **Error resilience** - Continues operation even if some businesses fail
- 🔍 **Duplicate prevention** - Avoids storing duplicate reviews

## 📋 Requirements

- Node.js (v14 or later)
- PostgreSQL database
- TypeScript and ts-node

## 🛠️ Installation

1. Clone the repository:

```bash
git clone https://github.com/spencermorris04/google-review-scraping.git
cd google-review-scraping
```

2. Install dependencies:

```bash
npm install typescript ts-node dotenv pg playwright csv-parse
```

3. Install Playwright browsers:

```bash
npx playwright install chromium
```

## ⚙️ Configuration

### Environment Variables

Create a `.env` file in the project root with the following variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `PG_CONN_STRING` | PostgreSQL connection string | `postgresql://user:password@example.com/db-name?sslmode=require` |
| `REVIEW_CSV_FILE` | Path to CSV file with businesses to scrape | `review_sources.csv` (default if not specified) |

### Input CSV Format

The script requires a CSV file with the following columns:

```csv
company,location,gmaps_url
"Acme Coffee","Downtown","https://maps.google.com/maps?cid=123456789"
"Zenith Fitness","North Side","https://maps.google.com/maps?cid=987654321"
```

## 🚀 Usage

Run the script with:

```bash
npx ts-node scrapeReviews.ts
```

## 🔧 Customization

You can adjust the following parameters at the top of the script:

```typescript
/* ═══════════════════ CONFIGURATION ═══════════════════ */
const CONCURRENCY         = 4;      // Number of pages to run in parallel
const FIRST_PAYLOAD_MS    = 12_000; // Wait time for initial review data (ms)
const INTER_PAGE_DELAY_MS = 350;    // Delay between pagination requests (ms)
const HEADLESS            = true;   // Run browser in headless mode
```

- Increase `CONCURRENCY` for faster processing (limited by your system resources)
- Increase `FIRST_PAYLOAD_MS` if you have a slower connection
- Increase `INTER_PAGE_DELAY_MS` to avoid rate limiting
- Set `HEADLESS` to `false` to see the browser in action (useful for debugging)

## 🧠 How It Works

### Core Logic Flow

1. **Initialization**:
   - Reads business information from the CSV file
   - Connects to PostgreSQL database
   - Creates the reviews table if it doesn't exist
   - Launches a headless Chromium browser

2. **Concurrent Processing**:
   - Creates a worker pool with up to `CONCURRENCY` workers
   - Each worker processes one business at a time from the queue

3. **For Each Business**:
   - Opens a new browser page and navigates to the Google Maps URL
   - Handles cookie consent dialog if it appears
   - Clicks on the reviews tab/section to load reviews
   - Intercepts the first API response containing review data
   - Parses the review data and pagination token
   - Continues fetching additional pages of reviews until no more are available
   - Stores all unique reviews in the database

4. **Data Parsing**:
   - Extracts review ID, author, rating, text, date, and images from Google's JSON response
   - Handles both standard "entities" endpoint and alternative "ugc" endpoint
   - Deduplicates image URLs and limits to 8 per review

5. **Database Storage**:
   - Checks which reviews already exist in the database
   - Only inserts new, unique reviews (based on review_id)
   - Uses parameterized queries for SQL injection protection

### Database Schema

```sql
CREATE TABLE IF NOT EXISTS google_reviews (
  company      text,
  location     text,
  business_url text,
  review_id    text PRIMARY KEY,
  author       text,
  rating       int,
  review_text  text,
  review_date  text,
  images       text[]
)
```

## 📊 Output

The script provides real-time progress in the console:

- Starting header with configuration summary
- Progress for each business with page counts
- Error messages for any failed businesses
- Summary statistics when complete

All reviews are stored in the PostgreSQL database for further analysis or export.

## ⚠️ Troubleshooting

### Common Issues

1. **Connection Errors**:
   - Verify your PostgreSQL connection string is correct
   - Check if your database server is accessible

2. **Timeout Errors**:
   - Increase `FIRST_PAYLOAD_MS` if reviews aren't loading fast enough
   - Check your internet connection stability

3. **Rate Limiting**:
   - Increase `INTER_PAGE_DELAY_MS` to slow down requests
   - Decrease `CONCURRENCY` to reduce parallel requests

4. **Missing Reviews**:
   - Google Maps may show different reviews based on your location/browser
   - Some reviews may be filtered out by Google's algorithm