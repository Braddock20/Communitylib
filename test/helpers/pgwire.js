// Minimal PostgreSQL wire-protocol client used ONLY by the test suite.
//
// Why this exists: production uses @neondatabase/serverless (HTTP/WebSocket),
// which cannot talk to a plain local Postgres, and `pg` may not be installed on
// a given developer/CI machine. This helper exposes the same call surface the
// application uses:
//
//   sql`SELECT ... ${value}`            -> lazy thenable resolving to row objects
//   sql.query(text, params)             -> same, explicit parameters
//   sql.transaction([q1, q2, ...])      -> BEGIN/COMMIT around lazy queries
//
// Result typing follows node-postgres/neon conventions (bigint and numeric stay
// strings, json/jsonb are parsed, timestamps become Date, arrays are parsed) so
// code under test sees the same value shapes it sees in production.
//
// It supports trust / cleartext auth only (a local test database). It is not a
// general-purpose driver and must never be used by application code.
import net from 'node:net';

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

function int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function cstr(s) { return Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]); }
function message(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type, 'latin1'), int32(body.length + 4), body]);
}

// ---- value encoding (mirrors pg's prepareValue closely enough for tests) ----
function arrayLiteral(arr) {
  const items = arr.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return arrayLiteral(v);
    const s = v instanceof Date ? v.toISOString()
      : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${items.join(',')}}`;
}
export function prepareValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return arrayLiteral(v);
  if (v instanceof Uint8Array) return `\\x${Buffer.from(v).toString('hex')}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---- result decoding ----
function parseArray(text, parseItem) {
  let i = 0;
  function parse() {
    const out = [];
    i++; // '{'
    while (i < text.length) {
      const ch = text[i];
      if (ch === '}') { i++; return out; }
      if (ch === ',') { i++; continue; }
      if (ch === '{') { out.push(parse()); continue; }
      if (ch === '"') {
        i++;
        let s = '';
        while (i < text.length && text[i] !== '"') {
          if (text[i] === '\\') i++;
          s += text[i++];
        }
        i++;
        out.push(parseItem(s));
      } else {
        let s = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '}') s += text[i++];
        out.push(s === 'NULL' ? null : parseItem(s));
      }
    }
    return out;
  }
  return parse();
}
const parseBool = (s) => s === 't' || s === 'true';
const PARSERS = {
  16: parseBool,
  20: (s) => s, // int8 stays a string, like node-postgres/neon
  21: Number, 23: Number, 26: Number,
  700: Number, 701: Number,
  1700: (s) => s, // numeric stays a string
  114: JSON.parse, 3802: JSON.parse,
  1082: (s) => new Date(`${s}T00:00:00Z`),
  1114: (s) => new Date(`${s.replace(' ', 'T')}Z`),
  1184: (s) => new Date(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')),
  1000: (s) => parseArray(s, parseBool),
  1005: (s) => parseArray(s, Number), 1007: (s) => parseArray(s, Number),
  1016: (s) => parseArray(s, (x) => x),
  1009: (s) => parseArray(s, (x) => x), 1015: (s) => parseArray(s, (x) => x),
  1021: (s) => parseArray(s, Number), 1022: (s) => parseArray(s, Number),
  1231: (s) => parseArray(s, (x) => x),
  199: (s) => parseArray(s, JSON.parse), 3807: (s) => parseArray(s, JSON.parse),
};

class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'postgres error');
    this.name = 'NeonDbError'; // same name the production driver uses
    this.code = fields.C;
    this.severity = fields.S;
    this.detail = fields.D;
    this.constraint = fields.n;
    this.hint = fields.H;
    this.table = fields.t;
  }
}

class Connection {
  constructor({ host, port, user, password, database }) {
    this.opts = { host, port, user, password, database };
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.ready = null;
  }

  async connect() {
    this.socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
    this.socket.setNoDelay(true);
    this.socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.#pump(); });
    this.socket.on('error', (e) => this.#fail(e));
    this.socket.on('close', () => this.#fail(new Error('connection closed')));
    await new Promise((res, rej) => { this.socket.once('connect', res); this.socket.once('error', rej); });
    const params = Buffer.concat([
      cstr('user'), cstr(this.opts.user), cstr('database'), cstr(this.opts.database), Buffer.from([0]),
    ]);
    this.socket.write(Buffer.concat([int32(params.length + 8), int32(196608), params]));
    for (;;) {
      const m = await this.#next();
      if (m.type === 'R') {
        const code = m.body.readInt32BE(0);
        if (code === 3) {
          this.socket.write(message('p', cstr(this.opts.password || '')));
        } else if (code !== 0) {
          throw new Error(`unsupported auth method ${code}; use trust auth for the test database`);
        }
      } else if (m.type === 'E') {
        throw new PgError(this.#errorFields(m.body));
      } else if (m.type === 'Z') {
        return this;
      }
    }
  }

  #fail(err) {
    this.dead = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  #errorFields(body) {
    const fields = {};
    let i = 0;
    while (i < body.length && body[i] !== 0) {
      const code = String.fromCharCode(body[i++]);
      let end = body.indexOf(0, i);
      fields[code] = body.toString('utf8', i, end);
      i = end + 1;
    }
    return fields;
  }

  #pump() {
    for (;;) {
      if (this.buf.length < 5) return;
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) return;
      const type = String.fromCharCode(this.buf[0]);
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve({ type, body });
      else (this.queue ||= []).push({ type, body });
    }
  }

