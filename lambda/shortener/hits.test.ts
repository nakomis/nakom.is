import { buildHitEvent, deviceFrom, header, langFrom, parseUserAgent, sqsHitSink } from './hits';

const UA = {
    iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
    iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
    macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
    windowsOpera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
    chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    curl: 'curl/8.7.1',
};

describe('parseUserAgent', () => {
    it.each([
        [UA.iphoneSafari, 'iOS', 'Safari'],
        [UA.iphoneChrome, 'iOS', 'Chrome'],
        [UA.iphoneFirefox, 'iOS', 'Firefox'],
        [UA.ipad, 'iOS', 'Safari'],
        [UA.androidChrome, 'Android', 'Chrome'],
        [UA.androidSamsung, 'Android', 'other'],
        [UA.macSafari, 'macOS', 'Safari'],
        [UA.macChrome, 'macOS', 'Chrome'],
        [UA.windowsEdge, 'Windows', 'Edge'],
        [UA.windowsFirefox, 'Windows', 'Firefox'],
        [UA.linuxFirefox, 'Linux', 'Firefox'],
        [UA.windowsOpera, 'Windows', 'other'],
        [UA.chromebook, 'other', 'Chrome'],
        [UA.curl, 'other', 'other'],
    ])('%s → %s / %s', (ua, os, browser) => {
        expect(parseUserAgent(ua)).toEqual({ os, browser });
    });

    it('is null without a User-Agent', () => {
        expect(parseUserAgent(null)).toEqual({ os: null, browser: null });
    });
});

describe('langFrom', () => {
    it.each([
        ['en-GB,en;q=0.9,fr;q=0.8', 'en-GB'],
        ['en-gb', 'en-GB'],
        ['fr', 'fr'],
        ['FR;q=0.7', 'fr'],
        ['zh-hant-TW', 'zh-Hant'],
        ['es-419,es;q=0.9', 'es-419'],
        ['*', null],
        ['', null],
        ['<script>', null],
    ])('%s → %s', (value, expected) => {
        expect(langFrom(value === '' ? null : value)).toBe(expected);
    });
});

describe('deviceFrom', () => {
    const flags = (m: string, t: string, d: string, tv = 'false') => ({
        'CloudFront-Is-Mobile-Viewer': m,
        'CloudFront-Is-Tablet-Viewer': t,
        'CloudFront-Is-Desktop-Viewer': d,
        'CloudFront-Is-SmartTV-Viewer': tv,
    });

    it.each([
        [flags('true', 'false', 'false'), 'mobile'],
        [flags('true', 'true', 'false'), 'tablet'],
        [flags('false', 'false', 'true'), 'desktop'],
        [flags('false', 'false', 'false', 'true'), 'other'],
        [flags('false', 'false', 'false'), 'other'],
        [{}, null],
    ])('%j → %s', (headers, expected) => {
        expect(deviceFrom(headers)).toBe(expected);
    });
});

describe('header', () => {
    it('looks headers up case-insensitively and treats blanks as absent', () => {
        expect(header({ 'cloudfront-viewer-country': 'GB' }, 'CloudFront-Viewer-Country')).toBe('GB');
        expect(header({ 'Accept-Language': '  ' }, 'accept-language')).toBeNull();
        expect(header({}, 'User-Agent')).toBeNull();
    });
});

describe('buildHitEvent', () => {
    it('clips oversized header values', () => {
        const hit = buildHitEvent('hi-x', 'qr', {
            headers: { 'CloudFront-Viewer-City': 'x'.repeat(500), 'CloudFront-Viewer-Country': 'GBGBGBGBGB' },
            requestId: 'r',
        }, new Date('2026-10-15T22:00:00Z'));
        expect(hit.city).toHaveLength(100);
        expect(hit.country).toHaveLength(8);
        expect(hit.at).toBe('2026-10-15T22:00:00.000Z');
    });
});

describe('sqsHitSink', () => {
    it('sends the event as the message body', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const send = jest.fn().mockResolvedValue({});
        const hit = buildHitEvent('hi-x', 'link', { headers: {}, requestId: 'r1' });
        await sqsHitSink({ send }, 'https://sqs.example/q')(hit);
        expect(send).toHaveBeenCalledTimes(1);
        const [command, options] = send.mock.calls[0];
        expect(command.input).toEqual({ QueueUrl: 'https://sqs.example/q', MessageBody: JSON.stringify(hit) });
        expect(options.abortSignal).toBeDefined();
    });
});
