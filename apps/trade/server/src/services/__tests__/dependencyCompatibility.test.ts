import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Storage } from '@google-cloud/storage';
import { Gaxios } from 'gaxios';
import nodemailer from 'nodemailer';

// Use the real packages: the application suites mock these boundaries. All
// operations below stay in memory; no SMTP or cloud requests are transmitted.
describe('security dependency compatibility', () => {
  it('composes invite email with the real Nodemailer stream transport', async () => {
    const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const result = await transporter.sendMail({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Offline compatibility check',
      html: '<p>Test invite</p>',
    });
    expect(result.envelope.to).toEqual(['recipient@example.test']);
    expect(result.message.toString()).toContain('Subject: Offline compatibility check');
    expect(result.message.toString()).toContain('<p>Test invite</p>');
  });

  it('constructs the GCS bucket and file handles used by the snapshot loaders', () => {
    const storage = new Storage({ projectId: 'offline-compatibility-check' });
    const bucket = storage.bucket('offline-snapshots');
    const file = bucket.file('templates.json');
    expect(bucket.name).toBe('offline-snapshots');
    expect(file.name).toBe('templates.json');
    expect(typeof bucket.getFiles).toBe('function');
    expect(typeof file.download).toBe('function');
  });

  it('preserves Gaxios multipart encoding with the patched UUID dependency', async () => {
    let contentType: unknown;
    let body = '';
    const client = new Gaxios();
    await expect(
      client.request({
        url: 'https://example.test/offline',
        method: 'POST',
        multipart: [{ headers: { 'Content-Type': 'text/plain' }, content: 'snapshot-fixture' }],
        adapter: async (options) => {
          contentType = options.headers?.['Content-Type'];
          if (!(options.body instanceof Readable)) throw new Error('Expected multipart stream');
          for await (const chunk of options.body) body += chunk.toString();
          throw new Error('offline-multipart-captured');
        },
      }),
    ).rejects.toThrow('offline-multipart-captured');
    expect(contentType).toMatch(/^multipart\/related; boundary=[0-9a-f-]{36}$/);
    expect(body).toContain('snapshot-fixture');
    expect(body).toContain('Content-Type: text/plain');
  });
});
