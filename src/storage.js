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
  if (env && env.__storage) return env.__storage; // test hook
  const endpoint = cleanBaseUrl(required(env, 'B2_ENDPOINT'));
  const bucket = required(env, 'B2_BUCKET');
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
      // Never hand back a raw B2 URL: the bucket is private, so a direct
      // link 401s in a browser and a presigned link would expire. This is
      // a same-origin path into our own /api/files proxy route, which
      // signs the request to B2 server-side on every request. It never
      // expires because it isn't a signature — it's a live proxy.
      return { key, url: `/api/files/${objectPath(key)}` };
    },

    async deleteObject(key) {
      try {
        const res = await client.fetch(urlForKey(key), { method: 'DELETE' });
        return res.ok;
      } catch {
        return false;
      }
    },

    async headObject(key) {
      const res = await client.fetch(urlForKey(key), { method: 'HEAD' });
      if (res.status === 404) return { exists: false, contentLength: 0, contentType: null };
      if (!res.ok) throw new Error(`B2 metadata fetch failed (${res.status})`);
      const rawLength = res.headers.get('content-length');
      const contentLength = rawLength == null ? null : Number(rawLength);
      return {
        exists: true,
        contentLength: Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null,
        contentType: res.headers.get('content-type'),
      };
    },

    async getObject(key) {
      const res = await client.fetch(urlForKey(key), { method: 'GET' });
      if (!res.ok) throw new Error(`B2 fetch failed (${res.status}) for ${key}`);
      return res.arrayBuffer();
    },

    // Used by the /api/files proxy route. Signs a GET (optionally a byte
    // range, so PDF viewers and resumable downloads work) and returns the
    // raw upstream Response so its body can be streamed straight through
    // without buffering the whole file in Worker memory.
    async fetchObject(key, range) {
      const headers = range ? { Range: range } : undefined;
      return client.fetch(urlForKey(key), { method: 'GET', headers });
    },
  };
}
