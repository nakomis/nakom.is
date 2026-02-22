import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { marked } from 'marked';
import chromium from '@sparticuz/chromium-min';
import puppeteer from 'puppeteer-core';
import { Readable } from 'stream';

const s3 = new S3Client({});
const cf = new CloudFrontClient({});

const PRIVATE_BUCKET = process.env.PRIVATE_BUCKET!;
const PUBLIC_BUCKET = process.env.PUBLIC_BUCKET!;
const CF_DISTRIBUTION_ID = process.env.CF_DISTRIBUTION_ID!;

// Chromium binary: downloaded from GitHub Releases on first cold start, cached in /tmp
// Update this URL when upgrading @sparticuz/chromium-min:
// https://github.com/Sparticuz/chromium/releases
const CHROMIUM_DOWNLOAD_URL =
    'https://github.com/Sparticuz/chromium/releases/download/v143.0.4/chromium-v143.0.4-pack.x64.tar';

const CV_CSS = `
  body {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #222;
    max-width: 820px;
    margin: 0 auto;
    padding: 0;
  }
  h1 { font-size: 22pt; margin: 0 0 4px; }
  h2 {
    font-size: 13pt;
    border-bottom: 1.5px solid #444;
    padding-bottom: 2px;
    margin-top: 20px;
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  h3 { font-size: 11pt; margin: 10px 0 2px; }
  p { margin: 4px 0; }
  ul { margin: 4px 0 4px 18px; padding: 0; }
  li { margin: 2px 0; }
  strong { font-weight: bold; }
  em { font-style: italic; }
  a { color: #0066cc; text-decoration: none; }
  hr { border: none; border-top: 1px solid #ccc; margin: 12px 0; }
`;

async function streamToString(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

export const handler = async (event: {
    source?: string;
    detail?: { bucket?: { name: string }; object?: { key: string } };
}): Promise<void> => {
    console.log('CV Lambda triggered:', JSON.stringify(event.detail?.object));

    // Read cv.md from private bucket
    const getResult = await s3.send(new GetObjectCommand({
        Bucket: PRIVATE_BUCKET,
        Key: 'cv.md',
    }));
    const markdown = await streamToString(getResult.Body as Readable);

    // Convert Markdown → HTML
    const htmlBody = await marked(markdown);
    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${CV_CSS}</style>
</head>
<body>${htmlBody}</body>
</html>`;

    // Launch Chromium and render PDF
    const executablePath = await chromium.executablePath(CHROMIUM_DOWNLOAD_URL);

    const browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath,
        headless: true,
    });

    let pdf: Buffer;
    try {
        const page = await browser.newPage();
        await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
        pdf = Buffer.from(await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
        }));
    } finally {
        await browser.close();
    }

    // Upload PDF to public bucket
    await s3.send(new PutObjectCommand({
        Bucket: PUBLIC_BUCKET,
        Key: 'cv.pdf',
        Body: pdf,
        ContentType: 'application/pdf',
        CacheControl: 'max-age=3600',
    }));

    // Invalidate CloudFront /cv path
    await cf.send(new CreateInvalidationCommand({
        DistributionId: CF_DISTRIBUTION_ID,
        InvalidationBatch: {
            Paths: { Quantity: 1, Items: ['/cv'] },
            CallerReference: `cv-${Date.now()}`,
        },
    }));

    console.log('CV PDF generated and uploaded successfully');
};
