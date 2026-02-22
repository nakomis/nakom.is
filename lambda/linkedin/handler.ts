import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { parse } from 'csv-parse/sync';
import { Readable } from 'stream';

const s3 = new S3Client({});
const PRIVATE_BUCKET = process.env.PRIVATE_BUCKET!;

async function streamToString(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

async function readCsv(key: string): Promise<Record<string, string>[]> {
    try {
        const result = await s3.send(new GetObjectCommand({
            Bucket: PRIVATE_BUCKET,
            Key: key,
        }));
        const text = await streamToString(result.Body as Readable);
        return parse(text, { columns: true, skip_empty_lines: true, relax_quotes: true });
    } catch {
        console.warn(`Could not read ${key} — skipping`);
        return [];
    }
}

function formatDate(dateStr: string): string {
    if (!dateStr) return '';
    // LinkedIn uses "Mon YYYY" or "YYYY" formats
    return dateStr.trim();
}

export const handler = async (): Promise<void> => {
    console.log('LinkedIn Lambda triggered — generating linkedin.md');

    // Read all the CSV exports in parallel
    const [profileData, positionsData, educationsData, skillsData, recommendationsData] = await Promise.all([
        readCsv('linkedin-export/Profile.csv'),
        readCsv('linkedin-export/Positions.csv'),
        readCsv('linkedin-export/Education.csv'),
        readCsv('linkedin-export/Skills.csv'),
        readCsv('linkedin-export/Recommendations_Received.csv'),
    ]);

    const lines: string[] = [];

    // Profile section
    if (profileData.length > 0) {
        const p = profileData[0];
        const name = [p['First Name'], p['Last Name']].filter(Boolean).join(' ');
        if (name) lines.push(`# ${name}`, '');
        if (p['Headline']) lines.push(`**${p['Headline']}**`, '');
        if (p['Summary']) lines.push('## Summary', '', p['Summary'], '');
        if (p['Industry']) lines.push(`**Industry:** ${p['Industry']}`, '');
        if (p['Geo Location']) lines.push(`**Location:** ${p['Geo Location']}`, '');
        lines.push('');
    }

    // Positions
    if (positionsData.length > 0) {
        lines.push('## Experience', '');
        for (const pos of positionsData) {
            const title = pos['Title'] || pos['Position'] || '';
            const company = pos['Company Name'] || pos['Company'] || '';
            const startDate = formatDate(pos['Started On'] || pos['Start Date'] || '');
            const endDate = pos['Finished On'] || pos['End Date'] ? formatDate(pos['Finished On'] || pos['End Date']) : 'Present';
            const description = pos['Description'] || '';
            const location = pos['Location'] || '';

            lines.push(`### ${title}${company ? ` — ${company}` : ''}`);
            const dateParts = [startDate, endDate].filter(Boolean).join(' – ');
            const metaParts = [dateParts, location].filter(Boolean).join(' | ');
            if (metaParts) lines.push(`*${metaParts}*`);
            if (description) lines.push('', description);
            lines.push('');
        }
    }

    // Education
    if (educationsData.length > 0) {
        lines.push('## Education', '');
        for (const edu of educationsData) {
            const school = edu['School Name'] || edu['School'] || '';
            const degree = edu['Degree Name'] || edu['Degree'] || '';
            const field = edu['Field Of Study'] || edu['Field'] || '';
            const startDate = formatDate(edu['Start Date'] || '');
            const endDate = edu['End Date'] ? formatDate(edu['End Date']) : '';
            const notes = edu['Notes'] || edu['Description'] || '';

            const title = [degree, field].filter(Boolean).join(', ');
            lines.push(`### ${school}`);
            if (title) lines.push(title);
            const dateParts = [startDate, endDate].filter(Boolean).join(' – ');
            if (dateParts) lines.push(`*${dateParts}*`);
            if (notes) lines.push('', notes);
            lines.push('');
        }
    }

    // Skills
    if (skillsData.length > 0) {
        lines.push('## Skills', '');
        const skillNames = skillsData
            .map(s => s['Name'] || s['Skill'] || '')
            .filter(Boolean);
        if (skillNames.length > 0) {
            lines.push(skillNames.join(', '), '');
        }
    }

    // Recommendations received
    if (recommendationsData.length > 0) {
        lines.push('## Recommendations', '');
        for (const rec of recommendationsData) {
            const from = rec['First Name'] && rec['Last Name']
                ? `${rec['First Name']} ${rec['Last Name']}`
                : rec['Recommender'] || 'Unknown';
            const text = rec['Text'] || rec['Recommendation Text'] || '';
            const relationship = rec['Relationship to recommender'] || rec['Position of recommender'] || '';

            lines.push(`> **${from}**${relationship ? ` (${relationship})` : ''}`);
            if (text) lines.push(`> `, `> ${text.replace(/\n/g, '\n> ')}`);
            lines.push('');
        }
    }

    const markdown = lines.join('\n');

    await s3.send(new PutObjectCommand({
        Bucket: PRIVATE_BUCKET,
        Key: 'linkedin.md',
        Body: markdown,
        ContentType: 'text/markdown',
    }));

    console.log('linkedin.md generated successfully');
};