  #next() {
    if (this.queue?.length) return Promise.resolve(this.queue.shift());
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async run(text, params = []) {
    const values = params.map(prepareValue);
    const bindParts = [cstr(''), cstr(''), int16(0), int16(values.length)];
    for (const v of values) {
      if (v === null) bindParts.push(int32(-1));
      else { const b = Buffer.from(v, 'utf8'); bindParts.push(int32(b.length), b); }
    }
    bindParts.push(int16(0));
    this.socket.write(Buffer.concat([
      message('P', cstr(''), cstr(text), int16(0)),
      message('B', ...bindParts),
      message('D', Buffer.from('P'), cstr('')),
      message('E', cstr(''), int32(0)),
      message('S'),
    ]));
    let fields = [];
    const rows = [];
    let error = null;
    let command = '';
    for (;;) {
      const m = await this.#next();
      if (m.type === 'T') {
        const n = m.body.readInt16BE(0);
        let i = 2;
        fields = [];
        for (let f = 0; f < n; f++) {
          const end = m.body.indexOf(0, i);
          const name = m.body.toString('utf8', i, end);
          i = end + 1;
          const typeOid = m.body.readInt32BE(i + 6);
          i += 18;
          fields.push({ name, typeOid });
        }
      } else if (m.type === 'D') {
        const n = m.body.readInt16BE(0);
        let i = 2;
        const row = {};
        for (let c = 0; c < n; c++) {
          const len = m.body.readInt32BE(i); i += 4;
          if (len === -1) { row[fields[c].name] = null; continue; }
          const text = TEXT_DECODER.decode(m.body.subarray(i, i + len)); i += len;
          const parser = PARSERS[fields[c].typeOid];
          row[fields[c].name] = parser ? parser(text) : text;
        }
        rows.push(row);
      } else if (m.type === 'C') {
        command = m.body.toString('utf8', 0, m.body.length - 1);
      } else if (m.type === 'E') {
        error = new PgError(this.#errorFields(m.body));
      } else if (m.type === 'Z') {
        if (error) throw error;
        rows.command = command;
        return rows;
      }
    }
  }

  /** Simple-query protocol: runs a multi-statement script (migrations, DO blocks). No parameters. */
  async script(text) {
    this.socket.write(message('Q', cstr(text)));
    let error = null;
    for (;;) {
      const m = await this.#next();
      if (m.type === 'E') error = error || new PgError(this.#errorFields(m.body));
      else if (m.type === 'Z') { if (error) throw error; return; }
    }
  }

  close() { try { this.socket.end(); } catch { /* ignore */ } }
}

function lazyQuery(executor, text, params) {
  let promise;
  const q = {
    text, params,
    __lazyQuery: true,
    execute() { return (promise ||= executor(text, params)); },
    then(res, rej) { return q.execute().then(res, rej); },
    catch(rej) { return q.execute().catch(rej); },
    finally(fn) { return q.execute().finally(fn); },
  };
  return q;
}

export function parseConnectionUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''), database: decodeURIComponent(u.pathname.slice(1) || 'postgres'),
  };
}

/** Pool + Neon-compatible tagged-template facade. */
export async function createSql(url, { size = 4 } = {}) {
  const opts = parseConnectionUrl(url);
  const idle = [];
  const all = [];
  const waiting = [];
  async function checkout() {
    if (idle.length) return idle.pop();
    if (all.length < size) {
      const c = new Connection(opts);
      all.push(c);
      try { await c.connect(); } catch (e) { all.splice(all.indexOf(c), 1); throw e; }
      return c;
    }
    return new Promise((resolve) => waiting.push(resolve));
  }
  function release(c) {
    if (c.dead) { all.splice(all.indexOf(c), 1); return; }
    const next = waiting.shift();
    if (next) next(c); else idle.push(c);
  }
  async function exec(text, params) {
    const c = await checkout();
    try { return await c.run(text, params); } finally { release(c); }
  }
  function build(strings, values) {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
    return [text, values];
  }
  const sql = (strings, ...values) => {
    const [text, params] = build(strings, values);
    return lazyQuery(exec, text, params);
  };
  sql.query = (text, params = []) => lazyQuery(exec, text, params);
  sql.transaction = async (queries) => {
    const list = typeof queries === 'function' ? queries(sql) : queries;
    const c = await checkout();
    try {
      await c.run('BEGIN');
      const results = [];
      for (const q of list) results.push(await c.run(q.text, q.params));
      await c.run('COMMIT');
      return results;
    } catch (err) {
      try { await c.run('ROLLBACK'); } catch { /* connection may be dead */ }
      throw err;
    } finally { release(c); }
  };
  sql.end = async () => { for (const c of all) c.close(); };
  sql.raw = exec;
  sql.script = async (text) => {
    const c = await checkout();
    try { await c.script(text); } finally { release(c); }
  };
  return sql;
}

export { TEXT_ENCODER };
