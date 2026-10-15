import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ShortenerRequest } from './resolver';

/**
 * Hit events for the book's links (HAND-22).
 *
 * The book *Handmade Intelligence* prints `https://nakom.is/hi-<slug>` beside
 * each figure that has an animation, and a QR code for a QR-only short code,
 * `HTTPS://NAKOM.IS/Q01` … `Q99`. Every hit on one of those is published to
 * SQS and drained into Postgres at home, so Martin can see which ones readers
 * actually use. `shortPath` is the lower-cased path (`q01` or `hi-pythagoras`);
 * the book's links.json maps each Q-number to its slug.
 *
 * Only `shortPath`, `at`, `requestId` and `source` are always set; the rest
 * are derived and nullable. The viewer's IP is never
 * read, and the raw User-Agent is reduced to coarse OS and browser families
 * here and then dropped: neither reaches the queue.
 */
export interface HitEvent {
    shortPath: string;
    /** ISO-8601, UTC. */
    at: string;
    /** Idempotency key: the consumer inserts with ON CONFLICT (request_id) DO NOTHING. */
    requestId: string;
    source: HitSource;
    country: string | null;
    region: string | null;
    city: string | null;
    device: Device | null;
    lang: string | null;
    os: string | null;
    browser: string | null;
}

export type HitSource = 'qr' | 'link';
export type Device = 'mobile' | 'tablet' | 'desktop' | 'other';

/** Publishes a hit. Must never throw: a failure is logged and the redirect carries on. */
export type HitSink = (hit: HitEvent) => Promise<void>;

/** The book's printed links: `hi-<slug>`, counted with source `link`. */
export const HIT_PREFIX = 'hi-';
/** The book's QR-only codes, `q01` to `q99` (lower-cased), counted with source `qr`. */
export const QR_CODE = /^q\d{2}$/;

/** Case-insensitive header lookup: API Gateway passes CloudFront's casing through. */
export function header(headers: ShortenerRequest['headers'], name: string): string | null {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers ?? {})) {
        if (key.toLowerCase() === wanted && value !== undefined) {
            const trimmed = value.trim();
            return trimmed === '' ? null : trimmed;
        }
    }
    return null;
}

/** Clips free text from a header so a hostile value cannot bloat a row. */
function clip(value: string | null, max = 100): string | null {
    return value === null ? null : value.slice(0, max);
}

/**
 * The device class from CloudFront's `CloudFront-Is-*-Viewer` headers. Tablet
 * is checked before mobile, since a tablet can be reported as both. `null`
 * when CloudFront sent none of them (the origin request policy is missing, or
 * the request did not come through CloudFront at all).
 */
export function deviceFrom(headers: ShortenerRequest['headers']): Device | null {
    const flags = {
        tablet: header(headers, 'CloudFront-Is-Tablet-Viewer'),
        mobile: header(headers, 'CloudFront-Is-Mobile-Viewer'),
        desktop: header(headers, 'CloudFront-Is-Desktop-Viewer'),
        smartTv: header(headers, 'CloudFront-Is-SmartTV-Viewer'),
    };
    if (Object.values(flags).every(v => v === null)) {
        return null;
    }
    if (flags.tablet === 'true') return 'tablet';
    if (flags.mobile === 'true') return 'mobile';
    if (flags.desktop === 'true') return 'desktop';
    return 'other';
}

const LANGUAGE_TAG = /^([a-z]{2,3})(?:-([a-z0-9]{2,8}))?(?:-[a-z0-9]{1,8})*$/i;

/**
 * The primary tag from `Accept-Language`, e.g. `en-GB` from
 * `en-GB,en;q=0.9,fr;q=0.8`: language and first subtag only, canonically cased.
 */
export function langFrom(acceptLanguage: string | null): string | null {
    if (!acceptLanguage) return null;
    const first = acceptLanguage.split(',')[0].split(';')[0].trim();
    const parsed = LANGUAGE_TAG.exec(first);
    if (!parsed) return null;
    const language = parsed[1].toLowerCase();
    const sub = parsed[2];
    if (!sub) return language;
    // Two letters is a region (GB), four a script (Hant), three digits a UN region (419).
    if (sub.length === 2) return `${language}-${sub.toUpperCase()}`;
    if (sub.length === 4) return `${language}-${sub[0].toUpperCase()}${sub.slice(1).toLowerCase()}`;
    return `${language}-${sub}`;
}

/**
 * Coarse OS and browser families from a User-Agent, by substring. Deliberately
 * tiny and dependency-free: the families are all that is kept, and the raw
 * string is discarded by the caller.
 *
 * Order matters. Every iOS browser says "Safari" and "Mac OS X"; Chrome says
 * "Safari"; Edge says "Chrome"; Android says "Linux".
 */
export function parseUserAgent(ua: string | null): { os: string | null; browser: string | null } {
    if (!ua) return { os: null, browser: null };

    let os = 'other';
    if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
    else if (/CrOS/.test(ua)) os = 'other';
    else if (/Linux|X11/.test(ua)) os = 'Linux';

    let browser = 'other';
    if (/Edg(?:e|A|iOS)?\//.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera|SamsungBrowser\//.test(ua)) browser = 'other';
    else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox';
    else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
    else if (/Safari\//.test(ua)) browser = 'Safari';

    return { os, browser };
}

/** Builds the event for one hit. The User-Agent is read here and nowhere else, and is not kept. */
export function buildHitEvent(
    shortPath: string,
    source: HitSource,
    request: ShortenerRequest,
    now: Date = new Date(),
): HitEvent {
    const { headers } = request;
    const { os, browser } = parseUserAgent(header(headers, 'User-Agent'));
    return {
        shortPath,
        at: now.toISOString(),
        requestId: request.requestId,
        source,
        country: clip(header(headers, 'CloudFront-Viewer-Country'), 8),
        region: clip(header(headers, 'CloudFront-Viewer-Country-Region'), 16),
        city: clip(header(headers, 'CloudFront-Viewer-City')),
        device: deviceFrom(headers),
        lang: langFrom(header(headers, 'Accept-Language')),
        os,
        browser,
    };
}

export type SqsSender = Pick<SQSClient, 'send'>;

/**
 * Sends each hit to SQS, waiting at most `timeoutMs`.
 *
 * Awaited, but bounded, rather than truly fire-and-forget: Lambda freezes the
 * execution environment as soon as the handler returns, so an un-awaited send
 * would usually be cut off mid-flight (or leak into the next invocation). The
 * timeout is what keeps a slow or broken SQS from slowing the redirect by more
 * than a fraction of a second, and every failure is logged and swallowed.
 */
export function sqsHitSink(client: SqsSender, queueUrl: string, timeoutMs = 500): HitSink {
    return async (hit) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            await client.send(
                new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(hit) }),
                { abortSignal: controller.signal },
            );
            console.log(`Hit event queued: ${hit.shortPath} (${hit.source}) ${hit.requestId}`);
        } catch (err) {
            const reason = controller.signal.aborted ? `timed out after ${timeoutMs} ms` : String(err);
            console.error(`Hit event NOT queued for ${hit.shortPath} (${hit.requestId}): ${reason}`);
        } finally {
            clearTimeout(timer);
        }
    };
}
