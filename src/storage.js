import { AwsClient } from 'aws4fetch';

function required(env, name) {
  const value = env?.[name];
  if (value == null || String(value).trim() === '') {
    throw new Error(`${name} is not configured`);
  }
  return String(value).trim();
}

function cleanBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function objectPath(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

export function getStorage(env) {
  const endpoint = cleanBaseUrl(required(env, 'B2_ENDPOINT'));
  const bucket = required(env, 'B2_BUCKET');
  const publicBase = cleanBaseUrl(env.B2_PUBLIC_BASE_URL || `${endpoint}/${encodeURIComponent(bucket)}`);
  const region = String(env.B2_REGION || 'us-west-000').trim();

  const client = new AwsClient({
    accessKeyId: required(env, 'B2_KEY_ID'),
    secretAccessKey: required(env, 'B2_APPLICATION_KEY'),
    region,
    service: 's3',
  });

  const urlForKey = (key) => `${endpoint}/${encodeURIComponent(bucket)}/${objectPath(key)}`;

  return {
    async putObject(key, body, contentType = 'application/octet-stream') {
      const res = await client.fetch(urlForKey(key), {
        method: 'PUT',
        body,
        headers: { 'Content-Type': contentType || 'application/octet-stream' },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`B2 upload failed (${res.status})${text ? `: ${text.slice(0, 300)}` : ''}`);
      }
      return { key, url: `${publicBase}/${objectPath(key)}` };
    },

    async deleteObject(key) {
      try {
        const res = await client.fetch(urlForKey(key), { method: 'DELETE' });
        return res.ok;
      } catch {
        return false;
      }
    },

    async getObject(key) {
      const res = await client.fetch(urlForKey(key), { method: 'GET' });
      if (!res.ok) throw new Error(`B2 fetch failed (${res.status}) for ${key}`);
      return res.arrayBuffer();
    },

    publicUrl(key) {
      return `${publicBase}/${objectPath(key)}`;
    },
  };
}
